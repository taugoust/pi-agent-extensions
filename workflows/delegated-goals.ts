import { randomUUID } from "node:crypto";
import { emptyGoalStory, recordGoalEvent, validateGoalStory, mergeGoalStory, type GoalStory, type GoalQuestionReply } from "./goal-story.ts";
import { validInteractionAnswer } from "../shared/task-interactions.ts";
import { validateGoalLimitOverrides, type GoalContinuationLimits } from "../shared/delegated-goal-policy.ts";

export { DEDICATED_GOAL_LIMITS } from "../shared/delegated-goal-policy.ts";

export type DelegatedGoalStatus = "paused" | "active" | "blocked" | "usage_limited" | "budget_limited" | "complete" | "cleared";
export type DelegatedGoalChild = { taskId: string; childId: string; jobId: string; attempt: number };
export type DelegatedGoalEntry = {
  id: string; revision: number; policyRevision?: number; text: string; status: DelegatedGoalStatus;
  tasks: Array<{ id: string; text: string; status: "pending" | "in_progress" | "completed" | "blocked" }>;
  child: DelegatedGoalChild | null; tokenBudget: number | null; tokensUsed: number;
  continuationLimits?: Partial<GoalContinuationLimits>;
  automaticTurns: number; noProgressTurns: number; summary: string | null; waiting: string | null;
  story?: GoalStory;
};
export type DelegatedGoals = { version: 1; revision: number; entries: DelegatedGoalEntry[] };
export type DelegatedGoalAction = "goals.create" | "goals.start" | "goals.pause" | "goals.resume" | "goals.edit" | "goals.limits" | "goals.clear" | "goals.add_task" | "goals.answer";
export type DelegatedGoalRequest = {
  action: DelegatedGoalAction; requestId: string; expectedGoalId: string | null;
  expectedEntryRevision?: number; expectedPolicyRevision?: number; expectedRegistryRevision?: number;
  objective?: string; text?: string; tokenBudget?: number | null;
  questionId?: string; questionRevision?: number; workerEpoch?: string; answer?: GoalQuestionReply["answer"];
  continuationLimits?: Partial<GoalContinuationLimits>;
};
/** Child execution is deliberately injected: this registry never runs a parent goal. */
export type DelegatedGoalObservation = Partial<Pick<DelegatedGoalEntry, "status" | "tasks" | "tokensUsed" | "automaticTurns" | "noProgressTurns" | "summary" | "waiting" | "story">>;
export interface DelegatedGoalExecutor {
  /** Live preflight; object presence alone does not authorize executable tools. */
  executionAvailable?(): boolean;
  executionUnavailableReason?(): string | null;
  start(entry: Readonly<DelegatedGoalEntry>): Promise<DelegatedGoalChild>;
  resume(entry: Readonly<DelegatedGoalEntry>): Promise<DelegatedGoalChild>;
  pause(entry: Readonly<DelegatedGoalEntry>): Promise<void | DelegatedGoalObservation>;
  updateLimits?(entry: Readonly<DelegatedGoalEntry>): Promise<void>;
  observe?(entry: Readonly<DelegatedGoalEntry>): Promise<DelegatedGoalObservation | null>;
  answer?(entry: Readonly<DelegatedGoalEntry>, reply: GoalQuestionReply, requestId: string): Promise<DelegatedGoalObservation>;
  verifyStopped?(entry: Readonly<DelegatedGoalEntry>): Promise<void>;
}
export type DelegatedGoalIntent = { requestId: string; action: string; entryId: string; expectedEntryRevision: number };
const copy = <T>(value: T): T => structuredClone(value);
const fingerprint = (r: DelegatedGoalRequest) => JSON.stringify(Object.keys(r).sort().map(k => [k, r[k as keyof typeof r]]));
function objective(value: unknown, max: number) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new Error(`Expected text of 1–${max} characters`);
  return value.trim();
}
export function validateDelegatedGoals(state: DelegatedGoals): void {
  if (state?.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.entries) || state.entries.length > 1000) throw new Error("Invalid delegated registry");
  const ids = new Set<string>(), childTasks = new Set<string>();
  for (const e of state.entries) {
    if (!e || !/^[a-f0-9-]{36}$/i.test(e.id) || ids.has(e.id) || !Number.isSafeInteger(e.revision) || e.revision < 1) throw new Error("Invalid delegated identity");
    if (e.policyRevision !== undefined && (!Number.isSafeInteger(e.policyRevision) || e.policyRevision < 1)) throw new Error("Invalid goal policy revision");
    ids.add(e.id); objective(e.text, 4000);
    if (!["paused", "active", "blocked", "usage_limited", "budget_limited", "complete", "cleared"].includes(e.status)) throw new Error("Invalid delegated status");
    budget(e.tokenBudget === null ? undefined : e.tokenBudget);
    validateGoalLimitOverrides(e.continuationLimits);
    validateGoalStory(e.story);
    if (![e.tokensUsed, e.automaticTurns, e.noProgressTurns].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)) throw new Error("Invalid delegated accounting");
    if (!Array.isArray(e.tasks) || e.tasks.length > 50 || new Set(e.tasks.map(t => t.id)).size !== e.tasks.length) throw new Error("Invalid delegated tasks");
    if (new Set(e.tasks.map(t => objective(t.text, 503))).size !== e.tasks.length) throw new Error("Goal tasks need distinct descriptions after trimming");
    for (const task of e.tasks) {
      if (typeof task.id !== "string" || !task.id || task.id.length > 128 || !["pending", "in_progress", "completed", "blocked"].includes(task.status)) throw new Error("Invalid delegated task");
      objective(task.text, 503);
    }
    if (e.child !== null && (!e.child || ![e.child.taskId, e.child.childId, e.child.jobId].every(id => typeof id === "string" && id.length > 0 && id.length <= 128) || !Number.isSafeInteger(e.child.attempt) || e.child.attempt < 1)) throw new Error("Invalid child linkage");
    if (e.child) {
      if (childTasks.has(e.child.taskId)) throw new Error("Dedicated child task cannot belong to multiple goals");
      childTasks.add(e.child.taskId);
    }
    if (e.status === "active" && !e.child) throw new Error("Active delegated goal requires child linkage");
    for (const [value, max] of [[e.summary, 6000], [e.waiting, 1000]] as const) if (value !== null && (typeof value !== "string" || value.length > max)) throw new Error("Invalid delegated status detail");
  }
}
function normalizeTaskDescriptions(entry: DelegatedGoalEntry): void {
  if (Array.isArray(entry.tasks)) entry.tasks = entry.tasks.map(task => ({ ...task, text: typeof task.text === "string" ? task.text.trim() : task.text }));
}
function budget(value: unknown) {
  if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1_000_000)) throw new Error("Invalid token budget");
  return value as number | undefined;
}

/** Session-bound durable metadata. One serialized mutation lane, including child RPC.
 * Persistence must be atomic and must not write goal-state or parent message history.
 * Child failures leave metadata unchanged; callers must inspect uncertain child RPC
 * outcomes before retrying with a new request ID.
 */
export class DelegatedGoalRegistry {
  private state: DelegatedGoals;
  private lane: Promise<unknown> = Promise.resolve();
  private requests = new Map<string, { fingerprint: string; promise: Promise<DelegatedGoals> }>();
  private pending: DelegatedGoalIntent | null;
  constructor(readonly sessionId: string, private executor: DelegatedGoalExecutor,
    private persist: (state: DelegatedGoals) => void,
    initial: DelegatedGoals = { version: 1, revision: 0, entries: [] },
    private journal: { initial?: DelegatedGoalIntent | null; save: (intent: DelegatedGoalIntent | null) => void } = { save() {} }) {
    validateDelegatedGoals(initial);
    this.state = copy(initial);
    this.state.entries.forEach(entry => { normalizeTaskDescriptions(entry); entry.policyRevision ??= entry.revision; });
    this.pending = copy(journal.initial ?? null);
  }
  blockedReason(): string | null { return this.pending ? `Dedicated child delivery requires reconciliation (${this.pending.action}, goal ${this.pending.entryId}); affected-goal mutations and new child execution are blocked to prevent duplicate execution` : null; }
  snapshot(): DelegatedGoals { return copy(this.state); }
  refresh(): Promise<void> {
    const result = this.lane.then(async () => {
      if (!this.executor.observe || this.pending) return;
      const next = this.snapshot();
      let changed = false;
      for (const entry of next.entries) {
        if (!entry.child || entry.status !== "active") continue;
        const observed = await this.executor.observe(copy(entry));
        if (!observed) continue;
        if (observed.status === "cleared") throw new Error("Child cannot clear parent goal history");
        const previous = JSON.stringify(entry);
        const previousStatus = entry.status;
        for (const key of ["status", "tasks", "tokensUsed", "automaticTurns", "noProgressTurns", "summary", "waiting"] as const) {
          if (Object.hasOwn(observed, key)) (entry as any)[key] = copy(observed[key]);
        }
        if (observed.story) entry.story = mergeGoalStory(entry.story, observed.story);
        normalizeTaskDescriptions(entry);
        if (JSON.stringify(entry) !== previous) {
          if (entry.status !== previousStatus) entry.policyRevision = (entry.policyRevision ?? 1) + 1;
          entry.revision++; changed = true;
        }
      }
      if (changed) { next.revision++; validateDelegatedGoals(next); this.persist(copy(next)); this.state = next; }
    });
    this.lane = result.catch(() => {});
    return result;
  }
  mutate(sessionId: string, request: DelegatedGoalRequest): Promise<DelegatedGoals> {
    if (sessionId !== this.sessionId) return Promise.reject(new Error("Stale delegated goal session"));
    const r = copy(request), key = fingerprint(r), previous = this.requests.get(r.requestId);
    if (previous) return previous.fingerprint === key ? previous.promise.then(copy) : Promise.reject(new Error("Request ID conflict"));
    if (!r.requestId || this.requests.size >= 2048) return Promise.reject(new Error("Invalid request or request limit reached"));
    const promise = this.lane.then(() => this.apply(r));
    this.requests.set(r.requestId, { fingerprint: key, promise });
    this.lane = promise.catch(() => {});
    return promise.then(copy);
  }
  private async apply(r: DelegatedGoalRequest): Promise<DelegatedGoals> {
    const next = this.snapshot();
    if (this.pending && (r.expectedGoalId === this.pending.entryId ||
      ["goals.start", "goals.resume", "goals.pause"].includes(r.action))) throw new Error(this.blockedReason()!);
    let performedEffect = false;
    const fields = ["operation", "sessionId", "serviceEpoch", "requestId", "action", "expectedGoalId", ...(r.action === "goals.create" ? ["expectedRegistryRevision", "objective", "tokenBudget", "continuationLimits"] : [r.action === "goals.limits" ? "expectedPolicyRevision" : "expectedEntryRevision", ...(r.action === "goals.edit" ? ["objective", "tokenBudget", "continuationLimits"] : r.action === "goals.limits" ? ["tokenBudget", "continuationLimits"] : r.action === "goals.add_task" ? ["text"] : r.action === "goals.answer" ? ["questionId", "questionRevision", "workerEpoch", "answer"] : [])])];
    if (Object.keys(r).some(key => !fields.includes(key))) throw new Error("Unknown delegated goal request fields");
    if (r.action === "goals.create") {
      if (r.expectedGoalId !== null || r.expectedEntryRevision !== undefined) throw new Error("Create requires null goal identity");
      if (r.expectedRegistryRevision !== undefined && r.expectedRegistryRevision !== next.revision) throw new Error("Registry changed");
      if (next.entries.length >= 1000) throw new Error("Delegated goal history limit reached");
      next.entries.push({ id: randomUUID(), revision: 1, policyRevision: 1, text: objective(r.objective, 4000), status: "paused", tasks: [], child: null,
        ...(r.continuationLimits === undefined ? {} : { continuationLimits: copy(r.continuationLimits) }),
        tokenBudget: budget(r.tokenBudget) ?? null, tokensUsed: 0, automaticTurns: 0, noProgressTurns: 0, summary: null, waiting: null });
    } else {
      const entry = next.entries.find(e => e.id === r.expectedGoalId);
      if (!entry || (r.action === "goals.limits" ? entry.policyRevision !== r.expectedPolicyRevision : entry.revision !== r.expectedEntryRevision)) throw new Error("Goal identity or revision changed");
      // Reconcile authenticated completion before writing a lifecycle intent.
      // A stale Pause/Resume is an observation, never a new execution.
      if (entry.child && ["goals.pause", "goals.resume"].includes(r.action)) {
        const observed = await this.executor.observe?.(copy(entry));
        if (observed?.status === "complete" || entry.status === "complete") {
          if (observed) for (const key of ["status", "tasks", "tokensUsed", "automaticTurns", "noProgressTurns", "summary", "waiting"] as const)
            if (Object.hasOwn(observed, key)) (entry as any)[key] = copy(observed[key]);
          if (observed?.story) entry.story = mergeGoalStory(entry.story, observed.story);
          entry.waiting = null;
          entry.policyRevision = (entry.policyRevision ?? 1) + 1;
          entry.revision++; next.revision++;
          validateDelegatedGoals(next); this.persist(copy(next)); this.state = next;
          return this.snapshot();
        }
      }
      if (entry.status === "cleared" || entry.status === "complete") throw new Error("Goal is terminal");
      // Write-ahead fence: lost RPC receipts and persistence failures are uncertain.
      const effect = async <T>(call: () => Promise<T>): Promise<T> => {
        if (["goals.start", "goals.resume"].includes(r.action) && this.executor.executionAvailable?.() === false)
          throw new Error(this.executor.executionUnavailableReason?.() || "Dedicated child execution preflight refused");
        const intent = { requestId: r.requestId, action: r.action, entryId: entry.id, expectedEntryRevision: entry.revision };
        this.journal.save(copy(intent));
        this.pending = intent;
        performedEffect = true;
        return await call();
      };
      switch (r.action) {
        case "goals.start":
          if (entry.status !== "paused" || entry.child) throw new Error("Start requires an unstarted paused goal");
          entry.child = await effect(() => this.executor.start(copy(entry))); entry.status = "active"; break;
        case "goals.resume": {
          if (entry.status === "active" || !entry.child) throw new Error("Resume requires an inactive linked goal");
          if (entry.tokenBudget !== null && entry.tokensUsed >= entry.tokenBudget)
            throw new Error("Goal token budget is still reached; edit or remove the cap before Resume");
          const child = await effect(() => this.executor.resume(copy(entry)));
          if (child.taskId !== entry.child.taskId || child.attempt <= entry.child.attempt) throw new Error("Child task ownership or attempt changed");
          entry.child = child; entry.status = "active"; break;
        }
        case "goals.pause":
          if (entry.status !== "active" || !entry.child) throw new Error("Goal is not active");
          await effect(async () => {
            const result = await this.executor.pause(copy(entry));
            const observed = result ?? await this.executor.observe?.(copy(entry));
            if (observed) {
              for (const key of ["tasks", "tokensUsed", "automaticTurns", "noProgressTurns", "summary", "waiting"] as const)
                if (Object.hasOwn(observed, key)) (entry as any)[key] = copy(observed[key]);
            }
            if (observed?.story) entry.story = mergeGoalStory(entry.story, observed.story);
            entry.status = observed?.status && observed.status !== "active" ? observed.status : "paused";
            if (entry.status === "complete") entry.waiting = null;
          });
          break;
        case "goals.answer": {
          const question = entry.story?.questions?.find(q => q.id === r.questionId);
          if (entry.status !== "active" || !entry.child || !this.executor.answer || !question || question.status !== "pending"
            || question.revision !== r.questionRevision || question.workerEpoch !== r.workerEpoch || !r.answer || !validInteractionAnswer(question.request, r.answer)) throw new Error("Goal question changed or is unavailable");
          // Answers resolve one epoch-bound waiter with an idempotent request ID;
          // they cannot create/resume a child. A cancelled-question race must not
          // poison the lifecycle journal. Lost receipts reconcile via observation.
          const observed = await this.executor.answer!(copy(entry), { questionId: question.id, questionRevision: question.revision, workerEpoch: question.workerEpoch, answer: r.answer! }, r.requestId);
          if (!observed.story) throw new Error("Goal answer receipt is missing");
          entry.story = mergeGoalStory(entry.story, observed.story);
          break;
        }
        case "goals.clear":
          if (entry.status === "active") throw new Error("Pause child before clearing goal");
          if (entry.child) {
            if (!this.executor.verifyStopped) throw new Error("Cannot clear until owned child stop is verified");
            await this.executor.verifyStopped(copy(entry));
          }
          entry.status = "cleared"; break;
        case "goals.limits": {
          if (r.tokenBudget === undefined || r.continuationLimits === undefined) throw new Error("Explicit limit policy required");
          entry.tokenBudget = r.tokenBudget === null ? null : budget(r.tokenBudget)!;
          validateGoalLimitOverrides(r.continuationLimits);
          entry.continuationLimits = copy(r.continuationLimits);
          if (entry.child) {
            if (!this.executor.updateLimits) throw new Error("Worker does not support limit editing");
            await effect(() => this.executor.updateLimits!(copy(entry)));
          }
          break;
        }
        case "goals.edit":
          if (entry.status === "active") throw new Error("Pause goal before editing metadata");
          entry.text = objective(r.objective, 4000);
          if (r.tokenBudget !== undefined) entry.tokenBudget = r.tokenBudget === null ? null : budget(r.tokenBudget)!;
          if (r.continuationLimits !== undefined) entry.continuationLimits = copy(r.continuationLimits);
          break;
        case "goals.add_task":
          if (entry.status === "active") throw new Error("Pause goal before editing tasks");
          if (entry.tasks.length >= 50) throw new Error("Goal task limit reached");
          entry.tasks.push({ id: randomUUID(), text: objective(r.text, 503), status: "pending" });
          break;
        default: throw new Error("Unknown delegated goal action");
      }
      entry.policyRevision = (entry.policyRevision ?? 1) + 1;
      entry.revision++;
    }
    const changed = r.action === "goals.create" ? next.entries.at(-1)! : next.entries.find(entry => entry.id === r.expectedGoalId)!;
    changed.story ??= emptyGoalStory();
    const kind = ({ "goals.create": "created", "goals.start": "started", "goals.pause": changed.status === "complete" ? "completed" : "paused", "goals.resume": "resumed", "goals.edit": "edited", "goals.limits": "edited", "goals.clear": "cleared", "goals.add_task": "task", "goals.answer": undefined } as const)[r.action];
    if (r.action !== "goals.answer") recordGoalEvent(changed.story, kind!, r.action === "goals.add_task" ? `Task added: ${r.text?.trim()}` : `Goal ${kind}`);
    next.revision++;
    next.entries.forEach(normalizeTaskDescriptions);
    validateDelegatedGoals(next);
    this.persist(copy(next));
    this.state = next;
    if (performedEffect) {
      this.journal.save(null);
      this.pending = null;
    }
    return this.snapshot();
  }
}
