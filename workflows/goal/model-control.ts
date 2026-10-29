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

/** Chat controls and progress share the runtime's single persisted goal record. */
export function registerGoalManagement(pi: ExtensionAPI, runtime: GoalRuntime) {
  pi.registerTool(defineTool({
    name: "goal_manage",
    label: "Goal manage",
    executionMode: "sequential",
    description: "Inspect or manage the current goal and its authoritative checklist. status is read-only and returns stable id, activationId, revision, tasks and effective limits. Prefer update_progress create to atomically create a goal and tasks: creation authorizes autonomous continuation by default; start:false is a paused draft. create here is an alias with the same semantics and requires request_id. Never replaces an existing goal. Existing lifecycle/objective changes require exact goal_id, activation_id, expected_revision and fresh user_authorized:true; they cannot originate in automatic continuation. complete is paused-only: on explicit user request, supply a nonempty verification summary after all required tasks are completed; it archives completion without resuming or starting a turn. Active autonomous completion still uses goal_complete. Task-only updates use update_progress and never resume or complete a goal. token_budget is create/update-only: omit on create for no token cap; omit on update to preserve it. Removal is explicit by task ID after a user scope change.",
    promptSnippet: "Inspect goal identity/revision, tasks and limits; explicitly manage lifecycle without losing progress.",
    promptGuidelines: [
      "Use a concise outcome-only objective (at most 320 characters); put implementation and verification steps in update_progress.",
      "update_progress create (or goal_manage create) authorizes autonomous continuation with configured limits unless start:false. Creation is not permission to bypass an existing goal, pending approvals, or another workflow.",
      "After pause, blocker or safety limit, wait for fresh user authorization to resume. Task updates do not resume. Complete only after verifying every required task and the outcome.",
      "Read status for the current stable goal_id, activation_id and revision, waiting/wake evidence and bounded session-owned execution activity. Session activity is not proof of goal assignment. Never reuse an old activation token after resume or objective changes.",
      "When the user explicitly asks to complete a verified paused goal, use goal_manage action:complete with summary and fresh user_authorized:true. Do not resume it or create an active Goal contract merely to complete it. All required tasks must already be completed.",
    ],
    parameters: Type.Object({
      action: Type.Union(["status", "create", "update", "pause", "resume", "clear", "complete"].map(value => Type.Literal(value))),
      goal_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      activation_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      expected_revision: Type.Optional(Type.Integer({ minimum: 1 })),
      request_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      objective: Type.Optional(Type.String({ minLength: 1, maxLength: 320 })),
      steps: Type.Optional(ProgressParameters.properties.steps),
      start: Type.Optional(Type.Boolean()),
      token_budget: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000 })),
      user_authorized: Type.Optional(Type.Boolean()),
      summary: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_COMPLETION_SUMMARY_LENGTH, description: "complete-only: what was completed and the evidence verifying the outcome and every required task." })),
      remove_task_ids: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 50 })),
    }, { additionalProperties: false }),
    renderCall(args, theme) { return new Text(theme.fg("toolTitle", theme.bold(goalManageTitle(args))), 0, 0); },
    renderResult(result, _options, theme, context) {
      const display = normalizeGoalManageDisplay(result, context.isError);
      return new Text(theme.fg(display.isError ? "error" : "toolOutput", display.text), 0, 0);
    },
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const previous = runtime.activeGoal;
      if (params.action !== "complete" && params.summary !== undefined) throw new Error("Summary is complete-only");
      if (params.action === "create") {
        const created = mutateProgress(pi, ctx, { action: "create", request_id: params.request_id!, objective: params.objective!, steps: params.steps ?? [], start: params.start }, params.token_budget);
        return { content: [{ type: "text", text: JSON.stringify(created) }], details: { presentation: goalManagePresentation("create", params.objective), ...created } };
      }
      if (params.action !== "status") {
        if (runtime.agentRunOrigin === "automatic") throw new Error("Goal controls require a new user instruction, not an automatic continuation");
        if (!previous || params.goal_id !== previous.id || params.activation_id !== (previous.activationId ?? previous.id) || params.expected_revision !== previous.revision)
          throw new Error("Goal identity, activation or revision changed; inspect status");
        if (params.user_authorized !== true) throw new Error("This lifecycle/scope change requires fresh explicit user authorization");
        if (params.steps !== undefined || params.start !== undefined || params.request_id !== undefined) throw new Error("Use update_progress for task mutations; start and request_id here are create-only");
        if (params.action !== "update" && (params.objective !== undefined || params.token_budget !== undefined || params.remove_task_ids !== undefined)) throw new Error("Objective, budget and task removal are update-only");
        if (params.action === "complete") {
          if (previous.status !== "paused") throw new Error("Explicit completion requires a paused goal; active autonomous completion uses goal_complete");
          const summary = typeof params.summary === "string" ? params.summary.trim() : "";
          completeVerifiedGoal(runtime, ctx, previous, summary);
          runtime.ensureInactiveGoalContextContract(ctx);
          return { content: [{ type: "text", text: `Goal complete: ${summary}` }], details: { goal_id: previous.id, summary, presentation: goalManagePresentation("complete", previous.text) }, terminate: true };
        }
        if (params.action === "pause" || params.action === "clear") {
          const commands = new GoalCommandController(runtime);
          if (params.action === "pause") commands.pauseGoal(ctx); else commands.clearGoal(ctx);
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
      const state = goal ? { id: goal.id, activationId: goal.activationId ?? goal.id, revision: goal.revision, policyRevision: runtime.policyRevision, objective: goal.text, status: goal.status, waiting: goal.waiting ?? null, lastWake: goal.lastWake ?? null, lastBlocker: goal.lastBlocker ?? null, wakeSemantics: GOAL_WAIT_WAKE_SEMANTICS, ...(sessionActivity ? { sessionActivity } : {}), tokenBudget: goal.tokenBudget, continuationLimits: goal.continuationLimits, effectiveLimits: runtime.continuationLimits, tasks: readGoalTasks(ctx, goal) } : null;
      return { content: [{ type: "text", text: state ? JSON.stringify(state) : "No current goal." }], details: { presentation: goalManagePresentation(params.action, goal?.text), goal: state } };
    },
  }));
  pi.on("context", (event, ctx) => {
    const messages = event.messages.filter(message => !(message.role === "custom" && message.customType === "goal-task-context"));
    const goal = runtime.activeGoal;
    if (goal) messages.push({ role: "custom", customType: "goal-task-context", content: `Current goal data: ${JSON.stringify({ goal_id: goal.id, activation_id: goal.activationId ?? goal.id, revision: goal.revision, status: goal.status, waiting: goal.waiting ?? null, lastWake: goal.lastWake ?? null, lastBlocker: goal.lastBlocker ?? null, objective: goal.text, tasks: readGoalTasks(ctx, goal) })}\nUse update_progress action:update with this exact goal_id and expected_revision, a new request_id, and only changed/new steps. Omitted tasks remain. Task updates never resume or complete the goal. ${goal.status === "active" ? "Continue independent work toward the outcome; do not call goal_complete while any required task is unfinished. If only delegated results or external work remain, arrange completion/guidance delivery and call goal_wait alone instead of ending with a progress-only response (which causes automatic continuation). The presence of a child alone is not a reason to wait. Wait reasons are status data, not event subscriptions; routine progress receipts do not wake you." : "Autonomous continuation is disabled; resume requires fresh user authorization. If the user explicitly requests completion of a verified paused goal, use goal_manage action:complete with summary, exact goal_id/activation_id/expected_revision and user_authorized:true; do not resume merely to complete it."}`, display: false, timestamp: 0 });
    return { messages };
  });
}
