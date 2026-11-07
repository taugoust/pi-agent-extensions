// Real separate extension factories + AgentSession, offline provider and real watcher engine.
// Usage: node tests/forge-watch-runtime.mjs <installed Pi package directory>
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { setImmediate as nextImmediate } from "node:timers/promises";
const sdkPath = resolve(process.argv[2]);
const sdk = await import(pathToFileURL(join(sdkPath, "dist/index.js")));
const { AssistantMessageEventStream } = await import(pathToFileURL(join(sdkPath, "node_modules/@earendil-works/pi-ai/dist/index.js")));
const { createJiti } = await import(pathToFileURL(join(sdkPath, "node_modules/jiti/lib/jiti.mjs")));
const jiti = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-coding-agent": join(sdkPath, "dist/index.js"),
  "@earendil-works/pi-ai": join(sdkPath, "node_modules/@earendil-works/pi-ai/dist/index.js"),
  "@earendil-works/pi-tui": join(sdkPath, "node_modules/@earendil-works/pi-tui/dist/index.js"),
  typebox: join(sdkPath, "node_modules/typebox/build/index.mjs"),
} });
const source = process.env.PI_FORGE_TEST_SOURCE ?? fileURLToPath(new URL("../", import.meta.url));
const { default: workflows } = await jiti.import(join(source, "workflows/index.ts"));
const { default: progress } = await jiti.import(join(source, "progress/progress-widget.ts"));
const { DEFAULT_PROGRESS_SETTINGS } = await jiti.import(join(source, "progress/settings.ts"));
const { createWorktreeSettingsRuntime } = await jiti.import(join(source, "workflows/worktree/settings.ts"));
const { createForgeWatchExtension } = await jiti.import(join(source, "forge-watch/index.ts"));
const { getCurrentForgeGoal } = await jiti.import(join(source, "shared/forge-goal.ts"));
const { parseTarget } = await jiti.import(join(source, "forge-watch/types.ts"));
const target = parseTarget("https://github.com/fixture/repo/pull/7"), head = "a".repeat(40);
const call = (name, args) => ({ type: "toolCall", id: crypto.randomUUID(), name, arguments: args });
const text = result => result.content.filter(p => p.type === "text").map(p => p.text).join("\n");
const identity = goal => ({ goal_id: goal.goalId, activation_id: goal.activationId });
async function until(predicate, message) {
  for (let n = 0; n < 2000; n++) { if (await predicate()) return; await nextImmediate(); }
  throw Error(`Fixture did not settle: ${message}`);
}
async function fixture(root, { manager, watcher = true, watcherFirst = false, script } = {}) {
  sdk.initTheme("dark", false);
  const agentDir = join(root, "agent"); await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "goal.json"), JSON.stringify({ continuationLimits: { automaticTurns: null, noProgressTurns: null }, rpc: { enabled: false } }));
  await writeFile(join(agentDir, "worktree.json"), JSON.stringify({ worktreeRoot: join(root, "trees") }));
  const models = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models"), allowModelNetwork: false, refreshOnCreate: false });
  const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const errors = [], tools = new Map(); let context, watcherPi, engine, requests = 0, polls = 0, checks = 0, closed = 0, approved = false;
  let snapshot = { head, state: "open", comments: [], reviews: [], ci: [] };
  const capture = pi => new Proxy(pi, { get(target, key) { if (key === "registerTool") return definition => { tools.set(definition.name, definition); return target.registerTool(definition); }; return Reflect.get(target, key, target); } });
  const modelFactory = pi => {
    watcherPi ??= pi; // inspect the same session bus even when the watcher is disabled on reload
    pi.on("session_start", (_event, ctx) => { context = ctx; });
    pi.registerProvider("forge-fixture", { api: "openai-completions", apiKey: "offline", baseUrl: "https://invalid.invalid", models: [{ id: "offline", name: "Offline", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple() {
        requests++; assert.ok(requests < 20, "No runaway inference");
        const goal = getCurrentForgeGoal(watcherPi.events);
        const content = script ? script({ requests, goal }) : requests === 1 ? [call("update_progress", { action: "create", request_id: "fixture-create", objective: "Verify revision approval without idle inference", steps: [{ text: "Verified fixture task", status: "completed" }] })] : requests === 2 ? [call("forge_watch", { action: "watch", ...identity(goal), url: target.url, require_approval: true, expected_head: head })] : requests === 4 ? [call("goal_complete", { ...identity(goal), summary: "Verified the fixture result and required task" })] : [call("goal_wait", { ...identity(goal), reason: "Wait only for subscribed forge changes" })];
        const message = { role: "assistant", provider: "forge-fixture", model: "offline", api: "openai-completions", timestamp: Date.now(), stopReason: "toolUse", content, usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const stream = new AssistantMessageEventStream(); queueMicrotask(() => { stream.push({ type: "done", reason: "toolUse", message }); stream.end(); }); return stream;
      },
    });
  };
  const factories = [modelFactory, pi => workflows(capture(pi), { goalSettingsPath: join(agentDir, "goal.json"), worktreeSettings: createWorktreeSettingsRuntime({ path: join(agentDir, "worktree.json") }) }), pi => progress(capture(pi), { loadSettings: async () => ({ kind: "loaded", settings: DEFAULT_PROGRESS_SETTINGS }) })];
  if (watcher) {
    const watchFactory = pi => {
    watcherPi = pi;
    createForgeWatchExtension({ settings: { servers: [{ provider: "github", host: "github.com", url: "https://invalid.invalid/mcp", auth: { env: "UNUSED_FIXTURE_TOKEN" } }], reviewer: "human", intervalMs: 10000 }, stateDirectory: join(root, "watch-state"),
      // The real engine is exercised; only the forge I/O is an offline fixture.
      adapterFactory: () => ({ async poll() { polls++; return structuredClone(snapshot); }, async close() { closed++; } }),
      approvalCheck: async () => { checks++; return { approved, reason: approved ? "Fixture human approved current revision" : "Fixture human has not approved current revision" }; },
      clock: { setTimer: () => 1, clearTimer: () => {}, jitter: value => value }, onReady: ready => { engine = ready; },
    })(capture(pi));
    };
    if (watcherFirst) factories.unshift(watchFactory); else factories.push(watchFactory);
  }
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: factories });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await sdk.createAgentSession({ cwd: root, agentDir, modelRuntime: models, settingsManager: settings, resourceLoader: loader, sessionManager: manager ?? sdk.SessionManager.create(root, join(root, "sessions")), noTools: "builtin" });
  const owner = new sdk.AgentSessionRuntime(session, { cwd: root, agentDir, modelRuntime: models, settingsManager: settings, resourceLoader: loader, diagnostics: [] }, async () => { throw Error("Unexpected replacement"); });
  await session.bindExtensions({ onError: error => errors.push(error) });
  await session.setModel(models.getModel("forge-fixture", "offline"));
  return { session, get engine() { return engine; }, get goal() { return getCurrentForgeGoal(watcherPi.events); }, get requests() { return requests; }, get polls() { return polls; }, get checks() { return checks; }, get closed() { return closed; }, set snapshot(value) { snapshot = value; }, set approved(value) { approved = value; },
    invoke(name, args) { return tools.get(name).execute("explicit-fixture-call", args, new AbortController().signal, undefined, context); },
    async settledAfter(action) { const settled = new Promise(resolve => { const off = session.subscribe(event => { if (event.type === "agent_settled") { off(); resolve(); } }); }); await action(); await settled; await session.waitForIdle(); },
    async dispose() { await session.abort(); await owner.dispose(); assert.deepEqual(errors, []); },
  };
}
async function isolated(run) {
  const root = await mkdtemp(join(tmpdir(), "forge-runtime-")), oldFetch = globalThis.fetch;
  const oldDir = process.env.PI_CODING_AGENT_DIR, oldChild = process.env.PI_DEDICATED_GOAL_CHILD;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent"); delete process.env.PI_DEDICATED_GOAL_CHILD;
  let network = 0; globalThis.fetch = async () => { network++; throw Error("Network forbidden in offline runtime test"); };
  try { await run(root); assert.equal(network, 0, "No provider or forge HTTP from fixture"); } finally { globalThis.fetch = oldFetch; if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir; if (oldChild === undefined) delete process.env.PI_DEDICATED_GOAL_CHILD; else process.env.PI_DEDICATED_GOAL_CHILD = oldChild; await rm(root, { recursive: true, force: true }); }
}

test("separate real extensions: unchanged idle polls make zero model requests; relevant event wakes once and fresh gate denies premature completion", { timeout: 20000 }, () => isolated(async root => {
  const f = await fixture(root);
  try {
    await f.session.prompt("Create a fixture Goal, require human approval, subscribe and wait."); await f.session.waitForIdle();
    assert.equal(f.requests, 3); assert.equal(f.goal.status, "active"); assert.equal(f.goal.waiting, true);
    await f.engine.pollOnce(target); // initial baseline
    for (let n = 0; n < 10; n++) await f.engine.pollOnce(target);
    assert.equal(f.polls, 11); assert.equal(f.requests, 3, "Unchanged idle polling causes no inference");
    const action = await f.session.extensionRunner.emitCacheWarmingDecision({ type: "cache_warming_decision" });
    assert.equal(action, "stop", "Explicit Goal wait also stops cache warming");
    f.snapshot = { head, state: "open", comments: [{ id: "human-note", fingerprint: "changed-note", actor: "human" }], reviews: [], ci: [] };
    await f.settledAfter(() => f.engine.pollOnce(target));
    assert.equal(f.requests, 5); assert.equal(f.checks, 1); assert.equal(f.goal.status, "active"); assert.equal(f.goal.waiting, true);
    const statuses = await f.engine.status();
    assert.ok(statuses[0].pending > 0);
    for (let n = 0; n < 5; n++) await f.engine.pollOnce(target);
    assert.equal(f.requests, 5, "Accepted unacknowledged batch never causes repeated turns");
    const events = await f.invoke("forge_watch", { action: "events", ...identity(f.goal) });
    assert.ok(events.details.events.length);
    await f.invoke("forge_watch", { action: "ack", ...identity(f.goal), event_ids: events.details.events.map(e => e.id) });
    await f.invoke("forge_watch", { action: "unwatch", ...identity(f.goal), url: target.url });
    assert.equal((await f.engine.status()).length, 0);
    // Unwatch cancels polling, but the required human approval obligation remains.
    const status = await f.invoke("goal_manage", { action: "status" });
    const g = status.details.goal;
    await f.invoke("goal_manage", { action: "pause", ...identity(f.goal), expected_revision: g.revision, user_authorized: true });
    assert.equal(f.goal.status, "paused");
    const pausedRevision = (await f.invoke("goal_manage", { action: "status" })).details.goal.revision;
    await assert.rejects(() => f.invoke("goal_manage", { action: "complete", ...identity(f.goal), expected_revision: pausedRevision, user_authorized: true, summary: "Verified the fixture result and all required tasks" }), /approval|required|rejected|denied/i);
  } finally { await f.dispose(); }
  assert.equal(f.closed, 1, "Standalone client lifecycle closed on shutdown");
}));

test("real reload restores paused subscriptions without inference and missing checker cannot bypass a durable obligation", { timeout: 20000 }, () => isolated(async root => {
  const first = await fixture(root);
  let manager, goalId;
  try {
    await first.session.prompt("Subscribe, require approval, then wait."); await first.session.waitForIdle();
    await first.engine.pollOnce(target);
    const g = (await first.invoke("goal_manage", { action: "status" })).details.goal;
    goalId = first.goal.goalId;
    await first.invoke("goal_manage", { action: "pause", ...identity(first.goal), expected_revision: g.revision, user_authorized: true });
    manager = first.session.sessionManager;
  } finally { await first.dispose(); }
  const missing = await fixture(root, { manager, watcher: false });
  try {
    assert.equal(missing.requests, 0);
    assert.equal(missing.goal.goalId, goalId); assert.equal(missing.goal.status, "paused");
    const g = (await missing.invoke("goal_manage", { action: "status" })).details.goal;
    await assert.rejects(() => missing.invoke("goal_manage", { action: "complete", ...identity(missing.goal), expected_revision: g.revision, user_authorized: true, summary: "Verified fixture output and completed all required tasks" }), /guard|checker|unavailable|required/i);
    assert.equal(missing.goal.status, "paused"); assert.equal(missing.requests, 0);
  } finally { await missing.dispose(); }
  const restored = await fixture(root, { manager });
  try {
    assert.equal(restored.goal.goalId, goalId); assert.equal(restored.goal.status, "paused");
    assert.equal(restored.requests, 0);
    const restoredStatus = await restored.engine.status();
    assert.equal(restoredStatus.length, 1, "Retained subscription was not deleted during startup");
    assert.ok(restoredStatus.every(s => s.subscription.active === false));
    await restored.engine.pollOnce(target); assert.equal(restored.polls, 0, "Paused reload does not continue background network activity");
    const g = (await restored.invoke("goal_manage", { action: "status" })).details.goal;
    await assert.rejects(() => restored.invoke("goal_manage", { action: "complete", ...identity(restored.goal), expected_revision: g.revision, user_authorized: true, summary: "Verified fixture output and completed all required tasks" }), /approval|not approved|required/i);
    restored.approved = true;
    const done = await restored.invoke("goal_manage", { action: "complete", ...identity(restored.goal), expected_revision: g.revision, user_authorized: true, summary: "Verified fixture output and completed all required tasks" });
    assert.match(text(done), /^Goal complete:/); assert.equal(restored.requests, 0, "Explicit verified paused completion does not start a model");
  } finally { await restored.dispose(); }
}));

test("watcher-first factory order preserves retained subscriptions and pending events until Goal restoration is ready", { timeout: 20000 }, () => isolated(async root => {
  const first = await fixture(root, { watcherFirst: true });
  let manager, goalId, pending;
  try {
    await first.session.prompt("Subscribe and wait."); await first.session.waitForIdle();
    await first.engine.pollOnce(target);
    first.snapshot = { head, state: "open", comments: [{ id: "retained-note", fingerprint: "retained-change" }], reviews: [], ci: [] };
    await first.settledAfter(() => first.engine.pollOnce(target));
    const statuses = await first.engine.status(); assert.equal(statuses.length, 1);
    pending = statuses[0].pending; assert.ok(pending > 0);
    goalId = first.goal.goalId; manager = first.session.sessionManager;
  } finally { await first.dispose(); }
  const restored = await fixture(root, { manager, watcherFirst: true });
  try {
    await until(async () => restored.goal?.goalId === goalId && (await restored.engine.status()).length === 1, "watcher-first ready reconciliation");
    const statuses = await restored.engine.status();
    assert.equal(statuses.length, 1, "Not an empty-array/vacuous restore assertion");
    assert.equal(statuses[0].pending, pending);
    assert.equal(restored.requests, 0, "Startup and readiness reconciliation never call the model");
  } finally { await restored.dispose(); }
}));

test("two real session coordinators cannot cross-subscribe or wake each other; paused changes remain quiet", { timeout: 20000 }, () => isolated(async root => {
  const leftRoot = join(root, "left"), rightRoot = join(root, "right"); await mkdir(leftRoot); await mkdir(rightRoot);
  const left = await fixture(leftRoot), right = await fixture(rightRoot);
  try {
    await left.session.prompt("Subscribe and wait."); await left.session.waitForIdle();
    await right.session.prompt("Subscribe and wait."); await right.session.waitForIdle();
    assert.notEqual(left.goal.goalId, right.goal.goalId);
    await left.engine.pollOnce(target); await right.engine.pollOnce(target);
    await assert.rejects(() => left.invoke("forge_watch", { action: "watch", ...identity(right.goal), url: target.url }), /exact current|identity/i);
    left.snapshot = { head, state: "open", comments: [{ id: "left-event", fingerprint: "left-change" }], reviews: [], ci: [] };
    await left.settledAfter(() => left.engine.pollOnce(target));
    assert.equal(left.requests, 5); assert.equal(right.requests, 3, "Only the subscribed session woke");
    const g = (await left.invoke("goal_manage", { action: "status" })).details.goal;
    await left.invoke("goal_manage", { action: "pause", ...identity(left.goal), expected_revision: g.revision, user_authorized: true });
    await until(async () => (await left.engine.status()).every(s => !s.subscription.active), "pause reconciliation");
    left.snapshot = { head: "b".repeat(40), state: "open", comments: [], reviews: [], ci: [] };
    await left.engine.pollOnce(target);
    assert.equal(left.requests, 5); assert.equal(left.goal.status, "paused");
    assert.equal(right.requests, 3); assert.equal(right.goal.waiting, true);
  } finally { await left.dispose(); await right.dispose(); }
}));
