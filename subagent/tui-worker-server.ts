import net from "node:net";
import { chmodSync, lstatSync, openSync, closeSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { decodeTuiWorkerRequest, TUI_WORKER_MAX_FRAME_BYTES } from "../shared/tui-worker-protocol.ts";
import type { TuiWorkerEvent, TuiWorkerManifest, TuiWorkerRequest, TuiWorkerResponse } from "../shared/tui-worker-protocol.ts";
import { TuiWorkerStore } from "./tui-worker-store.ts";
import type { WorkerState } from "./tui-worker-store.ts";

export type TuiWorkerAdapter = {
  isIdle(): boolean;
  canRun?(): boolean;
  permissionMode?(): boolean | undefined;
  send(message: string, mode: "steer" | "follow_up"): void;
  abort(): void | Promise<void>;
  /** Gracefully exit this idle Pi, retaining its tmux pane. */
  shutdown(): void;
  compact?(): Promise<void>;
  jobs?(params: import("../shared/tui-worker-protocol.ts").TuiWorkerJobParams, requestId: string): Promise<unknown>;
  applyOperatorMode?(enabled: boolean): unknown | Promise<unknown>;
};
const MUTATIONS = new Set(["prompt", "cancel", "compact", "prepare_reap", "promote"]);

/** Runs inside the actual TUI process. Observers own no lifetime-critical fd. */
export class TuiWorkerServer {
  readonly manifest: TuiWorkerManifest;
  readonly state: WorkerState;
  private server?: net.Server;
  private sockets = new Set<net.Socket>();
  private socketInode?: number;
  private lockHeld = false;
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private failed = false;
  readonly store: TuiWorkerStore;
  private adapter: TuiWorkerAdapter;
  constructor(store: TuiWorkerStore, adapter: TuiWorkerAdapter) {
    this.store = store;
    this.adapter = adapter;
    this.manifest = store.readManifest();
    this.state = store.readState();
  }
  get sealed(): boolean { return this.state.sealed || this.closing || this.failed; }
  private persist(): void {
    try { this.store.writeState(this.state); }
    catch (error) { this.failed = true; void this.adapter.abort(); throw error; }
  }
  private event(kind: TuiWorkerEvent["kind"], data?: unknown): void {
    this.state.events.push({ protocol: 1, workerEpoch: this.manifest.workerEpoch, sequence: ++this.state.sequence,
      timestamp: new Date().toISOString(), kind, ...(data === undefined ? {} : { data }) });
    this.state.events = this.state.events.slice(-256);
    this.persist();
  }
  /** Call synchronously from input/before_agent_start, before awaiting anything. */
  running(newTurn = false): boolean {
    if (this.sealed) { void this.adapter.abort(); return false; }
    if (newTurn || this.state.phase !== "running") {
      this.state.lastOutcome = undefined;
      this.state.lastReport = undefined;
    }
    this.state.active = true;
    this.state.phase = "running";
    this.event("running");
    return true;
  }
  settled(report: unknown): void {
    if (this.closing || this.failed || !this.adapter.isIdle()) return;
    this.state.lastReport = this.store.report(this.state.sequence + 1, report);
    this.state.active = false;
    this.state.phase = "settled";
    this.event("settled", { report: this.state.lastReport });
  }
  notification(data: unknown): void {
    const artifact = this.store.artifact("notification", this.state.sequence + 1, data);
    this.event("notification", { artifact });
  }
  outcome(data: unknown): void {
    const artifact = this.store.artifact("outcome", this.state.sequence + 1, data);
    this.state.lastOutcome = artifact;
    this.event("outcome", { artifact });
  }
  private snapshot() {
    return { active: this.state.active || !this.adapter.isIdle(), sealed: this.sealed, phase: this.state.phase,
      lastReport: this.state.lastReport, lastOutcome: this.state.lastOutcome, sequence: this.state.sequence, pid: process.pid,
      sessionFile: this.manifest.sessionFile, presentation: this.manifest.presentation,
      readyForPrompts: !this.sealed && (this.adapter.canRun?.() ?? true), permissionPromptsEnabled: this.adapter.permissionMode?.() };
  }
  private authenticated(r: TuiWorkerRequest): boolean {
    const expected = Buffer.from(this.manifest.controlToken);
    const actual = Buffer.from(r.token);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
    return (["ownerSessionId", "taskId", "runtimeId", "groupId", "childId", "attempt", "workerEpoch"] as const)
      .every(key => r[key] === this.manifest[key]);
  }
  private response(r: TuiWorkerRequest, extra: Record<string, unknown>): TuiWorkerResponse {
    return { protocol: 1, requestId: r.requestId, workerEpoch: r.workerEpoch, ...extra } as TuiWorkerResponse;
  }
  async handle(r: TuiWorkerRequest): Promise<TuiWorkerResponse> {
    const work = this.queue.catch(() => undefined).then(() => this.dispatch(r));
    this.queue = work;
    return await work;
  }
  private async dispatch(r: TuiWorkerRequest): Promise<TuiWorkerResponse> {
    const fail = (code: string, message: string) => this.response(r, { ok: false, code, message });
    if (!this.authenticated(r)) return fail("unauthorized", "Worker authentication failed");
    if (this.closing || this.failed) return fail("unavailable", "Worker control unavailable");
    const { token: _secret, ...publicRequest } = r;
    const digest = createHash("sha256").update(JSON.stringify(publicRequest)).digest("hex");
    const mutation = MUTATIONS.has(r.operation) || (r.operation === "jobs" && ["cancel", "reap", "ack", "unwatch"].includes(r.params.action));
    if (r.requestId.startsWith("operator:")) return fail("invalid", "Reserved request namespace");
    const receiptKey = `model:${r.requestId}`;
    const prior = Object.hasOwn(this.state.receipts, receiptKey) ? this.state.receipts[receiptKey] : undefined;
    if (prior) {
      if (prior.digest !== digest) return fail("invalid", "Request ID reused with different payload");
      if (r.operation === "prepare_reap" && prior.response?.ok) setTimeout(() => this.adapter.shutdown(), 25);
      return prior.response ?? fail("ambiguous", "Prior dispatch has no confirmed receipt; do not replay automatically");
    }
    if (r.operation === "status") return this.response(r, { ok: true, receipt: "applied", sequence: this.state.sequence, data: this.snapshot() });
    if (r.operation === "events") {
      const events = this.state.events.filter(event => event.sequence > r.afterSequence);
      // Bound response bytes even if event producers attach large data.
      const selected: TuiWorkerEvent[] = [];
      for (const event of events) {
        if (Buffer.byteLength(JSON.stringify([...selected, event])) > 96 * 1024) break;
        selected.push(event);
      }
      return this.response(r, { ok: true, receipt: "applied", sequence: this.state.sequence,
        data: { events: selected, oldestSequence: this.state.events[0]?.sequence ?? this.state.sequence,
          nextSequence: selected.at(-1)?.sequence ?? r.afterSequence } });
    }
    if (r.operation === "jobs" && !this.adapter.jobs) return fail("unavailable", "Child-local job controller unavailable");
    if (this.state.sealed && r.operation !== "prepare_reap") return fail("sealed", "Worker is reserved for explicit reap");
    if (r.operation === "jobs" && !mutation) {
      try { return this.response(r, { ok: true, receipt: "applied", sequence: this.state.sequence, data: await this.adapter.jobs!(r.params, r.requestId) }); }
      catch (error) { return fail("unavailable", error instanceof Error ? error.message : "Local job query failed"); }
    }
    if (r.operation === "compact" && (!this.adapter.compact || this.state.active || !this.adapter.isIdle())) return fail("busy", "Compaction requires an idle capable worker");
    if (r.operation === "prepare_reap" && (this.state.active || !this.adapter.isIdle())) return fail("busy", "Worker is active; reap never cancels work");
    if (r.operation === "promote") {
      const old = this.manifest.placement, next = r.placement;
      if (old.socketPath !== next.socketPath || old.serverEpoch !== next.serverEpoch || old.paneId !== next.paneId
        || old.ownershipNonce !== next.ownershipNonce) return fail("invalid", "Promotion must preserve server and owned pane");
    }
    if (mutation && Object.keys(this.state.receipts).length >= 4096) return fail("unavailable", "Worker receipt capacity exhausted");
    // Persist intent before side effects. A lost post-dispatch write is explicitly ambiguous.
    this.state.receipts[receiptKey] = { digest };
    this.persist();
    let data: unknown;
    switch (r.operation) {
      case "jobs":
        data = await this.adapter.jobs!(r.params, r.requestId);
        break;
      case "prompt":
        this.state.active = true;
        this.state.phase = "running";
        this.persist();
        if (r.mode === "interrupt") {
          await this.adapter.abort();
          if (this.closing || this.failed) return fail("unavailable", "Worker closed during interrupt");
          if (!this.adapter.isIdle()) return fail("busy", "Abort has not reached idle; dispatch remains ambiguous");
        }
        // abort() can emit agent_settled while awaited above. Re-reserve activity
        // before enqueueing the replacement so a queued reap cannot see idle.
        this.state.active = true;
        this.state.phase = "running";
        this.persist();
        this.adapter.send(r.message, r.mode === "follow_up" ? "follow_up" : "steer");
        break;
      case "compact":
        this.state.active = true; this.persist();
        await this.adapter.compact!();
        this.state.active = !this.adapter.isIdle();
        break;
      case "cancel":
        await this.adapter.abort();
        this.state.active = !this.adapter.isIdle();
        this.event("cancelled");
        data = this.snapshot();
        break;
      case "prepare_reap":
        // No await between live idle check above and input seal. JS event handlers
        // observe the seal before any later keyboard/Paseo/parent input can run.
        this.state.sealed = true;
        this.state.reapReservation ??= randomBytes(16).toString("hex");
        data = { reservation: this.state.reapReservation };
        break;
      case "promote":
        this.manifest.placement = r.placement;
        this.manifest.presentation = "background";
        this.store.writeManifest(this.manifest);
        break;
    }
    const response = this.response(r, { ok: true, receipt: r.operation === "prompt" ? "accepted" : "applied", sequence: this.state.sequence, ...(data === undefined ? {} : { data }) });
    this.state.receipts[receiptKey].response = response;
    this.persist();
    if (r.operation === "prepare_reap") {
      // Give the socket receipt a chance to flush. The seal is already durable.
      // Launcher MUST wait for actual pane death before removing it.
      setTimeout(() => this.adapter.shutdown(), 25);
    }
    return response;
  }
  /** Distinct capability, namespace and handler: never accepts model control token. */
  private async operator(value: unknown): Promise<TuiWorkerResponse> {
    const r = value as Record<string, unknown>;
    const response = (extra: Record<string, unknown>) => ({ protocol: 1, requestId: r.requestId,
      workerEpoch: r.workerEpoch, ...extra }) as TuiWorkerResponse;
    if (!r || Object.keys(r).sort().join(",") !== ["operatorProtocol", "requestId", "workerEpoch", "ownerSessionId", "runtimeId", "operatorCapability", "enabled"].sort().join(",")
      || r.operatorProtocol !== 1 || typeof r.requestId !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(r.requestId)
      || typeof r.operatorCapability !== "string" || !/^[a-f0-9]{64}$/.test(r.operatorCapability) || typeof r.enabled !== "boolean") {
      return response({ ok: false, code: "invalid", message: "Invalid operator request" });
    }
    const expected = this.manifest.operatorCapabilityHash;
    const hash = createHash("sha256").update(r.operatorCapability).digest("hex");
    if (!expected || !timingSafeEqual(Buffer.from(expected), Buffer.from(hash))
      || r.ownerSessionId !== this.manifest.ownerSessionId || r.runtimeId !== this.manifest.runtimeId || r.workerEpoch !== this.manifest.workerEpoch) {
      return response({ ok: false, code: "unauthorized", message: "Operator authentication failed" });
    }
    if (this.sealed || !this.adapter.applyOperatorMode) return response({ ok: false, code: "unavailable", message: "Operator service unavailable" });
    const id = `operator:${r.requestId}`;
    const digest = createHash("sha256").update(JSON.stringify({ enabled: r.enabled, epoch: r.workerEpoch })).digest("hex");
    const prior = Object.hasOwn(this.state.receipts, id) ? this.state.receipts[id] : undefined;
    if (prior) {
      if (prior.digest !== digest) return response({ ok: false, code: "invalid", message: "Operator request ID reused" });
      return prior.response ?? response({ ok: false, code: "ambiguous", message: "Prior operator dispatch uncertain" });
    }
    if (Object.keys(this.state.receipts).length >= 4096) return response({ ok: false, code: "unavailable", message: "Receipt capacity exhausted" });
    this.state.receipts[id] = { digest };
    this.persist();
    // Ignore service return values: a service must throw on failure and must not
    // leak its capabilities into an otherwise public receipt.
    await this.adapter.applyOperatorMode(r.enabled);
    const result = response({ ok: true, receipt: "applied", sequence: this.state.sequence });
    this.state.receipts[id].response = result;
    this.persist();
    return result;
  }
  async start(): Promise<void> {
    if (this.server) throw new Error("Worker server already started");
    // Exclusive lock: do not guess stale socket ownership. Worker-crash recovery
    // is explicit; parent crash never affects this lock or the child process.
    const fd = openSync(this.store.path("worker.lock"), "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, epoch: this.manifest.workerEpoch })); }
    finally { closeSync(fd); }
    this.lockHeld = true;
    this.server = net.createServer(socket => {
      if (this.sockets.size >= 32 || this.closing) { socket.destroy(); return; }
      this.sockets.add(socket);
      socket.setTimeout(35_000, () => socket.destroy());
      socket.on("error", () => undefined);
      socket.on("close", () => this.sockets.delete(socket));
      let bytes = Buffer.alloc(0), received = false;
      socket.on("data", chunk => {
        if (received) { socket.destroy(); return; }
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length > TUI_WORKER_MAX_FRAME_BYTES) { socket.destroy(); return; }
        const newline = bytes.indexOf(10);
        if (newline < 0) return;
        received = true;
        if (newline !== bytes.length - 1) { socket.destroy(); return; }
        let request: TuiWorkerRequest;
        try {
          const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, newline)));
          if (raw?.operatorProtocol !== undefined) {
            const work = this.queue.catch(() => undefined).then(() => this.operator(raw));
            this.queue = work;
            void work.then(response => { if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`); }, () => socket.destroy());
            return;
          }
          request = decodeTuiWorkerRequest(bytes.subarray(0, newline));
        }
        catch { socket.end(`${JSON.stringify({ protocol: 1, ok: false, code: "invalid", message: "Invalid worker frame" })}\n`); return; }
        void this.handle(request).then(response => {
          if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
        }, () => {
          if (!socket.destroyed) socket.end(`${JSON.stringify(this.response(request, { ok: false, code: "ambiguous", message: "Worker dispatch failed; inspect retained state before retrying" }))}\n`);
        });
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(this.manifest.controlSocket, () => { this.server!.removeListener("error", reject); resolve(); });
      });
      chmodSync(this.manifest.controlSocket, 0o600);
      this.socketInode = lstatSync(this.manifest.controlSocket).ino;
      this.server.on("error", () => { this.failed = true; void this.adapter.abort(); });
      this.state.active = !this.adapter.isIdle();
      this.state.phase = this.state.active ? "running" : this.state.lastReport ? "settled" : "ready";
      this.event("ready", { pid: process.pid, sealed: this.state.sealed });
      if (this.state.sealed) setTimeout(() => this.adapter.shutdown(), 25);
    } catch (error) { await this.close(); throw error; }
  }
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    // Drain in-flight dispatch before releasing the exclusive writer lock. A
    // replacement extension must never race writes from its old instance.
    await this.queue.catch(() => undefined);
    if (!this.failed && this.lockHeld) {
      this.state.phase = "closing";
      try { this.event("closing"); } catch { /* Cleanup still releases the socket on storage failure. */ }
    }
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>(resolve => { if (this.server?.listening) this.server.close(() => resolve()); else resolve(); });
    try { if (this.socketInode !== undefined && lstatSync(this.manifest.controlSocket).ino === this.socketInode) unlinkSync(this.manifest.controlSocket); } catch {}
    if (this.lockHeld) { try { unlinkSync(this.store.path("worker.lock")); } catch {} this.lockHeld = false; }
  }
}
