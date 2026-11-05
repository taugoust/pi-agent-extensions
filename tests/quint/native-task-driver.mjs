import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Only the ITF subset used by this model. Reject unsafe integers/unknown tags
// rather than silently weakening comparisons when a model changes.
export function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    if (Object.hasOwn(value, "#bigint")) {
      const number = Number(value["#bigint"]);
      assert.ok(Number.isSafeInteger(number), "ITF integer exceeds JavaScript precision");
      return number;
    }
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "#meta").map(([key, item]) => {
      assert.ok(!key.startsWith("#"), `Unsupported ITF value ${key}`);
      return [key, decode(item)];
    }));
  }
  return value;
}

export class ModelMismatch extends Error {
  constructor(file, step, command, cause) {
    super(`${file}, step ${step}, ${JSON.stringify(command)}: ${cause.message}`, { cause });
    this.name = "ModelMismatch";
    this.step = step;
    this.command = command;
  }
}

const owner = "quint-parent";
const taskId = `subagent-task-${"a".repeat(24)}`;
const childId = number => `subagent-child-${number.toString(16).padStart(24, "0")}`;
const childNumber = id => Number.parseInt(id.slice("subagent-child-".length), 16);

export async function replay(file, NativeTaskStore) {
  const trace = decode(JSON.parse(readFileSync(file, "utf8")));
  assert.deepEqual(trace.vars, ["state", "command"], "Unexpected model variables");
  assert.ok(trace.states.length > 1, "A differential trace must contain transitions");
  assert.equal(trace.states[0].command.kind, "init");
  const root = mkdtempSync(join(tmpdir(), "pi-quint-task-"));
  const taskRoot = join(root, "tasks");
  let store = new NativeTaskStore(taskRoot);
  const coverage = new Set();
  const spec = { task: "Quint retained-attempt fixture", cwd: root, tools: ["read"],
    acceptance: ["model agrees with persisted state"], cleanupWorktreesOnReap: true };
  const original = await store.create(owner, taskId, structuredClone(spec), childId(1));
  const session = readFileSync(store.sessionPath(taskId), "utf8");

  // Rejection provenance matters: an I/O failure is not an ownership refusal.
  const reject = (operation, pattern) => assert.rejects(async () => operation(), pattern);
  const compare = expected => {
    const fresh = new NativeTaskStore(taskRoot);
    const actual = fresh.get(owner, taskId);
    const { nextChild: _generatorCounter, ...snapshot } = expected;
    assert.deepEqual({
      attempt: actual.attempt, child: childNumber(actual.childId), running: actual.state === "running",
      history: actual.history.map(entry => ({ attempt: entry.attempt, child: childNumber(entry.childId), outcome: entry.outcome })),
      summaryAttempt: actual.latestSummaryAttempt ?? 0,
      summary: actual.latestSummary === undefined ? 0 : Number(actual.latestSummary.slice("summary-".length)),
      checkpointed: actual.checkpointed ?? false,
    }, snapshot, "persisted task state differs from Quint");
    assert.equal(actual.sessionId, original.sessionId, "resume changed session identity");
    assert.equal(readFileSync(fresh.sessionPath(taskId), "utf8"), session, "operation modified retained session contents");
    assert.deepEqual(actual.spec, spec, "retained task/permissions changed");
    assert.equal(actual.ownerSessionId, owner);
    assert.equal(actual.ownerPid, process.pid);
    assert.ok(actual.history.every(entry => entry.execution === "completed"));
    assert.equal(actual.requiresCompaction ?? false, false);
    const [listed] = fresh.list(owner);
    assert.ok(listed);
    assert.equal(listed.attempt, expected.attempt);
    assert.equal(listed.child_id, childId(expected.child));
    assert.equal(listed.state, expected.running ? "running" : "idle");
    assert.equal(listed.can_resume, !expected.running);
    assert.equal(listed.checkpointed, expected.checkpointed);
    assert.equal(listed.summary, expected.summaryAttempt === expected.attempt ? `summary-${expected.summary}` : undefined);
  };

  try {
    for (let step = 0; step < trace.states.length; step++) {
      const { command, state } = trace.states[step];
      const previous = trace.states[step - 1]?.state;
      try {
        switch (command.kind) {
          case "init":
            assert.equal(step, 0, "init is only allowed at the beginning");
            break;
          case "finish":
            await store.finish(owner, taskId, childId(command.child), {
              outcome: command.outcome, summary: `summary-${command.summary}`, execution: "completed",
            });
            coverage.add(command.child === previous.child ? "current_finish" : "stale_finish");
            if (command.child !== previous.child && previous.history.some(entry => entry.child === command.child && entry.attempt < previous.attempt)) coverage.add("previous_attempt_finish");
            if (command.child === previous.child && !previous.running) coverage.add("repeat_finish");
            if (command.child === previous.child && command.outcome === "checkpointed") coverage.add("checkpoint");
            break;
          case "resume":
            if (command.result === "rejected") {
              await reject(() => store.beginResume(owner, taskId, childId(command.child)), /still running/);
              coverage.add("running_resume_refused");
            } else {
              assert.equal(command.result, "ok");
              await store.beginResume(owner, taskId, childId(command.child));
              coverage.add("resume");
            }
            break;
          case "competingResume": {
            const results = await Promise.allSettled([
              store.beginResume(owner, taskId, childId(command.child)),
              store.beginResume(owner, taskId, childId(command.other)),
            ]);
            assert.equal(results[0].status, "fulfilled");
            assert.equal(results[1].status, "rejected");
            assert.match(results[1].reason.message, /still running/);
            coverage.add(command.child < command.other ? "resume_order_low_then_high" : "resume_order_high_then_low");
            break;
          }
          case "verifyStopped":
            if (command.result === "rejected") {
              await reject(() => store.verifyStopped(owner, taskId, childId(command.child), command.attempt), /ownership changed|owner is still running/);
              coverage.add(command.child !== previous.child ? "stop_child_refused"
                : command.attempt !== previous.attempt ? "stop_attempt_refused" : "stop_running_refused");
            } else {
              assert.equal(command.result, "ok");
              await store.verifyStopped(owner, taskId, childId(command.child), command.attempt);
              coverage.add("stopped");
            }
            break;
          case "foreign": {
            const foreign = "other-parent";
            const denied = /another parent session/;
            switch (command.method) {
              case "get": await reject(() => store.get(foreign, taskId), denied); break;
              case "list": assert.deepEqual(store.list(foreign), []); break;
              case "finish": await reject(() => store.finish(foreign, taskId, childId(command.child)), denied); break;
              case "resume": await reject(() => store.beginResume(foreign, taskId, childId(99)), denied); break;
              case "verifyStopped": await reject(() => store.verifyStopped(foreign, taskId, childId(command.child), command.attempt), denied); break;
              default: throw new Error(`Unknown foreign operation ${command.method}`);
            }
            coverage.add(`foreign_${command.method}`);
            break;
          }
          case "reconstruct":
            store = new NativeTaskStore(taskRoot);
            coverage.add("reconstruct");
            break;
          default: throw new Error(`Unknown model command ${command.kind}`);
        }
        compare(state);
      } catch (error) {
        if (error instanceof assert.AssertionError) throw new ModelMismatch(file, step, command, error);
        throw error;
      }
    }
    return { transitions: trace.states.length - 1, coverage };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
