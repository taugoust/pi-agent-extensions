import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { goalManagePresentation, goalManageTitle, normalizeGoalManageDisplay } from "./presentation.js";
import { currentTokenTotal } from "./accounting.js";
import { GoalCommandController } from "./commands.js";
import { nextGoalInstance, resetGoalSafetyEpoch, transitionGoal, type GoalRuntime } from "./runtime.js";
import { mutateProgress, readGoalTasks } from "../../shared/goal-progress.ts";
import { ProgressParameters } from "../../progress/progress-state.js";
import { mergeGoalTasks } from "./mutations.ts";
import { completeVerifiedGoal, MAX_COMPLETION_SUMMARY_LENGTH } from "./completion.js";
import { GOAL_WAIT_WAKE_SEMANTICS } from "./wait.js";
import { readGoalSessionActivity } from "./activity.js";
import { manageSavedGoal } from "../saved-goal-control.ts";

/** Current-scope controls share the single runtime record; saved-scope controls
 * dispatch to the authenticated parent's independent Goal registry. */
export function registerGoalManagement(pi: ExtensionAPI, runtime: GoalRuntime) {
  pi.registerTool(defineTool({
    name: "goal_manage",
    label: "Goal manage",
    executionMode: "sequential",
    description: "Inspect or manage the current goal (default scope:current) or the saved goals of this session (scope:saved). The harness tracks which goal and revision you last saw: current-goal actions take no IDs, saved-goal actions take only goal_id. A call is rejected if the goal changed since you last saw it; the error shows the new state, so check it and call again if still appropriate. Lifecycle changes need a new user instruction, never an automatic continuation.\n\nCurrent goal: status; pause, resume, clear; update (objective, token_budget, remove_task_ids); complete (paused goals only, with summary; active goals use goal_complete). Create the current goal and change its tasks with update_progress.\n\nSaved goals: list (offset for paging), status, create (objective, optional pending steps and token_budget; always a paused draft), start and resume (launch the goal's own coordinator; they never touch the current goal), pause, clear, update (task_edits and remove_task_ids on an inactive goal), complete (summary, plus task_evidence for every unfinished task).\n\ntask_edits: [{id?, text?, before_task_id?}] edits or moves an existing task by id, or inserts a pending task without id. before_task_id places it before that task, null places it last, omitted keeps its position (new tasks go last). Only remove_task_ids removes tasks, and only after the user changed the scope.",
    promptSnippet: "Inspect or manage the current goal, or list, start and manage saved goals with scope:saved.",
    promptGuidelines: [
      "Keep the goal objective a short outcome (at most 320 characters); put steps in update_progress.",
      "update_progress create starts autonomous work with the configured limits unless start:false. It is not permission to bypass an existing goal, pending approvals or another workflow.",
      "After a pause, blocker or safety limit, wait for the user to resume. Task updates never resume a goal. Complete only after verifying every required task and the outcome.",
      "To complete a verified paused goal at the user's request, use goal_manage action:complete with a summary; don't resume it first.",
    ],
    parameters: Type.Object({
      action: Type.Union(["status", "list", "start", "create", "update", "pause", "resume", "clear", "complete"].map(value => Type.Literal(value))),
      scope: Type.Optional(Type.Union([Type.Literal("current"), Type.Literal("saved")])),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000 })),
      task_evidence: Type.Optional(Type.Array(Type.Object({ task_id: Type.String({ minLength: 1, maxLength: 128 }), evidence: Type.String({ minLength: 1, maxLength: 1000 }) }, { additionalProperties: false }), { maxItems: 50 })),
      task_edits: Type.Optional(Type.Array(Type.Object({
        id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        text: Type.Optional(Type.String({ minLength: 1, description: "At most 503 grapheme clusters, validated by the canonical checklist policy." })),
        before_task_id: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()])),
      }, { additionalProperties: false }), { maxItems: 50, description: "Saved update only: ordered edits/moves by existing id, or insert pending tasks without id. Existing statuses are immutable. before_task_id targets an existing retained task; null appends; omission keeps position (new tasks append)." })),
      goal_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "scope:saved only: the saved goal to act on." })),
      objective: Type.Optional(Type.String({ minLength: 1, maxLength: 320 })),
      steps: Type.Optional(ProgressParameters.properties.steps),
      start: Type.Optional(Type.Boolean()),
      token_budget: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
      summary: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_COMPLETION_SUMMARY_LENGTH, description: "complete-only: what was completed and the evidence verifying the outcome and every required task." })),
      remove_task_ids: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 50 })),
    }, { additionalProperties: false }),
    renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold(goalManageTitle(args))), 0, 0); },
    renderResult(result, _options, theme, context) {
      const display = normalizeGoalManageDisplay(result, context.isError);
      return new Text(theme.fg(display.isError ? "error" : "toolOutput", display.text), 0, 0);
    },
    async execute(toolCallId, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      if (params.scope === "saved") {
        const result = await manageSavedGoal({ ...params, request_id: toolCallId }, ctx, signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: { scope: "saved", savedGoals: result, presentation: goalManagePresentation(params.action) } };
      }
      if (params.action === "list" || params.action === "start" || params.offset !== undefined || params.task_evidence !== undefined || params.task_edits !== undefined || params.goal_id !== undefined)
        throw new Error("list/start, goal_id, offset, task_evidence and task_edits require scope:saved");
      const previous = runtime.activeGoal;
      if (params.action !== "complete" && params.summary !== undefined) throw new Error("Summary is complete-only");
      if (params.action === "create")
        throw new Error("Create the current goal with update_progress action:create; goal_manage create is for scope:saved only");
      if (params.action !== "status") {
        if (runtime.agentRunOrigin === "automatic") throw new Error("Goal controls require a new user instruction, not an automatic continuation");
        if (!previous) throw new Error("No current goal");
        const stale = runtime.staleGoalReason(previous);
        if (stale) throw new Error(`Goal ${params.action} rejected: ${stale}`);
        if (params.steps !== undefined || params.start !== undefined) throw new Error("Use update_progress for task mutations; start is create-only");
        if (params.action !== "update" && (params.objective !== undefined || params.token_budget !== undefined || params.remove_task_ids !== undefined)) throw new Error("Objective, budget and task removal are update-only");
        if (params.action === "complete") {
          if (previous.status !== "paused") throw new Error("Explicit completion requires a paused goal; active autonomous completion uses goal_complete");
          const summary = typeof params.summary === "string" ? params.summary.trim() : "";
          completeVerifiedGoal(runtime, ctx, previous, summary);
          runtime.ensureInactiveGoalContextContract(ctx);
          runtime.markGoalSeen();
          return { content: [{ type: "text", text: `Goal complete: ${summary}` }], details: { goal_id: previous.id, summary, presentation: goalManagePresentation("complete", previous.text) }, terminate: true };
        }
        if (params.action === "pause" || params.action === "clear") {
          const commands = new GoalCommandController(runtime);
          if (params.action === "pause") commands.pauseGoal(ctx); else commands.clearGoal(ctx);
          runtime.markGoalSeen();
          return { content: [{ type: "text", text: params.action === "pause" ? "Goal paused. Wait for explicit resume." : "Goal cleared and retained in history; not marked complete." }], details: { goalId: previous.id, presentation: goalManagePresentation(params.action, previous.text) }, terminate: params.action === "pause" };
        }
        let next = nextGoalInstance(previous);
        if (params.action === "update") {
          if (params.objective !== undefined && !params.objective.trim()) throw new Error("Provide a concrete goal outcome");
          if (params.token_budget !== undefined && params.token_budget <= next.tokensUsed) throw new Error("The new budget must exceed tokens already used");
          next = { ...next, text: params.objective?.trim() ?? next.text, tokenBudget: params.token_budget ?? next.tokenBudget, tokenBudgetExplicit: params.token_budget !== undefined ? true : next.tokenBudgetExplicit,
            tasks: mergeGoalTasks(readGoalTasks(ctx, previous), [], params.remove_task_ids) };
        } else if (params.action === "resume") {
          if (previous.status === "active" && !previous.waiting) throw new Error("Goal is already active");
          if (next.tokenBudget !== undefined && next.tokensUsed >= next.tokenBudget) throw new Error("Goal budget is exhausted; explicitly update it before resuming");
          next = resetGoalSafetyEpoch(transitionGoal({ ...next, waiting: undefined,
            ...(previous.waiting ? { lastWake: { at: Date.now(), reason: "explicit_resume" as const } } : {}),
            baselineTokens: currentTokenTotal(ctx) }, "active"));
        }
        const retainedWorkflow = runtime.ownsWorkflow(previous);
        if (next.status === "active") {
          if (!ctx.model) throw new Error("Select a model before enabling Goal");
          runtime.assertGoalToolsAvailable();
          if (!runtime.acquireWorkflow(ctx.sessionManager)) throw new Error("Another workflow currently owns this session");
        }
        try { runtime.persistGoal(next); } catch (error) { if (!retainedWorkflow) runtime.releaseWorkflow(); throw error; }
        if (!next.waiting) runtime.clearGoalWaitTimer();
        if (next.status === "active") {
          runtime.beginAgentRun(next.id, "manual");
          runtime.markAgentToolAttempted();
          runtime.ensureGoalContextContract(ctx, next);
        } else runtime.ensureInactiveGoalContextContract(ctx);
        runtime.updateStatus(ctx, next);
        if (next.waiting) runtime.restoreGoalWaitTimer(ctx);
      }
      const sessionActivity = params.action === "status" ? await readGoalSessionActivity(ctx) : undefined;
      const goal = runtime.activeGoal;
      runtime.markGoalSeen(goal);
      const state = goal ? { id: goal.id, revision: goal.revision, policyRevision: runtime.policyRevision, objective: goal.text, status: goal.status, waiting: goal.waiting ?? null, lastTaskUpdateAt: goal.lastTaskUpdateAt ?? null, lastWake: goal.lastWake ?? null, lastBlocker: goal.lastBlocker ?? null, wakeSemantics: GOAL_WAIT_WAKE_SEMANTICS, ...(sessionActivity ? { sessionActivity } : {}), tokenBudget: goal.tokenBudget, continuationLimits: goal.continuationLimits, effectiveLimits: runtime.continuationLimits, tasks: readGoalTasks(ctx, goal) } : null;
      return { content: [{ type: "text", text: state ? JSON.stringify(state) : "No current goal." }], details: { presentation: goalManagePresentation(params.action, goal?.text), goal: state } };
    },
  }));
  pi.on("context", (event, ctx) => {
    const messages = event.messages.filter(message => !(message.role === "custom" && message.customType === "goal-task-context"));
    const goal = runtime.activeGoal;
    runtime.markGoalSeen(goal);
    if (goal) messages.push({ role: "custom", customType: "goal-task-context", content: `Current goal data: ${JSON.stringify({ revision: goal.revision, status: goal.status, waiting: goal.waiting ?? null, lastTaskUpdateAt: goal.lastTaskUpdateAt ?? null, lastWake: goal.lastWake ?? null, lastBlocker: goal.lastBlocker ?? null, objective: goal.text, tasks: readGoalTasks(ctx, goal) })}\nUse update_progress action:update with only changed/new steps. Omitted tasks remain. Task updates never resume or complete the goal. ${goal.status === "active" ? "Continue independent work toward the outcome; do not call goal_complete while any required task is unfinished. If only delegated results or external work remain, arrange completion/guidance delivery and call goal_wait alone instead of ending with a progress-only response (which causes automatic continuation). The presence of a child alone is not a reason to wait. Wait reasons are status data, not event subscriptions; routine progress receipts do not wake you." : "Autonomous continuation is disabled; resume requires fresh user authorization. If the user explicitly requests completion of a verified paused goal, use goal_manage action:complete with a summary; do not resume merely to complete it."}`, display: false, timestamp: 0 });
    return { messages };
  });
}
