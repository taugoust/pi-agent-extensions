import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

// This disposable SDK root must not inherit a live dedicated worker assignment.
delete process.env.PI_DEDICATED_GOAL_CHILD;
delete process.env.PI_DEDICATED_GOAL_BINDING;

const root = fileURLToPath(new URL("../", import.meta.url));
const sdk = resolve(process.argv[2]);
const { createJiti } = await import(pathToFileURL(resolve(sdk, "node_modules/jiti/lib/jiti.mjs")));
const jiti = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-coding-agent": resolve(sdk, "dist/index.js"),
  "@earendil-works/pi-tui": resolve(sdk, "node_modules/@earendil-works/pi-tui/dist/index.js"),
  "@earendil-works/pi-ai": resolve(sdk, "node_modules/@earendil-works/pi-ai/dist/index.js"),
  typebox: resolve(sdk, "node_modules/typebox/build/index.mjs"),
} });
const { registerGoalTools } = await jiti.import(resolve(root, "workflows/goal/tools.ts"));
const { default: workflows } = await jiti.import(resolve(root, "workflows/index.ts"));
const { default: progressExtension } = await jiti.import(resolve(root, "progress/index.ts"));
const sdkApi = await import(pathToFileURL(resolve(sdk, "dist/index.js")));
const aiApi = await import(pathToFileURL(resolve(sdk, "node_modules/@earendil-works/pi-ai/dist/index.js")));
const bridge = await jiti.import(resolve(root, "shared/forge-goal.ts"));

function fixture(initial) {
  const listeners = new Map(), tools = new Map();
  const events = {
    on(channel, handler) { const set = listeners.get(channel) ?? new Set(); set.add(handler); listeners.set(channel, set); return () => set.delete(handler); },
    emit(channel, data) { for (const handler of listeners.get(channel) ?? []) handler(data); },
  };
  const otherAPI = { events }; // Deliberately distinct ExtensionAPI object, same supported shared bus.
  const pi = { events, registerTool: tool => tools.set(tool.name, tool), on: () => () => {} };
  let snapshot = initial, sequence = 0, ready = true;
  const subscriptions = new Map(), guards = new Map(), required = new Map(), wakes = [];
  const binding = {
    ready: () => ready,
    snapshot: () => snapshot,
    subscribe(identity) {
      if (!snapshot || snapshot.status !== "active" || snapshot.goalId !== identity.goalId || snapshot.activationId !== identity.activationId) return undefined;
      const id = `sub-${++sequence}`; subscriptions.set(id, { identity, pending: false }); return id;
    },
    wake(identity, id, message) {
      const subscription = subscriptions.get(id);
      if (!snapshot?.waiting || snapshot.status !== "active" || !subscription || subscription.pending || snapshot.goalId !== identity.goalId || snapshot.activationId !== identity.activationId || subscription.identity.goalId !== identity.goalId || subscription.identity.activationId !== identity.activationId) return false;
      subscription.pending = true; wakes.push({ identity, id, message }); return true;
    },
    consume(identity, id) {
      const subscription = subscriptions.get(id);
      if (!snapshot?.waiting || snapshot.status !== "active" || !subscription?.pending || snapshot.goalId !== identity.goalId || snapshot.activationId !== identity.activationId || subscription.identity.goalId !== identity.goalId || subscription.identity.activationId !== identity.activationId) return false;
      subscriptions.delete(id); return true;
    },
    unsubscribe: id => subscriptions.delete(id),
    registerGuard(identity, key, check) {
      if (!snapshot || snapshot.goalId !== identity.goalId || snapshot.activationId !== identity.activationId || snapshot.status !== "active") throw Error("stale guard registration");
      const keys = required.get(identity.goalId) ?? new Set(); keys.add(key); required.set(identity.goalId, keys);
      guards.set(`${identity.goalId}:${key}`, { identity, check });
      return () => guards.delete(`${identity.goalId}:${key}`);
    },
    async checkGuards(identity) {
      for (const key of required.get(identity.goalId) ?? []) {
        const guard = guards.get(`${identity.goalId}:${key}`);
        if (!guard || guard.identity.activationId !== identity.activationId) return `Required guard ${key} unavailable`;
        const rejected = await guard.check(identity); if (rejected) return rejected;
      }
      return undefined;
    },
  };
  bridge.bindForgeGoal(events, binding);
  return { events, otherAPI, pi, tools, wakes, binding, requireKey: (goalId, key) => { const keys = required.get(goalId) ?? new Set(); keys.add(key); required.set(goalId, keys); }, set snapshot(value) { snapshot = value; } };
}

test("distinct extension APIs use the shared event bus; subscriptions precede wait and duplicate/stale wakes fail", () => {
  const waiting = { goalId: "g1", activationId: "a1", status: "active", waiting: true };
  const f = fixture({ ...waiting, waiting: false }), identity = { goalId: "g1", activationId: "a1" };
  assert.notEqual(f.otherAPI, f.pi);
  assert.equal(bridge.getCurrentForgeGoal(f.otherAPI.events).goalId, "g1");
  const sub = bridge.subscribeForgeGoalWake(f.otherAPI.events, identity); assert.ok(sub);
  f.snapshot = waiting; // the watcher subscribed before the model calls goal_wait
  assert.equal(bridge.wakeForgeGoal(f.otherAPI.events, identity, sub.subscriptionId, "done"), true);
  assert.equal(bridge.wakeForgeGoal(f.otherAPI.events, identity, sub.subscriptionId, "duplicate"), false);
  assert.equal(bridge.consumeForgeGoalWake(f.pi.events, identity, sub.subscriptionId), true);
  assert.equal(bridge.consumeForgeGoalWake(f.pi.events, identity, sub.subscriptionId), false);
  f.snapshot = { ...waiting, status: "paused", waiting: false };
  assert.equal(bridge.subscribeForgeGoalWake(f.otherAPI.events, identity), undefined);
  f.snapshot = { ...waiting, activationId: "new" };
  assert.equal(bridge.wakeForgeGoal(f.otherAPI.events, identity, sub.subscriptionId, "stale"), false);
});

test("workflows factory serves a distinct watcher API over shared bus before goal_wait", { timeout: 20000 }, async () => {
  const rootDir = await mkdtemp(resolve(tmpdir(), "forge-goal-workflows-"));
  const cwd = resolve(rootDir, "repo"), agentDir = resolve(rootDir, "agent");
  await mkdir(cwd); await mkdir(agentDir);
  const { execFileSync } = await import("node:child_process");
  for (const args of [["init", "--template=", "--initial-branch=main"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"]]) execFileSync("git", args, { cwd, stdio: "ignore" });
  sdkApi.initTheme("dark", false);
  const modelRuntime = await sdkApi.ModelRuntime.create({ authPath: resolve(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const settingsManager = sdkApi.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  let session, watcherApi, workflowsApi, subscribed, sessionContext, calls = 0, errors = [];
  const registeredTools = new Map();
  const factories = [pi => {
    pi.registerProvider("forge-bridge-test", { api: "openai-responses", apiKey: "offline", baseUrl: "https://invalid.invalid", models: [{ id: "offline", name: "Offline", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }], streamSimple(_model, _context, options) {
      calls++;
      const state = session?.sessionManager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === "goal-state")?.data?.goal;
      const content = calls === 1
        ? [{ type: "toolCall", id: "create", name: "update_progress", arguments: { action: "create", request_id: "create-bridge", objective: "Observe the subscribed forge result", steps: [{ text: "Verify the result", status: "pending" }] } }]
        : calls === 2 || calls === 3
          ? [{ type: "toolCall", id: `wait-${calls}`, name: "goal_wait", arguments: { goal_id: state.id, activation_id: state.activationId, reason: "Waiting for subscribed external result" } }]
          : [{ type: "text", text: "The delivered result was rechecked." }];
      const message = { role: "assistant", api: "openai-responses", provider: "forge-bridge-test", model: "offline", timestamp: Date.now(), stopReason: content[0]?.type === "toolCall" ? "toolUse" : "stop", content, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = aiApi.createAssistantMessageEventStream(); queueMicrotask(() => { stream.push({ type: "done", reason: message.stopReason, message }); stream.end(message); }); return stream;
    } });
    workflowsApi = new Proxy(pi, { get(target, key) { if (key === "registerTool") return tool => { registeredTools.set(tool.name, tool); return target.registerTool(tool); }; return Reflect.get(target, key, target); } });
    workflows(workflowsApi, { goalSettingsPath: resolve(agentDir, "goal.json") });
    progressExtension(pi);
    watcherApi = new Proxy(pi, {});
    assert.equal(bridge.isForgeGoalReady(watcherApi.events), false, "bus binding is not ready during extension factory startup");
    assert.equal(bridge.getCurrentForgeGoal(watcherApi.events), undefined, "unrestored Goal state is not exposed to early watcher reconciliation");
    watcherApi.events.on(bridge.FORGE_GOAL_READY_EVENT, () => { assert.equal(bridge.isForgeGoalReady(watcherApi.events), true); });
    watcherApi.on("session_start", (_event, ctx) => { sessionContext = ctx; });
    watcherApi.on("tool_execution_end", () => {
      if (subscribed) return;
      const goal = bridge.getCurrentForgeGoal(watcherApi.events);
      if (goal?.status === "active") subscribed = bridge.subscribeForgeGoalWake(watcherApi.events, { goalId: goal.goalId, activationId: goal.activationId });
    });
  }];
  const loader = new sdkApi.DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: factories });
  try {
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await sdkApi.createAgentSession({ cwd, agentDir, modelRuntime, settingsManager, resourceLoader: loader, sessionManager: sdkApi.SessionManager.create(cwd, resolve(rootDir, "sessions")), noTools: "builtin" }));
    const owner = new sdkApi.AgentSessionRuntime(session, { cwd, agentDir, modelRuntime, settingsManager, resourceLoader: loader, diagnostics: [] }, async () => { throw Error("Unexpected replacement"); });
    await session.bindExtensions({ onError: error => errors.push(error) }); await session.setModel(modelRuntime.getModel("forge-bridge-test", "offline"));
    await session.prompt("Create a goal, subscribe before waiting, then wait."); await session.waitForIdle();
    assert.notEqual(watcherApi, workflowsApi);
    assert.equal(watcherApi.events, workflowsApi.events, "distinct ExtensionAPI proxies share only the supported event bus bridge");
    assert.ok(subscribed, `separate watcher API subscribed before goal_wait (calls=${calls}, goal=${JSON.stringify(bridge.getCurrentForgeGoal(watcherApi.events))}, errors=${JSON.stringify(errors)}, states=${JSON.stringify(session.sessionManager.getBranch().filter(entry => entry.customType === "goal-state").map(entry => entry.data?.goal))})`);
    const callsAtWait = calls;
    const goal = bridge.getCurrentForgeGoal(watcherApi.events);
    assert.equal(goal.waiting, true);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls, callsAtWait, "unchanged explicit wait does not infer/poll");
    assert.equal(bridge.wakeForgeGoal(watcherApi.events, { goalId: goal.goalId, activationId: goal.activationId }, subscribed.subscriptionId, "forge changed"), true);
    assert.equal(bridge.wakeForgeGoal(watcherApi.events, { goalId: goal.goalId, activationId: goal.activationId }, subscribed.subscriptionId, "duplicate"), false);
    const eventLog = []; const stopEvents = session.subscribe(event => eventLog.push(event.type));
    const woke = await Promise.race([session.waitForIdle().then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 3000))]);
    stopEvents();
    assert.equal(woke, true, `target wake should settle; events=${eventLog.join(",")}, calls=${calls}`);
    assert.equal(calls, callsAtWait + 1, "one accepted wake caused one model inference");
    const resumed = bridge.getCurrentForgeGoal(watcherApi.events);
    const pausedSub = bridge.subscribeForgeGoalWake(watcherApi.events, { goalId: resumed.goalId, activationId: resumed.activationId });
    assert.ok(pausedSub, "new wait cycle requires a fresh subscription");
    const state = session.sessionManager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === "goal-state").data.goal;
    await registeredTools.get("goal_manage").execute("pause", { action: "pause", goal_id: state.id, activation_id: state.activationId, expected_revision: state.revision, user_authorized: true }, undefined, undefined, sessionContext);
    const paused = bridge.getCurrentForgeGoal(watcherApi.events);
    assert.equal(paused.status, "paused");
    assert.equal(bridge.wakeForgeGoal(watcherApi.events, { goalId: paused.goalId, activationId: paused.activationId }, pausedSub.subscriptionId, "stale after pause"), false);
    assert.equal(calls, callsAtWait + 1, "paused/stale wake did not infer");
    let releaseCheck;
    const pausedIdentity = { goalId: paused.goalId, activationId: paused.activationId };
    bridge.registerForgeGoalCompletionGuard(watcherApi.events, pausedIdentity, "race-check", () => new Promise(resolve => { releaseCheck = resolve; }));
    const checking = bridge.checkForgeGoalCompletionGuards(watcherApi.events, pausedIdentity);
    bridge.registerForgeGoalCompletionGuard(watcherApi.events, pausedIdentity, "race-check", async () => undefined);
    releaseCheck(undefined);
    assert.match(await checking, /changed during fresh verification/);
    const branch = session.sessionManager.getBranch();
    const markerEntry = branch.findLast(entry => entry.type === "custom" && entry.customType === "forge-goal-completion-guard" && entry.data?.goalId === paused.goalId);
    const pausedState = branch.findLast(entry => entry.type === "custom" && entry.customType === "goal-state" && entry.data?.goal?.id === paused.goalId);
    assert.ok(markerEntry && pausedState);
    await session.navigateTree(pausedState.id, { summarize: false });
    await session.navigateTree(markerEntry.id, { summarize: false });
    const restored = bridge.getCurrentForgeGoal(watcherApi.events);
    const restoredState = session.sessionManager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === "goal-state").data.goal;
    await assert.rejects(registeredTools.get("goal_manage").execute("complete", { action: "complete", goal_id: restored.goalId, activation_id: restored.activationId, expected_revision: restoredState.revision, user_authorized: true, summary: "Verified after branch navigation" }, undefined, undefined, sessionContext), /completion guard.*unavailable/i);
    assert.equal(calls, callsAtWait + 1, "branch restoration and rejected completion do not infer");
    await session.abort(); await owner.dispose(); assert.deepEqual(errors, []);
  } finally { await rm(rootDir, { recursive: true, force: true }); }
});

test("an async forge guard denies goal_complete before transition despite completed tasks", async () => {
  const identity = { goalId: "g1", activationId: "a1" };
  const f = fixture({ ...identity, status: "active", waiting: false });
  bridge.registerForgeGoalCompletionGuard(f.otherAPI.events, identity, "approval:repo", async () => "Forge approval is still pending");
  const goal = { id: "g1", activationId: "a1", status: "active", text: "Verify external work", tasks: [{ id: "task-1", text: "Verify result", status: "completed" }] };
  const runtime = { pi: f.pi, activeGoal: goal, hasActiveBudgetWrapUp: () => false, ownsWorkflow: () => true, canRecordGoalUsage: () => true };
  registerGoalTools(f.pi, runtime);
  const notices = [], ctx = { ui: { notify: message => notices.push(message) } };
  const result = await f.tools.get("goal_complete").execute("call", { goal_id: "g1", activation_id: "a1", summary: "Verified the completed required task" }, undefined, undefined, ctx);
  assert.match(result.content[0].text, /Forge approval is still pending/);
  assert.equal(runtime.activeGoal, goal); assert.equal(goal.status, "active"); assert.ok(notices.length);
});

test("paused goal_manage complete also awaits the same async guard", async () => {
  const identity = { goalId: "paused", activationId: "act" }, f = fixture({ ...identity, status: "active", waiting: false });
  bridge.registerForgeGoalCompletionGuard(f.otherAPI.events, identity, "approval:repo", async () => "Review must be refreshed");
  const goal = { id: identity.goalId, activationId: identity.activationId, revision: 4, status: "paused", text: "Verify work", tasks: [{ id: "t", text: "Done", status: "completed" }] };
  const runtime = { pi: f.pi, activeGoal: goal, agentRunOrigin: undefined };
  registerGoalTools(f.pi, runtime);
  await assert.rejects(f.tools.get("goal_manage").execute("call", { action: "complete", goal_id: goal.id, activation_id: goal.activationId, expected_revision: 4, user_authorized: true, summary: "Verified completed work" }, undefined, undefined, { ui: { notify() {} } }), /Review must be refreshed/);
  assert.equal(runtime.activeGoal, goal); assert.equal(goal.status, "paused");
});

test("aborting an awaited paused goal_manage guard prevents completion transition", async () => {
  const identity = { goalId: "cancel-paused", activationId: "a1" }, f = fixture({ ...identity, status: "active", waiting: false });
  let release, started = false;
  bridge.registerForgeGoalCompletionGuard(f.otherAPI.events, identity, "cancel-check", async () => { started = true; await new Promise(resolve => { release = resolve; }); return undefined; });
  const goal = { id: identity.goalId, activationId: identity.activationId, revision: 7, status: "paused", text: "Verified work", tasks: [{ id: "t", text: "Done", status: "completed" }] };
  const runtime = { pi: f.pi, activeGoal: goal, agentRunOrigin: undefined };
  registerGoalTools(f.pi, runtime);
  const aborter = new AbortController();
  const pending = f.tools.get("goal_manage").execute("cancel", { action: "complete", goal_id: goal.id, activation_id: goal.activationId, expected_revision: 7, user_authorized: true, summary: "Verified paused outcome" }, aborter.signal, undefined, { ui: { notify() {} } });
  assert.equal(started, true); aborter.abort(); release();
  await assert.rejects(pending, /abort/i);
  assert.equal(runtime.activeGoal, goal); assert.equal(goal.status, "paused");
});

test("missing required guard fails closed after reload; async errors deny completion", async () => {
  const identity = { goalId: "g2", activationId: "a2" }, f = fixture({ ...identity, status: "active", waiting: false });
  f.binding.registerGuard(identity, "required-review", async () => { throw Error("offline"); });
  await assert.rejects(bridge.checkForgeGoalCompletionGuards(f.otherAPI.events, identity), /offline/);
  const missing = fixture({ ...identity, status: "active", waiting: false });
  // Durable obligation restored by Goal runtime, but no checker is registered yet.
  missing.requireKey(identity.goalId, "required-review");
  assert.match(await bridge.checkForgeGoalCompletionGuards(missing.otherAPI.events, identity), /unavailable/);
});
