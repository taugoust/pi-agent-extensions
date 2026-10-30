import { randomBytes, createHash } from "node:crypto";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicPrivateJson, privateDirectory, readPrivateJson } from "./tui-worker-store.ts";
import { validInteractionInput, validInteractionAnswer } from "../shared/task-interactions.ts";
import type { TaskInteractionInput, TaskInteractionAnswer } from "../shared/foreground-tasks.ts";

export const GUIDANCE_ENV = "PI_SUBAGENT_GUIDANCE_V1";
export const GUIDANCE_HUMAN_KEY = "__paeGuidanceHumanV1";
export type GuidanceScope = { ownerSessionId: string; ownerRuntimeEpoch: string; taskId: string; childId: string; attempt: number; workerEpoch: string; goalId?: string };
export type GuidanceInput = { kind: "guidance"; prompt: string; context?: string } | { kind: "human"; questionnaire: TaskInteractionInput };
export type GuidanceRecord = GuidanceScope & { version: 1; requestId: string; workerRuntimeEpoch: string; revision: number; createdAt: string; input: GuidanceInput;
  status: "pending" | "answered" | "cancelled" | "unavailable"; reason?: string; forwarded?: { requestId: string; scope?: GuidanceScope }; receipt?: { replyId: string; fingerprint: string; answer: GuidanceAnswer; at: string } };
export type GuidanceAnswer = { kind: "guidance"; guidance: string } | { kind: "human"; answer: TaskInteractionAnswer };
export type GuidanceTarget = GuidanceScope & { requestId: string; workerRuntimeEpoch: string; expectedRevision: number };
export type GuidanceBinding = { socket: string; token: string; scope: GuidanceScope };
export type GuidanceUpstream = ((input: GuidanceInput, signal?: AbortSignal, requestId?: string) => Promise<GuidanceAnswer>) & { scope?: GuidanceScope };
const scopeKeys = ["ownerSessionId", "ownerRuntimeEpoch", "taskId", "childId", "attempt", "workerEpoch", "goalId"] as const;
const nonce = () => randomBytes(16).toString("hex");
const canonical = (value: any): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const fingerprint = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const exact = (value: any, required: string[], optional: string[] = []) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error("Unexpected guidance fields (permission payloads are forbidden)");
};
const text = (value: unknown, maximum: number) => { if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value) > maximum) throw new Error("Invalid bounded guidance text"); };
export function validateGuidanceInput(input: GuidanceInput): void {
  if (input?.kind === "guidance") { exact(input, ["kind", "prompt"], ["context"]); text(input.prompt, 4096); if (input.context !== undefined) text(input.context, 8192); }
  else if (input?.kind === "human") {
    exact(input, ["kind", "questionnaire"]);
    exact(input.questionnaire, ["kind", "questions"]);
    if (input.questionnaire?.kind !== "questionnaire" || !validInteractionInput(input.questionnaire)) throw new Error("Only human questionnaires may escalate; permission consent uses its existing authenticated channel");
  } else throw new Error("Invalid guidance kind; permission consent is not guidance");
}
export function guidanceTarget(record: GuidanceRecord): GuidanceTarget {
  return { ...Object.fromEntries(scopeKeys.filter(key => record[key] !== undefined).map(key => [key, record[key]])), requestId: record.requestId, workerRuntimeEpoch: record.workerRuntimeEpoch, expectedRevision: record.revision } as GuidanceTarget;
}
const owners = new Map<string, GuidanceBroker>();
export function pendingGuidance(owner: string, childIds: string[]): boolean {
  return owners.get(owner)?.list().some(record => record.status === "pending" && childIds.includes(record.childId)) === true;
}
/** Called only at trusted native launch seams, never from model-supplied environment. */
export function guidanceLaunchEnvironment(scope: Omit<GuidanceScope, "ownerRuntimeEpoch">): Record<string, string> {
  const owner = owners.get(scope.ownerSessionId);
  // New workers must not inherit an ancestor capability or silently fall back
  // to direct child-to-human prompts when the owning runtime is unavailable.
  return { [GUIDANCE_ENV]: owner ? JSON.stringify(owner.bind(scope)) : JSON.stringify({ unavailable: true }) };
}

/** Owner-hosted lane. A connection is the actual worker waiter, not a prompt queue.
 * Journal writes are synchronous/atomic and always precede notification or resolution.
 * Disconnected/restarted promises are never reconstructed or answered by replay.
 */
export class GuidanceBroker {
  readonly epoch = nonce();
  readonly records: GuidanceRecord[];
  private file: string;
  private server?: Server;
  private socketDirectory?: string;
  private bindings = new Map<string, { scope: GuidanceScope; runtime?: string }>();
  private waiters = new Map<string, { socket: Socket; abort: AbortController }>();
  private sockets = new Set<Socket>();
  private closed = false;
  private lockFile: string;
  private inFlight = new Set<string>();
  constructor(readonly ownerSessionId: string, root: string, private notify: (record: GuidanceRecord) => void = () => {}, private upstream?: GuidanceUpstream) {
    const directory = privateDirectory(join(privateDirectory(root, true), fingerprint(ownerSessionId)), true);
    this.file = join(directory, "guidance.json");
    this.lockFile = join(directory, "owner.lock");
    const processToken = (pid: number) => { try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]; } catch { return undefined; } };
    if (!processToken(process.pid)) throw new Error("Native guidance requires verified process identity");
    for (let retry = 0; ; retry++) {
      try { writeFileSync(this.lockFile, JSON.stringify({ pid: process.pid, token: processToken(process.pid) }), { flag: "wx", mode: 0o600 }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || retry) throw error;
        const prior = readPrivateJson(this.lockFile) as any;
        if (!Number.isSafeInteger(prior.pid) || !prior.token || processToken(prior.pid) === prior.token) throw new Error("Another live runtime owns coordinator guidance");
        unlinkSync(this.lockFile);
      }
    }
    try {
      const saved = existsSync(this.file) ? readPrivateJson(this.file) as any : { version: 1, records: [] };
      if (saved.version !== 1 || !Array.isArray(saved.records) || saved.records.length > 1024 || saved.records.some((record: any) => record.ownerSessionId !== ownerSessionId)) throw new Error("Invalid retained guidance journal");
      this.records = saved.records;
      for (const record of this.records) if (record.status === "pending") { record.status = "unavailable"; record.reason = "Owner runtime replaced; old waiter cannot be recovered"; record.revision++; }
      this.persist();
    } catch (error) { unlinkSync(this.lockFile); throw error; }
  }
  private persist() { atomicPrivateJson(this.file, { version: 1, records: this.records }); }
  async start(): Promise<void> {
    if (owners.has(this.ownerSessionId)) throw new Error("Guidance owner already active");
    this.socketDirectory = mkdtempSync(join(tmpdir(), "pi-guidance-")); chmodSync(this.socketDirectory, 0o700);
    this.server = createServer(socket => {
      if (this.closed || this.sockets.size >= 128) { socket.destroy(); return; }
      this.sockets.add(socket); socket.on("error", () => {});
      let data = Buffer.alloc(0), received = false;
      const timer = setTimeout(() => socket.destroy(), 5000); timer.unref();
      socket.on("data", chunk => {
        data = Buffer.concat([data, chunk]);
        if (data.length > 48 * 1024) { socket.destroy(); return; }
        for (let end; (end = data.indexOf(10)) >= 0;) {
          try {
            const frame = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, end)));
            data = data.subarray(end + 1);
            if (!received) { received = true; clearTimeout(timer); this.receive(frame, socket); }
            else {
              exact(frame, ["cancel"]);
              const waiter = this.waiters.get(frame.cancel);
              if (!waiter || waiter.socket !== socket) throw new Error("Foreign cancellation");
              this.cancel(frame.cancel, "Worker explicitly cancelled guidance", "cancelled");
            }
          } catch (error) { socket.end(JSON.stringify({ error: String(error) }) + "\n"); return; }
        }
      });
      socket.on("close", () => {
        clearTimeout(timer); this.sockets.delete(socket);
        for (const [id, waiter] of this.waiters) if (waiter.socket === socket) {
          try { this.cancel(id, "Worker disconnected or cancelled", "unavailable"); } catch { /* Durable write failure must not crash the event loop. */ }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(join(this.socketDirectory!, "owner.sock"), () => { this.server!.removeListener("error", reject); resolve(); });
    });
    this.server.on("error", () => { void this.close().catch(() => undefined); });
    chmodSync(join(this.socketDirectory, "owner.sock"), 0o600); owners.set(this.ownerSessionId, this);
  }
  bind(input: Omit<GuidanceScope, "ownerRuntimeEpoch">): GuidanceBinding {
    if (!this.server?.listening || this.closed || input.ownerSessionId !== this.ownerSessionId) throw new Error("Guidance owner unavailable");
    for (const key of ["taskId", "childId", "workerEpoch"] as const) text(input[key], 256);
    if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) throw new Error("Invalid guidance attempt");
    for (const [token, binding] of this.bindings) if (binding.scope.taskId === input.taskId) {
      this.bindings.delete(token);
      for (const record of this.records) if (record.status === "pending" && record.taskId === input.taskId) this.cancel(record.requestId, "Worker attempt replaced", "cancelled");
    }
    const scope = { ...input, ownerRuntimeEpoch: this.epoch }, token = randomBytes(32).toString("hex");
    this.bindings.set(token, { scope });
    return { socket: join(this.socketDirectory!, "owner.sock"), token, scope };
  }
  private receive(frame: any, socket: Socket) {
    exact(frame, ["version", "token", "scope", "requestId", "workerRuntimeEpoch", "input"]);
    const binding = this.bindings.get(frame.token);
    if (this.closed || frame.version !== 1 || !binding || canonical(binding.scope) !== canonical(frame.scope)) throw new Error("Stale or foreign guidance owner/worker scope");
    text(frame.requestId, 128); text(frame.workerRuntimeEpoch, 128); validateGuidanceInput(frame.input);
    if (binding.runtime && binding.runtime !== frame.workerRuntimeEpoch) throw new Error("Worker runtime replaced; new launch binding required");
    if (this.records.some(record => record.requestId === frame.requestId)) throw new Error("Request already recorded; waiter replay forbidden");
    if (this.records.length >= 1024 || this.waiters.size >= 64) throw new Error("Guidance journal capacity exhausted");
    binding.runtime = frame.workerRuntimeEpoch;
    const record: GuidanceRecord = { ...binding.scope, version: 1, requestId: frame.requestId, workerRuntimeEpoch: frame.workerRuntimeEpoch, revision: 1, createdAt: new Date().toISOString(), input: structuredClone(frame.input), status: "pending" };
    this.records.push(record);
    try { this.persist(); } catch (error) { record.status = "unavailable"; record.reason = "Request persistence failed"; throw error; }
    const abort = new AbortController(); this.waiters.set(record.requestId, { socket, abort });
    // Human-only requests go up automatically; no intermediary model can answer.
    if (record.input.kind === "human" && this.upstream) {
      void this.forward(guidanceTarget(record), abort.signal).catch(error => { try { this.cancel(record.requestId, `Upstream unavailable: ${String(error)}`, "unavailable"); } catch { /* no answer was manufactured */ } });
    } else { try { this.notify(structuredClone(record)); } catch { /* durable pending request remains discoverable */ } }
  }
  list(): GuidanceRecord[] { return structuredClone(this.records); }
  private locate(target: GuidanceTarget): GuidanceRecord {
    exact(target, [...scopeKeys.filter(key => key !== "goalId"), "requestId", "workerRuntimeEpoch", "expectedRevision"], ["goalId"]);
    const record = this.records.find(item => item.requestId === target.requestId);
    if (!record || target.ownerSessionId !== this.ownerSessionId || target.ownerRuntimeEpoch !== this.epoch || !scopeKeys.every(key => record[key] === target[key]) || record.workerRuntimeEpoch !== target.workerRuntimeEpoch) throw new Error("Stale or foreign guidance identity");
    return record;
  }
  /** Model lane: it cannot submit a human answer, a permission answer, or extras. */
  reply(target: GuidanceTarget, replyId: string, answer: { kind: "guidance"; guidance: string }): GuidanceRecord {
    exact(answer, ["kind", "guidance"]); if (answer.kind !== "guidance") throw new Error("Model replies cannot supply human or permission consent"); text(answer.guidance, 8192);
    const record = this.locate(target); if (record.input.kind !== "guidance") throw new Error("Human decision requires top-level questionnaire");
    return this.settle(target, replyId, answer);
  }
  private settle(target: GuidanceTarget, replyId: string, answer: GuidanceAnswer): GuidanceRecord {
    text(replyId, 128); const record = this.locate(target), digest = fingerprint({ target, answer });
    if (record.receipt) {
      if (record.status !== "answered" && !(record.status === "cancelled" && record.receipt.answer.kind === "human" && record.receipt.answer.answer.cancelled)) throw new Error("Guidance receipt unavailable; inspect retained state, never replay");
      if (record.receipt.replyId === replyId && record.receipt.fingerprint === digest) return structuredClone(record);
      throw new Error("Conflicting or duplicate guidance answer");
    }
    if (record.revision !== target.expectedRevision || record.status !== "pending" || !this.waiters.has(record.requestId)) throw new Error("Stale revision or unavailable guidance waiter");
    record.status = answer.kind === "human" && answer.answer.cancelled ? "cancelled" : "answered"; record.revision++; record.receipt = { replyId, fingerprint: digest, answer: structuredClone(answer), at: new Date().toISOString() };
    try { this.persist(); } catch (error) {
      // A rename may have committed even if fsync failed. Do not roll back and
      // accept a different answer, or claim the lost waiter consumed a receipt.
      record.status = "unavailable"; record.reason = "Receipt durability uncertain; no automatic replay";
      const waiter = this.waiters.get(record.requestId); this.waiters.delete(record.requestId);
      waiter?.abort.abort(); waiter?.socket.destroy(); throw error;
    }
    const waiter = this.waiters.get(record.requestId)!; this.waiters.delete(record.requestId);
    waiter.socket.end(JSON.stringify({ answer }) + "\n"); waiter.abort.abort();
    return structuredClone(record);
  }
  async forward(target: GuidanceTarget, signal?: AbortSignal): Promise<GuidanceRecord> {
    const record = this.locate(target);
    if (!this.upstream || record.status !== "pending" || record.revision !== target.expectedRevision) throw new Error("No owning ancestor available; top-level human decisions use questionnaire");
    if (this.inFlight.has(record.requestId)) throw new Error("Guidance escalation already in flight");
    this.inFlight.add(record.requestId);
    try {
    // Retain the exact upstream request link before its own durable notification.
    // Each explicit new escalation has a new identity; transport never retries.
    record.forwarded = { requestId: `guidance:${nonce()}`, ...(this.upstream.scope ? { scope: structuredClone(this.upstream.scope) } : {}) };
    this.persist();
    const waiterSignal = this.waiters.get(record.requestId)!.abort.signal;
    const answer = await this.upstream(structuredClone(record.input), signal ? AbortSignal.any([signal, waiterSignal]) : waiterSignal, record.forwarded.requestId);
    if (record.input.kind === "human") {
      if (answer.kind !== "human" || !validInteractionAnswer(record.input.questionnaire, answer.answer)) throw new Error("Invalid authenticated human response");
      return this.settle(target, `forward:${record.requestId}`, answer);
    }
    if (answer.kind !== "guidance") throw new Error("Invalid upstream guidance response");
    return this.reply(target, `forward:${record.requestId}`, answer);
    } finally { this.inFlight.delete(record.requestId); }
  }
  /** Only the top-level host adapter supplies this callback, never model arguments. */
  async askHuman(target: GuidanceTarget, ask: (input: TaskInteractionInput, signal: AbortSignal) => Promise<TaskInteractionAnswer>): Promise<GuidanceRecord> {
    const record = this.locate(target), waiter = this.waiters.get(record.requestId);
    if (this.upstream || record.input.kind !== "human" || record.status !== "pending" || record.revision !== target.expectedRevision || !waiter) throw new Error("Human questionnaire must run at the exact top-level pending waiter");
    if (this.inFlight.has(record.requestId)) throw new Error("Human questionnaire already in flight");
    this.inFlight.add(record.requestId);
    try {
      const answer = await ask(structuredClone(record.input.questionnaire), waiter.abort.signal);
      if (!validInteractionAnswer(record.input.questionnaire, answer)) throw new Error("Invalid human questionnaire result");
      return this.settle(target, `human:${record.requestId}`, { kind: "human", answer });
    } finally { this.inFlight.delete(record.requestId); }
  }
  cancel(requestId: string, reason: string, status: "cancelled" | "unavailable" = "cancelled") {
    const record = this.records.find(item => item.requestId === requestId); if (!record || record.status !== "pending") return;
    record.status = status; record.reason = reason; record.revision++;
    const waiter = this.waiters.get(requestId); this.waiters.delete(requestId);
    try { this.persist(); } finally { waiter?.abort.abort(); waiter?.socket.end(JSON.stringify({ error: reason }) + "\n"); }
  }
  async close() {
    if (this.closed) return; this.closed = true;
    if (owners.get(this.ownerSessionId) === this) owners.delete(this.ownerSessionId);
    let failure: unknown;
    for (const id of [...this.waiters.keys()]) { try { this.cancel(id, "Owner runtime closed", "unavailable"); } catch (error) { failure = error; } }
    for (const socket of this.sockets) socket.destroy();
    if (this.server?.listening) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    if (this.socketDirectory) rmSync(this.socketDirectory, { recursive: true, force: true });
    unlinkSync(this.lockFile);
    if (failure) throw failure;
  }
}

/** No automatic retry: a failed transport cannot reconstruct a promise or replay an answer. */
export function requestGuidance(binding: GuidanceBinding, workerRuntimeEpoch: string, input: GuidanceInput, signal?: AbortSignal, requestId = `guidance:${nonce()}`): Promise<GuidanceAnswer> {
  validateGuidanceInput(input);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Guidance request cancelled")); return; }
    const socket = createConnection(binding.socket); let data = Buffer.alloc(0), settled = false;
    const finish = (error?: Error, answer?: GuidanceAnswer, graceful = false) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); if (!graceful) socket.destroy(); error ? reject(error) : resolve(answer!); };
    const abort = () => {
      const graceful = !socket.connecting && socket.writable;
      if (graceful) { socket.end(JSON.stringify({ cancel: requestId }) + "\n"); const cleanup = setTimeout(() => socket.destroy(), 1000); cleanup.unref(); socket.once("close", () => clearTimeout(cleanup)); }
      finish(new Error("Guidance request cancelled"), undefined, graceful);
    };
    const timer = setTimeout(() => finish(new Error("Guidance owner connection unavailable")), 5000); timer.unref();
    signal?.addEventListener("abort", abort, { once: true });
    socket.on("connect", () => { clearTimeout(timer); socket.write(JSON.stringify({ version: 1, token: binding.token, scope: binding.scope, requestId, workerRuntimeEpoch, input }) + "\n"); });
    socket.on("error", error => finish(error)); socket.on("close", () => finish(new Error("Guidance owner unavailable; no answer replay")));
    socket.on("data", chunk => {
      data = Buffer.concat([data, chunk]); if (data.length > 48 * 1024) { finish(new Error("Oversized guidance response")); return; }
      if (!data.includes(10)) return;
      try {
        const result = JSON.parse(data.toString("utf8")); if (result.error) throw new Error(String(result.error));
        const answer = result.answer;
        if (input.kind === "guidance") { exact(answer, ["kind", "guidance"]); if (answer.kind !== "guidance") throw new Error("Invalid guidance answer"); text(answer.guidance, 8192); }
        else if (answer?.kind !== "human" || !validInteractionAnswer(input.questionnaire, answer.answer)) throw new Error("Invalid human answer");
        finish(undefined, answer);
      } catch (error) { finish(error as Error); }
    });
  });
}
