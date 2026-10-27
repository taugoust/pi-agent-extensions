import assert from "node:assert/strict";
import { test } from "node:test";
import { resumeRestoredGoal, type ChildGoalSnapshot } from "./goal-executor.ts";

test("restart handshake never resumes an active restored wait or non-idle child", async () => {
  let resumes = 0;
  const resume = async (): Promise<ChildGoalSnapshot> => {
    resumes++;
    return { goalId: "owned-goal", status: "active", waiting: null, executionStopped: false };
  };
  for (const restored of [
    { status: "active", waiting: "persisted wait deadline", executionStopped: true },
    { status: "active", waiting: null, executionStopped: false },
    { status: "paused", waiting: "persisted wait deadline", executionStopped: false },
  ] as const) {
    await assert.rejects(resumeRestoredGoal(async () => ({ goalId: "owned-goal", ...restored }), resume), /restore must be resumable and idle/);
    assert.equal(resumes, 0, "no structured resume is dispatched for an unsafe restore");
  }
  assert.equal((await resumeRestoredGoal(async () => ({ goalId: "owned-goal", status: "paused", waiting: null, executionStopped: true }), resume)).status, "active");
  assert.equal(resumes, 1, "only the explicit paused/idle resume activates execution");
});

test("all legitimate stopped resumable states forward unchanged; budget rejection is not bypassed", async () => {
  for (const status of ["paused", "blocked", "usage_limited", "budget_limited"] as const) {
    const restored = { goalId: "owned-goal", status, waiting: null, executionStopped: true, tokensUsed: 100 };
    const before = structuredClone(restored);
    await resumeRestoredGoal(async () => restored, async () => ({ ...restored, status: "active", executionStopped: false }));
    assert.deepEqual(restored, before, "transport must not normalize away a safety pause or reset usage");
    await assert.rejects(resumeRestoredGoal(async () => ({ ...restored, executionStopped: false }), async () => { throw new Error("must not dispatch"); }), /resumable and idle/);
  }
  const limited = { goalId: "budget-goal", status: "budget_limited" as const, waiting: null, executionStopped: true, tokensUsed: 100 };
  await assert.rejects(resumeRestoredGoal(async () => limited, async () => { throw new Error("Goal token budget is still reached"); }), /budget is still reached/);
  assert.equal(limited.tokensUsed, 100); assert.equal(limited.status, "budget_limited");
});
