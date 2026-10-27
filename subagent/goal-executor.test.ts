import assert from "node:assert/strict";
import { test } from "node:test";
import { createDelegatedGoalExecutor, type GoalChildHandle } from "./goal-executor.ts";
import type { DelegatedGoalEntry } from "../workflows/delegated-goals.ts";
const entry = (id: string): DelegatedGoalEntry => ({ id, revision: 1, text: id, status: "paused", tasks: [], child: null, tokenBudget: null, tokensUsed: 0, automaticTurns: 0, noProgressTurns: 0, summary: null, waiting: null });
test("two child bindings retain tasks across attempts; pause awaits halt and rejects stale attempts", async () => {
  let halted = 0, validPause = false;
  const contractIds = new Map<string, string>();
  const handles: GoalChildHandle[] = [];
  const executor = createDelegatedGoalExecutor({ sessionId: "s", runtimeId: "r", async launch(e, previous) {
    const attempt = (previous?.attempt ?? 0) + 1;
    const handle: GoalChildHandle = {
      model: "gpt-6.1-sol",
      identity: { sessionId: "s", runtimeId: "r", taskId: previous?.taskId ?? `task-${e.id}`, childId: `child-${e.id}-${attempt}`, jobId: `job-${e.id}-${attempt}`, attempt, workerEpoch: `epoch-${e.id}-${attempt}` },
      async start() { contractIds.set(e.id, e.id); return { goalId: e.id, status: "active", waiting: null, executionStopped: false }; },
      async resume() { const goalId = `${e.id}-contract-${attempt}`; contractIds.set(e.id, goalId); return { goalId, status: "active", waiting: null, executionStopped: false }; },
      async pause() { return { goalId: contractIds.get(e.id)!, status: "paused", waiting: null, executionStopped: validPause }; },
      async observe() { return { goalId: contractIds.get(e.id)!, status: "active", waiting: null, executionStopped: false }; },
      async stop() { await Promise.resolve(); halted++; },
    }; handles.push(handle); return handle;
  } });
  const a = entry("a"), b = entry("b");
  a.child = await executor.start(a); b.child = await executor.start(b);
  assert.notEqual(a.child.taskId, b.child.taskId);
  await assert.rejects(executor.update(a), /execution is not stopped/);
  await assert.rejects(executor.pause(a), /did not verify stopped execution/);
  assert.equal(halted, 0);
  validPause = true;
  await executor.pause(a); assert.equal(halted, 1);
  a.text = "Updated while paused";
  const launchedBeforeEdit = handles.length;
  await executor.update(a);
  assert.equal(handles.length, launchedBeforeEdit, "paused metadata edits cannot launch a worker");
  const stale = structuredClone(a);
  a.child = await executor.resume(a);
  assert.equal(a.child.taskId, stale.child!.taskId);
  assert.equal(a.child.attempt, 2);
  assert.equal((await executor.observe(a))?.goalId, "a-contract-2", "Resume rotates engine contract while retaining task identity");
  contractIds.set("a", "a");
  await assert.rejects(executor.observe(a), /Invalid dedicated child goal observation/, "ordinary observation must still reject the old pre-resume contract");
  contractIds.set("a", "a-contract-2");
  await assert.rejects(executor.observe(stale), /Stale dedicated goal child binding/);
  assert.equal((await executor.observe(b)).goalId, "b");
  handles[2].identity.workerEpoch = "replaced";
  await assert.rejects(executor.pause(a), /Stale dedicated goal child binding/);
});
