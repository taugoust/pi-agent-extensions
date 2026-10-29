import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Exercise the real runtime/persistence/lifecycle. Only SDK presentation helpers
// are seams; no model, network, live session or external settings are touched.
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith("/subagent/goal-worker.ts") && ["../workflows/index.ts", "../progress/index.ts"].includes(specifier))
    return { url: "data:text/javascript,export default function(){}", shortCircuit: true };
  const seams = {
    "@earendil-works/pi-coding-agent": "export const getAgentDir=()=>'/unused-goal-limits-test';",
    "@earendil-works/pi-ai": "export const isContextOverflow=()=>false; export const isRetryableAssistantError=()=>false;",
    "@earendil-works/pi-tui": "export const stripTerminalSequences=x=>x;",
  };
  if (specifier.endsWith("/shared/goal-progress.ts")) return { url: `data:text/javascript,${encodeURIComponent("export const readGoalTasks=()=>[]; export const writeProgress=()=>{throw Error('Limit updates cannot write progress')};")}`, shortCircuit: true };
  if (seams[specifier]) return { url: `data:text/javascript,${encodeURIComponent(seams[specifier])}`, shortCircuit: true };
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
    const url = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
    if (existsSync(url)) return { url: url.href, shortCircuit: true };
  }
  return next(specifier, context);
}, load(url, context, next) {
  if (url.endsWith(".json")) return { format: "module", source: `export default ${readFileSync(new URL(url), "utf8")}`, shortCircuit: true };
  return next(url, context);
} });
const { GoalRuntime, createGoal } = await import("./goal/runtime.ts");
const { registerGoalLifecycle } = await import("./goal/lifecycle.ts");
const { loadGoalStateFromSession } = await import("./goal/persistence.ts");
const { createDelegatedChildGoalService } = await import("./delegated-child.ts");
function fixture(status = "active") {
  const entries = [], handlers = new Map(); let idle = false, aborts = 0;
  const pi = { events: { on() {}, emit() {} }, on: (name, fn) => handlers.set(name, fn),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
    sendMessage() {}, getActiveTools: () => ["goal_complete", "goal_blocked", "goal_wait"] };
  const runtime = new GoalRuntime(pi);
  const ctx = { cwd: "/unused", isIdle: () => idle, hasPendingMessages: () => false, abort: () => { aborts++; },
    sessionManager: { getSessionId: () => "session", getBranch: () => entries, getEntries: () => entries },
    ui: { setStatus() {}, notify() {} } };
  runtime.acquireWorkflow(ctx.sessionManager);
  runtime.activeGoal = { ...createGoal("Keep this objective", 900, 0), status, tokensUsed: 100, automaticModelTurns: 8, toolFreeRepeatCount: 3 };
  runtime.persistGoal(runtime.activeGoal);
  registerGoalLifecycle(pi, runtime, {});
  return { runtime, ctx, pi, entries, handlers, setIdle: value => { idle = value; }, aborts: () => aborts };
}
for (const [label, budget, limits, stopped] of [
  ["tokens", 50, {}, "budget_limited"],
  ["automatic responses", null, { automaticTurns: 4 }, "paused"],
  ["no-progress responses", null, { noProgressTurns: 2 }, "paused"],
]) test(`lowering ${label} preserves state and pauses only after the complete tool turn`, () => {
  const f = fixture(), { runtime, ctx } = f, before = structuredClone(runtime.activeGoal), revision = runtime.policyRevision;
  runtime.updateGoalLimits(ctx, before.id, revision, budget, limits);
  assert.equal(runtime.activeGoal.status, "active"); assert.equal(f.aborts(), 0);
  assert.equal(runtime.limitActiveGoalForBudget(ctx, true), false, "intermediate tool boundary cannot abort remaining tools");
  for (const key of ["text", "tokensUsed", "automaticModelTurns", "toolFreeRepeatCount", "iteration", "progressId"]) assert.equal(runtime.activeGoal[key], before[key], key);
  assert.throws(() => runtime.updateGoalLimits(ctx, before.id, revision, null, {}), /revision changed/);
  f.handlers.get("turn_end")({ message: { role: "assistant", stopReason: "toolUse" } }, ctx);
  assert.equal(runtime.activeGoal.status, stopped); assert.ok(f.aborts() > 0);
  assert.equal(runtime.activeGoal.automaticModelTurns, 8); assert.equal(runtime.activeGoal.toolFreeRepeatCount, 3);
});
test("paused policy persists on the goal, inherits configured defaults, and never resets allowances", () => {
  const f = fixture("paused"), { runtime, ctx } = f;
  runtime.settings = { ...runtime.settings, continuationLimits: { automaticTurns: 12, noProgressTurns: 6 } };
  runtime.updateGoalLimits(ctx, runtime.activeGoal.id, runtime.policyRevision, null, { automaticTurns: 20, noProgressTurns: 10 });
  const revision = runtime.policyRevision;
  runtime.activeGoal.tokensUsed++; runtime.persistGoal(runtime.activeGoal);
  assert.equal(runtime.policyRevision, revision, "accounting does not invalidate a policy draft");
  const restored = loadGoalStateFromSession(ctx).goal;
  assert.deepEqual(restored.continuationLimits, { automaticTurns: 20, noProgressTurns: 10 });
  assert.equal(restored.tokenBudget, undefined); assert.equal(restored.tokensUsed, 101); assert.equal(restored.automaticModelTurns, 8);
  runtime.updateGoalLimits(ctx, runtime.activeGoal.id, revision, null, { automaticTurns: null, noProgressTurns: null });
  assert.deepEqual(runtime.continuationLimits, { automaticTurns: 12, noProgressTurns: 6 });
  assert.equal(runtime.activeGoal.status, "paused"); assert.equal(f.aborts(), 0);
  assert.throws(() => runtime.updateGoalLimits(ctx, "foreign", runtime.policyRevision, null, {}), /identity/);
  assert.throws(() => runtime.updateGoalLimits(ctx, runtime.activeGoal.id, runtime.policyRevision, null, { automaticTurns: 0 }), /Invalid/);
});
test("idle recorded waiting is a safe boundary and higher limits do not resume a paused goal", () => {
  const f = fixture(), { runtime, ctx } = f;
  f.setIdle(true);
  runtime.updateGoalLimits(ctx, runtime.activeGoal.id, runtime.policyRevision, null, { automaticTurns: 1 });
  assert.equal(runtime.activeGoal.status, "paused");
  runtime.updateGoalLimits(ctx, runtime.activeGoal.id, runtime.policyRevision, null, {});
  assert.equal(runtime.activeGoal.status, "paused"); assert.equal(runtime.activeGoal.automaticModelTurns, 8);
});
test("authenticated child seam changes launch policy, including finite to unlimited, without touching progress", async () => {
  const f = fixture(), { runtime, ctx } = f;
  const id = "11111111-1111-4111-8111-111111111111";
  f.pi.appendEntry("delegated-goal-child-binding-v1", { goalId: id, progressId: runtime.activeGoal.id });
  runtime.settings = { ...runtime.settings, continuationLimits: { automaticTurns: 10, noProgressTurns: 5 } };
  const service = createDelegatedChildGoalService(f.pi, ctx, runtime, {});
  const before = service.snapshot();
  const entry = { id, revision: 2, text: "Parent metadata must not replace objective", tasks: [], child: null, status: "paused", tokenBudget: null,
    tokensUsed: 0, automaticTurns: 0, noProgressTurns: 0, summary: null, waiting: null, continuationLimits: { automaticTurns: null, noProgressTurns: null } };
  const after = await service.updateLimits(id, before.childGoalId, before.policyRevision, entry);
  assert.deepEqual(after.limits, entry.continuationLimits); assert.deepEqual(runtime.continuationLimits, entry.continuationLimits);
  assert.equal(runtime.activeGoal.text, "Keep this objective"); assert.equal(after.goal.tokensUsed, 100); assert.equal(after.goal.automaticTurns, 8);
  await assert.rejects(service.updateLimits(id, before.childGoalId, before.policyRevision, entry), /policy changed/);
  await assert.rejects(service.updateLimits("foreign", before.childGoalId, after.policyRevision, entry), /ownership/);
  assert.equal(f.entries.filter(e => e.customType === "progress").length, 0);
});

test("real worker socket updates confirmed policy and rejects stale revisions, goals, epochs and capabilities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "live-goal-policy-"));
  const savedEnv = Object.fromEntries(["PI_DEDICATED_GOAL_CHILD", "PI_DEDICATED_GOAL_BINDING", "PI_SUBAGENT_ID"].map(key => [key, process.env[key]]));
  const f = fixture(), { runtime, ctx } = f, workerHandlers = new Map();
  const entryId = "11111111-1111-4111-8111-111111111111";
  f.pi.appendEntry("delegated-goal-child-binding-v1", { goalId: entryId, progressId: runtime.activeGoal.id });
  runtime.settings = { ...runtime.settings, continuationLimits: { automaticTurns: 10, noProgressTurns: 5 } };
  globalThis.__paeDelegatedChildGoalV1 = createDelegatedChildGoalService(f.pi, ctx, runtime, {});
  const binding = { path: join(directory, "worker.sock"), token: "t".repeat(48), entryId,
    policy: { continuationLimits: runtime.settings.continuationLimits }, identity: { sessionId: "s", runtimeId: "r", taskId: "t", childId: "c", jobId: "j", attempt: 1, workerEpoch: "epoch" } };
  process.env.PI_DEDICATED_GOAL_CHILD = "1"; process.env.PI_SUBAGENT_ID = "c"; process.env.PI_DEDICATED_GOAL_BINDING = JSON.stringify(binding);
  try {
    const { default: worker } = await import("../subagent/goal-worker.ts");
    const { requestGoalWorker } = await import("../subagent/goal-rpc.ts");
    await worker({ ...f.pi, on: (name, fn) => workerHandlers.set(name, fn) });
    await workerHandlers.get("session_start")({}, ctx);
    const request = (request, overrides = {}) => requestGoalWorker(binding.path, { token: binding.token, identity: binding.identity, request, ...overrides });
    const before = await request({ operation: "observe" }); assert.equal(before.limitsEditable, true);
    const update = { operation: "limits", expectedGoalId: before.goalId, expectedPolicyRevision: before.policyRevision,
      entry: { id: entryId, revision: 1, text: "Not applied", tasks: [], status: "paused", child: null, tokenBudget: null, tokensUsed: 0, automaticTurns: 0, noProgressTurns: 0, summary: null, waiting: null,
        continuationLimits: { automaticTurns: null, noProgressTurns: null } } };
    await assert.rejects(request(update, { token: "wrong" }), /identity/);
    await assert.rejects(request(update, { identity: { ...binding.identity, workerEpoch: "stale" } }), /identity/);
    await assert.rejects(request({ ...update, expectedGoalId: "foreign" }), /identity/);
    const after = await request(update);
    assert.deepEqual(after.limits, update.entry.continuationLimits); assert.equal(after.tokenBudget, null); assert.equal(after.automaticTurns, 8);
    assert.equal(runtime.activeGoal.text, "Keep this objective"); assert.equal(f.aborts(), 0);
    await assert.rejects(request(update), /revision changed/);
    assert.deepEqual((await request({ operation: "observe" })).limits, after.limits, "new confirmed policy remains observable");
  } finally {
    await workerHandlers.get("session_shutdown")?.(); delete globalThis.__paeDelegatedChildGoalV1;
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory, { recursive: true, force: true });
  }
});
