import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ActiveGoal } from "../workflows/goal/persistence.js";
import { cloneProgressSteps, readScopedProgress, type ProgressMutation, type ProgressStep } from "../progress/progress-state.js";

export const GOAL_PROGRESS_EVENT = "pi:goal-progress";
export const GOAL_MUTATION_EVENT = "pi:goal-mutation";
type Context = Pick<ExtensionContext, "sessionManager">;
type Goal = Pick<ActiveGoal, "id" | "progressId"> & Partial<Pick<ActiveGoal, "tasks">>;
export interface ProgressMutationResult {
  steps: ProgressStep[];
  goalId: string;
  revision: number;
  activationId: string;
  status: string;
}
export interface GoalMutationRequest {
  ctx: Context;
  mutation: ProgressMutation | { action: "replace_tasks"; goal_id: string; steps: readonly ProgressStep[]; initialize: boolean };
  initialTokenBudget?: number;
  result?: ProgressMutationResult;
  error?: unknown;
}

export function readGoalTasks(ctx: Context, goal: Goal): ProgressStep[] {
  return goal.tasks !== undefined ? cloneProgressSteps(goal.tasks) : readScopedProgress(ctx.sessionManager.getBranch(), goal.progressId ?? goal.id);
}

/** Synchronous request to the session-owned workflow service; never a second store. */
export function mutateProgress(pi: ExtensionAPI, ctx: Context, mutation: ProgressMutation, initialTokenBudget?: number): ProgressMutationResult {
  return requestMutation(pi, { ctx, mutation, initialTokenBudget });
}

function requestMutation(pi: ExtensionAPI, request: GoalMutationRequest): ProgressMutationResult {
  pi.events.emit(GOAL_MUTATION_EVENT, request);
  if (request.error) throw request.error;
  if (!request.result) throw new Error("Goal mutation service unavailable; standalone checklist writes are not supported");
  return request.result;
}

/** Trusted UI/parent controls only. Model writes must use mutateProgress with a revision and request ID. */
export function writeProgress(pi: ExtensionAPI, ctx: Context, steps: readonly ProgressStep[], goalId?: string | null, initialize = false, _notify = true) {
  if (!goalId) throw new Error("An explicit goal ID is required; standalone historical checklists are read-only");
  return requestMutation(pi, { ctx, mutation: { action: "replace_tasks", goal_id: goalId, steps, initialize } });
}

export function addGoalTask(pi: ExtensionAPI, ctx: ExtensionContext, goal: ActiveGoal, expectedGoalId: string, text: string) {
  if (goal.id !== expectedGoalId || goal.status === "complete" || goal.status === "active" || !ctx.isIdle() || ctx.hasPendingMessages())
    throw new Error("Pause the goal and wait for the current turn before adding a task");
  const steps = readGoalTasks(ctx, goal);
  const normalized = text.trim();
  if (steps.some(step => step.text === normalized)) throw new Error("That task is already in this goal");
  return writeProgress(pi, ctx, [...steps, { text: normalized, status: "pending" }], expectedGoalId);
}
