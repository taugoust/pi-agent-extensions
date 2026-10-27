import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { requestGoalWorker, serveGoalWorker, type GoalWorkerIdentity } from "./goal-rpc.ts";

test("independent dedicated child channels fence all execution identities and serialize mutations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "goal-rpc-"));
  const identity: GoalWorkerIdentity = { sessionId: "s", runtimeId: "r", taskId: "t1", childId: "c1", jobId: "j1", attempt: 1, workerEpoch: "epoch1" };
  const second = { ...identity, taskId: "t2", childId: "c2", jobId: "j2", workerEpoch: "epoch2" };
  const token = "capability-for-isolated-test-only-123456";
  const states = [0, 0];
  let current = true;
  const servers = await Promise.all([identity, second].map((id, i) => serveGoalWorker({
    path: join(dir, `${i}.sock`), token, identity: id, isCurrent: () => current,
    async handle(input) { const before = states[i]; await Promise.resolve(); states[i] = before + 1; return { goal: id.taskId, value: input, revision: states[i] }; },
  })));
  try {
    const call = (i: number, id: GoalWorkerIdentity, request: unknown = "snapshot") => requestGoalWorker(join(dir, `${i}.sock`), { token, identity: id, request });
    assert.deepEqual(await call(0, identity), { goal: "t1", value: "snapshot", revision: 1 });
    assert.deepEqual(await call(1, second, "🌍"), { goal: "t2", value: "🌍", revision: 1 });
    for (const key of Object.keys(identity) as Array<keyof GoalWorkerIdentity>) {
      const stale = { ...identity, [key]: key === "attempt" ? 2 : "stale" };
      await assert.rejects(call(0, stale), /Stale goal worker identity/);
    }
    await assert.rejects(call(0, second), /Stale goal worker identity/);
    await assert.rejects(requestGoalWorker(join(dir, "0.sock"), { token: "bad", identity, request: {} }), /Stale goal worker identity/);
    await Promise.all(Array.from({ length: 10 }, () => call(0, identity)));
    assert.deepEqual(states, [11, 1]);
    current = false;
    await assert.rejects(call(0, identity), /Stale goal worker runtime/);
    assert.deepEqual(states, [11, 1]);
  } finally { await Promise.all(servers.map(s => s.close())); await rm(dir, { recursive: true, force: true }); }
});
