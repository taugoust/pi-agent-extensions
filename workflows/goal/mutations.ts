import { randomUUID, createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GOAL_MUTATION_EVENT, readGoalTasks, type GoalMutationRequest, type ProgressMutationResult } from "../../shared/goal-progress.ts";
import { cloneProgressSteps, validateProgressArguments, validateProgressMutation, type ProgressStep } from "../../progress/progress-state.js";
import { currentTokenTotal } from "./accounting.js";
import { createGoal, transitionGoal, type GoalRuntime } from "./runtime.js";
import type { ActiveGoal } from "./persistence.js";

export function mergeGoalTasks(previous: readonly ProgressStep[], updates: readonly ProgressStep[], removals: readonly string[] = []): ProgressStep[] {
  const supplied = updates.filter(step => step.id).map(step => step.id!);
  if (new Set(supplied).size !== supplied.length || new Set(removals).size !== removals.length) throw new Error("Duplicate task ID");
  const known = new Set(previous.map(step => step.id));
  if ([...supplied, ...removals].some(id => !known.has(id))) throw new Error("Unknown or foreign task ID; use this goal's current checklist");
  if (supplied.some(id => removals.includes(id))) throw new Error("Cannot update and remove the same task");
  const byId = new Map(updates.filter(step => step.id).map(step => [step.id, step]));
  const next = [
    ...previous.filter(step => !removals.includes(step.id!)).map(step => byId.get(step.id) ?? step),
    ...updates.filter(step => !step.id).map(step => ({ ...step, id: randomUUID() })),
  ];
  if (new Set(next.map(step => step.text.trim())).size !== next.length) throw new Error("Goal tasks need distinct descriptions");
  return validateProgressArguments({ steps: next }).steps;
}

function snapshot(goal: ActiveGoal): ProgressMutationResult {
  return { goalId: goal.id, activationId: goal.activationId ?? goal.id, revision: goal.revision!, status: goal.status, steps: cloneProgressSteps(goal.tasks ?? []) };
}

/** One synchronous, session-owned commit boundary for tool, UI and native-parent task writes. */
export function bindGoalMutations(pi: ExtensionAPI, ctx: ExtensionContext, runtime: GoalRuntime, options: { child: boolean; busy(): boolean }) {
  const dispose = pi.events.on(GOAL_MUTATION_EVENT, (payload: unknown) => {
    const request = payload as GoalMutationRequest;
    if (!request || request.ctx?.sessionManager !== ctx.sessionManager) return;
    try { request.result = apply(request); } catch (error) { request.error = error; }
  });
  function apply(request: GoalMutationRequest): ProgressMutationResult {
    const input = request.mutation;
    if (input.action === "replace_tasks") {
      const goal = runtime.activeGoal;
      if (!goal || goal.id !== input.goal_id || goal.status === "complete") throw new Error("Goal changed");
      const previous = readGoalTasks(ctx, goal);
      const steps = validateProgressArguments({ steps: input.steps }).steps;
      const known = new Set(previous.map(step => step.id));
      if (!input.initialize && steps.some(step => step.id && !known.has(step.id))) throw new Error("Unknown goal task ID");
      const tasks = steps.map(step => ({ ...step, id: step.id ?? randomUUID() }));
      if (new Set(tasks.map(step => step.id)).size !== tasks.length) throw new Error("Duplicate task ID");
      const next = { ...goal, tasks };
      runtime.persistGoal(next);
      runtime.activeGoal = next;
      return snapshot(next);
    }
    const mutation = validateProgressMutation(input);
    const budget = request.initialTokenBudget;
    if (budget !== undefined && (mutation.action !== "create" || !Number.isSafeInteger(budget) || budget < 1 || budget > 1_000_000)) throw new Error("Invalid initial token budget");
    const fingerprint = createHash("sha256").update(JSON.stringify([mutation, budget ?? null])).digest("hex");
    // Receipts live in the same atomic goal-state entry as the mutation. Scan
    // branch history too: a retry after clear/completion must not create anew.
    for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
      if (entry.type !== "custom" || entry.customType !== "goal-state") continue;
      const receipts = (entry.data as any)?.goal?.requests;
      if (!receipts || !Object.hasOwn(receipts, mutation.request_id)) continue;
      const receipt = receipts[mutation.request_id];
      if (receipt.fingerprint !== fingerprint) throw new Error("request_id was already used with different arguments");
      return structuredClone(receipt.result);
    }
    if (options.busy()) throw new Error("Finish pending permission/workflow operations before changing the goal");
    const previous = runtime.activeGoal;
    let next: ActiveGoal;
    if (mutation.action === "create") {
      if (options.child) throw new Error("Dedicated child goals are owned by their authenticated parent; creation is forbidden");
      if (runtime.agentRunOrigin === "automatic") throw new Error("An automatic continuation cannot create a replacement goal");
      if (previous || runtime.legacyQueueState) throw new Error("A goal already exists; explicitly clear it before creating another");
      next = createGoal(mutation.objective, budget, currentTokenTotal(ctx));
      next.tasks = mergeGoalTasks([], mutation.steps);
      // Retain configured finite limits on the goal. Null keeps the existing
      // configured-default inheritance semantics.
      next.continuationLimits = { ...runtime.settings.continuationLimits };
      if (mutation.start === false) next = transitionGoal(next, "paused");
      if (next.status === "active") {
        if (!ctx.model) throw new Error("Select a model before enabling Goal");
        if (ctx.hasPendingMessages()) throw new Error("Resolve pending messages before starting a new goal");
        runtime.assertGoalToolsAvailable();
      }
      // Draft creation must also respect workflow ownership, but holds no lease.
      if (!runtime.acquireWorkflow(ctx.sessionManager)) throw new Error("Another workflow currently owns this session");
    } else {
      if (!previous || previous.id !== mutation.goal_id || previous.status === "complete") throw new Error("Goal changed; inspect goal_manage status");
      if (previous.revision !== mutation.expected_revision) throw new Error("Goal revision changed; inspect goal_manage status and retry with a new request_id");
      if (options.child && mutation.remove_task_ids?.length) throw new Error("Dedicated child scope removal is owned by its authenticated parent");
      next = { ...previous, tasks: mergeGoalTasks(readGoalTasks(ctx, previous), mutation.steps, mutation.remove_task_ids) };
    }
    // A new receipt always changes the mutation projection, even for a no-op
    // task patch. Reserve its one increment; accounting checkpoints add none.
    next.revision = Math.max(next.revision ?? 0, previous?.revision ?? 0);
    const result = { ...snapshot(next), revision: next.revision + 1 };
    // The immutable branch history is the durable request journal. Retain only
    // this receipt in the new record, rather than copying an ever-growing ledger
    // (and every old checklist snapshot) into every accounting checkpoint.
    next.requests = { [mutation.request_id]: { fingerprint, result } };
    try {
      runtime.persistGoal(next);
    } catch (error) {
      if (mutation.action === "create") runtime.releaseWorkflow();
      throw error;
    }
    runtime.activeGoal = next;
    if (mutation.action === "create") {
      if (next.status === "active") {
        runtime.beginAgentRun(next.id, "manual");
        runtime.markAgentToolAttempted();
        runtime.ensureGoalContextContract(ctx, next);
      } else {
        runtime.releaseWorkflow();
        runtime.ensureInactiveGoalContextContract(ctx);
      }
    }
    runtime.updateStatus(ctx, next);
    return structuredClone(result);
  }
  return dispose;
}
