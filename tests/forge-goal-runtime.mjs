import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
const bridge = await jiti.import(resolve(root, "shared/forge-goal.ts"));
const make = (initial) => {
  const tools = new Map(), handlers = new Map();
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); },
    on(name, handler) { handlers.set(name, handler); return () => handlers.delete(name); },
    events: { on() { return () => {}; }, emit() {} },
  };
  let snapshot = initial;
  const wakes = [];
  const binding = {
    wakeSubscriptions: new Map(), completionGuards: new Map(),
    snapshot: () => snapshot,
    nextId: (() => { let id = 0; return () => `id-${++id}`; })(),
    sendWake(identity, subscriptionId, message) {
      const current = snapshot, subscribed = this.wakeSubscriptions.get(subscriptionId);
      if (!current || current.status !== "active" || !current.waiting || !subscribed || current.goalId !== identity.goalId || current.activationId !== identity.activationId || subscribed.goalId !== identity.goalId || subscribed.activationId !== identity.activationId) return false;
      wakes.push({ identity, subscriptionId, message }); return true;
    },
  };
  bridge.bindForgeGoal(pi, binding);
  return { pi, binding, wakes, tools, set snapshot(value) { snapshot = value; } };
};

test("wake subscriptions are exact-activation, waiting-only and consumed once", () => {
  const active = { goalId: "g1", activationId: "a1", status: "active", waiting: true };
  const f = make(active), identity = { goalId: "g1", activationId: "a1" };
  assert.equal(bridge.getCurrentForgeGoal(f.pi), active);
  const sub = bridge.subscribeForgeGoalWake(f.pi, identity);
  assert.ok(sub);
  assert.equal(bridge.wakeForgeGoal(f.pi, { ...identity, activationId: "stale" }, sub.subscriptionId, "stale"), false);
  f.snapshot = { ...active, activationId: "a2" };
  assert.equal(bridge.wakeForgeGoal(f.pi, identity, sub.subscriptionId, "queued stale"), false);
  assert.equal(bridge.consumeForgeGoalWake(f.pi, identity, sub.subscriptionId), false);
  f.snapshot = { ...active, status: "paused", waiting: false };
  assert.equal(bridge.subscribeForgeGoalWake(f.pi, identity), undefined);
  f.snapshot = active;
  const fresh = bridge.subscribeForgeGoalWake(f.pi, identity);
  assert.ok(fresh);
  assert.equal(bridge.wakeForgeGoal(f.pi, identity, fresh.subscriptionId, "result"), true);
  assert.equal(bridge.consumeForgeGoalWake(f.pi, identity, fresh.subscriptionId), true);
  assert.equal(bridge.consumeForgeGoalWake(f.pi, identity, fresh.subscriptionId), false);
});

test("an async forge guard denies goal_complete before transition even with a completed checklist", async () => {
  const identity = { goalId: "g1", activationId: "a1" };
  const f = make({ ...identity, status: "active", waiting: false });
  bridge.registerForgeGoalCompletionGuard(f.pi, identity, async () => "Forge job is still running");
  const goal = { id: "g1", activationId: "a1", status: "active", text: "Verify external work", tasks: [{ id: "task-1", text: "Verify result", status: "completed" }] };
  const runtime = {
    pi: f.pi, activeGoal: goal,
    hasActiveBudgetWrapUp: () => false, ownsWorkflow: () => true, canRecordGoalUsage: () => true,
  };
  registerGoalTools(f.pi, runtime);
  const notices = [];
  const ctx = { ui: { notify: message => notices.push(message) } };
  const result = await f.tools.get("goal_complete").execute("call", { goal_id: "g1", activation_id: "a1", summary: "Verified the completed required task" }, undefined, undefined, ctx);
  assert.match(result.content[0].text, /Forge job is still running/);
  assert.equal(runtime.activeGoal, goal, "rejected completion did not transition lifecycle state");
  assert.equal(goal.status, "active");
  assert.ok(notices.length);
});

test("completion guards are activation scoped, fresh async checks and fail closed", async () => {
  const f = make({ goalId: "g1", activationId: "a1", status: "active", waiting: false });
  let checks = 0;
  const identity = { goalId: "g1", activationId: "a1" };
  bridge.registerForgeGoalCompletionGuard(f.pi, identity, async () => { checks++; return "external work remains"; });
  assert.equal(await bridge.checkForgeGoalCompletionGuards(f.pi, identity), "external work remains");
  assert.equal(checks, 1);
  assert.equal(await bridge.checkForgeGoalCompletionGuards(f.pi, { ...identity, activationId: "a2" }), undefined);
  assert.equal(checks, 1);
  const broken = make({ goalId: "g2", activationId: "a2", status: "active", waiting: false });
  bridge.registerForgeGoalCompletionGuard(broken.pi, { goalId: "g2", activationId: "a2" }, async () => { throw Error("offline"); });
  assert.match(await bridge.checkForgeGoalCompletionGuards(broken.pi, { goalId: "g2", activationId: "a2" }), /failed/);
});
