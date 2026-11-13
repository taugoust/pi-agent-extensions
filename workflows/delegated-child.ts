import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GoalRuntime } from "./goal/runtime.js";
import type { GoalCommandController } from "./goal/commands.js";
import { validateDelegatedGoals, type DelegatedGoalEntry } from "./delegated-goals.ts";
import { readGoalTasks, writeProgress } from "../shared/goal-progress.ts";

import { createGoalStoryRecorder, GOAL_STORY_ENTRY } from "./goal-story-recorder.ts";
const BINDING = "delegated-goal-child-binding-v1";
/** Trusted worker-only seam into the EXISTING per-child engine. No parent registry. */
export function createDelegatedChildGoalService(
  pi: ExtensionAPI,
  initial: ExtensionContext,
  runtime: GoalRuntime,
  commands: GoalCommandController,
) {
  let ctx = initial;
  let closed = false;
  let lane: Promise<unknown> = Promise.resolve();
  const sessionId = ctx.sessionManager.getSessionId();
  const active = () => runtime.activeGoal;
  // The authenticated launcher seeds these from the parent's confirmed policy.
  let confirmedLimits = { ...runtime.settings.continuationLimits };
  const applyConfirmedLimits = () => {
    runtime.settings = { ...runtime.settings, continuationLimits: { ...confirmedLimits } };
  };
  let binding: string | undefined;
  let boundProgressId: string | undefined;
  for (const entry of ctx.sessionManager.getBranch() as any[]) {
    const isBinding = entry.type === "custom" && entry.customType === BINDING
      && typeof entry.data?.goalId === "string";
    if (!isBinding) continue;
    binding = entry.data.goalId;
    boundProgressId = typeof entry.data.progressId === "string" ? entry.data.progressId : undefined;
  }
  const newRecorder = (goalId: string) => {
    const branch = ctx.sessionManager.getBranch() as unknown[];
    return createGoalStoryRecorder(goalId, branch, data => pi.appendEntry(GOAL_STORY_ENTRY, data));
  };
  let recorder = binding ? newRecorder(binding) : undefined;
  const storyState = () => {
    const goal = runtime.activeGoal ?? completedProjection()?.state;
    return goal ? { status: goal.status, tasks: readGoalTasks(ctx, goal) } : undefined;
  };
  function recordState(at?: number) {
    const state = storyState();
    if (state) recorder?.observe(state, at);
  }
  function bindProgress(goal: NonNullable<GoalRuntime["activeGoal"]>) {
    const progressId = goal.progressId ?? goal.id;
    if (boundProgressId && boundProgressId !== progressId) {
      throw new Error("Child goal lineage changed");
    }
    if (!boundProgressId) {
      boundProgressId = progressId;
      pi.appendEntry(BINDING, { goalId: binding, progressId });
    }
  }
  // Upgrade an existing paused binding before any authenticated Resume can run.
  if (binding && runtime.activeGoal) bindProgress(runtime.activeGoal);
  function current(entryId?: string, childGoalId?: string, activationId?: string) {
    if (closed || ctx.sessionManager.getSessionId() !== sessionId) {
      throw new Error("Stale child goal service");
    }
    if (entryId !== undefined && binding !== entryId) {
      throw new Error("Child goal ownership changed");
    }
    if (childGoalId !== undefined) {
      const goalId = runtime.activeGoal?.id ?? completedProjection()?.state.id;
      if (goalId !== childGoalId) throw new Error("Child goal identity changed");
      const currentActivation = runtime.activeGoal?.activationId
        ?? completedProjection()?.state.activationId
        ?? childGoalId;
      if (activationId !== currentActivation) throw new Error("Child goal activation changed");
    }
    const goal = runtime.activeGoal;
    if (goal && boundProgressId && (goal.progressId ?? goal.id) !== boundProgressId) {
      throw new Error("Child goal lineage changed");
    }
  }
  function completedProjection() {
    const branch = ctx.sessionManager.getBranch() as any[];
    return retainedGoalCompletion(branch, binding, boundProgressId);
  }

  function snapshot() {
    current();
    const completed = runtime.activeGoal ? undefined : completedProjection();
    if (completed && Number.isSafeInteger(completed.endedAt)) recordState(completed.endedAt);
    const goal = runtime.activeGoal ?? completed?.state;
    const terminal = runtime.snapshotSettingsApplicationState().terminalDetails;
    const terminalSummary = terminal?.goalId === goal?.id
      ? terminal?.summary ?? terminal?.reason ?? null
      : null;
    const goalView = goal ? {
      status: goal.status,
      tasks: readGoalTasks(ctx, goal),
      tokensUsed: goal.tokensUsed,
      automaticTurns: goal.automaticModelTurns,
      noProgressTurns: goal.toolFreeRepeatCount,
      summary: completed?.summary ?? terminalSummary,
      waiting: goal.waiting?.reason ?? null,
      prs: goal.prs ?? [],
      checks: goal.checks ?? [],
      diagnostics: {
        waitDeadline: goal.waiting?.resumeAt ?? null,
        lastTaskUpdateAt: goal.lastTaskUpdateAt ?? null,
        lastWake: goal.lastWake ?? null,
        lastBlocker: goal.lastBlocker ?? null,
      },
    } : null;
    return {
      entryId: binding ?? null,
      childGoalId: goal?.id ?? null,
      childActivationId: goal?.activationId ?? goal?.id ?? null,
      revision: goal?.revision ?? null,
      story: recorder?.snapshot(),
      limits: { ...runtime.continuationLimits },
      policyRevision: runtime.policyRevision,
      tokenBudget: goal?.tokenBudget ?? null,
      goal: goalView,
    };
  }
  function serial<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = lane.then(fn);
    lane = next.catch(() => {});
    return next;
  }
  const commandContext = () => new Proxy(ctx, {
    get(target, key) {
      if (key === "hasUI") return true;
      if (key === "ui") return { ...target.ui, confirm: async () => false };
      return Reflect.get(target, key, target);
    },
  });
  const runsOrFinished = (observed: ReturnType<typeof snapshot>) =>
    ["active", "complete"].includes(observed.goal?.status ?? "");

  async function bootstrap(entry: Readonly<DelegatedGoalEntry>) {
    current();
    if (binding && binding !== entry.id) throw new Error("Dedicated child belongs to another goal");
    if (binding) {
      throw new Error("Dedicated child is already bound; existing sessions require Resume");
    }
    if (runtime.activeGoal) {
      throw new Error("Dedicated child already has a goal; inspect or resume it");
    }
    if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Dedicated child is not idle");
    pi.appendEntry(BINDING, { goalId: entry.id });
    binding = entry.id;
    recorder = newRecorder(binding);
    applyConfirmedLimits();
    let activatedGoalId: string | undefined;
    const prepare = (goal: NonNullable<GoalRuntime["activeGoal"]>) => {
      // New execution binds the saved record itself, not a second Goal ID.
      // Existing bindings retain their recorded progressId on Resume, so
      // migration never rewrites historical contracts or checklist lineage.
      goal.id = entry.id;
      goal.tokensUsed = entry.tokensUsed;
      goal.automaticModelTurns = entry.automaticTurns;
      goal.toolFreeRepeatCount = entry.noProgressTurns;
      // Bind the stable lineage BEFORE dispatch; only activation tokens rotate.
      bindProgress(goal);
      activatedGoalId = goal.id;
      // Seed its existing checklist before its first goal prompt is dispatched.
      goal.tasks = structuredClone(entry.tasks);
      recorder?.baseline({ status: goal.status, tasks: readGoalTasks(ctx, goal) });
    };
    const budget = entry.tokenBudget ?? undefined;
    const stillOpen = () => !closed;
    await commands.startGoal(entry.text, budget, commandContext(), prepare, undefined, stillOpen);
    const observed = snapshot();
    if (!activatedGoalId || observed.childGoalId !== activatedGoalId || !runsOrFinished(observed)) {
      throw new Error("Child goal activation failed");
    }
    return observed;
  }

  function pause(entryId: string, childGoalId: string, activationId: string) {
    current(entryId, childGoalId, activationId);
    if (runtime.activeGoal?.status === "active") commands.pauseGoal(commandContext());
    if (runtime.activeGoal?.status === "active") throw new Error("Child goal did not pause");
    recordState();
    return snapshot();
  }

  function updateLimits(
    entryId: string, childGoalId: string, revision: number,
    entry: Readonly<DelegatedGoalEntry>, activationId: string,
  ) {
    current(entryId, childGoalId, activationId);
    if (entry.id !== entryId) throw new Error("Limit policy belongs to another goal");
    validateDelegatedGoals({ version: 1, revision: 0, entries: [structuredClone(entry)] });
    if (runtime.policyRevision !== revision) throw new Error("Child goal policy changed");
    const previousSettings = runtime.settings;
    // The parent sends resolved policy: null here means unlimited, not the
    // previous launch's finite default. Change defaults and policy together.
    const limits = { ...entry.continuationLimits! } as typeof confirmedLimits;
    runtime.settings = { ...runtime.settings, continuationLimits: limits };
    try {
      runtime.updateGoalLimits(
        ctx, childGoalId, runtime.policyRevision, entry.tokenBudget, entry.continuationLimits!,
      );
    } catch (error) {
      runtime.settings = previousSettings;
      throw error;
    }
    confirmedLimits = { ...runtime.continuationLimits };
    applyConfirmedLimits();
    recordState();
    return snapshot();
  }

  async function resume(
    entryId: string, childGoalId: string,
    entry: Readonly<DelegatedGoalEntry> | undefined, activationId: string,
  ) {
    current(entryId, childGoalId, activationId);
    if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error("Dedicated child is not idle");
    if (runtime.activeGoal?.status === "active") throw new Error("Child goal already active");
    if (!entry) throw new Error("Resume requires current delegated goal metadata");
    if (entry.id !== entryId) throw new Error("Resume metadata belongs to another goal");
    validateDelegatedGoals({ version: 1, revision: 0, entries: [structuredClone(entry)] });
    const goal = active();
    if (!goal) throw new Error("Child goal is missing");
    // Edit is metadata-only in the parent. Synchronize into this existing
    // paused engine BEFORE activation; never bootstrap a second goal here.
    runtime.activeGoal = {
      ...goal,
      text: entry.text,
      tokenBudget: entry.tokenBudget ?? undefined,
      tokenBudgetExplicit: entry.tokenBudget !== null,
      continuationLimits: entry.continuationLimits,
    };
    runtime.persistGoal(runtime.activeGoal);
    writeProgress(pi, ctx, entry.tasks, goal.id, true);
    const resumedLineage = boundProgressId;
    applyConfirmedLimits();
    await commands.resumeGoal(commandContext());
    recordState();
    const observed = snapshot();
    const resumed = resumedLineage && boundProgressId === resumedLineage
      && observed.childGoalId === childGoalId
      && observed.childActivationId !== activationId
      && runsOrFinished(observed);
    if (!resumed) throw new Error("Child goal resume failed");
    return observed;
  }

  return {
    protocol: 1 as const, sessionId, snapshot,
    recordState,
    recordActivity(id: string, text: string) {
      current();
      recorder?.activity(id, text);
    },
    bootstrap: (entry: Readonly<DelegatedGoalEntry>) => serial(() => bootstrap(entry)),
    pause: (entryId: string, childGoalId: string, activationId: string) =>
      serial(() => pause(entryId, childGoalId, activationId)),
    updateLimits: (
      entryId: string, childGoalId: string, revision: number,
      entry: Readonly<DelegatedGoalEntry>, activationId: string,
    ) => serial(() => updateLimits(entryId, childGoalId, revision, entry, activationId)),
    resume: (
      entryId: string, childGoalId: string,
      entry: Readonly<DelegatedGoalEntry> | undefined, activationId: string,
    ) => serial(() => resume(entryId, childGoalId, entry, activationId)),
    refreshContext(next: ExtensionContext) {
      if (!closed && next.sessionManager.getSessionId() === sessionId) ctx = next;
    },
    dispose() { closed = true; },
  };
}

/** A completed goal-history record of the bound lineage with a non-empty summary. */
function isCompletedHistory(entry: any, boundProgressId: string) {
  const history = entry?.data;
  return entry?.type === "custom" && entry.customType === "goal-history"
    && history?.status === "completed"
    && history.progressId === boundProgressId
    && typeof history.id === "string"
    && typeof history.summary === "string" && history.summary.trim();
}

/** The completed state was active under its own contract and lineage. */
function completedUnderContract(
  state: any, contract: any, historyId: string, boundProgressId: string,
) {
  const activationMatches = state?.activationId === undefined
    || contract?.details?.activationId === state.activationId;
  return state?.status === "complete"
    && (state.progressId ?? state.id) === boundProgressId
    && contract?.details?.state === "active"
    && contract.details.goalId === historyId
    && activationMatches;
}

/** The engine's successful goal_complete result for exactly this summary. */
function isAcceptedCompletion(e: any, history: any) {
  const message = e.message;
  const confirmsSummary = (part: any) =>
    part.type === "text" && part.text === `Goal complete: ${history.summary}`;
  return e.type === "message" && message?.role === "toolResult"
    && message.toolName === "goal_complete" && message.isError !== true
    && message.details?.goal_id === history.id
    && message.details?.summary === history.summary
    && message.content?.some(confirmsSummary);
}

/** The assistant's goal_complete call that produced `toolCallId`. */
function isCompletionCall(e: any, toolCallId: string, summary: string) {
  const matchesCall = (part: any) => part.type === "toolCall" && part.name === "goal_complete"
    && part.id === toolCallId && part.arguments?.summary === summary;
  return e.type === "message" && e.message?.role === "assistant"
    && e.message.content?.some(matchesCall);
}

export function retainedGoalCompletion(branch: any[], binding?: string, boundProgressId?: string) {
  if (!binding || !boundProgressId) return undefined;
  // Completion clears activeGoal. Require the bound stable lineage, the exact
  // completed instance, its then-current contract, and an accepted engine tool
  // result. Neither ordinary assistant text nor unrelated history qualifies.
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (!isCompletedHistory(entry, boundProgressId)) continue;
    const history = entry.data;
    const prior = branch.slice(0, index);
    const state = prior.findLast(e => e.type === "custom" && e.customType === "goal-state"
      && e.data?.goal?.id === history.id)?.data?.goal;
    const contract = prior.findLast(e =>
      e.type === "custom_message" && e.customType === "goal-contract");
    if (!completedUnderContract(state, contract, history.id, boundProgressId)) continue;
    const accepted = branch.slice(index + 1).find(e => isAcceptedCompletion(e, history));
    if (!accepted) continue;
    const toolCallId = accepted.message.toolCallId;
    const call = prior.findLast(e => isCompletionCall(e, toolCallId, history.summary));
    if (call) return { state, summary: history.summary, endedAt: history.endedAt };
  }
  return undefined;
}
