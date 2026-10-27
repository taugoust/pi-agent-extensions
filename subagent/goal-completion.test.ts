import assert from "node:assert/strict";
import { test } from "node:test";
import { createDelegatedGoalExecutor, type ChildGoalSnapshot } from "./goal-executor.ts";
import type { DelegatedGoalEntry } from "../workflows/delegated-goals.ts";

test("only observed owned child completion propagates and stops its execution", async () => {
  let stopped = false, instantlyComplete = false;
  let stoppedEvidence: ChildGoalSnapshot | undefined;
  let snapshot: ChildGoalSnapshot = { goalId: "child-goal", status: "active", waiting: null, executionStopped: false };
  const executor = createDelegatedGoalExecutor({ sessionId: "s", runtimeId: "r", async launch(e) {
    return { model: "gpt-6.1-sol", identity: { sessionId: "s", runtimeId: "r", taskId: `t-${e.id}`, childId: `c-${e.id}`, jobId: `j-${e.id}`, attempt: 1, workerEpoch: "epoch" },
      async start() { return { ...structuredClone(snapshot), ...(instantlyComplete ? { status: "complete" as const } : {}) }; }, async resume() { return structuredClone(snapshot); },
      async pause() { throw new Error("not called"); }, async observe() { return structuredClone(snapshot); },
      async stop(completion) { await Promise.resolve(); stopped = true; stoppedEvidence = completion; },
    };
  } });
  const entry = { id: "parent-goal", child: null } as DelegatedGoalEntry;
  entry.child = await executor.start(entry);
  snapshot = { ...snapshot, goalId: "foreign", status: "complete" };
  await assert.rejects(executor.observe(entry), /Invalid dedicated child goal observation/);
  assert.equal(stopped, false);
  snapshot = { ...snapshot, goalId: "child-goal", status: "complete", summary: "Verified child result" };
  const completed = await executor.observe(entry);
  assert.equal(completed?.status, "complete");
  assert.equal(completed?.summary, "Verified child result");
  assert.equal(completed?.executionStopped, true);
  assert.equal(stopped, true);
  assert.equal(stoppedEvidence?.goalId, "child-goal");
  assert.equal(stoppedEvidence?.status, "complete");
  await executor.verifyStopped(entry);
  assert.deepEqual(await executor.observe(entry), completed);
  instantlyComplete = true;
  stopped = false;
  const immediate = { id: "immediately-completed-parent-goal", child: null } as DelegatedGoalEntry;
  immediate.child = await executor.start(immediate);
  assert.equal(stopped, true, "rapid verified engine completion is not mistaken for failed activation");
  assert.equal((await executor.observe(immediate))?.status, "complete");
});
