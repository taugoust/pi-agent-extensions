import { registerHooks } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
const seams = {
  "./accounting.js": "export function currentTokenTotal(){return 0}",
  "./errors.js": "export function notifyTerminal(){}",
  "./goal-contract.js":
    "export const GOAL_CONTRACT_MESSAGE_TYPE='goal'; export function isGoalContextContract(){};export function reconcileGoalContextContract(){};export function reconcileInactiveGoalContextContract(){}",
  "./markers.js":
    "export function extractContinuationMarker(){};export function extractGoalPromptMarker(){}",
  "./persistence.js":
    "export function loadGoalStateFromSession(){return globalThis.__restoreFixture}",
  "./runtime.js": `export const GOAL_CONTINUATION_MESSAGE_TYPE='continue', STATUS_KEY='goal';
    export function transitionGoal(goal,status){return {...goal,status,waiting:undefined}};
    export function nextGoalInstance(goal){return {...goal,activationId:'restored-next'}};
    export function abortCurrentTurn(){};export function blocksStaleGoalToolCalls(){};export function findFinalAssistantMessage(){};
    export function incrementGoal(){};export function isGoalContextOverflow(){};export function isRetryableGoalInterruption(){};
    export function isUsageLimitedGoalInterruption(){};export function resetGoalSafetyEpoch(){};export function truncateNotification(){}`,
  "./safety.js": "export function hasAssistantToolCall(){}",
  "./settings.js":
    "export const DEFAULT_GOAL_SETTINGS={};export function readGoalSettings(){return {kind:'loaded',settings:{}}}",
};
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith("/goal/lifecycle.ts") && seams[specifier])
      return {
        url: `data:text/javascript,${encodeURIComponent(seams[specifier])}`,
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
const { registerGoalLifecycle } = await import("./goal/lifecycle.ts");
const { updateGoalUsage } = await import("./goal/accounting.ts");

test("dedicated child restoration is paused BEFORE active contracts, wait timers, ownership or continuation dispatch", async () => {
  const handlers = new Map(),
    calls = [];
  const loaded = {
    id: "restored",
    text: "saved active goal",
    status: "active",
    waiting: { reason: "wake", resumeAt: 0 },
    tokensUsed: 5,
    baselineTokens: 100,
    tokenBudget: 30,
    timeUsedSeconds: 0,
    updatedAt: 0,
  };
  globalThis.__restoreFixture = { goal: loaded };
  const forbidden = new Set([
    "acquireWorkflow",
    "ensureGoalContextContract",
    "restoreGoalWaitTimer",
    "scheduleContinuationDispatch",
    "sendOwnedGoalPrompt",
  ]);
  const runtime = new Proxy(
    { activeGoal: undefined },
    {
      get(target, key) {
        if (key in target) return target[key];
        return (...args) => {
          calls.push(key);
          if (forbidden.has(key)) throw Error(`Unsafe active restoration: ${key}`);
          if (key === "recordGoalUsage") {
            assert.equal(args[0].status, "active");
            assert.equal(args[2], false);
            updateGoalUsage(...args);
          }
          if (key === "persistGoal") assert.equal(args[0].tokensUsed, 35);
        };
      },
    },
  );
  registerGoalLifecycle(
    { on: (name, handler) => handlers.set(name, handler) },
    runtime,
    { bindSession: () => calls.push("bindSession") },
    { restorePaused: true },
  );
  try {
    await handlers.get("session_start")(
      { reason: "startup" },
      {
        sessionManager: {
          getBranch: () => [
            { type: "message", message: { role: "assistant", usage: { totalTokens: 135 } } },
          ],
        },
        ui: { setStatus() {} },
      },
    );
    assert.equal(runtime.activeGoal.status, "paused");
    assert.equal(runtime.activeGoal.waiting, undefined);
    assert.equal(runtime.activeGoal.tokensUsed, 35);
    assert.ok(runtime.activeGoal.tokensUsed >= runtime.activeGoal.tokenBudget);
    assert.ok(calls.indexOf("recordGoalUsage") < calls.indexOf("persistGoal"));
    assert.equal(loaded.status, "active");
    assert.ok(loaded.waiting);
    assert.ok(calls.includes("cancelContinuationWork"));
    assert.ok(calls.includes("clearPendingGoalPrompts"));
    assert.ok(calls.includes("ensureInactiveGoalContextContract"));
    assert.ok(!calls.some((call) => forbidden.has(call)));
  } finally {
    delete globalThis.__restoreFixture;
  }
});

function restoreFixture(reason, goal, gates = {}) {
  const handlers = new Map();
  const calls = [];
  globalThis.__restoreFixture = { goal };
  const runtime = new Proxy(
    { activeGoal: undefined },
    {
      get(target, key) {
        if (key in target) return target[key];
        return (...args) => {
          calls.push([key, ...args]);
          if (key === "acquireWorkflow") return gates.acquireWorkflow ?? true;
          if (key === "ownsWorkflow") return true;
          if (key === "goalToolsAvailable") return gates.goalToolsAvailable ?? true;
          if (key === "limitActiveGoalForBudget" && gates.budgetLimit) {
            target.activeGoal = { ...target.activeGoal, status: "budget_limited" };
            return true;
          }
          if (key === "enforceAutomaticTurnLimit" && gates.automaticLimit) {
            target.activeGoal = { ...target.activeGoal, status: "paused" };
            return true;
          }
          if (key === "enforceNoProgressLimit" && gates.noProgressLimit) {
            target.activeGoal = { ...target.activeGoal, status: "paused" };
            return true;
          }
          if (key === "pauseGoalForUnavailableTools") {
            target.activeGoal = { ...target.activeGoal, status: "paused" };
            return true;
          }
          return false;
        };
      },
    },
  );
  registerGoalLifecycle(
    { on: (name, handler) => handlers.set(name, handler) },
    runtime,
    { bindSession() {} },
    { restorePaused: true },
  );
  const ctx = {
    sessionManager: { getBranch: () => [] },
    ui: { setStatus() {} },
    isIdle: () => true,
  };
  return {
    calls,
    runtime,
    start: () => handlers.get("session_start")({ reason }, ctx),
  };
}

test("delegated reload preserves active waiting state and its absolute deadline", async () => {
  const deadline = Date.now() + 60_000;
  const goal = {
    id: "waiting",
    activationId: "activation-waiting",
    status: "active",
    waiting: { reason: "external work", resumeAt: deadline },
    automaticModelTurns: 4,
    tokensUsed: 25,
  };
  const fixture = restoreFixture("reload", goal);
  try {
    await fixture.start();
    assert.equal(fixture.runtime.activeGoal.status, "active");
    assert.equal(fixture.runtime.activeGoal.activationId, "activation-waiting");
    assert.deepEqual(fixture.runtime.activeGoal.waiting, {
      reason: "external work",
      resumeAt: deadline,
    });
    assert.equal(fixture.runtime.activeGoal.automaticModelTurns, 4);
    assert.ok(fixture.calls.some(([name]) => name === "restoreGoalWaitTimer"));
    assert.ok(!fixture.calls.some(([name]) => name === "requestContinuation"));

    const indefinite = restoreFixture("reload", {
      ...goal,
      id: "indefinite",
      waiting: { reason: "external work" },
    });
    await indefinite.start();
    assert.deepEqual(indefinite.runtime.activeGoal.waiting, { reason: "external work" });
    assert.ok(indefinite.calls.some(([name]) => name === "restoreGoalWaitTimer"));
    assert.ok(!indefinite.calls.some(([name]) => name === "requestContinuation"));
  } finally {
    delete globalThis.__restoreFixture;
  }
});

test("delegated reload schedules safe continuation for active nonwaiting work", async () => {
  const goal = {
    id: "working",
    activationId: "activation-working",
    status: "active",
    automaticModelTurns: 4,
    toolFreeRepeatCount: 2,
    tokensUsed: 25,
  };
  const fixture = restoreFixture("reload", goal);
  try {
    await fixture.start();
    assert.equal(fixture.runtime.activeGoal.status, "active");
    assert.equal(fixture.runtime.activeGoal.activationId, "activation-working");
    assert.equal(fixture.runtime.activeGoal.automaticModelTurns, 4);
    assert.equal(fixture.runtime.activeGoal.toolFreeRepeatCount, 2);
    assert.ok(fixture.calls.some(([name]) => name === "requestContinuation"));
    assert.ok(fixture.calls.some(([name]) => name === "scheduleContinuationDispatch"));
  } finally {
    delete globalThis.__restoreFixture;
  }
});

test("cold delegated starts and session replacements remain paused", async () => {
  for (const reason of ["startup", "new", "resume", "fork"]) {
    const fixture = restoreFixture(reason, {
      id: `cold-${reason}`,
      activationId: `activation-${reason}`,
      status: "active",
      waiting: { reason: "external work", resumeAt: Date.now() + 60_000 },
      tokensUsed: 25,
    });
    try {
      await fixture.start();
      assert.equal(fixture.runtime.activeGoal.status, "paused", reason);
      assert.equal(fixture.runtime.activeGoal.waiting, undefined, reason);
      assert.ok(!fixture.calls.some(([name]) => name === "acquireWorkflow"), reason);
      assert.ok(!fixture.calls.some(([name]) => name === "requestContinuation"), reason);
    } finally {
      delete globalThis.__restoreFixture;
    }
  }
});

test("delegated reload leaves all stopped and limit states inactive", async () => {
  for (const status of ["paused", "blocked", "budget_limited", "usage_limited"]) {
    const fixture = restoreFixture("reload", {
      id: `stopped-${status}`,
      activationId: `activation-${status}`,
      status,
      automaticModelTurns: 4,
      toolFreeRepeatCount: 2,
      tokensUsed: 25,
    });
    try {
      await fixture.start();
      assert.equal(fixture.runtime.activeGoal.status, status);
      assert.equal(fixture.runtime.activeGoal.activationId, `activation-${status}`);
      assert.equal(fixture.runtime.activeGoal.waiting, undefined);
      assert.equal(fixture.runtime.activeGoal.automaticModelTurns, 4);
      assert.equal(fixture.runtime.activeGoal.toolFreeRepeatCount, 2);
      assert.ok(!fixture.calls.some(([name]) => name === "acquireWorkflow"), status);
      assert.ok(!fixture.calls.some(([name]) => name === "requestContinuation"), status);
      assert.ok(!fixture.calls.some(([name]) => name === "scheduleContinuationDispatch"), status);
    } finally {
      delete globalThis.__restoreFixture;
    }
  }
});

test("delegated reload stays stopped when active restore gates fail", async () => {
  for (const [name, gates, status] of [
    ["ownership", { acquireWorkflow: false }, "paused"],
    ["budget", { budgetLimit: true }, "budget_limited"],
    ["automatic turns", { automaticLimit: true }, "paused"],
    ["no progress", { noProgressLimit: true }, "paused"],
    ["tools", { goalToolsAvailable: false }, "paused"],
  ]) {
    const fixture = restoreFixture(
      "reload",
      {
        id: `gate-${name}`,
        activationId: `activation-${name}`,
        status: "active",
        automaticModelTurns: 4,
        toolFreeRepeatCount: 2,
        tokensUsed: 25,
      },
      gates,
    );
    try {
      await fixture.start();
      assert.equal(fixture.runtime.activeGoal.status, status, name);
      assert.ok(!fixture.calls.some(([call]) => call === "requestContinuation"), name);
      assert.ok(!fixture.calls.some(([call]) => call === "scheduleContinuationDispatch"), name);
    } finally {
      delete globalThis.__restoreFixture;
    }
  }
});
