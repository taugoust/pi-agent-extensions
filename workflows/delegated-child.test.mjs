import { registerHooks } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith("/workflows/delegated-child.ts") && specifier === "../shared/goal-progress.ts") return {
    url: `data:text/javascript,${encodeURIComponent("export function readGoalTasks(ctx,goal){return goal.tasks??goal.testTasks??[]};export function writeProgress(pi,ctx,tasks,id){pi.appendEntry('progress-fixture',{tasks,id})}")}`, shortCircuit: true,
  };
  return next(specifier, context);
} });
const { createDelegatedChildGoalService } = await import("./delegated-child.ts");

test("structured child seam uses injected existing engine, binds ownership and seeds checklist before dispatch", async () => {
  const events = [], entries = [];
  const runtime = { activeGoal: undefined, get continuationLimits(){return this.settings.continuationLimits}, settings: { continuationLimits: { automaticTurns: 99, noProgressTurns: 88 } }, snapshotSettingsApplicationState: () => ({}), persistGoal: goal => events.push(`persist:${goal.id}`) };
  const ctx = { isIdle: () => true, hasPendingMessages: () => false, ui: {}, sessionManager: { getSessionId: () => "child-session", getBranch: () => entries } };
  const pi = { appendEntry(type, data) { entries.push({ type: "custom", customType: type, data }); events.push(type); } };
  const commands = {
    async startGoal(text, budget, context, onActivated) {
      assert.deepEqual(runtime.settings.continuationLimits, { automaticTurns: 99, noProgressTurns: 88 });
      runtime.activeGoal = { id: "child-goal-id", activationId: "first", status: "active", text, tokenBudget: budget, tokensUsed: 0, automaticModelTurns: 0, toolFreeRepeatCount: 0 };
      onActivated(runtime.activeGoal); assert.equal(runtime.activeGoal.tasks[0].id, "task"); events.push("owned-child-prompt");
    },
    pauseGoal() { runtime.activeGoal.status = "paused"; },
    async resumeGoal() { assert.deepEqual(runtime.settings.continuationLimits, { automaticTurns: 99, noProgressTurns: 88 }); runtime.activeGoal.status = "active"; runtime.activeGoal.progressId ??= runtime.activeGoal.id; runtime.activeGoal.activationId = "resumed"; events.push("owned-child-resume"); },
  };
  const service = createDelegatedChildGoalService(pi, ctx, runtime, commands);
  const entry = { id: "11111111-1111-4111-8111-111111111111", revision: 1, status: "paused", child: null, text: "objective", tokenBudget: 100, tokensUsed: 0, automaticTurns: 0, noProgressTurns: 0, summary: null, waiting: null, tasks: [{ id: "task", text: "check", status: "pending" }] };
  let result = await service.bootstrap(entry);
  assert.equal(result.entryId, entry.id); assert.equal(result.childGoalId, "child-goal-id"); assert.equal(result.goal.status, "active");
  assert.equal(result.goal.tasks[0].id, "task");
  runtime.activeGoal.lastBlocker = { at: 100, reason: "External dependency", evidence: "Recorded tool failure", repeatedTurns: 2 };
  runtime.activeGoal.lastWake = { at: 200, reason: "explicit_resume" };
  assert.deepEqual(service.snapshot().goal.diagnostics.lastBlocker, runtime.activeGoal.lastBlocker);
  assert.deepEqual(service.snapshot().goal.diagnostics.lastWake, runtime.activeGoal.lastWake);
  const persistedBinding = entries.find(e => e.customType === "delegated-goal-child-binding-v1" && e.data.progressId);
  assert.equal(persistedBinding.data.progressId, "child-goal-id");
  assert.ok(entries.indexOf(persistedBinding) >= 0);
  assert.deepEqual(result.limits, { automaticTurns: 99, noProgressTurns: 88 });
  await assert.rejects(service.bootstrap({ ...entry, id: "foreign" }), /another goal/);
  await assert.rejects(service.pause("foreign", "child-goal-id"), /ownership/);
  await assert.rejects(service.pause(entry.id, "stale-child"), /identity/);
  result = await service.pause(entry.id, "child-goal-id", "first"); assert.equal(result.goal.status, "paused");
  runtime.settings.continuationLimits = { automaticTurns: 55, noProgressTurns: 66 };
  result = await service.resume(entry.id, "child-goal-id", { ...entry, text: "edited while paused", tokenBudget: null, tasks: [...entry.tasks, { id: "new-task", text: "added while paused", status: "pending" }] }, "first"); assert.equal(result.goal.status, "active");
  assert.equal(runtime.activeGoal.text, "edited while paused"); assert.equal(runtime.activeGoal.tokenBudget, undefined);
  const synchronized = entries.filter(e => e.customType === "progress-fixture").at(-1);
  assert.equal(synchronized.data.tasks.length, 2);
  assert.ok(events.lastIndexOf("progress-fixture") < events.lastIndexOf("owned-child-resume"));
  assert.equal(result.childGoalId, "child-goal-id"); assert.equal(result.childActivationId, "resumed");
  await assert.rejects(service.pause(entry.id, "child-goal-id", "first"), /activation/);
  service.dispose(); assert.throws(() => service.snapshot(), /Stale/);
});

test("terminal projection requires persisted parent lineage and exact successful engine completion, not latest history or text", async () => {
  const summary = "Verified linked child completion", goalId = "rotated-final-contract", progressId = "stable-first-instance";
  const contract = { type: "custom_message", customType: "goal-contract", details: { state: "active", goalId } };
  const state = { id: goalId, progressId, status: "complete", tokensUsed: 4, automaticModelTurns: 1, toolFreeRepeatCount: 0 };
  const history = { type: "custom", customType: "goal-history", data: { version: 1, id: goalId, progressId, status: "completed", summary } };
  const result = { type: "message", message: { role: "toolResult", toolName: "goal_complete", toolCallId: "accepted-call", isError: false,
    details: { goal_id: goalId, summary }, content: [{ type: "text", text: `Goal complete: ${summary}` }] } };
  const entries = [
    { type: "custom", customType: "delegated-goal-child-binding-v1", data: { goalId: "parent-entry", progressId } },
    contract,
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "accepted-call", name: "goal_complete", arguments: { goal_id: goalId, summary } }] } },
    { type: "custom", customType: "goal-state", data: { goal: state } }, history,
    { type: "custom", customType: "goal-state", data: { goal: null } }, result,
    { type: "custom_message", customType: "goal-contract", details: { state: "inactive" } },
    { type: "custom", customType: "goal-history", data: { id: "unrelated", progressId: "foreign", status: "completed", summary: "not this goal" } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Goal complete: ordinary text is not evidence" }] } },
  ];
  const runtime = { activeGoal: undefined, get continuationLimits(){return this.settings.continuationLimits}, settings: { continuationLimits: { automaticTurns: 7, noProgressTurns: 5 } }, snapshotSettingsApplicationState: () => ({}) };
  const ctx = { sessionManager: { getSessionId: () => "child", getBranch: () => entries } };
  const service = createDelegatedChildGoalService({ appendEntry() {} }, ctx, runtime, {});
  const completed = service.snapshot();
  assert.equal(completed.entryId, "parent-entry"); assert.equal(completed.childGoalId, goalId);
  assert.equal(completed.goal.status, "complete"); assert.equal(completed.goal.summary, summary);
  const pauseRace = await service.pause("parent-entry", goalId, goalId);
  assert.equal(pauseRace.goal.status, "complete");
  await assert.rejects(service.pause("parent-entry", "foreign-contract"), /identity changed/);
  assert.deepEqual(completed.limits, { automaticTurns: 7, noProgressTurns: 5 }, "snapshot exposes actual runtime limits, not advertised constants");
  result.message.isError = true; assert.equal(service.snapshot().goal, null); result.message.isError = false;
  result.message.details.goal_id = "stale"; assert.equal(service.snapshot().goal, null); result.message.details.goal_id = goalId;
  contract.details.goalId = "stale"; assert.equal(service.snapshot().goal, null); contract.details.goalId = goalId;
  state.progressId = "foreign"; assert.equal(service.snapshot().goal, null); state.progressId = progressId;
  history.data.progressId = "foreign"; assert.equal(service.snapshot().goal, null); history.data.progressId = progressId;
  result.message.role = "assistant"; assert.equal(service.snapshot().goal, null); result.message.role = "toolResult";
  assert.equal(service.snapshot().goal.status, "complete");
});

test("verified completion before bootstrap/resume dispatch returns preserves accepted child linkage", async () => {
  const entry = { id: "11111111-1111-4111-8111-111111111111", revision: 1, status: "paused", child: null, text: "fast objective", tokenBudget: null,
    tokensUsed: 0, automaticTurns: 0, noProgressTurns: 0, summary: null, waiting: null, tasks: [] };
  function fixture(fastBootstrap) {
    const entries = [];
    let dispatches = 0;
    const runtime = { activeGoal: undefined, get continuationLimits(){return this.settings.continuationLimits}, settings: { continuationLimits: { automaticTurns: 3, noProgressTurns: 2 } },
      snapshotSettingsApplicationState: () => ({}), persistGoal(goal) { entries.push({ type: "custom", customType: "goal-state", data: { goal: structuredClone(goal ?? null) } }); } };
    const pi = { appendEntry(type, data) { entries.push({ type: "custom", customType: type, data }); } };
    const ctx = { isIdle: () => true, hasPendingMessages: () => false, ui: {}, sessionManager: { getSessionId: () => "fast-child", getBranch: () => entries } };
    function completeBeforeReply() {
      const goal = runtime.activeGoal, summary = "Verified fast fixture completion", callId = `complete-${goal.id}`;
      assert(entries.some(e => e.customType === "delegated-goal-child-binding-v1" && e.data.progressId === (goal.progressId ?? goal.id)), "binding is persisted before dispatch/completion");
      entries.push({ type: "custom_message", customType: "goal-contract", details: { state: "active", goalId: goal.id, activationId: goal.activationId } });
      entries.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: callId, name: "goal_complete", arguments: { goal_id: goal.id, activation_id: goal.activationId, summary } }] } });
      runtime.persistGoal({ ...goal, status: "complete" });
      entries.push({ type: "custom", customType: "goal-history", data: { version: 1, id: goal.id, progressId: goal.progressId ?? goal.id, status: "completed", summary } });
      runtime.activeGoal = undefined; runtime.persistGoal(undefined);
      entries.push({ type: "message", message: { role: "toolResult", toolName: "goal_complete", toolCallId: callId, isError: false,
        details: { goal_id: goal.id, summary }, content: [{ type: "text", text: `Goal complete: ${summary}` }] } });
    }
    const commands = {
      async startGoal(text, budget, _ctx, onActivated) {
        dispatches++;
        runtime.activeGoal = { id: "fast-start", activationId: "fast-first", status: "active", text, tokenBudget: budget, tokensUsed: 0, automaticModelTurns: 0, toolFreeRepeatCount: 0 };
        onActivated(runtime.activeGoal); if (fastBootstrap) completeBeforeReply();
      },
      pauseGoal() { runtime.activeGoal.status = "paused"; },
      async resumeGoal() {
        const prior = runtime.activeGoal;
        runtime.activeGoal = { ...prior, activationId: "fast-resumed-contract", progressId: prior.progressId ?? prior.id, status: "active" };
        completeBeforeReply();
      },
    };
    return { runtime, entries, get dispatches() { return dispatches; }, service: createDelegatedChildGoalService(pi, ctx, runtime, commands) };
  }
  const started = fixture(true);
  const completedStart = await started.service.bootstrap(entry);
  assert.equal(started.runtime.activeGoal, undefined);
  assert.equal(completedStart.childGoalId, "fast-start"); assert.equal(completedStart.goal.status, "complete");
  const entriesBeforeReplay = started.entries.length;
  await assert.rejects(started.service.bootstrap(entry), /already bound.*Resume/);
  assert.equal(started.dispatches, 1, "bootstrap replay cannot dispatch any new prompt");
  assert.equal(started.entries.length, entriesBeforeReplay, "bootstrap replay cannot mutate persisted state");
  assert.equal(started.runtime.activeGoal, undefined);
  assert.deepEqual(started.service.snapshot(), completedStart, "verified completion remains unchanged after replay");
  const resumed = fixture(false);
  await resumed.service.bootstrap(entry);
  await resumed.service.pause(entry.id, "fast-start", "fast-first");
  const completedResume = await resumed.service.resume(entry.id, "fast-start", entry, "fast-first");
  assert.equal(resumed.runtime.activeGoal, undefined);
  assert.equal(completedResume.childGoalId, "fast-start"); assert.equal(completedResume.childActivationId, "fast-resumed-contract"); assert.equal(completedResume.goal.status, "complete");
});
