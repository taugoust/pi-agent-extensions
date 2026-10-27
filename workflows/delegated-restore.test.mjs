import { registerHooks } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
const seams = {
  "./accounting.js": "export function currentTokenTotal(){return 0}",
  "./errors.js": "export function notifyTerminal(){}",
  "./goal-contract.js": "export const GOAL_CONTRACT_MESSAGE_TYPE='goal'; export function isGoalContextContract(){};export function reconcileGoalContextContract(){};export function reconcileInactiveGoalContextContract(){}",
  "./markers.js": "export function extractContinuationMarker(){};export function extractGoalPromptMarker(){}",
  "./persistence.js": "export function loadGoalStateFromSession(){return globalThis.__restoreFixture}",
  "./runtime.js": `export const GOAL_CONTINUATION_MESSAGE_TYPE='continue', STATUS_KEY='goal';
    export function transitionGoal(goal,status){return {...goal,status,waiting:undefined}};
    export function abortCurrentTurn(){};export function blocksStaleGoalToolCalls(){};export function findFinalAssistantMessage(){};
    export function incrementGoal(){};export function isGoalContextOverflow(){};export function isRetryableGoalInterruption(){};
    export function isUsageLimitedGoalInterruption(){};export function resetGoalSafetyEpoch(){};export function truncateNotification(){}`,
  "./safety.js": "export function hasAssistantToolCall(){}",
  "./settings.js": "export const DEFAULT_GOAL_SETTINGS={};export function readGoalSettings(){return {kind:'loaded',settings:{}}}",
};
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith("/goal/lifecycle.ts") && seams[specifier]) return { url: `data:text/javascript,${encodeURIComponent(seams[specifier])}`, shortCircuit: true };
  return next(specifier, context);
} });
const { registerGoalLifecycle } = await import("./goal/lifecycle.ts");
const { updateGoalUsage } = await import("./goal/accounting.ts");

test("dedicated child restoration is paused BEFORE active contracts, wait timers, ownership or continuation dispatch", async () => {
  const handlers = new Map(), calls = [];
  const loaded = { id: "restored", text: "saved active goal", status: "active", waiting: { reason: "wake", resumeAt: 0 }, tokensUsed: 5, baselineTokens: 100, tokenBudget: 30, timeUsedSeconds: 0, updatedAt: 0 };
  globalThis.__restoreFixture = { goal: loaded };
  const forbidden = new Set(["acquireWorkflow", "ensureGoalContextContract", "restoreGoalWaitTimer", "scheduleContinuationDispatch", "sendOwnedGoalPrompt"]);
  const runtime = new Proxy({ activeGoal: undefined }, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      calls.push(key);
      if (forbidden.has(key)) throw Error(`Unsafe active restoration: ${key}`);
      if (key === "recordGoalUsage") {
        assert.equal(args[0].status, "active"); assert.equal(args[2], false);
        updateGoalUsage(...args);
      }
      if (key === "persistGoal") assert.equal(args[0].tokensUsed, 35);
    };
  } });
  registerGoalLifecycle({ on: (name, handler) => handlers.set(name, handler) }, runtime, { bindSession: () => calls.push("bindSession") }, { restorePaused: true });
  try {
    await handlers.get("session_start")({}, { sessionManager: { getBranch: () => [{ type: "message", message: { role: "assistant", usage: { totalTokens: 135 } } }] }, ui: { setStatus() {} } });
    assert.equal(runtime.activeGoal.status, "paused"); assert.equal(runtime.activeGoal.waiting, undefined);
    assert.equal(runtime.activeGoal.tokensUsed, 35); assert.ok(runtime.activeGoal.tokensUsed >= runtime.activeGoal.tokenBudget);
    assert.ok(calls.indexOf("recordGoalUsage") < calls.indexOf("persistGoal"));
    assert.equal(loaded.status, "active"); assert.ok(loaded.waiting);
    assert.ok(calls.includes("cancelContinuationWork")); assert.ok(calls.includes("clearPendingGoalPrompts"));
    assert.ok(calls.includes("ensureInactiveGoalContextContract"));
    assert.ok(!calls.some(call => forbidden.has(call)));
  } finally { delete globalThis.__restoreFixture; }
});
