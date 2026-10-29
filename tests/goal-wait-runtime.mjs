// Real Pi AgentSession, offline scripted provider and real quiet-state delivery.
// node tests/goal-wait-runtime.mjs <installed pi package directory>
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
const sdk = resolve(process.argv[2]);
const { createAgentSession, AgentSessionRuntime, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, initTheme } = await import(pathToFileURL(join(sdk, "dist/index.js")));
const { AssistantMessageEventStream } = await import(pathToFileURL(join(sdk, "node_modules/@earendil-works/pi-ai/dist/index.js")));
const { createJiti } = await import(pathToFileURL(join(sdk, "node_modules/jiti/lib/jiti.mjs")));
const jiti = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-coding-agent": join(sdk, "dist/index.js"),
  "@earendil-works/pi-ai": join(sdk, "node_modules/@earendil-works/pi-ai/dist/index.js"),
  "@earendil-works/pi-tui": join(sdk, "node_modules/@earendil-works/pi-tui/dist/index.js"),
  typebox: join(sdk, "node_modules/typebox/build/index.mjs"),
} });
// Optional immutable installed bundle for post-deployment verification.
const source = process.env.PI_GOAL_TEST_SOURCE ?? fileURLToPath(new URL("../", import.meta.url));
const { default: goal } = await jiti.import(join(source, "workflows/goal/goal.ts"));
const { default: progress } = await jiti.import(join(source, "progress/progress-widget.ts"));
const { DEFAULT_PROGRESS_SETTINGS } = await jiti.import(join(source, "progress/settings.ts"));
const { bindGoalMutations } = await jiti.import(join(source, "workflows/goal/mutations.ts"));
const { installQuietState } = await jiti.import(join(source, "shared/quiet-state.ts"));
const { GoalWaitTimer } = await jiti.import(join(source, "workflows/goal/wait.ts"));
const call = (name, args) => ({ type: "toolCall", id: `${name}-${crypto.randomUUID()}`, name, arguments: args });
const text = m => typeof m.content === "string" ? m.content : m.content.filter(p => p.type === "text").map(p => p.text).join("\n");

async function fixture(directory, script, manager) {
  initTheme("dark", false);
  const models = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, modelsStorePath: join(directory, "models"), allowModelNetwork: false, refreshOnCreate: false });
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  let engine, ctx, quiet, calls = 0, externalStarts = 0;
  const errors = [], tools = new Map(), contexts = [];
  const factory = pi => {
    const wrapped = { ...pi, registerTool(tool) { tools.set(tool.name, tool); pi.registerTool(tool); } };
    ({ runtime: engine } = goal(wrapped, { settingsPath: join(directory, "absent-settings.json") }));
    progress(pi, { loadSettings: async () => ({ kind: "loaded", settings: DEFAULT_PROGRESS_SETTINGS }) });
    quiet = installQuietState(pi, 1);
    let unbind;
    pi.on("session_start", (_event, context) => { ctx = context; unbind = bindGoalMutations(pi, ctx, engine, { child: false, busy: () => false }); });
    pi.on("session_shutdown", () => unbind?.());
    // Controlled external work with an explicit fixture identity, not a guessed child assignment.
    pi.registerTool({ name: "external_start", label: "External fixture", description: "Arrange fixture completion delivery", parameters: { type: "object", properties: {} },
      async execute() { externalStarts++; return { content: [{ type: "text", text: "Fixture job arranged; completion will be delivered by harness-state" }], details: { job_id: "fixture-job" } }; } });
    pi.registerProvider("goal-wait-test", {
      api: "openai-completions", apiKey: "offline", baseUrl: "https://invalid.invalid",
      models: [{ id: "offline", name: "Offline", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(_model, context) {
        calls++; contexts.push(context);
        assert.ok(calls < 30, "fixture runaway guard");
        const content = script({ calls, context, engine });
        const message = { role: "assistant", provider: "goal-wait-test", model: "offline", api: "openai-completions", timestamp: Date.now(), stopReason: content.some(p => p.type === "toolCall") ? "toolUse" : "stop", content,
          usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const stream = new AssistantMessageEventStream();
        queueMicrotask(() => { stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); });
        return stream;
      },
    });
  };
  const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [factory] });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: models, settingsManager: settings, resourceLoader: loader, sessionManager: manager ?? SessionManager.create(directory, join(directory, "sessions")), noTools: "builtin" });
  const owner = new AgentSessionRuntime(session, { cwd: directory, agentDir: directory, modelRuntime: models, settingsManager: settings, resourceLoader: loader, diagnostics: [] }, async () => { throw Error("Unexpected replacement"); });
  await session.bindExtensions({ onError: error => errors.push(error) });
  await session.setModel(models.getModel("goal-wait-test", "offline"));
  return { session, owner, tools, errors, contexts, get calls() { return calls; }, get externalStarts() { return externalStarts; }, get engine() { return engine; }, get ctx() { return ctx; },
    invoke(name, args) { return tools.get(name).execute("fixture-replay", args, new AbortController().signal, undefined, ctx); },
    enqueue(update) { return quiet.enqueue(ctx, update); },
    async settledAfter(action) {
      const settled = new Promise(resolve => { const off = session.subscribe(event => { if (event.type === "agent_settled") { off(); resolve(); } }); });
      await action(); await settled; await session.waitForIdle();
    },
    async dispose() { await session.abort(); await owner.dispose(); engine.clearCompletionStatusTimer(); assert.deepEqual(errors, []); },
  };
}
const identity = engine => ({ goal_id: engine.activeGoal.id, activation_id: engine.activeGoal.activationId });
const waitArgs = engine => ({ ...identity(engine), reason: "Only the arranged fixture result remains" });
function startScript({ calls, engine }) {
  if (calls === 1) return [call("update_progress", { action: "create", request_id: "create", objective: "Verify controlled external work", steps: [{ text: "Verify external result", status: "pending" }] })];
  if (calls === 2) return [call("external_start", {})];
  return [call("goal_wait", waitArgs(engine))];
}
async function isolated(run) {
  const directory = await mkdtemp(join(tmpdir(), "pi-goal-wait-")), originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw Error("Network forbidden in offline wait tests"); };
  try { await run(directory); } finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }
}

test("real Pi create/tasks/external work/wait; idempotent repeats preserve deadlines and authority", { timeout: 15000 }, () => isolated(async directory => {
  const f = await fixture(directory, startScript);
  try {
    await f.session.prompt("Create a goal, arrange external work, then wait for its result."); await f.session.waitForIdle();
    assert.equal(f.calls, 3); assert.equal(f.externalStarts, 1);
    const args = waitArgs(f.engine);
    const initialRevision = f.engine.activeGoal.revision;
    const first = await f.invoke("goal_wait", args);
    assert.equal(first.details.changed, false); assert.equal(first.details.deadline, "preserved");
    assert.deepEqual(first.details.waiting, { reason: args.reason, resume_at: null });
    assert.equal(f.engine.activeGoal.revision, initialRevision);
    const timed = await f.invoke("goal_wait", { ...args, resume_after_ms: 1 });
    assert.equal(timed.details.resume_after_ms, 10000); assert.equal(timed.details.requested_resume_after_ms, 1);
    const deadline = timed.details.waiting.resume_at;
    const repeated = await f.invoke("goal_wait", args);
    assert.equal(repeated.details.waiting.resume_at, deadline); assert.equal(repeated.details.changed, false);
    const changedReason = await f.invoke("goal_wait", { ...args, reason: "Same job, updated reason" });
    assert.equal(changedReason.details.waiting.resume_at, deadline); assert.equal(changedReason.details.changed, true);
    const updated = await f.invoke("goal_wait", { ...args, resume_after_ms: 60000 });
    assert.ok(updated.details.waiting.resume_at > deadline); assert.equal(updated.details.deadline, "replaced");
    assert.equal(updated.details.wake_semantics.subscription, "none");
    const snapshot = structuredClone(f.engine.activeGoal);
    const stale = await f.invoke("goal_wait", { ...args, activation_id: "stale" });
    assert.match(text(stale), /rejected/); assert.deepEqual(f.engine.activeGoal, snapshot);
    const status = await f.invoke("goal_manage", { action: "status" });
    assert.deepEqual(status.details.goal.waiting, snapshot.waiting); assert.equal(status.details.goal.tasks.length, 1);
    assert.equal(status.details.goal.lastWake, null); assert.equal(status.details.goal.wakeSemantics.subscription, "none");
    assert.equal(f.engine.dispatchContinuationIfSettled(f.ctx), false);
    await delay(30); assert.equal(f.calls, 3, "no automatic continuation/polling after wait or status reads");
    assert.match(f.contexts.at(-1).systemPrompt ?? JSON.stringify(f.contexts.at(-1)), /only delegated results|only delegated results or external work/i);
    await f.invoke("goal_manage", { action: "resume", ...identity(f.engine), expected_revision: f.engine.activeGoal.revision, user_authorized: true });
    assert.equal(f.engine.activeGoal.waiting, undefined); assert.equal(f.engine.activeGoal.lastWake.reason, "explicit_resume");
    assert.equal(f.engine.dispatchDueGoalWait(f.ctx), false);
  } finally { await f.dispose(); }
}));

test("arranged external work does not suppress useful independent parent work", { timeout: 15000 }, () => isolated(async directory => {
  const f = await fixture(directory, ({ calls, engine }) => {
    if (calls === 1) return [call("update_progress", { action: "create", request_id: "create", objective: "Verify parent and external work", steps: [{ text: "Independent parent verification", status: "pending" }, { text: "External result", status: "pending" }] })];
    if (calls === 2) return [call("external_start", {})];
    if (calls === 3) return [call("update_progress", { action: "update", goal_id: engine.activeGoal.id, expected_revision: engine.activeGoal.revision, request_id: "independent", steps: [{ ...engine.activeGoal.tasks[0], status: "completed" }] })];
    return [call("goal_wait", waitArgs(engine))];
  });
  try {
    await f.session.prompt("Arrange external work, finish independent parent verification, then wait."); await f.session.waitForIdle();
    assert.equal(f.externalStarts, 1); assert.equal(f.calls, 4);
    assert.deepEqual(f.engine.activeGoal.tasks.map(task => task.status), ["completed", "pending"]);
    assert.ok(f.engine.activeGoal.waiting);
  } finally { await f.dispose(); }
}));

test("real completion/guidance delivery wakes once; routine and duplicate receipts remain quiet", { timeout: 15000 }, () => isolated(async directory => {
  const f = await fixture(directory, startScript);
  try {
    await f.session.prompt("Create, arrange external work and wait."); await f.session.waitForIdle();
    const routine = { kind: "job", id: "fixture-job-progress", job_id: "fixture-job", state: "running", message: "ordinary progress" };
    f.enqueue(routine); f.enqueue(routine); await delay(30); assert.equal(f.calls, 3);
    const done = { kind: "job", id: "fixture-job-result", job_id: "fixture-job", completion: true, state: "completed", through_sequence: 1 };
    await f.settledAfter(() => f.enqueue(done));
    assert.equal(f.calls, 4); assert.equal(f.engine.activeGoal.lastWake.reason, "custom_message");
    assert.equal(f.engine.activeGoal.lastWake.customType, "harness-state");
    assert.ok(f.engine.activeGoal.waiting, "fixture deliberately re-waits after reading the wake");
    const wake = structuredClone(f.engine.activeGoal.lastWake);
    f.enqueue(done); f.enqueue(routine); await delay(30); assert.equal(f.calls, 4); assert.deepEqual(f.engine.activeGoal.lastWake, wake);
    const guidance = { kind: "notification", id: "fixture-guidance", child_id: "fixture-child", requires_guidance: true, message: "Need a decision" };
    await f.settledAfter(() => f.enqueue(guidance)); assert.equal(f.calls, 5);
    f.enqueue(guidance); await delay(30); assert.equal(f.calls, 5, "duplicate guidance never re-wakes");
  } finally { await f.dispose(); }
}));

test("user interruption clears waiting before provider; paused goals stay paused; explicit resume and completion work", { timeout: 15000 }, () => isolated(async directory => {
  let mode = "start";
  const f = await fixture(directory, info => {
    if (mode === "start") return startScript(info);
    if (mode === "user") {
      assert.equal(info.engine.activeGoal.waiting, undefined); assert.equal(info.engine.activeGoal.lastWake.reason, "user_input");
      mode = "rewait"; return [call("goal_manage", { action: "status" })];
    }
    if (mode === "rewait") return [call("goal_wait", waitArgs(info.engine))];
    if (mode === "paused") { assert.equal(info.engine.activeGoal.status, "paused"); return [{ type: "text", text: "Ordinary user answer; no goal work." }]; }
    if (mode === "finish-task") { mode = "finish"; const g = info.engine.activeGoal; return [call("update_progress", { action: "update", goal_id: g.id, expected_revision: g.revision, request_id: "verified", steps: [{ ...g.tasks[0], status: "completed" }] })]; }
    return [call("goal_complete", { ...identity(info.engine), summary: "Verified controlled external output and all required tasks" })];
  });
  try {
    await f.session.prompt("Create and wait."); await f.session.waitForIdle();
    await f.invoke("goal_wait", { ...waitArgs(f.engine), resume_after_ms: 10000 });
    mode = "user"; await f.session.prompt("Recheck the condition, then wait again."); await f.session.waitForIdle();
    assert.equal(f.calls, 5); assert.equal(f.engine.activeGoal.waiting.resumeAt, undefined, "old deadline was cleared, not inherited by a fresh wait");
    const g = f.engine.activeGoal;
    await f.invoke("goal_manage", { action: "pause", ...identity(f.engine), expected_revision: g.revision, user_authorized: true });
    assert.equal(f.engine.activeGoal.waiting, undefined);
    mode = "paused"; await f.session.prompt("Answer an unrelated question without resuming."); await f.session.waitForIdle();
    assert.equal(f.engine.activeGoal.status, "paused"); assert.equal(f.calls, 6);
    assert.equal(f.engine.dispatchDueGoalWait(f.ctx), false);
    const paused = f.engine.activeGoal;
    await f.invoke("goal_manage", { action: "resume", ...identity(f.engine), expected_revision: paused.revision, user_authorized: true });
    assert.notEqual(f.engine.activeGoal.activationId, g.activationId);
    const stale = await f.invoke("goal_wait", { goal_id: g.id, activation_id: g.activationId, reason: "stale" }); assert.match(text(stale), /rejected/);
    mode = "finish-task"; await f.session.prompt("Verify the external result and complete."); await f.session.waitForIdle();
    assert.equal(f.engine.activeGoal, undefined); assert.equal(f.calls, 8);
  } finally { await f.dispose(); }
}));

test("deadline dispatch is one-shot, stale timer is cancelled, and live limits still stop waiting goals", { timeout: 15000 }, () => isolated(async directory => {
  const f = await fixture(directory, startScript);
  try {
    await f.session.prompt("Create and wait."); await f.session.waitForIdle();
    // Absolute timestamps are controlled; no ten-second real wait or paid calls.
    f.engine.enterGoalWait(f.ctx, f.engine.activeGoal.id, { reason: "deadline fixture", resumeAt: Date.now() - 1 });
    await f.settledAfter(() => assert.equal(f.engine.dispatchDueGoalWait(f.ctx), true));
    assert.equal(f.calls, 4); assert.equal(f.engine.activeGoal.lastWake.reason, "deadline");
    assert.equal(f.engine.dispatchDueGoalWait(f.ctx), false); await delay(30); assert.equal(f.calls, 4);
    const timer = new GoalWaitTimer(); let fired = 0;
    timer.schedule(Date.now() + 5, () => fired++); timer.clear(); await delay(20); assert.equal(fired, 0);
    assert.equal(f.engine.activeGoal.automaticModelTurns, 1);
    f.engine.updateGoalLimits(f.ctx, f.engine.activeGoal.id, f.engine.policyRevision, null, { automaticTurns: 1 });
    assert.equal(f.engine.activeGoal.status, "paused"); assert.equal(f.engine.activeGoal.waiting, undefined);
    assert.equal(f.engine.dispatchDueGoalWait(f.ctx), false);
  } finally { await f.dispose(); }
}));

test("failed deadline sends have one retry; identical wait replay cannot re-arm exhausted delivery", { timeout: 15000 }, () => isolated(async directory => {
  const f = await fixture(directory, startScript);
  try {
    await f.session.prompt("Create and wait."); await f.session.waitForIdle();
    let sends = 0;
    const send = f.engine.pi.sendMessage;
    f.engine.pi.sendMessage = () => { sends++; throw Error("Fixture delivery failure"); };
    try {
      f.engine.enterGoalWait(f.ctx, f.engine.activeGoal.id, { reason: "deadline delivery", resumeAt: Date.now() - 1 });
      assert.equal(f.engine.dispatchDueGoalWait(f.ctx), false);
      assert.equal(f.engine.activeGoal.lastWake, undefined, "failed delivery is not reported as an accepted wake");
      // Advance only the runtime's bounded retry due time, not global clocks.
      f.engine.goalWaitDeadlineRetry.retryAt = Date.now() - 1;
      assert.equal(f.engine.dispatchDueGoalWait(f.ctx), false); assert.equal(sends, 2);
      const replay = await f.invoke("goal_wait", { ...identity(f.engine), reason: "deadline delivery" });
      assert.equal(replay.details.changed, false);
      assert.equal(f.engine.dispatchDueGoalWait(f.ctx), false); assert.equal(sends, 2);
      assert.equal(f.calls, 3); assert.ok(f.engine.activeGoal.waiting);
    } finally { f.engine.pi.sendMessage = send; }
  } finally { await f.dispose(); }
}));

test("status projects only owner-validated public execution IDs and records blocker evidence", { timeout: 15000 }, () => isolated(async directory => {
  const f = await fixture(directory, startScript), key = "__paeHarnessReadOnlyV1", old = globalThis[key];
  try {
    await f.session.prompt("Create and wait."); await f.session.waitForIdle();
    const sessionId = f.session.sessionManager.getSessionId();
    const childId = `subagent-child-${"a".repeat(24)}`;
    const jobId = `subagent-job-${"b".repeat(24)}`;
    const taskId = `subagent-task-${"c".repeat(24)}`;
    globalThis[key] = { protocol: 1,
      jobs: { protocol: 1, sessionId: "other-session", list() { throw Error("Must not query another owner"); } },
      subagents: { protocol: 1, sessionId, async list(input) {
        assert.deepEqual(input, { sessionId, limit: 20 });
        return { protocol: 1, sessionId, state: "available", stale: false, items: [{ taskId, childId, groupId: jobId, status: "running", stale: false, needsAttention: true, runtimeId: "PRIVATE-RUNTIME", controlToken: "PRIVATE-CAPABILITY", title: "PRIVATE-TEXT" }] };
      } },
    };
    // A real persisted queue receipt, matched only against the verified child ID.
    f.session.sessionManager.appendCustomEntry("harness-state-receipt", { v: 1, key: "notification:fixture", state: "queued", update: { child_id: childId, requires_guidance: true } });
    const result = await f.invoke("goal_manage", { action: "status" });
    const activity = result.details.goal.sessionActivity;
    assert.match(activity.scope, /goal assignment is not established/);
    assert.equal(activity.jobs.state, "unavailable");
    assert.deepEqual(activity.subagents.items, [{ taskId, childId, jobId, status: "running", stale: false, reaped: false, needsAttention: true, pendingGuidance: true }]);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    const blocked = await f.invoke("goal_blocked", { ...identity(f.engine), reason: "External fixture denied access", evidence: "Three recorded fixture attempts returned denied", repeated_turns: 3 });
    assert.match(text(blocked), /Goal blocked:/);
    const status = await f.invoke("goal_manage", { action: "status" });
    assert.equal(status.details.goal.status, "blocked");
    assert.equal(status.details.goal.lastBlocker.evidence, "Three recorded fixture attempts returned denied");
    assert.equal(status.details.goal.lastBlocker.repeatedTurns, 3);
  } finally { if (old === undefined) delete globalThis[key]; else globalThis[key] = old; await f.dispose(); }
}));

test("queued user follow-up interrupts the accepted wait at its delivery boundary", { timeout: 15000 }, () => isolated(async directory => {
  const f = await fixture(directory, info => {
    if (info.calls === 4) {
      assert.equal(info.engine.activeGoal.waiting, undefined);
      assert.equal(info.engine.activeGoal.lastWake.reason, "user_input");
    }
    return startScript(info);
  });
  let queued;
  const off = f.session.subscribe(event => {
    if (event.type === "tool_execution_end" && event.toolName === "goal_wait" && !queued) {
      queued = f.session.followUp("Recheck and wait again after this queued user interruption.");
    }
  });
  try {
    await f.session.prompt("Create and wait."); await queued; await f.session.waitForIdle();
    assert.equal(f.calls, 4); assert.ok(f.engine.activeGoal.waiting);
    await delay(20); assert.equal(f.calls, 4);
  } finally { off(); await f.dispose(); }
}));

test("branch navigation revokes the old wait, rotates activation and does not resume", { timeout: 15000 }, () => isolated(async directory => {
  const f = await fixture(directory, startScript);
  try {
    await f.session.prompt("Create and wait."); await f.session.waitForIdle();
    const branch = f.session.sessionManager.getBranch();
    const target = branch.findLast(entry => entry.type === "custom" && entry.customType === "goal-state" && entry.data.goal?.waiting);
    const prior = structuredClone(f.engine.activeGoal);
    await f.invoke("goal_wait", { ...waitArgs(f.engine), resume_after_ms: 10000 });
    const navigation = await f.session.navigateTree(target.id, { summarize: false });
    assert.equal(navigation.cancelled, false);
    assert.equal(f.engine.activeGoal.status, "paused"); assert.equal(f.engine.activeGoal.waiting, undefined);
    assert.notEqual(f.engine.activeGoal.activationId, prior.activationId);
    assert.equal(f.engine.dispatchDueGoalWait(f.ctx), false);
    await delay(20); assert.equal(f.calls, 3);
    const stale = await f.invoke("goal_wait", { goal_id: prior.id, activation_id: prior.activationId, reason: "stale branch" });
    assert.match(text(stale), /rejected/);
  } finally { await f.dispose(); }
}));

test("reload preserves absolute wait and bounded diagnostics without scheduling work", { timeout: 15000 }, () => isolated(async directory => {
  let f = await fixture(directory, startScript), saved, file;
  try {
    await f.session.prompt("Create and wait."); await f.session.waitForIdle();
    await f.session.prompt("Recheck then wait again."); await f.session.waitForIdle();
    await f.invoke("goal_wait", { ...waitArgs(f.engine), resume_after_ms: 60000 });
    saved = structuredClone(f.engine.activeGoal); file = f.session.sessionManager.getSessionFile();
  } finally { await f.dispose(); }
  f = await fixture(directory, () => { throw Error("Reload must not dispatch work"); }, SessionManager.open(file));
  try {
    assert.deepEqual(f.engine.activeGoal.waiting, saved.waiting); assert.deepEqual(f.engine.activeGoal.lastWake, saved.lastWake);
    assert.equal(f.engine.activeGoal.activationId, saved.activationId); assert.equal(f.calls, 0);
    await delay(30); assert.equal(f.calls, 0);
  } finally { await f.dispose(); }
}));
