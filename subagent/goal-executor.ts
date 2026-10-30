import type { DelegatedGoalEntry, DelegatedGoalChild } from "../workflows/delegated-goals.ts";
import { sameGoalWorker, type GoalWorkerIdentity } from "./goal-rpc.ts";
import type { GoalQuestionReply } from "../workflows/goal-story.ts";

export type ChildGoalSnapshot = {
  goalId: string; activationId?: string; revision?: number; status: DelegatedGoalEntry["status"]; executionStopped: boolean; waiting: string | null;
  tasks?: DelegatedGoalEntry["tasks"]; tokensUsed?: number; automaticTurns?: number;
  noProgressTurns?: number; summary?: string | null;
  story?: DelegatedGoalEntry["story"];
  diagnostics?: DelegatedGoalEntry["diagnostics"];
  limitsEditable?: boolean; policyRevision?: number; tokenBudget?: number | null;
  limits?: DelegatedGoalEntry["continuationLimits"];
};
export async function resumeRestoredGoal(
  observe: () => Promise<ChildGoalSnapshot>,
  resume: () => Promise<ChildGoalSnapshot>,
): Promise<ChildGoalSnapshot> {
  const restored = await observe();
  if (!["paused", "blocked", "usage_limited", "budget_limited"].includes(restored.status) || !restored.executionStopped)
    throw new Error("Dedicated goal restore must be resumable and idle before explicit Resume");
  return await resume();
}

export type GoalChildHandle = {
  identity: GoalWorkerIdentity;
  model: string;
  start(entry: Readonly<DelegatedGoalEntry>): Promise<ChildGoalSnapshot>;
  resume(expectedGoalId?: string, expectedActivationId?: string): Promise<ChildGoalSnapshot>;
  pause(expectedGoalId?: string, expectedActivationId?: string): Promise<ChildGoalSnapshot>;
  observe(): Promise<ChildGoalSnapshot>;
  answer?(reply: GoalQuestionReply, requestId: string): Promise<ChildGoalSnapshot>;
  updateLimits?(entry: Readonly<DelegatedGoalEntry>, expectedGoalId: string, expectedPolicyRevision: number, expectedActivationId: string): Promise<ChildGoalSnapshot>;
  /** Resolves only once the owned execution and its process group have exited. */
  stop(completion?: ChildGoalSnapshot): Promise<void>;
};
export function createDelegatedGoalExecutor(options: {
  sessionId: string; runtimeId: string;
  /** Launch the resolved coordinator role without prompting before structured start/resume. */
  launch(entry: Readonly<DelegatedGoalEntry>, previous?: DelegatedGoalChild): Promise<GoalChildHandle>;
  verifyStopped?(entry: Readonly<DelegatedGoalEntry>): Promise<void>;
  retainedCompletion?(entry: Readonly<DelegatedGoalEntry>): Promise<ChildGoalSnapshot | null>;
  executionUnavailableReason?(): string | null;
  reviewRoot?(entry: Readonly<DelegatedGoalEntry>): Promise<string>;
}) {
  const bindings = new Map<string, { handle: GoalChildHandle; identity: GoalWorkerIdentity; goalId: string; stopped: boolean; last: ChildGoalSnapshot }>();
  const restorationFailures = new Map<string, string>();
  let lane: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = lane.then(fn); lane = result.catch(() => {}); return result;
  };
  const binding = (entry: Readonly<DelegatedGoalEntry>) => {
    const b = bindings.get(entry.id), child = entry.child;
    if (!b || !child || !sameGoalWorker(b.identity, b.handle.identity)
      || child.taskId !== b.identity.taskId || child.childId !== b.identity.childId
      || child.jobId !== b.identity.jobId || child.attempt !== b.identity.attempt)
      throw new Error("Stale dedicated goal child binding");
    return b;
  };
  const validate = (snapshot: ChildGoalSnapshot, goalId?: string, activationId?: string) => {
    if (!snapshot || typeof snapshot.goalId !== "string" || !snapshot.goalId
      || (goalId && snapshot.goalId !== goalId) || (activationId && snapshot.activationId !== activationId) || !["active", "paused", "blocked", "usage_limited", "budget_limited", "complete"].includes(snapshot.status)
      || typeof snapshot.executionStopped !== "boolean"
      || !(snapshot.waiting === null || typeof snapshot.waiting === "string"))
      throw new Error("Invalid dedicated child goal observation");
    return snapshot;
  };
  async function launch(entry: Readonly<DelegatedGoalEntry>, resume: boolean): Promise<DelegatedGoalChild> {
    const unavailable = restorationFailures.values().next().value ?? options.executionUnavailableReason?.();
    if (unavailable) throw new Error(unavailable);
    const previous = resume && bindings.has(entry.id) ? binding(entry) : undefined;
    if (resume && (!entry.child || (previous && !previous.stopped))) throw new Error("Previous dedicated goal execution is not stopped");
    if (resume && !previous) await verifyStopped(entry);
    if (!resume && (entry.child || bindings.has(entry.id))) throw new Error("Goal already has a child");
    const handle = await options.launch(structuredClone(entry), resume ? structuredClone(entry.child!) : undefined);
    const id = structuredClone(handle.identity);
    try {
      if (typeof handle.model !== "string" || !handle.model.trim() || handle.model.length > 512 || id.sessionId !== options.sessionId || id.runtimeId !== options.runtimeId
        || !Number.isSafeInteger(id.attempt) || id.attempt < 1
        || !id.taskId || !id.childId || !id.jobId || !id.workerEpoch
        || (resume && (id.taskId !== entry.child!.taskId || id.attempt !== entry.child!.attempt + 1
          || id.childId === entry.child!.childId || (previous && id.workerEpoch === previous.identity.workerEpoch))))
        throw new Error("Invalid dedicated goal launch identity");
      for (const [entryId, owned] of bindings) {
        if (entryId !== entry.id && (owned.identity.taskId === id.taskId || owned.identity.childId === id.childId))
          throw new Error("Dedicated child execution is already bound to another goal");
      }
      const restored = resume ? validate(await handle.observe(), previous?.goalId, previous?.last.activationId) : undefined;
      // Goal identity is stable. Bind the new activation separately; the native
      // worker epoch still fences this exact process/attempt.
      const snapshot = validate(await (resume ? handle.resume(restored!.goalId, restored!.activationId) : handle.start(structuredClone(entry))));
      if (restored && (snapshot.goalId !== restored.goalId || !snapshot.activationId || snapshot.activationId === restored.activationId)) throw new Error("Dedicated goal activation did not change on Resume");
      if (!sameGoalWorker(id, handle.identity)) throw new Error("Dedicated goal attempt changed during launch");
      if (snapshot.status === "paused") throw new Error("Dedicated child goal did not become active");
      const bound = { handle, identity: id, goalId: snapshot.goalId, stopped: false, last: structuredClone(snapshot) };
      bindings.set(entry.id, bound);
      if (snapshot.status !== "active") {
        await handle.stop(snapshot.status === "complete" ? snapshot : undefined);
        bound.stopped = true;
        bound.last.executionStopped = true;
      }
      return { taskId: id.taskId, childId: id.childId, jobId: id.jobId, attempt: id.attempt, model: handle.model };
    } catch (error) { await handle.stop(); throw error; }
  }
  async function verifyStopped(entry: Readonly<DelegatedGoalEntry>): Promise<void> {
    if (!entry.child) return;
    if (bindings.has(entry.id)) {
      if (!binding(entry).stopped) throw new Error("Dedicated goal execution is not stopped");
      restorationFailures.delete(entry.id);
    } else {
      if (!options.verifyStopped) throw new Error("Dedicated goal stop verification is unavailable");
      try {
        await options.verifyStopped(entry);
        restorationFailures.delete(entry.id);
      } catch (error) {
        restorationFailures.set(entry.id, `Dedicated child stop verification unavailable: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    }
  }
  return {
    protocol: 1 as const,
    sessionId: options.sessionId,
    executionAvailable: () => restorationFailures.size === 0 && (options.executionUnavailableReason?.() ?? null) === null,
    executionUnavailableReason: () => restorationFailures.values().next().value ?? options.executionUnavailableReason?.() ?? null,
    verifyStopped: (entry: Readonly<DelegatedGoalEntry>) => serialize(() => verifyStopped(entry)),
    reviewRoot: (entry: Readonly<DelegatedGoalEntry>) => serialize(async () => {
      if (!entry.child || !options.reviewRoot) throw new Error("Goal review access unavailable");
      if (bindings.has(entry.id)) binding(entry);
      return options.reviewRoot(entry);
    }),
    // Edits are parent metadata only. The next explicit Resume synchronizes
    // that durable entry into the restored, paused engine before activation.
    update: (entry: Readonly<DelegatedGoalEntry>) => serialize(() => verifyStopped(entry)),
    updateLimits: (entry: Readonly<DelegatedGoalEntry>) => serialize(async () => {
      // Stopped workers consume the durable parent policy only on explicit Resume.
      if (!bindings.has(entry.id)) { await verifyStopped(entry); return; }
      const b = binding(entry);
      if (b.stopped) return;
      const before = validate(await b.handle.observe(), b.goalId, b.last.activationId);
      if (!before.limitsEditable || !Number.isSafeInteger(before.policyRevision) || !before.activationId || !b.handle.updateLimits)
        throw new Error("Worker does not support live limit editing; reload required");
      binding(entry);
      const observed = validate(await b.handle.updateLimits(entry, b.goalId, before.policyRevision!, before.activationId!), b.goalId);
      binding(entry);
      if (observed.activationId !== before.activationId) throw new Error("Child goal activation changed during limit edit");
      if (observed.tokenBudget !== entry.tokenBudget || JSON.stringify(observed.limits) !== JSON.stringify(entry.continuationLimits))
        throw new Error("Child limit policy receipt differs from requested policy");
      // Do not stop a process here: it may be finishing a tool at the safe boundary.
      b.last = structuredClone(observed);
    }),
    answer: (entry: Readonly<DelegatedGoalEntry>, reply: GoalQuestionReply, requestId: string) => serialize(async () => {
      const b = binding(entry);
      if (b.stopped || !b.handle.answer || reply.workerEpoch !== b.identity.workerEpoch) throw new Error("Goal question worker is unavailable or changed");
      const observed = validate(await b.handle.answer(reply, requestId), b.goalId, b.last.activationId);
      binding(entry); b.last = structuredClone(observed);
      return structuredClone(observed);
    }),
    start: (entry: Readonly<DelegatedGoalEntry>) => serialize(() => launch(entry, false)),
    resume: (entry: Readonly<DelegatedGoalEntry>) => serialize(() => launch(entry, true)),
    pause: (entry: Readonly<DelegatedGoalEntry>) => serialize(async () => {
      if (!bindings.has(entry.id)) { await verifyStopped(entry); return; }
      const b = binding(entry);
      if (b.stopped) return structuredClone(b.last);
      const snapshot = validate(await b.handle.pause(b.goalId, b.last.activationId), b.goalId, b.last.activationId);
      binding(entry);
      if (snapshot.status !== "complete" && (!["paused", "blocked", "usage_limited", "budget_limited"].includes(snapshot.status) || !snapshot.executionStopped))
        throw new Error("Dedicated child goal pause did not verify stopped execution");
      await b.handle.stop(snapshot.status === "complete" ? snapshot : undefined);
      if (snapshot.status === "complete") snapshot.executionStopped = true;
      binding(entry);
      b.stopped = true;
      restorationFailures.delete(entry.id);
      b.last = structuredClone(snapshot);
      return structuredClone(b.last);
    }),
    observe: (entry: Readonly<DelegatedGoalEntry>) => serialize(async () => {
      // A missing in-memory binding is not stop evidence. Reconcile only from
      // the exact durable task/attempt process proof, never by relaunching.
      if (!bindings.has(entry.id)) {
        if (!entry.child) return null;
        try { await verifyStopped(entry); }
        catch { return null; }
        const completed = await options.retainedCompletion?.(entry);
        if (completed) {
          validate(completed);
          if (completed.status !== "complete" || !completed.executionStopped) throw new Error("Invalid retained completion");
          return completed;
        }
        return { status: "paused" as const, executionStopped: true, waiting: null,
          summary: "Dedicated child execution stopped during parent reload; explicit Resume is required.", goalId: undefined };
      }
      const b = binding(entry);
      if (b.stopped) return structuredClone(b.last);
      let observed: ChildGoalSnapshot;
      try { observed = await b.handle.observe(); }
      catch (error) {
        try {
          if (!options.verifyStopped) throw new Error("Exact retained execution stop proof is unavailable");
          await options.verifyStopped(entry);
          binding(entry);
          await b.handle.stop();
          binding(entry);
          b.stopped = true;
          b.last = { ...b.last, status: "paused", executionStopped: true, waiting: null,
            summary: "Owned dedicated child execution exited; explicit Resume is required." };
          restorationFailures.delete(entry.id);
          return structuredClone(b.last);
        } catch (proofError) {
          restorationFailures.set(entry.id, `Dedicated child observation unavailable: ${error instanceof Error ? error.message : String(error)}; stop proof: ${proofError instanceof Error ? proofError.message : String(proofError)}`);
          return null;
        }
      }
      const snapshot = validate(observed, b.goalId, b.last.activationId);
      restorationFailures.delete(entry.id);
      binding(entry);
      if (snapshot.status !== "active") {
        await b.handle.stop(snapshot.status === "complete" ? snapshot : undefined);
        binding(entry);
        b.stopped = true;
        snapshot.executionStopped = true;
      }
      b.last = structuredClone(snapshot);
      return structuredClone(snapshot);
    }),
  };
}
