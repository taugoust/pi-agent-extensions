import assert from "node:assert/strict";
import { test } from "node:test";
import { createDelegatedGoalExecutor, type ChildGoalSnapshot } from "./goal-executor.ts";
import { DelegatedGoalRegistry } from "../workflows/delegated-goals.ts";
import { randomUUID } from "node:crypto";
import type { DelegatedGoalEntry } from "../workflows/delegated-goals.ts";
import { openRetainedSession } from "./retained-session.ts";

async function activeSavedGoal() {
  const identity = {
    sessionId: "s",
    runtimeId: "r",
    taskId: "task",
    childId: "child",
    jobId: "job",
    attempt: 1,
    workerEpoch: "epoch",
  };
  const executor = createDelegatedGoalExecutor({
    sessionId: "s",
    runtimeId: "r",
    async launch() {
      return {
        identity,
        model: "fixture",
        async start() {
          return {
            goalId: "child-goal",
            status: "active",
            executionStopped: false,
            waiting: "child wait",
          };
        },
        async resume() {
          throw Error("unexpected resume");
        },
        async pause() {
          throw Error("unexpected pause");
        },
        async observe() {
          throw Error("unexpected observation");
        },
        async stop() {},
      };
    },
  });
  const registry = new DelegatedGoalRegistry("s", executor, () => {});
  let state = await registry.mutate("s", {
    action: "goals.create",
    requestId: "create",
    expectedGoalId: null,
    objective: "Verify reaped child output",
  });
  let entry = state.entries[0];
  state = await registry.mutate("s", {
    action: "goals.add_task",
    requestId: "task",
    expectedGoalId: entry.id,
    expectedEntryRevision: entry.revision,
    text: "Review the output",
  });
  entry = state.entries[0];
  state = await registry.mutate("s", {
    action: "goals.start",
    requestId: "start",
    expectedGoalId: entry.id,
    expectedEntryRevision: entry.revision,
  });
  return { state, entry: state.entries[0] };
}

test("Pause racing exact owned completion preserves complete/delivery and never downgrades to paused", async () => {
  let wrongId = true,
    stops = 0,
    evidence: ChildGoalSnapshot | undefined;
  const executor = createDelegatedGoalExecutor({
    sessionId: "s",
    runtimeId: "r",
    async launch() {
      return {
        model: "gpt-6.1-sol",
        identity: {
          sessionId: "s",
          runtimeId: "r",
          taskId: "task",
          childId: "child",
          jobId: "job",
          attempt: 1,
          workerEpoch: "epoch",
        },
        async start() {
          return {
            goalId: "owned-contract",
            status: "active",
            executionStopped: false,
            waiting: null,
          };
        },
        async resume() {
          throw new Error("not called");
        },
        async pause() {
          return {
            goalId: wrongId ? "foreign" : "owned-contract",
            status: "complete",
            executionStopped: false,
            waiting: null,
            summary: "Verified exact completion before Pause receipt",
          };
        },
        async observe() {
          throw new Error("completed worker already stopped");
        },
        async stop(completed) {
          stops++;
          evidence = completed;
        },
      };
    },
  });
  const entry = { id: "parent", child: null } as DelegatedGoalEntry;
  entry.child = await executor.start(entry);
  await assert.rejects(executor.pause(entry), /Invalid dedicated child goal observation/);
  assert.equal(stops, 0);
  wrongId = false;
  await executor.pause(entry);
  assert.equal(stops, 1);
  assert.equal(evidence?.status, "complete");
  const observed = await executor.observe(entry);
  assert.equal(observed?.status, "complete");
  assert.equal(observed?.executionStopped, true);
  await executor.pause(entry);
  assert.equal(stops, 1, "replayed Pause cannot cancel verified completion");
});

for (const status of ["blocked", "usage_limited", "budget_limited"] as const)
  test(`Pause reconciles owned ${status} without intent fence`, async () => {
    let stopped = false,
      terminal = false,
      intent: unknown;
    const snapshot = () => ({
      goalId: "owned",
      status: terminal ? status : ("active" as const),
      executionStopped: terminal,
      waiting: "reason",
      tokensUsed: 42,
      automaticTurns: 3,
      noProgressTurns: 2,
      tasks: [{ id: "t", text: "task", status: "blocked" as const }],
    });
    const executor = createDelegatedGoalExecutor({
      sessionId: "s",
      runtimeId: "r",
      async launch() {
        return {
          model: "gpt-6.1-sol",
          identity: {
            sessionId: "s",
            runtimeId: "r",
            taskId: "task",
            childId: "child",
            jobId: "job",
            attempt: 1,
            workerEpoch: "epoch",
          },
          async start() {
            return snapshot();
          },
          async resume() {
            throw Error("unexpected");
          },
          async observe() {
            return snapshot();
          },
          async pause() {
            terminal = true;
            return snapshot();
          },
          async stop() {
            stopped = true;
          },
        };
      },
    });
    const registry = new DelegatedGoalRegistry("s", executor, () => {}, undefined, {
      save(value) {
        intent = value;
      },
    });
    let state = await registry.mutate("s", {
      action: "goals.create",
      requestId: "create",
      expectedGoalId: null,
      objective: "goal",
      tokenBudget: 99,
    });
    let entry = state.entries[0];
    state = await registry.mutate("s", {
      action: "goals.start",
      requestId: "start",
      expectedGoalId: entry.id,
      expectedEntryRevision: entry.revision,
    });
    entry = state.entries[0];
    const child = entry.child;
    state = await registry.mutate("s", {
      action: "goals.pause",
      requestId: "pause",
      expectedGoalId: entry.id,
      expectedEntryRevision: entry.revision,
    });
    entry = state.entries[0];
    assert(stopped);
    assert.equal(intent, null);
    assert.equal(registry.blockedReason(), null);
    assert.equal(entry.status, status);
    assert.equal(entry.tokensUsed, 42);
    assert.equal(entry.tokenBudget, 99);
    assert.deepEqual(entry.child, child);
    assert.deepEqual(entry.tasks, snapshot().tasks);
  });

test("reaped active goal pauses without a session and completes with fresh evidence", async () => {
  const saved = await activeSavedGoal();
  let opened = 0;
  const restored = createDelegatedGoalExecutor({
    sessionId: "s",
    runtimeId: "restored",
    async verifyStopped() {},
    async retainedCompletion() {
      const manager = await openRetainedSession(
        `/tmp/missing-retained-session-${randomUUID()}`,
        "child-session",
        (file) => {
          opened++;
          return { file, getSessionId: () => "child-session" };
        },
      );
      if (!manager) return null;
      throw Error("unexpected retained manager");
    },
    async launch() {
      throw Error("must not relaunch");
    },
  });
  const registry = new DelegatedGoalRegistry("s", restored, () => {}, saved.state);
  let state = await registry.mutate("s", {
    action: "goals.pause",
    requestId: "pause-reaped",
    expectedGoalId: saved.entry.id,
    expectedEntryRevision: saved.entry.revision,
  });
  const paused = state.entries[0];
  assert.equal(paused.status, "paused");
  assert.equal(opened, 0);
  state = await registry.mutate("s", {
    action: "goals.complete",
    requestId: "complete-reaped",
    expectedGoalId: paused.id,
    expectedEntryRevision: paused.revision,
    user_authorized: true,
    summary: "Reviewed and verified the child output.",
    taskEvidence: [{ taskId: paused.tasks[0].id, evidence: "Reviewed the output." }],
  });
  assert.equal(state.entries[0].status, "complete");
  assert.equal(state.entries[0].tasks[0].status, "completed");
});

test("retained session identity mismatch and other IO errors reject saved Pause", async () => {
  const saved = await activeSavedGoal();
  let opened = 0;
  const wrongId = createDelegatedGoalExecutor({
    sessionId: "s",
    runtimeId: "restored",
    async verifyStopped() {},
    async retainedCompletion() {
      await openRetainedSession(
        "/present-session",
        "saved-session",
        () => {
          opened++;
          return { getSessionId: () => "foreign-session" };
        },
        async () => {},
      );
      return null;
    },
    async launch() {
      throw Error("must not relaunch");
    },
  });
  const registry = new DelegatedGoalRegistry("s", wrongId, () => {}, saved.state);
  await assert.rejects(
    registry.mutate("s", {
      action: "goals.pause",
      requestId: "wrong-id-pause",
      expectedGoalId: saved.entry.id,
      expectedEntryRevision: saved.entry.revision,
    }),
  );
  assert.equal(registry.snapshot().entries[0].status, "active");
  assert.equal(opened, 1);

  const denied = Object.assign(Error("permission denied"), { code: "EACCES" });
  const ioFailure = createDelegatedGoalExecutor({
    sessionId: "s",
    runtimeId: "restored",
    async verifyStopped() {},
    async retainedCompletion() {
      await openRetainedSession(
        "unreadable-session",
        "saved-session",
        () => null,
        async () => {
          throw denied;
        },
      );
      return null;
    },
    async launch() {
      throw Error("must not relaunch");
    },
  });
  const ioRegistry = new DelegatedGoalRegistry("s", ioFailure, () => {}, saved.state);
  await assert.rejects(
    ioRegistry.mutate("s", {
      action: "goals.pause",
      requestId: "io-failure-pause",
      expectedGoalId: saved.entry.id,
      expectedEntryRevision: saved.entry.revision,
    }),
    (error) => error === denied,
  );
  assert.equal(ioRegistry.snapshot().entries[0].status, "active");
});

for (const action of ["goals.pause", "goals.resume"] as const)
  test(`reload stale ${action} reconciles terminal before intent`, async () => {
    let launches = 0,
      journalWrites = 0;
    const complete = {
      goalId: "owned",
      status: "complete" as const,
      executionStopped: true,
      waiting: null,
      summary: "authenticated evidence",
      tasks: [],
      tokensUsed: 7,
    };
    const executor = createDelegatedGoalExecutor({
      sessionId: "s",
      runtimeId: "new",
      async verifyStopped() {},
      async retainedCompletion() {
        return complete;
      },
      async launch() {
        launches++;
        throw Error("must not launch");
      },
    });
    const entry = {
      id: "11111111-1111-1111-1111-111111111111",
      revision: 1,
      text: "goal",
      status: "paused" as const,
      tasks: [],
      child: { taskId: "task", childId: "child", jobId: "job", attempt: 1 },
      tokenBudget: null,
      tokensUsed: 0,
      automaticTurns: 0,
      noProgressTurns: 0,
      summary: null,
      waiting: null,
    };
    const registry = new DelegatedGoalRegistry(
      "s",
      executor,
      () => {},
      { version: 1, revision: 1, entries: [entry] },
      {
        save() {
          journalWrites++;
        },
      },
    );
    let state = await registry.mutate("s", {
      action,
      requestId: "stale",
      expectedGoalId: entry.id,
      expectedEntryRevision: 1,
    });
    assert.equal(state.entries[0].status, "complete");
    assert.equal(state.entries[0].summary, complete.summary);
    state = await registry.mutate("s", {
      action,
      requestId: "repeat",
      expectedGoalId: entry.id,
      expectedEntryRevision: state.entries[0].revision,
    });
    assert.equal(state.entries[0].status, "complete");
    assert.equal(launches, 0);
    assert.equal(journalWrites, 0);
  });
