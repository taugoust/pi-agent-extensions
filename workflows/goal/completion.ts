import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readGoalTasks } from "../../shared/goal-progress.ts";
import { notifyTerminal } from "./errors.js";
import type { ActiveGoal } from "./persistence.js";
import { formatFooterStatus, isContradictoryCompletionSummary, STATUS_KEY, transitionGoal, type GoalRuntime } from "./runtime.js";

export const MAX_COMPLETION_SUMMARY_LENGTH = 4_000;

export function completionSummaryRejection(summary: string): string | undefined {
  return !summary
    ? "summary is empty"
    : summary.length > MAX_COMPLETION_SUMMARY_LENGTH
      ? "summary is too long"
      : isContradictoryCompletionSummary(summary)
        ? "summary says the goal is not complete"
        : undefined;
}

/** Callers must authorize the lifecycle transition before invoking shared verification/cleanup. */
export function completeVerifiedGoal(runtime: GoalRuntime, ctx: ExtensionContext, goal: ActiveGoal, summary: string) {
  const rejection = completionSummaryRejection(summary);
  if (rejection) throw new Error(`Goal completion rejected: ${rejection}.`);
  const unfinished = readGoalTasks(ctx, goal).filter(step => step.status !== "completed");
  if (unfinished.length) throw new Error(`Goal completion rejected: ${unfinished.length} required tasks remain unfinished: ${unfinished.map(step => step.text).join("; ")}`);

  runtime.clearGoalWaitTimer();
  runtime.activeGoal = transitionGoal(goal, "complete");
  runtime.setCompletionSummary(runtime.activeGoal.id, summary);
  // Paused goals already checkpointed their usage. Unrelated chat since pause is not Goal work.
  if (goal.status !== "paused") runtime.recordGoalUsage(runtime.activeGoal, ctx);
  runtime.persistGoal(runtime.activeGoal);

  ctx.ui.setStatus(STATUS_KEY, formatFooterStatus(runtime.activeGoal, runtime.continuationLimits.automaticTurns, ctx.ui.theme));
  runtime.clearCompletedGoal(ctx);
  runtime.showCompletionStatus(ctx);
  notifyTerminal(ctx.ui, `Goal complete: ${goal.text}`, "info");
}
