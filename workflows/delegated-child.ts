import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalRuntime } from "./goal/runtime.js";
import type { GoalCommandController } from "./goal/commands.js";
import { validateDelegatedGoals, type DelegatedGoalEntry } from "./delegated-goals.ts";
import { readGoalTasks, writeProgress } from "../shared/goal-progress.ts";

import { createGoalStoryRecorder, GOAL_STORY_ENTRY } from "./goal-story-recorder.ts";
const BINDING = "delegated-goal-child-binding-v1";
/** Trusted worker-only seam into the EXISTING per-child engine. No parent registry. */
export function createDelegatedChildGoalService(pi: ExtensionAPI, initial: ExtensionContext, runtime: GoalRuntime, commands: GoalCommandController) {
  let ctx = initial, closed = false, lane: Promise<unknown> = Promise.resolve();
  const sessionId = ctx.sessionManager.getSessionId();
  const active = () => runtime.activeGoal;
  // The authenticated launcher seeds these from the parent's confirmed policy.
  let confirmedLimits = { ...runtime.settings.continuationLimits };
  const applyConfirmedLimits = () => { runtime.settings = { ...runtime.settings, continuationLimits: { ...confirmedLimits } }; };
  let binding: string | undefined, boundProgressId: string | undefined;
  for (const entry of ctx.sessionManager.getBranch() as any[]) {
    if (entry.type === "custom" && entry.customType === BINDING && typeof entry.data?.goalId === "string") {
      binding = entry.data.goalId;
      boundProgressId = typeof entry.data.progressId === "string" ? entry.data.progressId : undefined;
    }
  }
  let recorder = binding ? createGoalStoryRecorder(binding, ctx.sessionManager.getBranch() as unknown[], data => pi.appendEntry(GOAL_STORY_ENTRY, data)) : undefined;
  const storyState = () => {
    const goal = runtime.activeGoal ?? completedProjection()?.state;
    return goal ? { status: goal.status, tasks: readGoalTasks(ctx, goal) } : undefined;
  };
  function recordState(at?: number) { const state = storyState(); if (state) recorder?.observe(state, at); }
  function bindProgress(goal: NonNullable<GoalRuntime["activeGoal"]>) {
    const progressId = goal.progressId ?? goal.id;
    if (boundProgressId && boundProgressId !== progressId) throw new Error("Child goal lineage changed");
    if (!boundProgressId) {
      boundProgressId = progressId;
      pi.appendEntry(BINDING, { goalId: binding, progressId });
    }
  }
  // Upgrade an existing paused binding before any authenticated Resume can run.
  if (binding && runtime.activeGoal) bindProgress(runtime.activeGoal);
  function current(entryId?: string, childGoalId?: string) {
    if (closed || ctx.sessionManager.getSessionId() !== sessionId) throw new Error("Stale child goal service");
    if (entryId !== undefined && binding !== entryId) throw new Error("Child goal ownership changed");
    if (childGoalId !== undefined && (runtime.activeGoal?.id ?? completedProjection()?.state.id) !== childGoalId)
      throw new Error("Child goal identity changed");
    if (runtime.activeGoal && boundProgressId && (runtime.activeGoal.progressId ?? runtime.activeGoal.id) !== boundProgressId)
      throw new Error("Child goal lineage changed");
  }
  function completedProjection() {
    return retainedGoalCompletion(ctx.sessionManager.getBranch() as any[], binding, boundProgressId);
  }

  function snapshot() {
    current();
    const completed = runtime.activeGoal ? undefined : completedProjection();
    if (completed && Number.isSafeInteger(completed.endedAt)) recordState(completed.endedAt);
    const goal = runtime.activeGoal ?? completed?.state;
    const terminal = runtime.snapshotSettingsApplicationState().terminalDetails;
    return { entryId: binding ?? null, childGoalId: goal?.id ?? null, story: recorder?.snapshot(), limits: { ...runtime.settings.continuationLimits }, policyRevision: runtime.policyRevision, tokenBudget: goal?.tokenBudget ?? null, goal: goal ? {
      status: goal.status, tasks: readGoalTasks(ctx, goal), tokensUsed: goal.tokensUsed,
      automaticTurns: goal.automaticModelTurns, noProgressTurns: goal.toolFreeRepeatCount,
      summary: completed?.summary ?? (terminal?.goalId === goal.id ? terminal.summary ?? terminal.reason ?? null : null),
      waiting: goal.waiting?.reason ?? null,
    } : null };
  }
  function serial<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = lane.then(fn); lane = next.catch(() => {}); return next;
  }
  const commandContext = () => new Proxy(ctx, { get(target, key) {
    if (key === "hasUI") return true;
    if (key === "ui") return { ...target.ui, confirm: async () => false };
    return Reflect.get(target, key, target);
  } });
  return {
    protocol: 1 as const, sessionId, snapshot,
    recordState,
    recordActivity(id: string, text: string) { current(); recorder?.activity(id, text); },
    bootstrap(entry: Readonly<DelegatedGoalEntry>) { return serial(async () => {
      current();
      if (binding && binding !== entry.id) throw new Error("Dedicated child belongs to another goal");
      if (binding) throw new Error("Dedicated child is already bound; existing sessions require Resume");
      if (runtime.activeGoal) throw new Error("Dedicated child already has a goal; inspect or resume it");
      if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Dedicated child is not idle");
      if (!binding) { pi.appendEntry(BINDING, { goalId: entry.id }); binding = entry.id; }
      recorder = createGoalStoryRecorder(binding, ctx.sessionManager.getBranch() as unknown[], data => pi.appendEntry(GOAL_STORY_ENTRY, data));
      applyConfirmedLimits();
      let activatedGoalId: string | undefined;
      await commands.startGoal(entry.text, entry.tokenBudget ?? undefined, commandContext(), goal => {
        // Bind the stable lineage BEFORE dispatch; resumed contract IDs rotate.
        bindProgress(goal);
        activatedGoalId = goal.id;
        // Seed its existing checklist before its first goal prompt is dispatched.
        runtime.persistGoal(goal);
        if (entry.tasks.length) writeProgress(pi, ctx, entry.tasks, goal.id, true);
        recorder?.baseline({ status: goal.status, tasks: readGoalTasks(ctx, goal) });
      }, undefined, () => !closed);
      const observed = snapshot();
      if (!activatedGoalId || observed.childGoalId !== activatedGoalId
        || !["active", "complete"].includes(observed.goal?.status ?? "")) throw new Error("Child goal activation failed");
      return observed;
    }); },
    pause(entryId: string, childGoalId: string) { return serial(() => {
      current(entryId, childGoalId);
      if (runtime.activeGoal?.status === "active") commands.pauseGoal(commandContext());
      if (runtime.activeGoal?.status === "active") throw new Error("Child goal did not pause");
      recordState();
      return snapshot();
    }); },
    updateLimits(entryId: string, childGoalId: string, revision: number, entry: Readonly<DelegatedGoalEntry>) { return serial(() => {
      current(entryId, childGoalId);
      if (entry.id !== entryId) throw new Error("Limit policy belongs to another goal");
      validateDelegatedGoals({ version: 1, revision: 0, entries: [structuredClone(entry)] });
      if (runtime.policyRevision !== revision) throw new Error("Child goal policy changed");
      const previousSettings = runtime.settings;
      // The parent sends resolved policy: null here means unlimited, not the
      // previous launch's finite default. Change defaults and policy together.
      runtime.settings = { ...runtime.settings, continuationLimits: { ...entry.continuationLimits! } as typeof confirmedLimits };
      try { runtime.updateGoalLimits(ctx, childGoalId, runtime.policyRevision, entry.tokenBudget, entry.continuationLimits!); }
      catch (error) { runtime.settings = previousSettings; throw error; }
      confirmedLimits = { ...runtime.continuationLimits };
      applyConfirmedLimits();
      recordState();
      return snapshot();
    }); },
    resume(entryId: string, childGoalId: string, entry?: Readonly<DelegatedGoalEntry>) { return serial(async () => {
      current(entryId, childGoalId);
      if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Dedicated child is not idle");
      if (runtime.activeGoal?.status === "active") throw new Error("Child goal already active");
      if (!entry) throw new Error("Resume requires current delegated goal metadata");
      if (entry) {
        if (entry.id !== entryId) throw new Error("Resume metadata belongs to another goal");
        validateDelegatedGoals({ version: 1, revision: 0, entries: [structuredClone(entry)] });
        const goal = active();
        if (!goal) throw new Error("Child goal is missing");
        // Edit is metadata-only in the parent. Synchronize into this existing
        // paused engine BEFORE activation; never bootstrap a second goal here.
        runtime.activeGoal = { ...goal, text: entry.text, tokenBudget: entry.tokenBudget ?? undefined,
          tokenBudgetExplicit: entry.tokenBudget !== null, continuationLimits: entry.continuationLimits };
        runtime.persistGoal(runtime.activeGoal);
        writeProgress(pi, ctx, entry.tasks, goal.id, true);
      }
      const resumedLineage = boundProgressId;
      applyConfirmedLimits();
      await commands.resumeGoal(commandContext());
      recordState();
      const observed = snapshot();
      if (!resumedLineage || boundProgressId !== resumedLineage || observed.childGoalId === childGoalId
        || !["active", "complete"].includes(observed.goal?.status ?? "")) throw new Error("Child goal resume failed");
      return observed;
    }); },
    refreshContext(next: ExtensionContext) { if (!closed && next.sessionManager.getSessionId() === sessionId) ctx = next; },
    dispose() { closed = true; },
  };
}

export function retainedGoalCompletion(branch: any[], binding?: string, boundProgressId?: string) {
  if (!binding || !boundProgressId) return undefined;
    // Completion clears activeGoal. Require the bound stable lineage, the exact
    // completed instance, its then-current contract, and an accepted engine tool
    // result. Neither ordinary assistant text nor unrelated history qualifies.
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index], history = entry?.data;
      if (entry?.type !== "custom" || entry.customType !== "goal-history" || history?.status !== "completed"
        || history.progressId !== boundProgressId || typeof history.id !== "string" || typeof history.summary !== "string" || !history.summary.trim()) continue;
      const prior = branch.slice(0, index);
      const state = prior.findLast(e => e.type === "custom" && e.customType === "goal-state" && e.data?.goal?.id === history.id)?.data?.goal;
      const contract = prior.findLast(e => e.type === "custom_message" && e.customType === "goal-contract");
      if (state?.status !== "complete" || (state.progressId ?? state.id) !== boundProgressId
        || contract?.details?.state !== "active" || contract.details.goalId !== history.id) continue;
      const accepted = branch.slice(index + 1).find(e => e.type === "message" && e.message?.role === "toolResult"
        && e.message.toolName === "goal_complete" && e.message.isError !== true
        && e.message.details?.goal_id === history.id && e.message.details?.summary === history.summary
        && e.message.content?.some((part: any) => part.type === "text" && part.text === `Goal complete: ${history.summary}`));
      if (!accepted) continue;
      const call = prior.findLast(e => e.type === "message" && e.message?.role === "assistant"
        && e.message.content?.some((part: any) => part.type === "toolCall" && part.name === "goal_complete"
          && part.id === accepted.message.toolCallId && part.arguments?.goal_id === history.id && part.arguments?.summary === history.summary));
      if (call) return { state, summary: history.summary, endedAt: history.endedAt };
    }
    return undefined;
}
