import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { goalManagePresentation, goalManageTitle, normalizeGoalManageDisplay } from "./presentation.js";
import { currentTokenTotal } from "./accounting.js";
import { GoalCommandController } from "./commands.js";
import { nextGoalInstance, resetGoalSafetyEpoch, transitionGoal, type GoalRuntime } from "./runtime.js";
import { readGoalTasks } from "../../shared/goal-progress.ts";
import { ProgressParameters } from "../../progress/progress-state.js";
import { mergeGoalTasks } from "./mutations.ts";
import { completeVerifiedGoal, MAX_COMPLETION_SUMMARY_LENGTH } from "./completion.js";
import { GOAL_WAIT_WAKE_SEMANTICS } from "./wait.js";
import { readGoalSessionActivity } from "./activity.js";
import { manageSavedGoal } from "../saved-goal-control.ts";
import type { ActiveGoal } from "./persistence.js";

const DESCRIPTION = [
  "Manage the current goal, or with scope saved, the saved goals of this session.",
  "Current goal actions: status, pause, resume, clear, update (objective, token_budget, remove_task_ids) and complete (paused goals only, with a summary).",
  "Saved goal actions: list, status, create, start, resume, pause, clear, update (task_edits, remove_task_ids) and complete (summary and task_evidence).",
  "Saved goal actions other than list and create take a goal_id. Nothing else takes an ID.",
  "A call is rejected if the goal changed since you last saw it. The error shows the new state.",
  "Changing a goal needs a new instruction from the user.",
].join(" ");

const TaskId = Type.String({ minLength: 1, maxLength: 128 });
const Parameters = Type.Object({
  action: Type.Union(["status", "list", "start", "create", "update", "pause", "resume", "clear", "complete"].map(value => Type.Literal(value))),
  scope: Type.Optional(Type.Union([Type.Literal("current"), Type.Literal("saved")])),
  goal_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Saved goals only." })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000, description: "Saved list paging." })),
  objective: Type.Optional(Type.String({ minLength: 1, maxLength: 320 })),
  steps: Type.Optional(ProgressParameters.properties.steps),
  start: Type.Optional(Type.Boolean()),
  token_budget: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
  summary: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_COMPLETION_SUMMARY_LENGTH, description: "What was done and how it was verified." })),
  task_evidence: Type.Optional(Type.Array(Type.Object({ task_id: TaskId, evidence: Type.String({ minLength: 1, maxLength: 1000 }) }, { additionalProperties: false }), { maxItems: 50 })),
  task_edits: Type.Optional(Type.Array(Type.Object({
    id: Type.Optional(TaskId),
    text: Type.Optional(Type.String({ minLength: 1 })),
    before_task_id: Type.Optional(Type.Union([TaskId, Type.Null()])),
  }, { additionalProperties: false }), { maxItems: 50, description: "Edit or move a task by id, or add one without id. before_task_id places it before that task, null places it last." })),
  remove_task_ids: Type.Optional(Type.Array(TaskId, { maxItems: 50 })),
}, { additionalProperties: false });
type Params = Static<typeof Parameters>;

const text = (value: string) => [{ type: "text" as const, text: value }];

/** Current-scope controls share the single runtime record; saved-scope controls
 * dispatch to the authenticated parent's independent Goal registry. */
export function registerGoalManagement(pi: ExtensionAPI, runtime: GoalRuntime) {
  /** Reject fields that don't belong to a current-goal action. */
  function checkCurrentFields(params: Params) {
    const savedOnly = params.action === "list" || params.action === "start" || params.goal_id !== undefined
      || params.offset !== undefined || params.task_evidence !== undefined || params.task_edits !== undefined;
    if (savedOnly) throw new Error("list/start, goal_id, offset, task_evidence and task_edits require scope:saved");
    if (params.action === "create") throw new Error("Create the current goal with update_progress action:create; goal_manage create is for scope:saved only");
    if (params.action !== "complete" && params.summary !== undefined) throw new Error("Summary is complete-only");
    if (params.action === "status") return;
    if (params.steps !== undefined || params.start !== undefined) throw new Error("Use update_progress for task mutations; start is create-only");
    const updateOnly = params.objective !== undefined || params.token_budget !== undefined || params.remove_task_ids !== undefined;
    if (params.action !== "update" && updateOnly) throw new Error("Objective, budget and task removal are update-only");
  }

  /** The current goal, if this call may change it. */
  function goalToChange(action: string): ActiveGoal {
    if (runtime.agentRunOrigin === "automatic") throw new Error("Goal controls require a new user instruction, not an automatic continuation");
    const goal = runtime.activeGoal;
    if (!goal) throw new Error("No current goal");
    const stale = runtime.staleGoalReason(goal);
    if (stale) throw new Error(`Goal ${action} rejected: ${stale}`);
    return goal;
  }

  function complete(goal: ActiveGoal, summary: string, ctx: ExtensionContext) {
    if (goal.status !== "paused") throw new Error("Explicit completion requires a paused goal; active autonomous completion uses goal_complete");
    completeVerifiedGoal(runtime, ctx, goal, summary);
    runtime.ensureInactiveGoalContextContract(ctx);
    runtime.markGoalSeen();
    return { content: text(`Goal complete: ${summary}`), details: { goal_id: goal.id, summary, presentation: goalManagePresentation("complete", goal.text) }, terminate: true };
  }

  function pauseOrClear(goal: ActiveGoal, action: "pause" | "clear", ctx: ExtensionContext) {
    const commands = new GoalCommandController(runtime);
    if (action === "pause") commands.pauseGoal(ctx);
    else commands.clearGoal(ctx);
    runtime.markGoalSeen();
    const message = action === "pause" ? "Goal paused. Wait for explicit resume." : "Goal cleared and retained in history; not marked complete.";
    return { content: text(message), details: { goalId: goal.id, presentation: goalManagePresentation(action, goal.text) }, terminate: action === "pause" };
  }

  function updated(goal: ActiveGoal, params: Params, ctx: ExtensionContext): ActiveGoal {
    const next = nextGoalInstance(goal);
    if (params.objective !== undefined && !params.objective.trim()) throw new Error("Provide a concrete goal outcome");
    if (params.token_budget !== undefined && params.token_budget <= next.tokensUsed) throw new Error("The new budget must exceed tokens already used");
    return {
      ...next,
      text: params.objective?.trim() ?? next.text,
      tokenBudget: params.token_budget ?? next.tokenBudget,
      tokenBudgetExplicit: params.token_budget !== undefined ? true : next.tokenBudgetExplicit,
      tasks: mergeGoalTasks(readGoalTasks(ctx, goal), [], params.remove_task_ids),
    };
  }

  function resumed(goal: ActiveGoal, ctx: ExtensionContext): ActiveGoal {
    if (goal.status === "active" && !goal.waiting) throw new Error("Goal is already active");
    const next = nextGoalInstance(goal);
    if (next.tokenBudget !== undefined && next.tokensUsed >= next.tokenBudget) throw new Error("Goal budget is exhausted; explicitly update it before resuming");
    const wake = goal.waiting ? { lastWake: { at: Date.now(), reason: "explicit_resume" as const } } : {};
    return resetGoalSafetyEpoch(transitionGoal({ ...next, waiting: undefined, ...wake, baselineTokens: currentTokenTotal(ctx) }, "active"));
  }

  /** Persist an updated or resumed goal and take or release the session's workflow. */
  function commit(goal: ActiveGoal, next: ActiveGoal, ctx: ExtensionContext) {
    const retainedWorkflow = runtime.ownsWorkflow(goal);
    if (next.status === "active") {
      if (!ctx.model) throw new Error("Select a model before enabling Goal");
      runtime.assertGoalToolsAvailable();
      if (!runtime.acquireWorkflow(ctx.sessionManager)) throw new Error("Another workflow currently owns this session");
    }
    try {
      runtime.persistGoal(next);
    } catch (error) {
      if (!retainedWorkflow) runtime.releaseWorkflow();
      throw error;
    }
    if (!next.waiting) runtime.clearGoalWaitTimer();
    if (next.status === "active") {
      runtime.beginAgentRun(next.id, "manual");
      runtime.markAgentToolAttempted();
      runtime.ensureGoalContextContract(ctx, next);
    } else runtime.ensureInactiveGoalContextContract(ctx);
    runtime.updateStatus(ctx, next);
    if (next.waiting) runtime.restoreGoalWaitTimer(ctx);
  }

  async function status(action: string, ctx: ExtensionContext) {
    const sessionActivity = action === "status" ? await readGoalSessionActivity(ctx) : undefined;
    const goal = runtime.activeGoal;
    runtime.markGoalSeen(goal);
    const state = goal && {
      id: goal.id, revision: goal.revision, policyRevision: runtime.policyRevision, objective: goal.text, status: goal.status,
      waiting: goal.waiting ?? null, lastTaskUpdateAt: goal.lastTaskUpdateAt ?? null, lastWake: goal.lastWake ?? null, lastBlocker: goal.lastBlocker ?? null,
      wakeSemantics: GOAL_WAIT_WAKE_SEMANTICS, ...(sessionActivity ? { sessionActivity } : {}),
      tokenBudget: goal.tokenBudget, continuationLimits: goal.continuationLimits, effectiveLimits: runtime.continuationLimits,
      tasks: readGoalTasks(ctx, goal),
    };
    return { content: text(state ? JSON.stringify(state) : "No current goal."), details: { presentation: goalManagePresentation(action, goal?.text), goal: state ?? null } };
  }

  pi.registerTool(defineTool({
    name: "goal_manage",
    label: "Goal manage",
    executionMode: "sequential",
    description: DESCRIPTION,
    promptSnippet: "Inspect or manage the current goal, or list, start and manage saved goals with scope saved.",
    promptGuidelines: [
      "Keep a goal objective to a short outcome. Put the steps in update_progress.",
      "After a pause, blocker or safety limit, wait for the user to resume the goal. Task updates never resume a goal.",
      "To complete a verified paused goal when the user asks, use goal_manage complete with a summary. Don't resume it first.",
    ],
    parameters: Parameters,
    renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold(goalManageTitle(args))), 0, 0); },
    renderResult(result, _options, theme, context) {
      const display = normalizeGoalManageDisplay(result, context.isError);
      return new Text(theme.fg(display.isError ? "error" : "toolOutput", display.text), 0, 0);
    },
    async execute(toolCallId, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      if (params.scope === "saved") {
        const result = await manageSavedGoal({ ...params, request_id: toolCallId }, ctx, signal);
        return { content: text(JSON.stringify(result)), details: { scope: "saved", savedGoals: result, presentation: goalManagePresentation(params.action) } };
      }
      checkCurrentFields(params);
      if (params.action === "status") return status(params.action, ctx);
      const goal = goalToChange(params.action);
      switch (params.action) {
        case "complete": return complete(goal, params.summary?.trim() ?? "", ctx);
        case "pause":
        case "clear": return pauseOrClear(goal, params.action, ctx);
        case "update": commit(goal, updated(goal, params, ctx), ctx); break;
        case "resume": commit(goal, resumed(goal, ctx), ctx); break;
      }
      return status(params.action, ctx);
    },
  }));

  pi.on("context", (event, ctx) => {
    const messages = event.messages.filter(message => !(message.role === "custom" && message.customType === "goal-task-context"));
    const goal = runtime.activeGoal;
    runtime.markGoalSeen(goal);
    if (goal) messages.push({ role: "custom", customType: "goal-task-context", content: goalContext(goal, readGoalTasks(ctx, goal)), display: false, timestamp: 0 });
    return { messages };
  });
}

function goalContext(goal: ActiveGoal, tasks: unknown) {
  const data = {
    revision: goal.revision, status: goal.status, waiting: goal.waiting ?? null, lastTaskUpdateAt: goal.lastTaskUpdateAt ?? null,
    lastWake: goal.lastWake ?? null, lastBlocker: goal.lastBlocker ?? null, objective: goal.text, tasks,
  };
  const guidance = goal.status === "active"
    ? "Keep working toward the outcome. Don't call goal_complete while a required task is unfinished. If only delegated results or external work remain, arrange for them to notify you and call goal_wait alone. Ending a turn with only a progress update starts another turn automatically. Having a child running is not by itself a reason to wait."
    : "The goal is not running. Only the user can resume it. If the user asks to complete a verified paused goal, use goal_manage complete with a summary. Don't resume it first.";
  return `Current goal data: ${JSON.stringify(data)}\nUpdate tasks with update_progress, sending only changed or new steps. ${guidance}`;
}
