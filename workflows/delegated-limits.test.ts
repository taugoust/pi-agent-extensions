import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { DelegatedGoalRegistry, type DelegatedGoalEntry } from "./delegated-goals.ts";
import { createDelegatedGoalExecutor, type ChildGoalSnapshot, type GoalChildHandle } from "../subagent/goal-executor.ts";
const entry = (): DelegatedGoalEntry => ({ id: randomUUID(), revision: 3, text: "Keep objective", status: "active",
  tasks: [{ id: "task", text: "Keep checklist", status: "in_progress" }],
  child: { taskId: "task", childId: "child", jobId: "job", attempt: 1 }, tokenBudget: 1000, tokensUsed: 100,
  automaticTurns: 8, noProgressTurns: 3, summary: null, waiting: null });
test("active and paused limits-only edits propagate with exact revision and preserve all accounting and scope", async () => {
  for (const status of ["active", "paused"] as const) {
    const original = { ...entry(), status }, deliveries: DelegatedGoalEntry[] = [], persisted: unknown[] = [];
    const registry = new DelegatedGoalRegistry("session", {
      start: async () => { throw Error("Cannot start"); }, resume: async () => { throw Error("Cannot resume"); }, pause: async () => { throw Error("Cannot pause mid-tool"); },
      updateLimits: async updated => { deliveries.push(structuredClone(updated)); },
    }, state => persisted.push(state), { version: 1, revision: 1, entries: [original] });
    const request = { action: "goals.limits" as const, requestId: randomUUID(), expectedGoalId: original.id, expectedEntryRevision: original.revision,
      tokenBudget: 50, continuationLimits: { automaticTurns: 2, noProgressTurns: null } };
    const state = await registry.mutate("session", request), updated = state.entries[0];
    for (const key of ["text", "tasks", "child", "status", "tokensUsed", "automaticTurns", "noProgressTurns"] as const) assert.deepEqual(updated[key], original[key], key);
    assert.equal(updated.tokenBudget, 50); assert.deepEqual(updated.continuationLimits, request.continuationLimits);
    assert.equal(deliveries.length, 1); assert.equal(persisted.length, 1);
    assert.deepEqual(await registry.mutate("session", request), state, "same request does not redeliver");
    await assert.rejects(registry.mutate("session", { ...request, requestId: randomUUID() }), /revision/);
    await assert.rejects(registry.mutate("foreign", { ...request, requestId: randomUUID() }), /Stale/);
    await assert.rejects(registry.mutate("session", { ...request, requestId: randomUUID(), expectedEntryRevision: updated.revision, objective: "Scope change forbidden" }), /Unknown/);
    assert.equal(deliveries.length, 1);
  }
});
test("lost live-policy receipts retain the durable uncertainty fence rather than reporting a successful parent-only edit", async () => {
  const original = entry(); let intent: unknown;
  const registry = new DelegatedGoalRegistry("session", {
    start: async () => original.child!, resume: async () => original.child!, pause: async () => {},
    updateLimits: async () => { throw Error("lost receipt"); },
  }, () => { throw Error("must not persist unconfirmed policy"); }, { version: 1, revision: 1, entries: [original] }, { save: value => { intent = value; } });
  await assert.rejects(registry.mutate("session", { action: "goals.limits", requestId: randomUUID(), expectedGoalId: original.id, expectedEntryRevision: original.revision,
    tokenBudget: null, continuationLimits: {} }), /lost receipt/);
  assert.ok(intent); assert.ok(registry.blockedReason()); assert.deepEqual(registry.snapshot().entries[0], original);
});
test("executor live policy fails closed for old workers and stale attempts; stopped edits never launch or call a dead worker", async () => {
  const original = entry(); original.child = null; original.status = "paused";
  let calls = 0, launches = 0;
  let state: ChildGoalSnapshot = { goalId: "contract", status: "active", waiting: null, executionStopped: false };
  const handle: GoalChildHandle = { model: "fixture", identity: { sessionId: "s", runtimeId: "r", taskId: "t", childId: "c", jobId: "j", attempt: 1, workerEpoch: "e" },
    start: async () => state, resume: async () => state, observe: async () => state,
    pause: async () => { state = { ...state, status: "paused", executionStopped: true }; return state; }, stop: async () => {},
    updateLimits: async (entry, goalId, revision) => { calls++; assert.equal(goalId, "contract"); assert.equal(revision, state.policyRevision);
      state = { ...state, policyRevision: revision + 1, tokenBudget: entry.tokenBudget, limits: entry.continuationLimits }; return state; } };
  const executor = createDelegatedGoalExecutor({ sessionId: "s", runtimeId: "r", launch: async () => { launches++; return handle; } });
  original.child = await executor.start(original); original.status = "active";
  await assert.rejects(executor.updateLimits(original), /does not support/); assert.equal(calls, 0);
  state = { ...state, policyRevision: 1, limitsEditable: true };
  original.tokenBudget = 50; original.continuationLimits = { automaticTurns: 2, noProgressTurns: null };
  await executor.updateLimits(original); assert.equal(calls, 1); assert.equal(state.tokenBudget, 50);
  await assert.rejects(executor.updateLimits({ ...original, child: { ...original.child, attempt: 99 } }), /Stale/);
  await executor.pause(original); original.status = "paused";
  await executor.updateLimits(original); assert.equal(calls, 1); assert.equal(launches, 1);
});
