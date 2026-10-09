import { randomBytes, createHash } from "node:crypto";
import { waitForGroupSnapshot } from "./group-wait.ts";
import { readdirSync, existsSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync, readSync, constants } from "node:fs";
import { join, resolve, basename } from "node:path";
import { validateAcceptance } from "./outcome.ts";
import { subagentTmuxName, validateSubagentName } from "./tui-names.ts";
import { TuiWorkerTmux, tuiWorkerLaunchContract, processIdentity } from "./tui-worker-tmux.ts";
import { TuiWorkerStore, privateDirectory, atomicPrivateJson, readPrivateJson } from "./tui-worker-store.ts";
import { callTuiWorker, applyTuiWorkerOperatorMode } from "./tui-worker-client.ts";
import { publicTuiWorkerManifest, parseTuiWorkerJobParams } from "../shared/tui-worker-protocol.ts";
import { truncateUtf8 } from "../shared/harness-readonly.ts";
import type { QuietUpdate } from "../shared/quiet-state.ts";
import type { TuiWorkerManifest, TuiWorkerPlacement } from "../shared/tui-worker-protocol.ts";

const id = (prefix: string) => `${prefix}-${randomBytes(12).toString("hex")}`;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Spec = { name?: string; task: string; cwd: string; model?: string; tools?: string[]; systemPrompt?: string; acceptance?: string[] };
type Child = { childId: string; taskId: string; attempt: number; directory: string; spec: Spec;
  resumeSessionFile?: string; resumeMessage?: string; compactBeforePrompt?: boolean;
  state: "pending" | "launching" | "running" | "completed" | "failed" | "cancelled" | "lost" | "skipped";
  operatorCapability: string; started: boolean; reaped?: boolean; error?: string; report?: string;
  notifiedSequence: number; runSequence?: number; terminalNotification?: string; lastOutcome?: unknown; requiresCompaction?: boolean; };
type Group = { windowName?: string; version: 1; id: string; owner: string; createdAt: string; mode: "single" | "parallel" | "chain";
  background: boolean; cancelled: boolean; children: Child[]; caller: TuiWorkerPlacement;
  parentOwnerToken: string;
  operatorEnabled: boolean; launcher: string; launchMode: "none" | "guard-only"; promotionPending?: boolean; };
type Disposition = "native" | "guard-only" | "full" | "unavailable";
const active = (child: Child) => ["pending", "launching", "running"].includes(child.state);
const terminalToken = (child: Child) => child.report ?? `terminal:${child.attempt ?? 1}:${child.runSequence ?? 0}`;
const messageText = (message: any) => typeof message?.content === "string" ? message.content : (message?.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
const response = (text: string, data: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: Buffer.from(text).subarray(0, 48 * 1024).toString("utf8") }], details: { tui_subagent: true, backend: "native", ...data } });

/** Native-only durable adapter. Legacy AgentSH execution never enters here. */
export class TuiNativeManager {
  readonly root: string;
  readonly tmux = new TuiWorkerTmux();
  private groups = new Map<string, Group>();
  private inventoryErrors: string[] = [];
  private savedGroups = new Map<string, string>();
  private persistenceWriter = atomicPrivateJson;
  private queue: Promise<unknown> = Promise.resolve();
  private refreshFlight?: Promise<void>;
  private modeQueue: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private reapReserved = false;
  private owner?: string;
  private notify?: (update: QuietUpdate) => boolean;
  private foregroundWaits = new Set<string>();
  private generation = 0;
  private ownerLock?: string;
  private resuming = new Set<string>();
  private processToken(pid: number): string | undefined {
    try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return `${pid}:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`; }
    catch { return undefined; }
  }
  private groupLimit: number;
  constructor(root: string, privateDisposition: () => Disposition, ready: () => boolean, groupLimit: number) {
    if (!Number.isSafeInteger(groupLimit) || groupLimit < 1) throw new Error("Invalid shared subagent group limit");
    this.groupLimit = groupLimit;
    this.root = privateDirectory(root, true);
    privateDirectory(join(this.root, "groups"), true);
    privateDirectory(join(this.root, "workers"), true);
    this.disposition = privateDisposition;
    this.ready = ready;
    for (const name of readdirSync(join(this.root, "groups"))) {
      if (!/^subagent-job-[a-f0-9]{24}\.json$/.test(name)) continue;
      try {
        const g = readPrivateJson(join(this.root, "groups", name)) as Group;
        const persistedGroup = JSON.stringify(g);
        if (g.version !== 1 || `${g.id}.json` !== name || typeof g.owner !== "string" || !Array.isArray(g.children) || g.children.length > 8) throw new Error("Invalid retained group");
        if (g.children.some(c => !/^subagent-child-[a-f0-9]{24}$/.test(c.childId) || !/^subagent-task-[a-f0-9]{24}$/.test(c.taskId)
          || !/^[a-f0-9]{64}$/.test(c.operatorCapability) || typeof c.directory !== "string"
          || !/^[a-f0-9]{24}$/.test(basename(c.directory)) || c.directory !== join(this.root, "workers", basename(c.directory)))) throw new Error("Invalid retained child");
        // Old already-terminal records were previously observed without wakes.
        // Baseline them instead of replaying historical completions on upgrade.
        for (const c of g.children) if (c.terminalNotification === undefined) c.terminalNotification = active(c) ? '' : terminalToken(c);
        this.groups.set(g.id, g);
        // Seed the persistence baseline from disk so constructor normalization is
        // durable only when it actually changed the record.
        this.savedGroups.set(g.id, persistedGroup);
      } catch { this.inventoryErrors.push(name); /* Invalid records never authorize launch/control/deletion. */ }
    }
  }
  private disposition: () => Disposition;
  private ready: () => boolean;
  private save(g: Group) {
    const file = join(this.root, "groups", `${g.id}.json`);
    const text = JSON.stringify(g);
    if (this.savedGroups.get(g.id) === text) return;
    this.persistenceWriter(file, g);
    this.savedGroups.set(g.id, text);
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(run); this.queue = next; return next;
  }
  activate(owner: string, notify?: (update: QuietUpdate) => boolean): void {
    const lock = join(this.root, `owner-${createHash("sha256").update(owner).digest("hex").slice(0, 32)}.lock`);
    for (let retry = 0; ; retry++) {
      try { writeFileSync(lock, JSON.stringify({ pid: process.pid, token: this.processToken(process.pid) }), { flag: "wx", mode: 0o600 }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || retry >= 2) throw error;
        const prior = readPrivateJson(lock) as any;
        if (!Number.isSafeInteger(prior.pid) || typeof prior.token !== "string" || this.processToken(prior.pid) === prior.token) {
          this.closed = true; throw new Error("Another live parent owns this session's TUI scheduler; refusing concurrent writers");
        }
        unlinkSync(lock);
      }
    }
    this.ownerLock = lock;
    this.owner = owner; this.notify = notify;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => { void this.refresh(owner).catch(() => undefined); }, 1000);
    this.timer.unref?.();
    void this.refresh(owner).catch(() => undefined);
  }
  private liveOperatorMode(owner: string): boolean {
    const service = (globalThis as any).__PAE_PERMISSION_GATE_OPERATOR_V1__;
    if (service?.version !== 1 || typeof service.status !== "function") throw new Error("Live parent operator authority unavailable");
    const status = service.status(owner);
    if (status?.sessionId !== owner || typeof status.enabled !== "boolean") throw new Error("Invalid live parent operator mode");
    return status.enabled;
  }
  private sendMode(g: Group, c: Child, m: TuiWorkerManifest, requestId?: string): Promise<void> {
    const next = this.modeQueue.catch(() => undefined).then(async () => {
      // Disk state is observational only: especially after restart it cannot
      // authorize prompts-off for a new/pending child or a resumed attempt.
      const enabled = this.liveOperatorMode(g.owner);
      g.operatorEnabled = enabled; this.save(g);
      const applied = await applyTuiWorkerOperatorMode(m, c.operatorCapability, enabled, requestId);
      if (!applied.ok) throw new Error(`Child operator mode rejected: ${applied.code}`);
    });
    this.modeQueue = next;
    return next;
  }
  async shutdown(cancelForeground: boolean): Promise<void> {
    this.closed = true; this.generation++;
    if (this.timer) clearInterval(this.timer);
    await this.queue.catch(() => undefined);
    await this.modeQueue.catch(() => undefined);
    if (cancelForeground && this.owner) {
      for (const g of this.groups.values()) if (g.owner === this.owner && !g.background) await this.cancelGroup(g);
    }
    if (this.ownerLock) {
      try { const lock = readPrivateJson(this.ownerLock) as any; if (lock.pid === process.pid && lock.token === this.processToken(process.pid)) unlinkSync(this.ownerLock); } catch {}
      this.ownerLock = undefined;
    }
  }
  private manifest(c: Child): TuiWorkerManifest | undefined {
    try {
      const m = new TuiWorkerStore(c.directory).readManifest();
      if (m.childId !== c.childId || m.taskId !== c.taskId) throw new Error("Worker identity mismatch");
      return m;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  }
  private owned(owner: string, job: string): Group | undefined {
    const g = this.groups.get(job); if (g && g.owner !== owner) throw new Error("Subagent belongs to a different Pi session"); return g;
  }
  private byChild(owner: string, childId: string): { group: Group; child: Child } | undefined {
    for (const g of [...this.groups.values()].reverse()) {
      const child = g.children.find(c => c.childId === childId || c.taskId === childId);
      if (child) { if (g.owner !== owner) throw new Error("Subagent belongs to a different Pi session"); return { group: g, child }; }
    }
  }
  /** Derive reachability only from validated worker identity and its exact retained
   * session header. Pane names, cwd and model-supplied owner IDs confer no authority. */
  private descendantGroups(owner: string, roots?: Group[]): Group[] {
    const disk = new TuiNativeManager(this.root, this.disposition, () => false, this.groupLimit);
    const result: Group[] = [];
    const seen = new Set<string>([owner]);
    const visit = (groups: Group[], depth: number) => {
      if (depth > 32) throw new Error("Subagent ancestry depth exceeds cleanup safety limit");
      for (const g of groups) for (const c of g.children) {
        const m = this.manifest(c);
        if (!m) continue;
        if (m.ownerSessionId !== g.owner || m.groupId !== g.id || m.attempt !== (c.attempt ?? 1)
          || m.sessionFile !== join(c.directory, "session.jsonl")) throw new Error("Subagent ancestry identity mismatch");
        let sessionId: string;
        let fd: number;
        try { fd = openSync(m.sessionFile, constants.O_RDONLY | constants.O_NOFOLLOW); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        try {
          const bytes = Buffer.alloc(8192); const n = readSync(fd, bytes, 0, bytes.length, 0);
          const header = JSON.parse(bytes.subarray(0, n).toString("utf8").split("\n")[0]);
          if (header.type !== "session" || typeof header.id !== "string" || !header.id || header.id.length > 512) throw new Error("Invalid descendant session header");
          sessionId = header.id;
        } finally { closeSync(fd); }
        if (seen.has(sessionId)) continue;
        seen.add(sessionId);
        const nested = [...disk.groups.values()].filter(candidate => candidate.owner === sessionId);
        result.push(...nested); visit(nested, depth + 1);
      }
    };
    visit(roots ?? [...this.groups.values()].filter(g => g.owner === owner), 0);
    return result;
  }
  /** Never overwrite a live parent's scheduler state. A stopped parent's groups
   * can be reconciled under the same PID/start-token lock, without activating a scheduler. */
  private observerLease(owner: string): (() => void) | undefined {
    const lock = join(this.root, `owner-${createHash("sha256").update(owner).digest("hex").slice(0, 32)}.lock`);
    for (let retry = 0; retry < 2; retry++) {
      try {
        writeFileSync(lock, JSON.stringify({ pid: process.pid, token: this.processToken(process.pid) }), { flag: "wx", mode: 0o600 });
        return () => {
          const current = readPrivateJson(lock) as any;
          if (current.pid !== process.pid || current.token !== this.processToken(process.pid)) throw new Error("Descendant observer lease changed");
          unlinkSync(lock);
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const prior = readPrivateJson(lock) as any;
        if (!Number.isSafeInteger(prior.pid) || typeof prior.token !== "string" || this.processToken(prior.pid) === prior.token) return;
        unlinkSync(lock);
      }
    }
    return;
  }
  private async observeDescendants(owner: string): Promise<Group[]> {
    const groups = this.descendantGroups(owner);
    for (const session of new Set(groups.map(g => g.owner))) {
      const release = this.observerLease(session);
      try {
        const fresh = release ? new TuiNativeManager(this.root, this.disposition, () => false, this.groupLimit) : undefined;
        for (let index = 0; index < groups.length; index++) {
          if (groups[index].owner !== session) continue;
          // Re-read after acquiring the lock: the prior owner may have
          // committed a final snapshot between ancestry discovery and leasing.
          const g = fresh ? fresh.groups.get(groups[index].id) : groups[index];
          if (!g || g.owner !== session) throw new Error("Descendant ownership changed during reconciliation");
          if (release) this.savedGroups.set(g.id, JSON.stringify(g));
          groups[index] = g;
          for (const c of g.children) await this.observe(g, c, true);
          if (release) this.save(g);
        }
      } finally { release?.(); }
    }
    return groups;
  }
  private async reapStoppedDescendants(groups: Group[]): Promise<void> {
    for (let nested of [...groups].reverse()) {
      const release = this.observerLease(nested.owner);
      if (!release) continue; // Live parents recurse through their own cleanup boundary.
      try {
        const fresh = new TuiNativeManager(this.root, this.disposition, () => false, this.groupLimit).groups.get(nested.id);
        if (!fresh || fresh.owner !== nested.owner) throw new Error("Descendant ownership changed before reap");
        nested = fresh;
        for (const c of nested.children) {
          await this.observe(nested, c, true);
          if (active(c)) throw new Error(`Active descendant blocks reap: ${nested.id}/${c.childId}`);
          if (c.report) this.retainedArtifact(c, c.report, "report");
          const m = this.manifest(c);
          if (m && !c.reaped) { await this.tmux.reap(m); c.reaped = true; this.save(nested); }
        }
      } finally { release(); }
    }
  }
  private publicGroup(g: Group) {
    return { job_id: g.id, mode: g.mode, background: g.background, created_at: g.createdAt,
      status: g.children.some(active) ? "running" : g.cancelled || g.children.some(c => c.state === "cancelled") ? "cancelled" : g.children.some(c => ["failed", "lost"].includes(c.state)) ? "failed" : "completed",
      children: g.children.map((c, i) => ({ child: i + 1, child_id: c.childId, task_id: c.taskId,
        status: c.state, attempt: c.attempt ?? 1, reaped: !!c.reaped, task: c.spec.task.slice(0, 500), error: c.error,
        report: c.report, task_outcome: c.lastOutcome,
        ...(this.manifest(c) ? { runtime: publicTuiWorkerManifest(this.manifest(c)!) } : {}) })) };
  }
  private text(g: Group, output = false): string {
    const snapshot = this.publicGroup(g);
    let text = `${g.id} ${snapshot.status} (${g.mode}${g.background ? ", background" : ", foreground staged"})`;
    for (const [i, c] of g.children.entries()) {
      text += `\n${i + 1}. ${c.childId} task_id=${c.taskId} ${c.state}${c.reaped ? " [reaped]" : ""}${c.error ? `: ${c.error}` : ""}`;
      if (output && c.report) { try { text += `\n${messageText((readPrivateJson(c.report) as any).assistant)}`; } catch {} }
    }
    return text;
  }
  private retainedArtifact(c: Child, path: unknown, kind: "report" | "outcome"): any {
    if (typeof path !== "string" || path !== join(c.directory, basename(path))
      || !new RegExp(`^${kind}-[0-9]+-[a-f0-9]{16}\\.json$`).test(basename(path))) throw new Error("Worker artifact identity mismatch");
    return readPrivateJson(path);
  }
  private async observe(g: Group, c: Child, observationOnly = false): Promise<void> {
    if (c.reaped || c.state === "pending") return;
    const m = this.manifest(c);
    if (!m) {
      if (c.state === "launching") { c.state = "failed"; c.error = "Interrupted uncommitted launch; no automatic replay"; }
      return;
    }
    try {
      try {
        const tombstone = readPrivateJson(new TuiWorkerStore(c.directory).path("reaped.json")) as any;
        if (tombstone.workerEpoch !== m.workerEpoch || tombstone.paneId !== m.placement?.paneId) throw new Error("Reap tombstone identity mismatch");
        c.reaped = true;
        // The report remains independently retained after pane cleanup.
        if (active(c)) {
          const state = new TuiWorkerStore(c.directory).readState();
          if (state.lastReport) {
            const report = this.retainedArtifact(c, state.lastReport, "report");
            c.report = state.lastReport;
            c.error = typeof report.error === "string" ? report.error.slice(0, 2000) : undefined;
            c.state = c.error || report.assistant?.stopReason === "error" ? "failed"
              : report.assistant?.stopReason === "aborted" || g.cancelled ? "cancelled" : "completed";
            c.lastOutcome = state.lastOutcome ? this.retainedArtifact(c, state.lastOutcome, "outcome") : undefined;
          }
          else { c.state = "lost"; c.error = "Reaped worker has no retained settlement"; }
        }
        return;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const result = await callTuiWorker(m, { operation: "status" }, { timeoutMs: 1000 });
      if (!result.ok) { c.error = result.code; return; }
      c.error = undefined;
      const state = result.data as any;
      if (state.active) { c.state = "running"; c.runSequence = state.sequence; }
      else if (state.lastReport) {
        const report = this.retainedArtifact(c, state.lastReport, "report");
        c.report = state.lastReport;
        c.requiresCompaction = Number.isFinite(report.contextTokens) && Number.isFinite(report.contextWindow) && report.contextTokens >= report.contextWindow * 0.8;
        // A terminating tool block can settle with toolUse, not an assistant
        // error/final answer. Retain explicit failures and recognize old workers
        // whose report predates that field. Tool-only success remains supported.
        c.error = typeof report.error === "string" ? report.error.slice(0, 2000)
          : report.assistant?.stopReason === "toolUse" && state.readyForPrompts === false
            ? "Worker command authority unavailable" : undefined;
        c.state = c.error || report.assistant?.stopReason === "error" ? "failed"
          : report.assistant?.stopReason === "aborted" || g.cancelled ? "cancelled" : "completed";
        // Settlement is reported through the replay cursor below, never a text injection.
      }
      // Current-turn state is authoritative even after a replay gap. Only
      // newer events may supersede this snapshot (a human can act mid-poll).
      c.lastOutcome = state.lastOutcome ? this.retainedArtifact(c, state.lastOutcome, "outcome") : undefined;
      if (!state.lastReport) { c.report = undefined; c.requiresCompaction = false; }
      if (observationOnly) return; // Ancestor observation never consumes/reroutes notifications or dispatches work.
      if (state.active) this.notifyActivity(g, c, state.sequence);
      const events = await callTuiWorker(m, { operation: "events", afterSequence: c.notifiedSequence }, { timeoutMs: 1000 });
      if (events.ok) {
        for (const event of (events.data as any)?.events ?? []) {
          if (event.kind === "running" && event.sequence > state.sequence) {
            c.state = "running"; c.runSequence = event.sequence; c.lastOutcome = undefined; c.report = undefined; c.requiresCompaction = false;
            this.notifyActivity(g, c, event.sequence);
          }
          if (event.kind === "notification" || event.kind === "outcome") {
            const artifact = event.data?.artifact;
            if (typeof artifact === "string" && artifact.startsWith(`${c.directory}/`)) {
              const data = readPrivateJson(artifact) as any;
              if (event.kind === "outcome" && event.sequence > state.sequence) c.lastOutcome = data;
              const update: QuietUpdate = event.kind === "outcome"
                ? { kind: "subagent", id: `${g.id}:${c.childId}:${event.sequence}`, child_id: c.childId, state: data.state,
                    outcomes: [{ child: g.children.indexOf(c) + 1, task_id: c.taskId, attempt: c.attempt ?? 1, state: data.state }], through_sequence: event.sequence }
                : { kind: "notification", id: `${g.id}:${c.childId}:${event.sequence}`, child_id: c.childId,
                    message: String(data.message ?? "").slice(0, 1000), requires_guidance: data.requires_guidance === true, through_sequence: event.sequence };
              if (this.notify && !this.notify(update)) break;
            }
          }
          // Completion is emitted from the current terminal snapshot below,
          // not historical settled events (which may precede a newer human turn).
          c.notifiedSequence = Math.max(c.notifiedSequence, event.sequence);
        }
      }
      // Recover committed launch after parent death before the initial receipt.
      if (!c.started && state.readyForPrompts && !g.cancelled) await this.startPrompt(g, c, m);
    } catch (error) {
      try {
        if ((await this.tmux.inspect(m)).dead && active(c)) { c.state = "lost"; c.error = "Pi exited before reporting settlement"; }
      } catch { c.error = `Worker unavailable: ${String(error).slice(0, 300)}`; }
      // Parent/observer failure alone never marks a live TUI lost.
    }
  }
  private notifyActivity(g: Group, c: Child, sequence: number): void {
    // group/child IDs identify this worker attempt; task IDs may span attempts.
    this.notify?.({ kind: "subagent", id: `${g.id}:${c.childId}:activity`, job_id: g.id,
      child_id: c.childId, activity: true, through_sequence: sequence });
  }
  private async startPrompt(g: Group, c: Child, m: TuiWorkerManifest): Promise<void> {
    if (this.closed || this.reapReserved || g.cancelled || !this.ready() || (g.launchMode === "guard-only" ? this.disposition() !== "guard-only" : this.disposition() !== "native")) return;
    if (g.launchMode === "guard-only") {
      await this.sendMode(g, c, m);
    }
    const index = g.children.indexOf(c);
    const previous = index > 0 && g.children[index - 1].report ? messageText((readPrivateJson(g.children[index - 1].report!) as any).assistant) : "";
    if (c.compactBeforePrompt) {
      const compacted = await callTuiWorker(m, { operation: "compact" }, { requestId: `resume-compact:${c.childId}`, timeoutMs: 300_000 });
      if (!compacted.ok) throw new Error(`Resume compaction not confirmed: ${compacted.code}: ${compacted.message}`);
    }
    const task = c.resumeSessionFile ? `Continue the retained session, not a new assignment. Latest parent instruction: ${c.resumeMessage ?? "Continue from the saved checkpoint."}`
      : g.mode === "chain" ? c.spec.task.replaceAll("{previous}", previous) : c.spec.task;
    const prompt = `Task: ${task}\n\nAcceptance criteria: ${JSON.stringify(c.spec.acceptance ?? [])}\nReport useful findings with notify_parent and your outcome with task_outcome. The parent handles pane cleanup.`;
    const accepted = await callTuiWorker(m, { operation: "prompt", mode: "steer", message: prompt }, { requestId: `initial:${c.childId}` });
    if (!accepted.ok) throw new Error(`Initial prompt not confirmed: ${accepted.code}`);
    this.notifyActivity(g, c, accepted.sequence);
    c.started = true; c.state = "running"; this.save(g);
  }
  async refresh(owner: string): Promise<void> {
    // A timer tick (or an impatient caller) joins the in-flight pass instead of
    // appending another full-group scan to the serialized mutation queue.
    if (this.refreshFlight) return this.refreshFlight;
    const flight = this.serial(async () => {
      if (this.closed) return;
      for (const g of this.groups.values()) {
        if (g.owner !== owner) continue;
        if (!g.background && g.parentOwnerToken !== this.processToken(process.pid) && !g.cancelled) await this.cancelGroup(g);
        if (!this.reapReserved && g.children.some(c => c.state === "pending") && !g.cancelled) {
          const caller = await this.tmux.resolveCaller();
          if (caller.socketPath === g.caller.socketPath && caller.serverEpoch === g.caller.serverEpoch) g.caller = caller;
        }
        for (const c of g.children) await this.observe(g, c);
        if (!this.reapReserved && !g.cancelled && this.ready() && (g.launchMode === "guard-only" ? this.disposition() === "guard-only" : this.disposition() === "native")) {
          let running = g.children.filter(c => c.state === "running" || c.state === "launching").length;
          for (const [index, c] of g.children.entries()) {
            if (this.closed || this.reapReserved || c.state !== "pending" || running >= 4) continue;
            if (g.mode === "chain" && index > 0) {
              const prior = g.children[index - 1];
              if (active(prior)) break;
              if (prior.state !== "completed") { c.state = "skipped"; continue; }
            }
            c.state = "launching"; this.save(g);
            try {
              const existing = g.children.map(child => this.manifest(child)).find(Boolean);
              const contract = tuiWorkerLaunchContract(this.disposition());
              if (contract.launchMode !== g.launchMode) throw new Error("Current launcher does not match retained group authority");
              g.launcher = contract.launcher; // disk executable paths never authorize new launches
              const manifest = await this.tmux.launch({ directory: c.directory, ownerSessionId: owner, taskId: c.taskId,
                groupId: g.id, childId: c.childId, attempt: c.attempt ?? 1, caller: g.caller, cwd: c.spec.cwd,
                foreground: !g.background, groupWindowId: existing?.placement?.windowId,
                windowName: g.windowName ?? subagentTmuxName(g.children[0].spec.task, g.children[0].spec.name),
                paneTitle: subagentTmuxName(c.spec.task, c.spec.name),
                parentDisposition: this.disposition(), launcher: g.launcher, launchMode: g.launchMode,
                model: c.spec.model, tools: c.spec.tools, systemPrompt: c.spec.systemPrompt, acceptance: c.spec.acceptance, resumeSessionFile: c.resumeSessionFile,
                operatorCapabilityHash: createHash("sha256").update(c.operatorCapability).digest("hex") });
              await this.tmux.waitReady(manifest);
              await this.startPrompt(g, c, manifest);
              running++;
            } catch (error) { c.state = "failed"; c.error = String(error).slice(0, 1000); }
            this.save(g);
            if (g.mode === "chain") break;
          }
        }
        for (const c of g.children) this.notifyTerminal(g, c);
        this.save(g);
      }
      await this.observeDescendants(owner);
    });
    this.refreshFlight = flight;
    try { await flight; } finally { if (this.refreshFlight === flight) this.refreshFlight = undefined; }
  }
  private notifyTerminal(g: Group, c: Child): void {
    if (active(c) || c.reaped) return;
    const token = terminalToken(c);
    if (c.terminalNotification === token) return;
    // Foreground callers receive their result directly. Persist the baseline
    // so promotion/restart cannot turn an already-observed result into a wake.
    if (!g.background) { c.terminalNotification = token; return; }
    const identity = createHash("sha256").update(token).digest("hex").slice(0, 24);
    if (this.notify?.({ kind: "subagent", id: `${g.id}:${c.childId}:terminal:${identity}`,
      job_id: g.id, child_id: c.childId, state: c.state, completion: true,
      through_sequence: Number(c.report?.match(/report-(\d+)-[a-f0-9]{16}\.json$/)?.[1]) || c.runSequence || 0 })) c.terminalNotification = token;
  }
  async launch(params: any, owner: string, cwd: string, signal?: AbortSignal, update?: (value: any) => void,
    resume?: { child: Child; sessionFile: string; compact: boolean; message?: string }) {
    const forms = [typeof params.task === "string" && params.task.trim(), Array.isArray(params.tasks) && params.tasks.length, Array.isArray(params.chain) && params.chain.length].filter(Boolean);
    if (forms.length !== 1) throw new Error("Provide exactly one task/tasks/chain form");
    const specs: Spec[] = (params.tasks ?? params.chain ?? [params]).map((s: any) => {
      if (typeof s.task !== "string" || !s.task.trim() || Buffer.byteLength(s.task) > 48 * 1024) throw new Error("Invalid bounded subagent task");
      if (s.systemPrompt !== undefined && (typeof s.systemPrompt !== "string" || Buffer.byteLength(s.systemPrompt) > 64 * 1024)) throw new Error("Invalid system prompt");
      if (s.model !== undefined && (typeof s.model !== "string" || Buffer.byteLength(s.model) > 512)) throw new Error("Invalid model");
      if (s.tools !== undefined && (!Array.isArray(s.tools) || s.tools.length > 64 || s.tools.some((tool: any) => typeof tool !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(tool)))) throw new Error("Invalid tool selection");
      return { name: validateSubagentName(s.name), task: s.task, cwd: resolve(s.cwd ?? cwd), model: s.model, tools: s.tools, systemPrompt: s.systemPrompt, acceptance: validateAcceptance(s.acceptance) };
    });
    if (specs.length > 8) throw new Error("At most eight subagent children are allowed");
    if (signal?.aborted || this.closed || this.reapReserved) throw new Error("Subagent launch cancelled or cleanup reserved");
    if (!this.ready()) throw new Error("Parent authority is not active; refusing native TUI launch");
    const contract = tuiWorkerLaunchContract(this.disposition());
    const enabled = contract.launchMode === "guard-only" ? this.liveOperatorMode(owner) : true;
    if (typeof enabled !== "boolean") throw new Error("Parent operator authority unavailable");
    const groupId = id("subagent-job");
    const g: Group = { windowName: subagentTmuxName(specs[0].task, validateSubagentName(params.name) ?? specs[0].name), version: 1, id: groupId, owner, createdAt: new Date().toISOString(), mode: params.chain ? "chain" : params.tasks ? "parallel" : "single",
      background: params.background === true, cancelled: false, parentOwnerToken: this.processToken(process.pid)!, operatorEnabled: enabled, ...contract,
      caller: await this.tmux.resolveCaller(), children: specs.map(spec => ({ childId: id("subagent-child"), taskId: resume?.child.taskId ?? id("subagent-task"), attempt: resume ? (resume.child.attempt ?? 1) + 1 : 1,
        ...(resume ? { resumeSessionFile: resume.sessionFile, compactBeforePrompt: resume.compact, resumeMessage: resume.message } : {}),
        directory: join(this.root, "workers", randomBytes(12).toString("hex")), spec, state: "pending", operatorCapability: randomBytes(32).toString("hex"), started: false, notifiedSequence: 0, terminalNotification: '' })) };
    await this.serial(async () => {
      if (signal?.aborted || this.closed || this.reapReserved) throw new Error("Launch cancelled before commit");
      if ([...this.groups.values()].filter(group => group.owner === owner && group.children.some(active)).length >= this.groupLimit) throw new Error(`Subagent concurrency limit reached (${this.groupLimit})`);
      this.groups.set(g.id, g); this.save(g);
    });
    void this.refresh(owner).catch(() => undefined);
    if (g.background) return response(this.text(g), { operation: "start", group: this.publicGroup(g), job_id: g.id });
    this.foregroundWaits.add(g.id);
    const abortForeground = () => { if (!g.background && !this.closed) { g.cancelled = true; this.save(g); void this.serial(() => this.cancelGroup(g)).catch(() => undefined); } };
    signal?.addEventListener("abort", abortForeground, { once: true });
    if (signal?.aborted) abortForeground();
    try {
      while (!g.background && g.children.some(active)) {
        if (this.closed) throw new Error("Foreground subagent controller closed");
        if (signal?.aborted) { await this.serial(() => this.cancelGroup(g)); throw new Error("Foreground subagent cancelled"); }
        try { update?.(response(this.text(g), { group: this.publicGroup(g), job_id: g.id })); } catch { /* Rendering cannot abandon a live foreground execution. */ }
        await pause(200);
      }
      return response(this.text(g, !g.background), { operation: g.background ? "start" : "result", job_id: g.id, group: this.publicGroup(g),
        failed: !g.background && g.children.some(child => ["failed", "lost"].includes(child.state)) });
    } finally { signal?.removeEventListener("abort", abortForeground); this.foregroundWaits.delete(g.id); }
  }
  private async cancelGroup(g: Group) {
    g.cancelled = true;
    for (const c of g.children) {
      if (c.state === "pending") { c.state = "cancelled"; continue; }
      const m = this.manifest(c);
      if (m && !c.reaped) {
        try { await callTuiWorker(m, { operation: "cancel" }); c.state = "cancelled"; } catch {}
      }
    }
    this.save(g);
  }
  async promote(owner: string, jobId: string): Promise<void> {
    await this.serial(async () => {
      const g = this.owned(owner, jobId); if (!g) throw new Error("Unknown TUI subagent");
      const caller = await this.tmux.resolveCaller();
      if (caller.socketPath !== g.caller.socketPath || caller.serverEpoch !== g.caller.serverEpoch) throw new Error("Promotion requires the original tmux server");
      g.caller = caller;
      const manifests = g.children.filter(c => !c.reaped).map(c => this.manifest(c)).filter(Boolean) as TuiWorkerManifest[];
      g.background = true; g.promotionPending = true; this.save(g);
      if (manifests.length) await this.tmux.promote(manifests, g.caller);
      g.promotionPending = false; this.save(g);
    });
  }
  async promoteForeground(owner: string): Promise<number> {
    const ids = [...this.foregroundWaits].filter(key => this.groups.get(key)?.owner === owner);
    for (const key of ids) await this.promote(owner, key);
    return ids.length;
  }
  async operatorMode(owner: string, enabled: boolean): Promise<void> {
    if (this.disposition() !== "guard-only") return;
    if (this.liveOperatorMode(owner) !== enabled) return; // stale or forged bus event
    // Mode changes must not wait behind slow child launches or model work.
    // A separate serialized capability queue also orders initial inheritance.
    const sends: Promise<void>[] = [];
    for (const g of this.groups.values()) if (g.owner === owner && g.launchMode === "guard-only") {
      g.operatorEnabled = enabled; this.save(g);
      for (const c of g.children) {
        const m = this.manifest(c); if (m && !c.reaped) sends.push(this.sendMode(g, c, m));
      }
    }
    await Promise.all(sends);
  }
  taskRecord(owner: string, taskId: string): any | undefined {
    const found = this.byChild(owner, taskId); if (!found) return;
    const { group: g, child: c } = found;
    return { taskId: c.taskId, ownerSessionId: owner, childId: c.childId, attempt: c.attempt ?? 1,
      spec: c.spec, state: active(c) ? "running" : "idle", createdAt: g.createdAt, updatedAt: g.createdAt,
      checkpointed: (c.lastOutcome as any)?.state === "checkpointed", requiresCompaction: c.requiresCompaction,
      nextAction: (c.lastOutcome as any)?.next_action, latestSummary: (c.lastOutcome as any)?.summary,
      history: [...this.groups.values()].filter(group => group.owner === owner).flatMap(group => group.children.filter(child => child.taskId === taskId)
        .map(child => ({ attempt: child.attempt ?? 1, childId: child.childId, finishedAt: group.createdAt, outcome: (child.lastOutcome as any)?.state, execution: child.state }))) };
  }
  /** Return only retained in-memory native task snapshots; never refresh/observe or write. */
  readonlyTaskList(owner: string): any[] {
    if (this.owner !== owner) throw new Error("Native task snapshots belong to another Pi session");
    return [...this.groups.values()].filter(g => g.owner === owner).flatMap(g => g.children.map(c => {
      const manifest = this.manifest(c);
      return { taskId: c.taskId, childId: c.childId, groupId: g.id, runtimeId: manifest?.runtimeId ?? null,
        attempt: c.attempt ?? 1, status: c.state, title: c.spec.task.slice(0, 140),
        summary: typeof (c.lastOutcome as any)?.summary === "string" ? (c.lastOutcome as any).summary.slice(0, 2000) : undefined,
        lastUpdated: null, stale: true };
    })).slice(-50);
  }
  readonlyTaskReport(owner: string, taskId: string, maxBytes = 48 * 1024): any {
    if (this.owner !== owner) throw new Error("Native task snapshots belong to another Pi session");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 48 * 1024) throw new Error("Invalid report byte limit");
    const found = this.byChild(owner, taskId);
    if (!found) return undefined;
    const { group: g, child: c } = found;
    let text = "";
    let lastUpdated: string | null = null;
    if (c.report) {
      try {
        const reportPath = resolve(c.report);
        if (!reportPath.startsWith(`${resolve(c.directory)}/`) || !/^report-[0-9]+-[a-f0-9]{16}\.json$/.test(reportPath.slice(reportPath.lastIndexOf("/") + 1))) throw new Error("Invalid retained report identity");
        const artifact = readPrivateJson(reportPath) as any;
        // Report artifact shape is { sessionFile, assistant, contextTokens, contextWindow, timestamp }.
        // Return text content only: no session path, model metadata, tool calls, or diagnostics.
        if (typeof artifact?.timestamp === "string" && Number.isFinite(Date.parse(artifact.timestamp))) lastUpdated = artifact.timestamp;
        const assistant = artifact?.assistant;
        text = typeof assistant?.content === "string" ? assistant.content
          : Array.isArray(assistant?.content) ? assistant.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n") : "";
      } catch {}
    }
    text = text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
    const bounded = truncateUtf8(text, maxBytes);
    text = bounded.text;
    const truncated = bounded.truncated;
    const manifest = this.manifest(c);
    return { taskId: c.taskId, childId: c.childId, groupId: g.id, runtimeId: manifest?.runtimeId ?? null,
      attempt: c.attempt ?? 1, text, truncated, lastUpdated, stale: true };
  }
  taskList(owner: string): any[] {
    const tasks = new Map<string, any>();
    for (const g of this.groups.values()) if (g.owner === owner) for (const c of g.children) tasks.set(c.taskId,
      { task_id: c.taskId, child_id: c.childId, attempt: c.attempt ?? 1, state: active(c) ? "running" : "idle", title: c.spec.task.slice(0, 140),
        outcome: (c.lastOutcome as any)?.state, execution: c.state, can_resume: !active(c), checkpointed: (c.lastOutcome as any)?.state === "checkpointed",
        requires_compaction: c.requiresCompaction, summary: (c.lastOutcome as any)?.summary, next_action: (c.lastOutcome as any)?.next_action, updated_at: g.createdAt });
    return [...tasks.values()].reverse().slice(0, 50);
  }
  async jobs(owner: string, taskId: string, params: unknown): Promise<any> {
    if (this.closed) throw new Error("Native TUI controller is closing");
    const found = this.byChild(owner, taskId);
    if (!found) throw new Error("Task does not belong to this parent session");
    if (found.child.reaped) throw new Error("Child TUI was reaped. Its independent jobs are not implicitly cancelled; re-adopt their panes in a live Pi to manage them.");
    const manifest = this.manifest(found.child);
    if (!manifest) throw new Error("Child TUI has not launched; no local job controller is available.");
    const request = parseTuiWorkerJobParams(params);
    let result;
    try { result = await callTuiWorker(manifest, { operation: "jobs", params: request }, { timeoutMs: (request.timeout_ms ?? 0) + 5000 }); }
    catch { throw new Error("Child-local job control is unavailable. Jobs remain independent; reconnect the worker or re-adopt their panes in a live Pi."); }
    if (!result.ok) throw new Error(`Child-local job control ${result.code}: ${result.message}`);
    return result.data;
  }
  /** Reserve delegation until the enclosing worker either seals or releases cleanup.
   * Every child reap uses its own authenticated cleanup boundary recursively. */
  async prepareReap(owner: string, preserve: (report: unknown) => Promise<void>): Promise<() => void> {
    if (this.owner !== owner || this.closed || this.reapReserved) throw new Error("Subagent cleanup authority unavailable");
    this.reapReserved = true;
    try {
      await this.serial(async () => {
        const inventory = new TuiNativeManager(this.root, this.disposition, () => false, this.groupLimit);
        if (inventory.inventoryErrors.length) throw new Error(`Subagent inventory is unverifiable: ${inventory.inventoryErrors.slice(0, 16).join(", ")}`);
        const groups = [...this.groups.values()].filter(g => g.owner === owner);
        for (const g of groups) {
          for (const c of g.children) await this.observe(g, c);
          this.save(g);
        }
        const blockers = groups.flatMap(g => g.children.filter(active).map(c => `${g.id}/${c.childId} ${c.state}`));
        if (blockers.length) throw new Error(`Active descendant subagents block reap: ${blockers.slice(0, 32).join(", ")}`);
        // Reports are retained before any pane is removed. Never treat a model
        // task_outcome as execution settlement; observe() checks live activity.
        await preserve({ groups: groups.map(g => this.publicGroup(g)), results: groups.flatMap(g => g.children.map(c => ({
          job_id: g.id, child_id: c.childId, report: c.report ? readPrivateJson(c.report) : undefined,
        }))) });
        for (const g of groups) for (const c of g.children) {
          const m = this.manifest(c);
          if (m && !c.reaped) { await this.tmux.reap(m); c.reaped = true; this.save(g); }
          else if (!m && !c.reaped && c.started) throw new Error(`Descendant manifest unavailable: ${g.id}/${c.childId}`);
        }
      });
      return () => { this.reapReserved = false; };
    } catch (error) { this.reapReserved = false; throw error; }
  }
  hasOwnedGroups(owner: string): boolean { return [...this.groups.values()].some(g => g.owner === owner); }
  async operation(params: any, owner: string, signal?: AbortSignal): Promise<any | undefined> {
    const op = params.operation;
    if (!op) return;
    if (this.closed || this.reapReserved) throw new Error("Native TUI controller is closing or cleanup reserved");
    if (op === "reap") {
      const inventory = new TuiNativeManager(this.root, this.disposition, () => false, this.groupLimit);
      if (inventory.inventoryErrors.length) throw new Error(`Subagent inventory is unverifiable: ${inventory.inventoryErrors.slice(0, 16).join(", ")}`);
    }
    const ownedGroups = [...this.groups.values()].filter(g => g.owner === owner);
    const directTarget = ownedGroups.some(g => params.job_id ? g.id === params.job_id
      : g.children.some(c => c.childId === params.child_id || c.taskId === params.task_id));
    const descendantRead = ["list", "tasks", "reap"].includes(op) || !directTarget && ["status", "output", "result"].includes(op);
    const descendants = descendantRead ? await this.observeDescendants(owner) : [];
    let descendant = descendants.find(g => params.job_id ? g.id === params.job_id
      : g.children.some(c => c.childId === params.child_id || c.taskId === params.task_id));
    if (descendant) {
      if (params.child_id && !descendant.children.some(c => c.childId === params.child_id)
        || params.task_id && !descendant.children.some(c => c.taskId === params.task_id)) throw new Error("Descendant target identity mismatch");
      if (op === "reap") {
        const nestedIds = new Set(this.descendantGroups(descendant.owner, [descendant]).map(group => group.id));
        const nested = descendants.filter(group => nestedIds.has(group.id));
        const blockers = [descendant, ...nested].flatMap(group => group.children.filter(active).map(c => `${group.id}/${c.childId} ${c.state}`));
        if (blockers.length) throw new Error(`Active descendants block ancestor reap: ${blockers.slice(0, 32).join(", ")}`);
        const release = this.observerLease(descendant.owner);
        if (!release) throw new Error(`Descendant owner is live; ask its parent to reap ${descendant.id}`);
        try {
          const fresh = new TuiNativeManager(this.root, this.disposition, () => false, this.groupLimit).groups.get(descendant.id);
          if (!fresh || fresh.owner !== descendant.owner) throw new Error("Descendant ownership changed before reap");
          descendant = fresh;
          for (const c of descendant.children) await this.observe(descendant, c, true);
          if (descendant.children.some(active)) throw new Error(`Active descendant blocks reap: ${descendant.id}`);
          await this.reapStoppedDescendants(nested);
          for (const c of descendant.children) {
            if (c.report) readPrivateJson(c.report); // Require readable retained results before deletion.
            const manifest = this.manifest(c);
            if (manifest && !c.reaped) { await this.tmux.reap(manifest); c.reaped = true; this.save(descendant); }
          }
        } finally { release(); }
      }
      const c = descendant.children.find(c => c.childId === params.child_id || c.taskId === params.task_id)
        ?? descendant.children[(params.child ?? 1) - 1];
      if (op === "result") {
        if (!c || active(c) || !c.report) return response("Descendant result not ready.", { operation: op, job_id: descendant.id });
        const bytes = Buffer.from(messageText((readPrivateJson(c.report) as any).assistant));
        const offset = params.offset ?? 0, limit = params.limit ?? 48 * 1024;
        return response(bytes.subarray(offset, offset + limit).toString("utf8"), { operation: op, job_id: descendant.id, child_id: c.childId,
          descendant: true, artifact: c.report, offset, next_offset: Math.min(bytes.length, offset + limit), complete: offset + limit >= bytes.length });
      }
      return response(this.text(descendant, op === "output"), { operation: op, job_id: descendant.id, descendant: true, group: this.publicGroup(descendant) });
    }
    let selected: Group | undefined;
    let child: Child | undefined;
    if (params.child_id || params.task_id) {
      const found = this.byChild(owner, params.child_id ?? params.task_id); selected = found?.group; child = found?.child;
    } else if (params.job_id) selected = this.owned(owner, params.job_id);
    if (selected && params.job_id && selected.id !== params.job_id) throw new Error("Child does not belong to the requested group");
    const globalOp = ["list", "tasks", "wait_any", "wait_all"].includes(op);
    if (!selected && (!globalOp || !ownedGroups.length)) return;
    let retainedResult = false;
    // Selected result reads observe only their selected child, outside the
    // global refresh queue. An unrelated slow worker must not delay a result.
    if (op === "result" && selected) {
      child ??= selected.children[(params.child ?? 1) - 1];
      if (!child) return response("Unknown child result.", { operation: op, job_id: selected.id });
      if (signal?.aborted) throw new Error("Result observation cancelled");
      // Observe a bounded selected-child status without mutating shared state
      // or waiting for the manager refresh queue. Never return an old report
      // while the worker reports an active turn.
      if (!child.reaped) {
        const manifest = this.manifest(child);
        let status;
        if (manifest) {
          try { status = await callTuiWorker(manifest, { operation: "status" }, { timeoutMs: 1000, signal }); }
          catch (error) { if (signal?.aborted) throw error; }
        }
        if (signal?.aborted) throw new Error("Result observation cancelled");
        if (!status?.ok) {
          if (!child.report) return response("Worker status unavailable; no retained result.", { operation: op, job_id: selected.id, unavailable: true });
          retainedResult = true;
        } else {
          const snapshot = status.data as any;
          if (snapshot.active || !snapshot.lastReport) return response("Result not ready. Use wait.", { operation: op, job_id: selected.id });
          const reportPath = snapshot.lastReport;
          const artifactPath = (path: unknown, kind: string): path is string => typeof path === "string"
            && resolve(path).startsWith(`${resolve(child!.directory)}/`)
            && new RegExp(`^${kind}-[0-9]+-[a-f0-9]{16}\\.json$`).test(resolve(path).slice(resolve(child!.directory).length + 1));
          if (!artifactPath(reportPath, "report")) return response("Worker returned an invalid report; retained result not substituted.", { operation: op, job_id: selected.id, unavailable: true });
          // Work on a private snapshot: concurrent scheduler observations retain
          // ownership of manager state and event cursors.
          child = { ...child, report: reportPath, error: undefined, lastOutcome: undefined, runSequence: snapshot.sequence };
          if (artifactPath(snapshot.lastOutcome, "outcome")) child.lastOutcome = readPrivateJson(snapshot.lastOutcome);
          const artifact = readPrivateJson(reportPath) as any;
          child.error = typeof artifact.error === "string" ? artifact.error.slice(0, 2000)
            : artifact.assistant?.stopReason === "toolUse" && snapshot.readyForPrompts === false ? "Worker command authority unavailable"
            : artifact.assistant?.stopReason === "error" ? "Worker reported an error" : undefined;
          child.state = child.error ? "failed" : artifact.assistant?.stopReason === "aborted" ? "cancelled" : "completed";
        }
      }
    } else await this.refresh(owner);
    if (op === "list" || op === "tasks") return response([
      ...ownedGroups.slice(-(params.limit ?? 20)).map(g => this.text(g)),
      ...descendants.filter(g => g.children.some(c => !c.reaped)).map(g => `Descendant: ${this.text(g)}`),
    ].join("\n\n"), { operation: op, groups: ownedGroups.map(g => this.publicGroup(g)),
      descendants: descendants.map(g => this.publicGroup(g)), ...(op === "tasks" ? { tasks: this.taskList(owner) } : {}) });
    if (op === "wait_any" || op === "wait_all") {
      const waited = await waitForGroupSnapshot(async () => {
        await this.refresh(owner);
        return ownedGroups.map(g => this.publicGroup(g));
      }, op, params.wait_ms ?? 1000, signal);
      return response(waited.groups.map(g => `${g.job_id} ${g.status}`).join("\n") || "No running TUI groups", { operation: op, ...waited });
    }
    const g = selected!;
    if (op === "prompt" || op === "resume") {
      if (this.disposition() !== (g.launchMode === "guard-only" ? "guard-only" : "native") || !this.ready()) throw new Error("Current authority does not permit native child prompts");
      const c = child!; const m = this.manifest(c);
      // A model checkpoint records progress, not measured context pressure.
      const requiresCompaction = c.requiresCompaction === true;
      if (op === "resume" && requiresCompaction && params.compact === false) throw new Error("High-context continuation requires compaction");
      const dead = !m || c.reaped || (await this.tmux.inspect(m)).dead;
      if (dead) {
        if (op !== "resume" || !m) throw new Error("Worker is closed; use explicit operation=resume with task_id");
        if (await callTuiWorker(m, { operation: "status" }, { timeoutMs: 500 }).then(() => true, () => false)) throw new Error("Prior worker endpoint is still live; new attempt refused");
        if (m.panePid && m.paneProcessToken && await processIdentity(m.panePid).then(token => token === m.paneProcessToken, () => false)) throw new Error("Prior worker process is still live; new attempt refused");
        if (c.reaped) {
          const tombstone = readPrivateJson(new TuiWorkerStore(c.directory).path("reaped.json")) as any;
          if (tombstone.workerEpoch !== m.workerEpoch) throw new Error("Old worker death is not verified");
        }
        if (this.resuming.has(c.taskId) || this.byChild(owner, c.taskId)?.child !== c) throw new Error("Task already has a successor attempt");
        this.resuming.add(c.taskId);
        try {
          return await this.launch({ ...c.spec, background: true }, owner, c.spec.cwd, signal, undefined,
            { child: c, sessionFile: m.sessionFile, compact: params.compact ?? requiresCompaction, message: params.message });
        } finally { this.resuming.delete(c.taskId); }
      }
      if (op === "resume" && (params.compact === true || requiresCompaction)) {
        const compacted = await callTuiWorker(m!, { operation: "compact" }, { timeoutMs: 300_000, signal });
        if (!compacted.ok) throw new Error(`Resume compaction failed: ${compacted.code}: ${compacted.message}`);
      }
      const result = await callTuiWorker(m!, { operation: "prompt", mode: params.control_mode ?? "steer", message: params.message ?? "Continue from the saved task context." });
      if (!result.ok) throw new Error(`Worker prompt failed: ${result.code}: ${result.message}`);
      this.notifyActivity(g, c, result.sequence);
      c.state = "running"; g.cancelled = false; this.save(g);
      if (params.wait_for_response) {
        while (active(c)) { if (signal?.aborted) throw new Error("Prompt observation cancelled; child continues"); await pause(200); await this.refresh(owner); }
      }
      return response(this.text(g, params.wait_for_response === true), { operation: op, group: this.publicGroup(g), job_id: g.id, child_id: c.childId });
    }
    if (op === "cancel") await this.serial(() => this.cancelGroup(g));
    if (op === "promote") await this.promote(owner, g.id);
    if (op === "reap") await this.serial(async () => {
      if (g.children.some(c => c.state === "running")) throw new Error("Group is busy; reap never cancels active work");
      if (g.children.some(c => c.state === "pending" || c.state === "launching")) throw new Error("Pending group work must finish or be explicitly cancelled before reap");
      const nestedIds = new Set(this.descendantGroups(owner, [g]).map(group => group.id));
      const blockers = descendants.filter(group => nestedIds.has(group.id)).flatMap(group => group.children.filter(active).map(c => `${group.id}/${c.childId} ${c.state}`));
      if (blockers.length) throw new Error(`Active descendants block ancestor reap: ${blockers.slice(0, 32).join(", ")}`);
      // Stopped/reaped intermediate parents no longer run a scheduler. Recover
      // only their proven descendants, deepest first; live parents perform
      // their own recursive cleanup through prepare_reap instead.
      await this.reapStoppedDescendants(descendants.filter(group => nestedIds.has(group.id)));
      for (const c of g.children) { const m = this.manifest(c); if (m && !c.reaped) { await this.tmux.reap(m); c.reaped = true; this.save(g); } }
    });
    if (op === "wait" || op === "wait_group") {
      const deadline = Date.now() + (params.wait_ms ?? 1000);
      while (g.children.some(active) && Date.now() < deadline) { if (signal?.aborted) throw new Error("Wait cancelled; worker continues"); await pause(100); await this.refresh(owner); }
    }
    if (op === "result") {
      const c = child ?? g.children[(params.child ?? 1) - 1];
      if (!c?.report) return response("Result not ready. Use wait.", { operation: op, job_id: g.id });
      const raw = readPrivateJson(c.report) as any;
      const text = params.diagnostics ? JSON.stringify(raw, null, 2)
        : [retainedResult ? "Worker status unavailable; retained result may be stale." : "", c.error ? `Worker failed: ${c.error}` : "", messageText(raw.assistant)].filter(Boolean).join("\n\n");
      const bytes = Buffer.from(text), offset = params.offset ?? 0, limit = params.limit ?? 48 * 1024;
      return response(bytes.subarray(offset, offset + limit).toString("utf8"), { operation: op, job_id: g.id, child_id: c.childId,
        artifact: c.report, retained: retainedResult, terminal_id: createHash("sha256").update(terminalToken(c)).digest("hex").slice(0, 24),
        report_sequence: Number(c.report.match(/report-(\d+)-[a-f0-9]{16}\.json$/)?.[1]) || c.runSequence || 0,
        offset, next_offset: Math.min(bytes.length, offset + limit), complete: offset + limit >= bytes.length, task_outcome: c.lastOutcome });
    }
    return response(this.text(g, op === "output"), { operation: op, job_id: g.id, group: this.publicGroup(g) });
  }
}
