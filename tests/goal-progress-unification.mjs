// Offline regression: real goal runtime, mutation service, tools and persistence.
// Usage: node tests/goal-progress-unification.mjs <installed pi package directory>
import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
globalThis.fetch = () => { throw new Error("Network forbidden in goal/checklist regression"); };
globalThis.WebSocket = class { constructor() { throw new Error("Network forbidden"); } };
const sdk = resolve(process.argv[2]);
const { createJiti } = await import(pathToFileURL(join(sdk, "node_modules/jiti/lib/jiti.mjs")));
const jiti = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-coding-agent": join(sdk, "dist/index.js"),
  "@earendil-works/pi-ai": join(sdk, "node_modules/@earendil-works/pi-ai/dist/index.js"),
  "@earendil-works/pi-tui": join(sdk, "node_modules/@earendil-works/pi-tui/dist/index.js"),
  typebox: join(sdk, "node_modules/typebox/build/index.mjs"),
} });
const { GoalRuntime, createGoal, nextGoalInstance, transitionGoal } = await jiti.import("../workflows/goal/runtime.ts");
const { bindGoalMutations } = await jiti.import("../workflows/goal/mutations.ts");
const { mutateProgress, readGoalTasks } = await jiti.import("../shared/goal-progress.ts");
const { loadGoalStateFromSession } = await jiti.import("../workflows/goal/persistence.ts");
const { readGoalHistory } = await jiti.import("../workflows/goal/history.ts");
const { validateProgressMutation, reconstructProgress, readScopedProgress } = await jiti.import("../progress/progress-state.ts");
const { registerGoalTools } = await jiti.import("../workflows/goal/tools.ts");
const { registerGoalLifecycle } = await jiti.import("../workflows/goal/lifecycle.ts");
const { createDelegatedChildGoalService } = await jiti.import("../workflows/delegated-child.ts");
const { GoalCommandController } = await jiti.import("../workflows/goal/commands.ts");
const { default: progressWidget } = await jiti.import("../progress/progress-widget.ts");
const { DEFAULT_PROGRESS_SETTINGS } = await jiti.import("../progress/settings.ts");
function fixture(options = {}) {
  const entries = options.entries ?? [], events = new EventEmitter(), tools = new Map(), messages = [], handlers = new Map();
  let idle = false, busy = false;
  const pi = { events: { emit: (...args) => events.emit(...args), on(name, fn) { events.on(name, fn); return () => events.off(name, fn); } },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data: structuredClone(data) }); },
    registerCommand() {}, registerTool(tool) { tools.set(tool.name, tool); }, on(name, fn) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); },
    getActiveTools: () => ["goal_complete", "goal_wait", "goal_blocked", "update_progress"],
    sendMessage(...args) { messages.push(args); }, sendUserMessage(...args) { messages.push(["user", ...args]); },
  };
  const ctx = { cwd: "/unused", model: { id: "offline" }, hasUI: false,
    isIdle: () => idle, hasPendingMessages: () => false,
    ui: { setStatus() {}, notify() {}, confirm: async () => false },
    sessionManager: { getSessionId: () => "offline", getBranch: () => entries, getEntries: () => entries },
  };
  const runtime = new GoalRuntime(pi);
  runtime.bindWorkflowSession(ctx.sessionManager);
  runtime.settings = { ...runtime.settings, continuationLimits: { automaticTurns: 8, noProgressTurns: 4 } };
  const dispose = bindGoalMutations(pi, ctx, runtime, { child: options.child ?? false, busy: () => busy });
  registerGoalTools(pi, runtime);
  const mutate = input => mutateProgress(pi, ctx, input);
  const create = (extra = {}) => mutate({ action: "create", request_id: "create", objective: "Verified offline outcome", steps: [{ text: "verify", status: "pending" }], ...extra });
  const update = (extra = {}) => mutate({ action: "update", request_id: "update", goal_id: runtime.activeGoal.id, expected_revision: runtime.activeGoal.revision, steps: [], ...extra });
  return { pi, ctx, runtime, entries, tools, messages, handlers, dispose, mutate, create, update, idle: value => idle = value, busy: value => busy = value };
}
test("checklist change timestamp is recorded without treating accounting as progress", () => {
  const f = fixture(), created = f.create({ start: false });
  const at = f.runtime.activeGoal.lastTaskUpdateAt;
  assert.ok(Number.isSafeInteger(at));
  f.runtime.activeGoal.tokensUsed++; f.runtime.persistGoal(f.runtime.activeGoal);
  assert.equal(f.runtime.activeGoal.lastTaskUpdateAt, at);
  f.runtime.activeGoal.tasks = f.runtime.activeGoal.tasks.map(task => ({ id: task.id, status: task.status, text: task.text }));
  f.runtime.persistGoal(f.runtime.activeGoal);
  assert.equal(f.runtime.activeGoal.lastTaskUpdateAt, at, 'serialization key order is not checklist progress');
  f.runtime.activeGoal.lastTaskUpdateAt = 1;
  f.update({ steps: [{ ...created.steps[0], status: 'completed' }] });
  assert.ok(f.runtime.activeGoal.lastTaskUpdateAt > 1);
  f.dispose();
});
test("create atomically allocates goal and tasks and authorizes default continuation with configured limits", () => {
  const f = fixture(), result = f.create();
  assert.equal(result.status, "active"); assert.ok(result.goalId); assert.ok(result.activationId); assert.ok(result.steps[0].id);
  assert.equal(f.entries.length, 1); assert.equal(f.entries[0].customType, "goal-state");
  assert.deepEqual(f.entries[0].data.goal.tasks, result.steps);
  assert.deepEqual(f.runtime.continuationLimits, { automaticTurns: 8, noProgressTurns: 4 });
  assert.equal(f.runtime.ownsWorkflow(), true);
  f.runtime.requestContinuation(f.runtime.activeGoal); f.idle(true);
  assert.equal(f.runtime.dispatchContinuationIfSettled(f.ctx), true);
  assert.ok(f.messages.some(([m, opts]) => m.customType === "goal-continuation" && opts.triggerTurn));
  assert.deepEqual(reconstructProgress(f.entries), result.steps);
});
test("registered update_progress and goal_manage creation share durable identities and reject standalone writes", async () => {
  const f = fixture(); progressWidget(f.pi, { loadSettings: async () => ({ kind: "loaded", settings: DEFAULT_PROGRESS_SETTINGS }) });
  for (const handler of f.handlers.get("session_start")) await handler({}, f.ctx);
  const tool = f.tools.get("update_progress");
  const input = { action: "create", request_id: "shared", objective: "Shared outcome", start: false, steps: [{ text: "Verify", status: "pending" }] };
  const result = await tool.execute("create", tool.prepareArguments(input), undefined, undefined, f.ctx);
  assert.ok(result.details.steps[0].id); assert.equal(result.details.goalId, f.runtime.activeGoal.id);
  const alias = await f.tools.get("goal_manage").execute("alias", input, undefined, undefined, f.ctx);
  assert.equal(alias.details.goalId, result.details.goalId); assert.equal(f.entries.length, 1);
  await assert.rejects(() => tool.execute("old", { steps: [] }, undefined, undefined, f.ctx), /request_id/);
  for (const handler of f.handlers.get("session_shutdown")) await handler({}, f.ctx);
});
test("default creation reaches the real settled lifecycle dispatcher without a second start", async () => {
  const f = fixture(); registerGoalLifecycle(f.pi, f.runtime, {});
  f.create();
  for (const handler of f.handlers.get("agent_end")) await handler({ messages: [] }, f.ctx);
  assert.ok(f.runtime.continuationIntent);
  f.idle(true);
  for (const handler of f.handlers.get("agent_settled")) await handler({}, f.ctx);
  assert.equal(f.messages.filter(([m]) => m.customType === "goal-continuation").length, 1);
  f.create();
  assert.equal(f.messages.filter(([m]) => m.customType === "goal-continuation").length, 1);
});
test("native child bootstrap preserves parent task IDs; Resume keeps identity and rejects old activation controls", async () => {
  const f = fixture({ child: true }); f.idle(true);
  const child = createDelegatedChildGoalService(f.pi, f.ctx, f.runtime, new GoalCommandController(f.runtime));
  const entry = { id: "12345678-1234-1234-1234-123456789abc", revision: 1, text: "Native child outcome", status: "paused", tasks: [{ id: "parent-task", text: "Preserved completed task", status: "completed" }], child: null, tokenBudget: null, tokensUsed: 0, automaticTurns: 0, noProgressTurns: 0, summary: null, waiting: null, continuationLimits: { automaticTurns: 8, noProgressTurns: 4 } };
  const started = await child.bootstrap(entry);
  assert.equal(started.goal.tasks[0].id, "parent-task"); assert.equal(started.goal.tasks[0].status, "completed");
  assert.equal(f.entries.filter(e => e.customType === "goal-state").length, 1, "native bootstrap persists goal plus tasks atomically");
  await child.pause(entry.id, started.childGoalId, started.childActivationId);
  const resumed = await child.resume(entry.id, started.childGoalId, entry, started.childActivationId);
  assert.equal(resumed.childGoalId, started.childGoalId); assert.notEqual(resumed.childActivationId, started.childActivationId);
  assert.deepEqual(resumed.goal.tasks, started.goal.tasks);
  await assert.rejects(child.pause(entry.id, started.childGoalId, started.childActivationId), /activation changed/);
  await assert.rejects(child.updateLimits(entry.id, resumed.childGoalId, resumed.policyRevision, entry, started.childActivationId), /activation changed/);
  assert.throws(() => f.create(), /authenticated parent/);
  assert.throws(() => f.update({ remove_task_ids: ["parent-task"] }), /authenticated parent/);
  child.dispose();
});
test("draft creation and task updates never resume or auto-complete", () => {
  const f = fixture(), created = f.create({ start: false });
  assert.equal(created.status, "paused"); assert.equal(f.runtime.ownsWorkflow(), false);
  const result = f.update({ steps: [{ ...created.steps[0], status: "completed" }] });
  assert.equal(result.status, "paused"); assert.equal(f.runtime.activeGoal.status, "paused");
  assert.equal(f.runtime.continuationIntent, undefined);
});
test("updates preserve omitted tasks, allocate missing IDs, and remove only explicit IDs", () => {
  const f = fixture(), created = f.create({ start: false });
  const added = f.update({ steps: [{ text: "second", status: "pending" }] });
  assert.equal(added.steps.length, 2); assert.equal(added.steps[0].id, created.steps[0].id);
  const changed = f.update({ request_id: "change", steps: [{ ...added.steps[0], text: "verified refinement", status: "completed" }] });
  assert.equal(changed.steps.length, 2); assert.equal(changed.steps[1].id, added.steps[1].id);
  const removed = f.update({ request_id: "remove", remove_task_ids: [added.steps[1].id] });
  assert.deepEqual(removed.steps, [changed.steps[0]]);
});
test("missing/null goal, missing revision, unknown/foreign and duplicate task IDs fail closed", () => {
  const f = fixture(), created = f.create({ start: false });
  for (const goal_id of [null, undefined, "foreign"]) assert.throws(() => f.update({ goal_id }), /goal|Goal/);
  assert.throws(() => f.update({ expected_revision: undefined }), /expected_revision/);
  assert.throws(() => f.update({ steps: [{ id: "foreign", text: "x", status: "pending" }] }), /Unknown or foreign/);
  assert.throws(() => f.update({ steps: [created.steps[0], created.steps[0]] }), /Duplicate/);
  assert.throws(() => f.update({ remove_task_ids: ["foreign"] }), /Unknown or foreign/);
  assert.equal(f.entries.length, 1);
});
test("durable retry receipts survive reload, revisions, completion/clear and reject payload reuse", () => {
  const f = fixture(), created = f.create({ start: false });
  assert.deepEqual(f.create({ start: false }), created); assert.equal(f.entries.length, 1);
  const request = { action: "update", request_id: "append", goal_id: created.goalId, expected_revision: created.revision, steps: [{ text: "new", status: "pending" }] };
  const result = f.mutate(request);
  f.update({ request_id: "later-mutation" });
  assert.equal(Object.keys(f.runtime.activeGoal.requests).length, 1, "checkpoints do not copy an unbounded receipt ledger");
  f.runtime.activeGoal.tokensUsed++; f.runtime.persistGoal(f.runtime.activeGoal);
  const entries = structuredClone(f.entries); f.dispose();
  const reload = fixture({ entries }); reload.runtime.activeGoal = loadGoalStateFromSession(reload.ctx).goal;
  assert.deepEqual(reload.mutate(request), result); assert.equal(reload.runtime.activeGoal.tasks.length, 2);
  assert.throws(() => reload.mutate({ ...request, steps: [] }), /request_id/);
  reload.runtime.clearActiveGoal(reload.ctx);
  const count = entries.length;
  assert.deepEqual(reload.create({ start: false }), created); assert.equal(entries.length, count); assert.equal(reload.runtime.activeGoal, undefined);
});
test("existing paused goals, native child ownership, workflow ownership and pending approvals block creation", () => {
  const f = fixture(); f.create({ start: false });
  assert.throws(() => f.create({ request_id: "replacement" }), /already exists/);
  assert.throws(() => fixture({ child: true }).create(), /authenticated parent/);
  const busy = fixture(); busy.busy(true); assert.throws(() => busy.create(), /permission/); assert.equal(busy.entries.length, 0);
  const other = fixture(), owner = new GoalRuntime(other.pi); owner.bindWorkflowSession(other.ctx.sessionManager); assert.ok(owner.acquireWorkflow());
  assert.throws(() => other.create(), /workflow/); assert.equal(other.entries.length, 0);
});
test("standalone history is readable but never becomes a current checklist", () => {
  const history = [{ type: 'custom', customType: 'progress-scoped-state', data: { version: 1, goalKey: null, steps: [{ text: 'Historical task', status: 'pending' }] } }];
  assert.equal(readScopedProgress(history, null).length, 1);
  assert.deepEqual(reconstructProgress(history), []);
  assert.deepEqual(reconstructProgress([...history, { type: 'custom', customType: 'goal-state', data: { goal: null } }]), []);
});
test("legacy migration preserves exact linked tasks and IDs without associating standalone history", () => {
  const f = fixture(); const legacy = createGoal("old", undefined, 0); delete legacy.tasks; delete legacy.revision; delete legacy.activationId;
  legacy.progressId = "original-scope"; legacy.status = "paused";
  const linked = [{ id: "kept-id", text: "linked", status: "completed" }, { text: "old no id", status: "blocked" }];
  f.entries.push({ type: "custom", customType: "progress-scoped-state", data: { version: 1, goalKey: null, steps: [{ text: "unrelated", status: "pending" }] } },
    { type: "custom", customType: "goal-state", data: { goal: legacy } },
    { type: "custom", customType: "progress-scoped-state", data: { version: 1, goalKey: "original-scope", steps: linked } });
  const restored = loadGoalStateFromSession(f.ctx).goal;
  assert.equal(restored.tasks[0].id, "kept-id"); assert.equal(restored.tasks[1].status, "blocked"); assert.ok(restored.tasks[1].id);
  assert.deepEqual(loadGoalStateFromSession(f.ctx).goal.tasks, restored.tasks);
  f.runtime.activeGoal = restored; f.runtime.persistGoal(restored);
  assert.deepEqual(reconstructProgress(f.entries), restored.tasks);
  assert.equal(readScopedProgress(f.entries, null)[0].text, "unrelated");
  assert.throws(() => validateProgressMutation({ steps: [] }), /request_id/);
});
test("stable goal identity rotates only activation and rejects stale completion/wait/block calls", async () => {
  const f = fixture(), created = f.create();
  const old = f.runtime.activeGoal; f.runtime.requestContinuation(old); const oldPrompt = f.runtime.continuationIntent.prompt;
  f.runtime.activeGoal = nextGoalInstance(transitionGoal(old, "active")); f.runtime.persistGoal(f.runtime.activeGoal);
  assert.equal(f.runtime.activeGoal.id, created.goalId); assert.notEqual(f.runtime.activeGoal.activationId, created.activationId);
  assert.equal(f.runtime.continuationIntent, undefined); assert.equal(f.runtime.markContinuationStarted(oldPrompt), undefined);
  f.runtime.beginAgentRun(created.goalId, "manual");
  for (const [name, args] of [["goal_complete", { summary: "verified" }], ["goal_wait", { reason: "external event" }], ["goal_blocked", { reason: "external", evidence: "verified blocker", repeated_turns: 3 }]]) {
    const result = await f.tools.get(name).execute("old", { goal_id: created.goalId, activation_id: created.activationId, ...args }, undefined, undefined, f.ctx);
    assert.match(result.content[0].text, /activation_id/); assert.equal(f.runtime.activeGoal.status, "active");
  }
});
test("goal_manage status is authoritative and completion still rejects unfinished tasks", async () => {
  const f = fixture(), created = f.create();
  const status = await f.tools.get("goal_manage").execute("status", { action: "status" }, undefined, undefined, f.ctx);
  assert.deepEqual(status.details.goal.tasks, created.steps); assert.equal(status.details.goal.revision, f.runtime.activeGoal.revision);
  await assert.rejects(() => f.tools.get("goal_complete").execute("complete", { goal_id: created.goalId, activation_id: created.activationId, summary: "Verified result" }, undefined, undefined, f.ctx), /required tasks/);
  f.update({ steps: [{ ...created.steps[0], status: "completed" }] });
  assert.equal(f.runtime.activeGoal.status, "active");
  const result = await f.tools.get("goal_complete").execute("complete2", { goal_id: created.goalId, activation_id: created.activationId, summary: "Verified result" }, undefined, undefined, f.ctx);
  assert.equal(result.terminate, true); assert.equal(f.runtime.activeGoal, undefined);
  f.runtime.clearCompletionStatusTimer();
});
function completionRequest(f, extra = {}) {
  const goal = f.runtime.activeGoal;
  return { action: "complete", goal_id: goal.id, activation_id: goal.activationId, expected_revision: goal.revision,
    user_authorized: true, summary: "Verified the outcome with passing offline regression tests.", ...extra };
}
function manage(f, args) {
  return f.tools.get("goal_manage").execute("manage", args, undefined, undefined, f.ctx);
}
for (const draft of [true, false]) test(`explicit paused completion preserves verified history without activation (${draft ? "draft" : "previously active"})`, async () => {
  const f = fixture(); registerGoalLifecycle(f.pi, f.runtime, {});
  const created = f.create({ start: !draft });
  f.update({ steps: [{ ...created.steps[0], status: "completed" }] });
  if (!draft) {
    f.entries.push({ type: "message", message: { role: "assistant", usage: { totalTokens: 37 } } });
    await manage(f, { ...completionRequest(f), action: "pause", summary: undefined });
    assert.equal(f.runtime.activeGoal.tokensUsed, 37);
  }
  const previous = structuredClone(f.runtime.activeGoal);
  f.entries.push({ type: "message", message: { role: "assistant", usage: { totalTokens: 91 } } });
  f.runtime.beginAgentRun(null, "manual");
  f.runtime.acquireWorkflow = () => { throw new Error("Completion must not acquire autonomy"); };
  const beginAgentRun = f.runtime.beginAgentRun.bind(f.runtime);
  f.runtime.beginAgentRun = (goalId, origin) => { assert.equal(goalId, null, "completion may only revoke run ownership"); beginAgentRun(goalId, origin); };
  f.runtime.ensureGoalContextContract = () => { throw new Error("Completion must not create an active contract"); };
  f.ctx.model = undefined;
  const messageCount = f.messages.length;
  const args = completionRequest(f, { summary: "  Verified the outcome with passing offline regression tests.  " });
  try {
    const result = await manage(f, args);
    assert.equal(result.terminate, true);
    assert.equal(result.details.summary, args.summary.trim());
    assert.equal(result.details.goal_id, previous.id);
    assert.equal(result.details.presentation.action, "complete");
    assert.equal(f.runtime.activeGoal, undefined);
    assert.equal(f.runtime.ownsWorkflow(), false);
    assert.equal(f.runtime.continuationIntent, undefined);
    assert.equal(f.runtime.continuationDelivery, undefined);
    assert.equal(f.runtime.goalWaitTimer.timer, undefined);
    assert.equal(f.runtime.goalRecovery, undefined);
    assert.equal(f.runtime.budgetWrapUp, undefined);
    const completed = f.entries.filter(e => e.customType === "goal-state" && e.data.goal?.status === "complete").at(-1).data.goal;
    assert.equal(completed.activationId, previous.activationId);
    assert.equal(completed.revision, previous.revision + 1);
    assert.deepEqual(completed.tasks, previous.tasks);
    assert.equal(completed.tokensUsed, previous.tokensUsed, "paused chat must not be charged to Goal usage");
    assert.equal(completed.timeUsedSeconds, previous.timeUsedSeconds);
    assert.equal(completed.automaticModelTurns, previous.automaticModelTurns);
    assert.equal(completed.waiting, undefined);
    assert.equal(loadGoalStateFromSession(f.ctx).goal, undefined);
    const [history] = readGoalHistory(f.ctx);
    assert.equal(history.id, previous.id); assert.equal(history.status, "completed");
    assert.equal(history.summary, args.summary.trim()); assert.deepEqual(history.tasks, previous.tasks);
    // If best-effort archiving fails, the accepted state + matching result still retain evidence.
    const fallbackEntries = f.entries.filter(e => e.customType !== "goal-history");
    fallbackEntries.push({ type: "message", message: { role: "toolResult", toolName: "goal_manage", ...result } });
    assert.equal(readGoalHistory({ sessionManager: { getBranch: () => fallbackEntries } })[0].summary, args.summary.trim());
    fallbackEntries.at(-1).message.isError = true;
    assert.equal(readGoalHistory({ sessionManager: { getBranch: () => fallbackEntries } })[0].summary, null);
    assert.deepEqual(reconstructProgress(f.entries), []);
    f.idle(true);
    for (const handler of f.handlers.get("agent_settled")) await handler({}, f.ctx);
    for (const [message, options] of f.messages.slice(messageCount)) {
      assert.equal(message.customType, "goal-contract");
      assert.equal(message.details.state, "inactive");
      assert.equal(options.triggerTurn, false);
    }
    assert.equal(f.runtime.dispatchContinuationIfSettled(f.ctx), false);
    const count = f.entries.length;
    await assert.rejects(manage(f, args), /identity/);
    assert.equal(f.entries.length, count, "completion cannot replay against an absent goal");
  } finally { f.runtime.clearCompletionStatusTimer(); }
});
test("paused completion fails closed on unfinished tasks, authorization, stale identity and automatic origin", async () => {
  const f = fixture(), created = f.create({ start: false });
  const rejectUnchanged = async (extra, pattern) => {
    const before = structuredClone(f.runtime.activeGoal), entries = structuredClone(f.entries), messages = structuredClone(f.messages);
    await assert.rejects(manage(f, completionRequest(f, extra)), pattern);
    assert.deepEqual(f.runtime.activeGoal, before); assert.deepEqual(f.entries, entries); assert.deepEqual(f.messages, messages);
  };
  for (const status of ["pending", "in_progress", "blocked"]) {
    f.update({ request_id: `task-${status}`, steps: [{ ...created.steps[0], status }] });
    await rejectUnchanged({}, /required tasks/);
  }
  f.update({ steps: [{ ...created.steps[0], status: "completed" }] });
  for (const user_authorized of [undefined, false]) await rejectUnchanged({ user_authorized }, /fresh explicit user authorization/);
  for (const extra of [{ goal_id: undefined }, { goal_id: "foreign" }, { activation_id: undefined }, { activation_id: "stale" },
    { expected_revision: undefined }, { expected_revision: f.runtime.activeGoal.revision - 1 }]) await rejectUnchanged(extra, /identity, activation or revision changed/);
  for (const summary of [undefined, "", "   ", "x".repeat(4001), "The goal is not complete."]) await rejectUnchanged({ summary }, /summary/);
  f.runtime.beginAgentRun(f.runtime.activeGoal.id, "automatic");
  await rejectUnchanged({}, /automatic continuation/);
  f.runtime.beginAgentRun(null, "manual");
  for (const status of ["active", "blocked", "budget_limited", "usage_limited", "complete"]) {
    f.runtime.activeGoal.status = status;
    await rejectUnchanged({}, /requires a paused goal/);
  }
});
test("autonomous goal_complete still rejects paused goals without execution authority", async () => {
  const f = fixture(), created = f.create({ start: false, steps: [{ text: "Verified", status: "completed" }] });
  for (const ownedRun of [false, true]) {
    f.runtime.beginAgentRun(ownedRun ? created.goalId : null, "manual");
    const before = structuredClone(f.runtime.activeGoal), count = f.entries.length;
    const result = await f.tools.get("goal_complete").execute("autonomous", { goal_id: created.goalId, activation_id: created.activationId, summary: "Verified outcome" }, undefined, undefined, f.ctx);
    assert.match(result.content[0].text, /rejected/); assert.notEqual(result.terminate, true);
    assert.deepEqual(f.runtime.activeGoal, before); assert.equal(f.entries.length, count);
  }
});
test("branch navigation pauses selected goal, preserves branch tasks/counters, and invalidates old callbacks", async () => {
  const f = fixture(); registerGoalLifecycle(f.pi, f.runtime, {}); f.idle(true);
  f.entries.push({ type: "custom", customType: "progress-scoped-state", data: { version: 1, goalKey: null, steps: [{ text: "unrelated history", status: "blocked" }] } });
  const created = f.create(); f.runtime.activeGoal.tokensUsed = 17; f.runtime.activeGoal.automaticModelTurns = 2; f.runtime.persistGoal(f.runtime.activeGoal);
  const selectedBranch = structuredClone(f.entries);
  f.update({ steps: [{ text: "other branch task", status: "pending" }] });
  const oldRevision = f.runtime.activeGoal.revision;
  f.runtime.requestContinuation(f.runtime.activeGoal); const stalePrompt = f.runtime.continuationIntent.prompt;
  f.entries.splice(0, f.entries.length, ...structuredClone(selectedBranch));
  for (const handler of f.handlers.get("session_tree")) await handler({}, f.ctx);
  assert.equal(f.runtime.activeGoal.id, created.goalId); assert.notEqual(f.runtime.activeGoal.activationId, created.activationId);
  assert.equal(f.runtime.activeGoal.status, "paused"); assert.equal(f.runtime.activeGoal.tokensUsed, 17); assert.equal(f.runtime.activeGoal.automaticModelTurns, 2);
  assert.ok(f.runtime.activeGoal.revision > oldRevision); assert.equal(f.runtime.ownsWorkflow(), false);
  assert.equal(f.runtime.continuationIntent, undefined); assert.equal(f.runtime.markContinuationStarted(stalePrompt), undefined);
  assert.throws(() => f.update({ expected_revision: oldRevision, request_id: "stale-callback", steps: [{ text: "must not attach", status: "pending" }] }), /revision changed/);
  const status = await f.tools.get("goal_manage").execute("status", { action: "status" }, undefined, undefined, f.ctx);
  assert.deepEqual(status.details.goal.tasks, created.steps); assert.deepEqual(reconstructProgress(f.entries), created.steps);
  assert.deepEqual(f.entries.slice(0, selectedBranch.length), selectedBranch, "navigation never rewrites historical entries");
  assert.equal(readScopedProgress(f.entries, null)[0].text, "unrelated history");
  for (const handler of f.handlers.get("agent_settled")) await handler({}, f.ctx);
  assert.equal(f.runtime.activeGoal.status, "paused"); assert.equal(f.messages.filter(([m]) => m.customType === "goal-continuation").length, 0);
});
test("control and policy revisions ignore accounting while live limits survive task updates", () => {
  const f = fixture(); f.create({ start: false });
  f.runtime.activeGoal.automaticModelTurns = 5;
  f.runtime.updateGoalLimits(f.ctx, f.runtime.activeGoal.id, f.runtime.policyRevision, null, { automaticTurns: 12, noProgressTurns: 6 });
  const policy = f.runtime.policyRevision, revision = f.runtime.activeGoal.revision;
  Object.assign(f.runtime.activeGoal, { tokensUsed: 19, timeUsedSeconds: 12, baselineTokens: 1,
    activeStartedAt: Date.now(), updatedAt: Date.now(), iteration: 2, toolFreeRepeatCount: 1,
    lastToolFreeOutputFingerprint: "a".repeat(64) });
  f.runtime.persistGoal(f.runtime.activeGoal);
  assert.equal(f.runtime.policyRevision, policy); assert.equal(f.runtime.activeGoal.revision, revision);
  const patched = f.update({ expected_revision: revision, steps: [{ text: "extra", status: "pending" }] });
  assert.equal(patched.revision, revision + 1);
  assert.deepEqual(f.runtime.continuationLimits, { automaticTurns: 12, noProgressTurns: 6 });
  assert.equal(f.runtime.activeGoal.automaticModelTurns, 5);
});
test("task, scope, lifecycle, activation and policy changes still invalidate control revisions", () => {
  const f = fixture(); f.create();
  for (const change of [
    goal => { goal.tasks[0].text = "Refined scope"; },
    goal => { goal.text = "Changed objective"; },
    goal => { goal.status = "paused"; },
    goal => { goal.activationId = "new-activation"; },
    goal => { goal.tokenBudget = 100; goal.tokenBudgetExplicit = true; },
    goal => { goal.continuationLimits = { automaticTurns: 12, noProgressTurns: 6 }; },
  ]) {
    const revision = f.runtime.activeGoal.revision;
    change(f.runtime.activeGoal);
    f.runtime.persistGoal(f.runtime.activeGoal);
    assert.equal(f.runtime.activeGoal.revision, revision + 1);
    assert.throws(() => f.update({ expected_revision: revision, request_id: `stale-${revision}` }), /revision changed/);
    f.runtime.activeGoal.automaticModelTurns++; f.runtime.persistGoal(f.runtime.activeGoal);
    assert.equal(f.runtime.activeGoal.revision, revision + 1, "counter checkpoint preserves mutation fence");
  }
  const waiting = fixture(), created = waiting.create();
  waiting.runtime.enterGoalWait(waiting.ctx, created.goalId, { reason: "External wake" });
  assert.equal(waiting.runtime.activeGoal.revision, created.revision + 1);
  waiting.runtime.recordGoalUsage(waiting.runtime.activeGoal, waiting.ctx);
  waiting.runtime.persistGoal(waiting.runtime.activeGoal);
  assert.equal(waiting.runtime.activeGoal.revision, created.revision + 1);
  waiting.runtime.clearGoalWait(waiting.ctx, created.goalId);
  assert.equal(waiting.runtime.activeGoal.revision, created.revision + 2);
});
test("no-op task mutations commit their receipt revision once and retry durably", () => {
  const f = fixture(), created = f.create({ start: false });
  const request = { action: "update", goal_id: created.goalId, expected_revision: created.revision, request_id: "no-op", steps: [] };
  const result = f.mutate(request);
  assert.equal(result.revision, created.revision + 1);
  assert.equal(result.revision, f.runtime.activeGoal.revision);
  assert.equal(result.revision, f.entries.at(-1).data.goal.requests[request.request_id].result.revision);
  f.runtime.activeGoal.tokensUsed++; f.runtime.persistGoal(f.runtime.activeGoal);
  assert.deepEqual(f.mutate(request), result);
  const next = f.update({ request_id: "another-no-op", expected_revision: result.revision });
  assert.equal(next.revision, result.revision + 1);
});
