import assert from "node:assert/strict";
import { test } from "node:test";
import { createDelegatedGoalExecutor } from "./goal-executor.ts";
import type { DelegatedGoalEntry } from "../workflows/delegated-goals.ts";

test("parent reload reconciles only exact stopped execution and never implicitly launches", async () => {
  let launches = 0, canVerify = false;
  const entry = { id: "parent-goal", status: "active", child: { taskId: "task", childId: "old-child", jobId: "old-job", attempt: 1 } } as DelegatedGoalEntry;
  const executor = createDelegatedGoalExecutor({ sessionId: "session", runtimeId: "new-runtime",
    async verifyStopped(e) { assert.deepEqual(e.child, entry.child); if (!canVerify) throw new Error("owned child process still alive"); },
    async launch(e, previous) {
      launches++;
      assert.equal(previous?.taskId, "task");
      return { model: "gpt-6.1-sol", identity: { sessionId: "session", runtimeId: "new-runtime", taskId: "task", childId: "new-child", jobId: "new-job", attempt: 2, workerEpoch: "new-epoch" },
        async start() { throw new Error("must not start new assignment"); },
        async resume() { return { goalId: "restored-contract", activationId: "new-activation", status: "active", waiting: null, executionStopped: false }; },
        async pause() { return { goalId: "restored-contract", activationId: "new-activation", status: "paused", waiting: null, executionStopped: true }; },
        async observe() { return { goalId: "restored-contract", activationId: "old-activation", status: "paused", waiting: null, executionStopped: true }; },
        async stop() {},
      };
    },
  });
  assert.equal(await executor.observe(entry), null);
  assert.equal(executor.executionAvailable(), false);
  assert.match(executor.executionUnavailableReason()!, /owned child process still alive/);
  assert.equal(launches, 0);
  canVerify = true;
  const recovered = await executor.observe(entry);
  assert.equal(recovered?.status, "paused");
  assert.match(recovered?.summary!, /explicit Resume/);
  assert.equal(executor.executionAvailable(), true);
  assert.equal(launches, 0);
  const resumed = await executor.resume({ ...entry, status: "paused" });
  assert.equal(resumed.taskId, entry.child!.taskId);
  assert.equal(resumed.attempt, 2);
  assert.equal(launches, 1);
});

test("live binding socket failure becomes paused only with exact stopped proof, otherwise explicitly unavailable", async () => {
  let exited = false, failure = false, stops = 0, launches = 0;
  const entry = { id: "live-parent", status: "paused", child: null } as DelegatedGoalEntry;
  const active = { goalId: "live-contract", status: "active" as const, executionStopped: false, waiting: null };
  const executor = createDelegatedGoalExecutor({ sessionId: "s", runtimeId: "r",
    async verifyStopped(e) { assert.equal(e.child?.taskId, "owned-task"); if (!exited) throw new Error("exact owned child is still running"); },
    async launch() { launches++; return {
      model: "gpt-6.1-sol", identity: { sessionId: "s", runtimeId: "r", taskId: "owned-task", childId: "owned-child", jobId: "owned-job", attempt: 1, workerEpoch: "owned-epoch" },
      async start() { return { ...active }; }, async resume() { return { ...active }; },
      async pause() { return { ...active, status: "paused", executionStopped: true }; },
      async observe() { if (failure) throw new Error("owned workflow socket closed"); return { ...active }; },
      async stop() { stops++; },
    }; },
  });
  entry.child = await executor.start(entry);
  failure = true;
  assert.equal(await executor.observe(entry), null);
  assert.equal(executor.executionAvailable(), false);
  assert.match(executor.executionUnavailableReason()!, /exact owned child is still running/);
  assert.equal(stops, 0, "a socket failure is not authority to assume execution halted");
  exited = true;
  const observed = await executor.observe(entry);
  assert.equal(observed?.status, "paused");assert.equal(observed?.executionStopped, true);
  assert.match(observed?.summary!, /execution exited/);
  assert.equal(executor.executionAvailable(), true);
  assert.equal(stops, 1);assert.equal(launches, 1, "exit reconciliation never relaunches");
});
