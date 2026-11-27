import assert from "node:assert/strict";
import { test } from "node:test";
import { runGoalCompletionWorkerGate, unreapedWorkerIds } from "./worker-cleanup.ts";

test("goal completion inventory reports only unreaped workers", () => {
  const result = {
    details: {
      groups: [
        {
          job_id: "owned",
          children: [
            { child_id: "finished", reaped: true },
            { child_id: "waiting", reaped: false },
          ],
        },
      ],
      descendants: [{ job_id: "nested", children: [{ child_id: "nested-waiting" }] }],
      foregroundTasks: [],
      background: [{ id: "background-job" }],
    },
  };
  assert.deepEqual(unreapedWorkerIds(result), [
    "owned/waiting",
    "nested/nested-waiting",
    "background-job",
  ]);
  assert.deepEqual(
    unreapedWorkerIds({
      details: {
        groups: [],
        descendants: [],
        foregroundTasks: [],
        background: [],
      },
    }),
    [],
  );
  assert.equal(unreapedWorkerIds({ isError: true }), undefined);
  assert.equal(unreapedWorkerIds({}), undefined);
});

test("standalone goals work without subagents but managed goals fail closed", async () => {
  const globals = globalThis as any;
  const previous = globals.__paeLocalSubagentControllerV1;
  const oldManaged = process.env.PI_DEDICATED_GOAL_CHILD;
  delete globals.__paeLocalSubagentControllerV1;
  delete process.env.PI_DEDICATED_GOAL_CHILD;
  const ctx = { sessionManager: { getSessionId: () => "standalone" } };
  try {
    assert.equal(
      await runGoalCompletionWorkerGate(
        ctx,
        () => "completed",
        (message) => message,
      ),
      "completed",
    );
    process.env.PI_DEDICATED_GOAL_CHILD = "1";
    const refused = await runGoalCompletionWorkerGate(
      ctx,
      () => "completed",
      (message) => message,
    );
    assert.match(refused, /inventory is unavailable/);
  } finally {
    if (oldManaged === undefined) delete process.env.PI_DEDICATED_GOAL_CHILD;
    else process.env.PI_DEDICATED_GOAL_CHILD = oldManaged;
    if (previous !== undefined) globals.__paeLocalSubagentControllerV1 = previous;
  }
});

test("goal completion checks authenticated inventory without a subagent tool", async () => {
  const globals = globalThis as any;
  const previous = globals.__paeLocalSubagentControllerV1;
  const ctx = { sessionManager: { getSessionId: () => "coordinator" } };
  try {
    globals.__paeLocalSubagentControllerV1 = {
      protocol: 1,
      sessionId: "coordinator",
      async goalCompletionWorkers() {
        return {
          groups: [{ job_id: "coordinator-job", children: [{ child_id: "idle" }] }],
          descendants: [],
          foregroundTasks: [],
          background: [],
        };
      },
    };
    let completions = 0;
    let rejections = 0;
    const blocked = await runGoalCompletionWorkerGate(
      ctx,
      () => {
        completions++;
        return "complete";
      },
      (message) => {
        rejections++;
        return message;
      },
    );
    assert.match(blocked, /coordinator-job\/idle/);
    assert.equal(completions, 0);
    assert.equal(rejections, 1);
    globals.__paeLocalSubagentControllerV1.goalCompletionWorkers = async () => ({
      groups: [
        {
          job_id: "coordinator-job",
          children: [{ child_id: "idle", reaped: true }],
        },
      ],
      descendants: [],
      foregroundTasks: [],
      background: [],
    });
    const accepted = await runGoalCompletionWorkerGate(
      ctx,
      () => {
        completions++;
        return "complete";
      },
      () => {
        rejections++;
        return "rejected";
      },
    );
    assert.equal(accepted, "complete");
    assert.equal(completions, 1);
    assert.equal(rejections, 1);
  } finally {
    if (previous === undefined) delete globals.__paeLocalSubagentControllerV1;
    else globals.__paeLocalSubagentControllerV1 = previous;
  }
});
