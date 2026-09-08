import { randomBytes, createHash } from "node:crypto";
import { waitForGroupSnapshot } from "./group-wait.ts";
import { readdirSync, existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateAcceptance } from "./outcome.ts";
import { TuiWorkerTmux, tuiWorkerLaunchContract, processIdentity } from "./tui-worker-tmux.ts";
import { TuiWorkerStore, privateDirectory, atomicPrivateJson, readPrivateJson } from "./tui-worker-store.ts";
import { callTuiWorker, applyTuiWorkerOperatorMode } from "./tui-worker-client.ts";
import { publicTuiWorkerManifest, parseTuiWorkerJobParams } from "../shared/tui-worker-protocol.ts";
import type { QuietUpdate } from "../shared/quiet-state.ts";
import type { TuiWorkerManifest, TuiWorkerPlacement } from "../shared/tui-worker-protocol.ts";

const id = (prefix: string) => `${prefix}-${randomBytes(12).toString("hex")}`;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Spec = { task: string; cwd: string; model?: string; tools?: string[]; systemPrompt?: string; acceptance?: string[] };
type Child = { childId: string; taskId: string; attempt: number; directory: string; spec: Spec;
  resumeSessionFile?: string; resumeMessage?: string; compactBeforePrompt?: boolean;
  state: "pending" | "launching" | "running" | "completed" | "failed" | "cancelled" | "lost" | "skipped";
  operatorCapability: string; started: boolean; reaped?: boolean; error?: string; report?: string;
  notifiedSequence: number; lastOutcome?: unknown; requiresCompaction?: boolean; };
type Group = { version: 1; id: string; owner: string; createdAt: string; mode: "single" | "parallel" | "chain";
  background: boolean; cancelled: boolean; children: Child[]; caller: TuiWorkerPlacement;
  parentOwnerToken: string;
  operatorEnabled: boolean; launcher: string; launchMode: "none" | "guard-only"; promotionPending?: boolean; };
type Disposition = "native" | "guard-only" | "full" | "unavailable";
const active = (child: Child) => ["pending", "launching", "running"].includes(child.state);
const messageText = (message: any) => typeof message?.content === "string" ? message.content : (message?.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
const response = (text: string, data: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: Buffer.from(text).subarray(0, 48 * 1024).toString("utf8") }], details: { tui_subagent: true, backend: "native", ...data } });

/** Native-only durable adapter. Legacy AgentSH execution never enters here. */
export class TuiNativeManager {
  readonly root: string;
  readonly tmux = new TuiWorkerTmux();
  private groups = new Map<string, Group>();
  private queue: Promise<unknown> = Promise.resolve();
  private modeQueue: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
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
        if (g.version !== 1 || `${g.id}.json` !== name || typeof g.owner !== "string" || !Array.isArray(g.children) || g.children.length > 8) continue;
        if (g.children.some(c => !/^subagent-child-[a-f0-9]{24}$/.test(c.childId) || !/^subagent-task-[a-f0-9]{24}$/.test(c.taskId)
          || !/^[a-f0-9]{64}$/.test(c.operatorCapability) || !c.directory.startsWith(`${join(this.root, "workers")}/`))) continue;
        this.groups.set(g.id, g);
      } catch { /* Invalid records never authorize launch/control/deletion. */ }
    }
  }
  private disposition: () => Disposition;
  private ready: () => boolean;
  private save(g: Group) { atomicPrivateJson(join(this.root, "groups", `${g.id}.json`), g); }
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
    return `${text}\nCompletion leaves Pi messageable. Inspect status/result, then explicitly operation=reap when its panes are no longer needed; cancel only stops work.`;
  }
  private async observe(g: Group, c: Child): Promise<void> {
    if (c.reaped || c.state === "pending") return;
    const m = this.manifest(c);
    if (!m) {
      if (c.state === "launching") { c.state = "failed"; c.error = "Interrupted uncommitted launch; no automatic replay"; }
      return;
    }
    try {
      const result = await callTuiWorker(m, { operation: "status" }, { timeoutMs: 1000 });
      if (!result.ok) { c.error = result.code; return; }
      c.error = undefined;
      const state = result.data as any;
      if (state.active) c.state = "running";
      else if (state.lastReport) {
        c.report = state.lastReport;
        const report = readPrivateJson(c.report!) as any;
        c.requiresCompaction = Number.isFinite(report.contextTokens) && Number.isFinite(report.contextWindow) && report.contextTokens >= report.contextWindow * 0.8;
        c.state = report.assistant?.stopReason === "error" ? "failed"
          : report.assistant?.stopReason === "aborted" || g.cancelled ? "cancelled" : "completed";
        // Settlement is reported through the replay cursor below, never a text injection.
      }
      // Current-turn state is authoritative even after a replay gap. Only
      // newer events may supersede this snapshot (a human can act mid-poll).
      c.lastOutcome = typeof state.lastOutcome === "string" && state.lastOutcome.startsWith(`${c.directory}/`)
        ? readPrivateJson(state.lastOutcome) : undefined;
      if (!state.lastReport) { c.report = undefined; c.requiresCompaction = false; }
      const events = await callTuiWorker(m, { operation: "events", afterSequence: c.notifiedSequence }, { timeoutMs: 1000 });
      if (events.ok) {
        for (const event of (events.data as any)?.events ?? []) {
          if (event.kind === "running" && event.sequence > state.sequence) {
            c.state = "running"; c.lastOutcome = undefined; c.report = undefined; c.requiresCompaction = false;
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
          if (event.kind === "settled" && this.notify && !this.notify({ kind: "subagent", id: `${g.id}:${c.childId}:${event.sequence}`,
            child_id: c.childId, state: "settled", through_sequence: event.sequence })) break;
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
  private async startPrompt(g: Group, c: Child, m: TuiWorkerManifest): Promise<void> {
    if (this.closed || g.cancelled || !this.ready() || (g.launchMode === "guard-only" ? this.disposition() !== "guard-only" : this.disposition() !== "native")) return;
    if (g.launchMode === "guard-only") {
      await this.sendMode(g, c, m);
    }
    const index = g.children.indexOf(c);
    const previous = index > 0 && g.children[index - 1].report ? messageText((readPrivateJson(g.children[index - 1].report!) as any).assistant) : "";
    if (c.compactBeforePrompt) {
      const compacted = await callTuiWorker(m, { operation: "compact" }, { requestId: `resume-compact:${c.childId}`, timeoutMs: 30_000 });
      if (!compacted.ok) throw new Error(`Resume compaction not confirmed: ${compacted.code}`);
    }
    const task = c.resumeSessionFile ? `Continue the retained session, not a new assignment. Latest parent instruction: ${c.resumeMessage ?? "Continue from the saved checkpoint."}`
      : g.mode === "chain" ? c.spec.task.replaceAll("{previous}", previous) : c.spec.task;
    const prompt = `Task: ${task}\n\nAcceptance criteria: ${JSON.stringify(c.spec.acceptance ?? [])}\nUse notify_parent for concise discoveries and task_outcome before returning. Execution completion is not task delivery. The parent will inspect results and explicitly reap this pane when done; do not close the TUI yourself.`;
    const accepted = await callTuiWorker(m, { operation: "prompt", mode: "steer", message: prompt }, { requestId: `initial:${c.childId}` });
    if (!accepted.ok) throw new Error(`Initial prompt not confirmed: ${accepted.code}`);
    c.started = true; c.state = "running"; this.save(g);
  }
  async refresh(owner: string): Promise<void> {
    return await this.serial(async () => {
      if (this.closed) return;
      for (const g of this.groups.values()) {
        if (g.owner !== owner) continue;
        if (!g.background && g.parentOwnerToken !== this.processToken(process.pid) && !g.cancelled) await this.cancelGroup(g);
        if (g.children.some(c => c.state === "pending") && !g.cancelled) {
          const caller = await this.tmux.resolveCaller();
          if (caller.socketPath === g.caller.socketPath && caller.serverEpoch === g.caller.serverEpoch) g.caller = caller;
        }
        for (const c of g.children) await this.observe(g, c);
        if (!g.cancelled && this.ready() && (g.launchMode === "guard-only" ? this.disposition() === "guard-only" : this.disposition() === "native")) {
          let running = g.children.filter(c => c.state === "running" || c.state === "launching").length;
          for (const [index, c] of g.children.entries()) {
            if (this.closed || c.state !== "pending" || running >= 4) continue;
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
                foreground: !g.background, groupWindowId: existing?.placement.windowId,
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
        this.save(g);
      }
    });
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
      return { task: s.task, cwd: resolve(s.cwd ?? cwd), model: s.model, tools: s.tools, systemPrompt: s.systemPrompt, acceptance: validateAcceptance(s.acceptance) };
    });
    if (specs.length > 8) throw new Error("At most eight subagent children are allowed");
    if (signal?.aborted || this.closed) throw new Error("Subagent launch cancelled");
    if (!this.ready()) throw new Error("Parent authority is not active; refusing native TUI launch");
    const contract = tuiWorkerLaunchContract(this.disposition());
    const enabled = contract.launchMode === "guard-only" ? this.liveOperatorMode(owner) : true;
    if (typeof enabled !== "boolean") throw new Error("Parent operator authority unavailable");
    const groupId = id("subagent-job");
    const g: Group = { version: 1, id: groupId, owner, createdAt: new Date().toISOString(), mode: params.chain ? "chain" : params.tasks ? "parallel" : "single",
      background: params.background === true, cancelled: false, parentOwnerToken: this.processToken(process.pid)!, operatorEnabled: enabled, ...contract,
      caller: await this.tmux.resolveCaller(), children: specs.map(spec => ({ childId: id("subagent-child"), taskId: resume?.child.taskId ?? id("subagent-task"), attempt: resume ? (resume.child.attempt ?? 1) + 1 : 1,
        ...(resume ? { resumeSessionFile: resume.sessionFile, compactBeforePrompt: resume.compact, resumeMessage: resume.message } : {}),
        directory: join(this.root, "workers", randomBytes(12).toString("hex")), spec, state: "pending", operatorCapability: randomBytes(32).toString("hex"), started: false, notifiedSequence: 0 })) };
    await this.serial(async () => {
      if (signal?.aborted || this.closed) throw new Error("Launch cancelled before commit");
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
  hasOwnedGroups(owner: string): boolean { return [...this.groups.values()].some(g => g.owner === owner); }
  async operation(params: any, owner: string, signal?: AbortSignal): Promise<any | undefined> {
    const op = params.operation;
    if (!op) return;
    if (this.closed) throw new Error("Native TUI controller is closing");
    const ownedGroups = [...this.groups.values()].filter(g => g.owner === owner);
    let selected: Group | undefined;
    let child: Child | undefined;
    if (params.child_id || params.task_id) {
      const found = this.byChild(owner, params.child_id ?? params.task_id); selected = found?.group; child = found?.child;
    } else if (params.job_id) selected = this.owned(owner, params.job_id);
    if (selected && params.job_id && selected.id !== params.job_id) throw new Error("Child does not belong to the requested group");
    const globalOp = ["list", "tasks", "wait_any", "wait_all"].includes(op);
    if (!selected && (!globalOp || !ownedGroups.length)) return;
    await this.refresh(owner);
    if (op === "list" || op === "tasks") return response(ownedGroups.slice(-(params.limit ?? 20)).map(g => this.text(g)).join("\n\n"), { operation: op, groups: ownedGroups.map(g => this.publicGroup(g)), ...(op === "tasks" ? { tasks: this.taskList(owner) } : {}) });
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
      const checkpoint = c.requiresCompaction || (c.lastOutcome as any)?.state === "checkpointed";
      if (op === "resume" && checkpoint && params.compact === false) throw new Error("Checkpoint continuation requires compaction");
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
            { child: c, sessionFile: m.sessionFile, compact: params.compact ?? checkpoint, message: params.message });
        } finally { this.resuming.delete(c.taskId); }
      }
      if (op === "resume" && (params.compact === true || checkpoint)) {
        const compacted = await callTuiWorker(m!, { operation: "compact" }, { timeoutMs: 30_000 });
        if (!compacted.ok) throw new Error(`Resume compaction failed: ${compacted.code}`);
      }
      const result = await callTuiWorker(m!, { operation: "prompt", mode: params.control_mode ?? "steer", message: params.message ?? "Continue from the saved task context." });
      if (!result.ok) throw new Error(`Worker prompt failed: ${result.code}`);
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
      for (const c of g.children) { const m = this.manifest(c); if (m && !c.reaped) { await this.tmux.reap(m); c.reaped = true; this.save(g); } }
    });
    if (op === "wait" || op === "wait_group") {
      const deadline = Date.now() + (params.wait_ms ?? 1000);
      while (g.children.some(active) && Date.now() < deadline) { if (signal?.aborted) throw new Error("Wait cancelled; worker continues"); await pause(100); await this.refresh(owner); }
    }
    if (op === "result") {
      const c = child ?? g.children[(params.child ?? 1) - 1];
      if (!c?.report) return response("Result not ready; use bounded wait/status.", { operation: op, job_id: g.id });
      const raw = readPrivateJson(c.report) as any;
      const text = params.diagnostics ? JSON.stringify(raw, null, 2) : messageText(raw.assistant);
      const bytes = Buffer.from(text), offset = params.offset ?? 0, limit = params.limit ?? 48 * 1024;
      return response(bytes.subarray(offset, offset + limit).toString("utf8"), { operation: op, job_id: g.id, child_id: c.childId,
        artifact: c.report, offset, next_offset: Math.min(bytes.length, offset + limit), complete: offset + limit >= bytes.length, task_outcome: c.lastOutcome });
    }
    return response(this.text(g, op === "output"), { operation: op, job_id: g.id, group: this.publicGroup(g) });
  }
}
