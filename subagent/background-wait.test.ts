import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import backgroundSubagentExtension, { backgroundChildProgress, backgroundChildStatus, validateBackgroundOperation } from "./index.js";
import {
  sharedBackgroundSubagentChildTracker,
  sharedBackgroundSubagentManager,
} from "./background.js";

const jobId = "subagent-job-0123456789abcdef01234567";
assert.throws(() => validateBackgroundOperation({ operation: "wait_everything" }), /Unknown background subagent operation/);

for (const operation of ["wait", "wait_group"]) {
  assert.doesNotThrow(() => validateBackgroundOperation({ operation, job_id: jobId, wait_ms: 10 }));
  assert.throws(() => validateBackgroundOperation({ operation, wait_ms: 10 }), /requires a valid job_id/);
}
for (const operation of ["wait_any", "wait_all"]) {
  assert.doesNotThrow(() => validateBackgroundOperation({ operation, wait_ms: 10 }));
  assert.throws(() => validateBackgroundOperation({ operation, job_id: jobId }), /accepts only optional wait_ms/);
  assert.throws(() => validateBackgroundOperation({ operation, task: "not a lifecycle request" }), /cannot include launch/);
}
const sixHoursMs = 6 * 60 * 60 * 1000;
for (const operation of ["wait", "wait_group", "wait_any", "wait_all"]) {
  const params = operation === "wait" || operation === "wait_group" ? { operation, job_id: jobId } : { operation };
  assert.doesNotThrow(() => validateBackgroundOperation({ ...params, wait_ms: sixHoursMs }));
  assert.throws(() => validateBackgroundOperation({ ...params, wait_ms: Number.MAX_SAFE_INTEGER }), /wait_ms/);
  assert.throws(() => validateBackgroundOperation({ ...params, wait_ms: 1.5 }), /wait_ms/);
}

assert.equal(backgroundChildStatus({ exitCode: -1, backgroundState: "pending" }), "pending");
assert.equal(backgroundChildStatus({ exitCode: -1, backgroundState: "running" }), "running");
assert.equal(backgroundChildStatus({ exitCode: -1, stopReason: "aborted", backgroundState: "running" }), "running");
assert.equal(backgroundChildStatus({ terminal: { state: "failed" }, exitCode: 0, stopReason: "completed" }), "failed");
assert.equal(backgroundChildStatus({ terminal: { state: "completed" }, exitCode: 1, stopReason: "error" }), "completed");
assert.equal(backgroundChildStatus({ exitCode: 130, stopReason: "aborted" }), "cancelled");
assert.equal(backgroundChildStatus({ exitCode: 0, stopReason: "completed" }), "completed");
assert.equal(backgroundChildStatus({ exitCode: 1, stopReason: "error" }), "failed");
assert.deepEqual(
  backgroundChildProgress(
    { results: [{ label: "task 2", exitCode: 0 }, { label: "task 1", exitCode: -1 }] },
    [{ label: "task 1" }, { label: "task 2" }],
  ).map((child) => [child.child, child.label, child.status]),
  [[2, "task 2", "completed"], [1, "task 1", "running"]],
);

function createPi() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const tools = new Map<string, any>();
  return {
    handlers,
    tools,
    on(event: string, handler: (event: any, ctx: any) => any) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
    sendMessage() {},
  };
}

async function emit(pi: ReturnType<typeof createPi>, event: string, value: any, ctx: any) {
  for (const handler of pi.handlers.get(event) ?? []) await handler(value, ctx);
}

async function operationCheck() {
  const root = await mkdtemp(path.join(os.tmpdir(), "subagent-wait-api-"));
  const agentDir = path.join(root, "agent");
  const sessionId = "background-wait-api-session";
  const pi = createPi();
  const ctx = {
    cwd: root,
    mode: "rpc",
    hasUI: false,
    isIdle: () => false,
    ui: { setStatus() {}, notify() {}, theme: { fg: (_color: string, text: string) => text } },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => path.join(agentDir, "sessions", "session.jsonl"),
      getBranch: () => [],
    },
    modelRegistry: { getAll: () => [] },
  };
  backgroundSubagentExtension(pi as any);
  await emit(pi, "session_start", { reason: "startup" }, ctx);
  const tool = pi.tools.get("subagent");
  assert(tool, "subagent tool was not registered");
  assert.match(tool.parameters.properties.operation.pattern, /wait_group/);
  assert.match(tool.parameters.properties.operation.pattern, /wait_any/);
  assert.match(tool.parameters.properties.operation.pattern, /wait_all/);
  assert(tool.parameters.properties.wait_ms.maximum >= sixHoursMs, "tool schema does not expose hour-scale waits");

  const manager = sharedBackgroundSubagentManager(path.join(agentDir, "state", "background-subagents-v1"));
  const tracker = sharedBackgroundSubagentChildTracker();
  let releaseAny!: () => void;
  const anyGroup = await manager.start({ sessionId, backend: "native", mode: "parallel", summary: "parallel 2: any" }, async () => {
    await new Promise<void>((resolve) => { releaseAny = resolve; });
    return { text: "any complete", failed: false };
  });
  tracker.register(anyGroup, [{ label: "task 1" }, { label: "task 2" }]);
  tracker.update(anyGroup.id, [
    { child: 1, label: "task 1", status: "running" },
    { child: 2, label: "task 2", status: "running" },
  ]);
  setTimeout(() => tracker.update(anyGroup.id, [{ child: 2, label: "task 2", status: "completed" }]), 20);
  const anyResult = await tool.execute("wait-any", { operation: "wait_any", wait_ms: 500 }, undefined, undefined, ctx);
  assert.equal(anyResult.details.operation, "wait_any");
  assert.equal(anyResult.details.job_id, anyGroup.id);
  assert.equal(anyResult.details.child, 2);
  assert.equal(anyResult.details.child_status, "completed");
  assert.equal((await manager.get(anyGroup.id)).status, "running", "wait_any cancelled its group");
  setTimeout(releaseAny, 20);
  const groupResult = await tool.execute("wait-group", { operation: "wait_group", job_id: anyGroup.id, wait_ms: 500 }, undefined, undefined, ctx);
  assert.equal(groupResult.details.status, "completed");
  const aliasResult = await tool.execute("wait-alias", { operation: "wait", job_id: anyGroup.id, wait_ms: 0 }, undefined, undefined, ctx);
  assert.equal(aliasResult.details.status, "completed");

  let releaseOne!: () => void;
  let releaseTwo!: () => void;
  const one = await manager.start({ sessionId, backend: "native", mode: "single", summary: "all one" }, async () => {
    await new Promise<void>((resolve) => { releaseOne = resolve; });
    return { text: "one", failed: false };
  });
  const two = await manager.start({ sessionId, backend: "agentsh", mode: "single", summary: "all two" }, async () => {
    await new Promise<void>((resolve) => { releaseTwo = resolve; });
    return { text: "two", failed: false };
  });
  const allPromise = tool.execute("wait-all", { operation: "wait_all", wait_ms: 500 }, undefined, undefined, ctx);
  const later = await manager.start({ sessionId, backend: "native", mode: "single", summary: "later" }, async (signal) => {
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    return { text: "unexpected", failed: false };
  });
  setTimeout(releaseOne, 20);
  setTimeout(releaseTwo, 40);
  const allResult = await allPromise;
  assert.equal(allResult.details.operation, "wait_all");
  assert.deepEqual(new Set(allResult.details.groups.map((group: any) => group.job_id)), new Set([one.id, two.id]));
  assert.equal((await manager.get(later.id)).status, "running", "wait_all included or cancelled a later group");
  await manager.cancel(later.id);

  const foreign = await manager.start({ sessionId: "another-session", backend: "native", mode: "single", summary: "foreign" }, async (signal) => {
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    return { text: "unexpected", failed: false };
  });
  await assert.rejects(
    tool.execute("foreign-status", { operation: "status", job_id: foreign.id }, undefined, undefined, ctx),
    /belongs to a different Pi session/,
  );
  await manager.cancel(foreign.id);

  await emit(pi, "session_shutdown", { reason: "quit" }, ctx);
  await rm(root, { recursive: true, force: true });
}

await operationCheck();
console.log("background subagent wait API checks passed");
