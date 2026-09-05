import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import backgroundSubagentExtension, {
  backgroundChildProgress,
  backgroundChildStatus,
  decorateChildResultIdentities,
  getFinalOutput,
  applyNativeAssistantDelta,
  validateBackgroundOperation,
} from "./index.js";
import {
  BackgroundSubagentManager,
  MAX_STATE_BYTES,
  sharedBackgroundSubagentChildTracker,
  sharedBackgroundSubagentManager,
} from "./background.js";
import {
  bindNativeSubagentControl,
  completeSubagentChildren,
  createSubagentChildId,
  reserveSubagentChildren,
} from "./control.js";

const jobId = "subagent-job-0123456789abcdef01234567";
const childId = "subagent-child-0123456789abcdef01234567";
const taskId = "subagent-task-0123456789abcdef01234567";
assert.doesNotThrow(() => validateBackgroundOperation({operation:"resume",task_id:taskId,message:"continue"}));
assert.throws(() => validateBackgroundOperation({operation:"resume",task_id:taskId,cwd:"/other"}), /accepts only/);
assert.throws(() => validateBackgroundOperation({operation:"resume",task_id:taskId,compact:"false"}), /boolean/);
assert.throws(() => validateBackgroundOperation({operation:"resume",task_id:"../session"}), /valid task_id/);
assert.doesNotThrow(() => validateBackgroundOperation({operation:"tasks",limit:20}));
assert.throws(() => validateBackgroundOperation({ operation: "wait_everything" }), /Unknown background subagent operation/);
assert.doesNotThrow(() => validateBackgroundOperation({ operation: "prompt", child_id: childId, message: "continue" }));
assert.doesNotThrow(() => validateBackgroundOperation({ operation: "prompt", child_id: childId, message: "continue", control_mode: "interrupt" }));
assert.throws(() => validateBackgroundOperation({ operation: "prompt", child_id: childId, message: "continue", job_id: jobId }), /cannot include/);
assert.throws(() => validateBackgroundOperation({ operation: "prompt", child_id: childId, message: "" }), /message must be non-empty/);
assert.throws(() => validateBackgroundOperation({ operation: "prompt", child_id: childId, message: "continue", control_mode: "later" }), /control_mode/);
assert.doesNotThrow(() => validateBackgroundOperation({ operation: "result", job_id: jobId, child_id: childId }));
assert.throws(() => validateBackgroundOperation({ operation: "result", job_id: jobId, child: 1, child_id: childId }), /either child or child_id/);
assert.throws(() => validateBackgroundOperation({ operation: "prompt", child_id: childId, message: "continue", wait_for_response: "false" }), /wait_for_response/);
assert.throws(() => validateBackgroundOperation({ operation: "status", job_id: jobId, wait_for_response: false }), /prompt-control fields/);
assert.throws(() => validateBackgroundOperation({ operation: 42 }), /operation must be a non-empty string/);
assert.throws(() => validateBackgroundOperation({ operation: "prompt", child_id: childId, message: "continue", control_mode: 1 }), /control_mode/);
assert.doesNotThrow(() => validateBackgroundOperation({ operation: "list", limit: 50 }));
for (const limit of [0, 51, 1.5, "5", Number.NaN]) {
  assert.throws(() => validateBackgroundOperation({ operation: "list", limit }), /list limit/);
}
assert.doesNotThrow(() => validateBackgroundOperation({ operation: "result", job_id: jobId, child: 8, offset: Number.MAX_SAFE_INTEGER, limit: 48 * 1024 }));
for (const child of [0, 9, 1.5, "1"]) {
  assert.throws(() => validateBackgroundOperation({ operation: "result", job_id: jobId, child }), /result child/);
}
for (const offset of [-1, 1.5, "0", Number.POSITIVE_INFINITY]) {
  assert.throws(() => validateBackgroundOperation({ operation: "result", job_id: jobId, offset }), /result offset/);
}
for (const limit of [3, 48 * 1024 + 1, 4.5, "4"]) {
  assert.throws(() => validateBackgroundOperation({ operation: "result", job_id: jobId, limit }), /result limit/);
}

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

assert.equal(getFinalOutput([
  { role: "assistant", content: [{ type: "text", text: "first " }, { type: "thinking", thinking: "hidden" }, { type: "text", text: "second" }] } as any,
]), "first second", "final assistant output dropped a later text block");

const partial: any = { role: "assistant", content: [] };
for (const delta of [
  { type: "thinking_start", contentIndex: 0 },
  { type: "thinking_delta", contentIndex: 0, delta: "not displayed" },
  { type: "text_start", contentIndex: 1 },
  { type: "text_delta", contentIndex: 1, delta: "hello" },
  { type: "text_delta", contentIndex: 1, delta: " world" },
  { type: "toolcall_start", contentIndex: 3, id: "tool", toolName: "read" },
]) {
  applyNativeAssistantDelta(partial, delta);
  assert.doesNotThrow(() => getFinalOutput([partial]));
  assert(partial.content.every((part: any) => part && typeof part.type === "string"));
}
assert.equal(getFinalOutput([partial]), "hello world");
assert.equal(getFinalOutput([{ role: "assistant", content: [undefined, null, { type: "text", text: "retained" }] } as any]), "retained");
for (const contentIndex of [-1, 1.5, 1000000000]) {
  assert.throws(() => applyNativeAssistantDelta(partial, { type: "text_delta", contentIndex }), /invalid content index/);
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
const preIdentityProgress = backgroundChildProgress(
  { results: [{ child: 1, label: "subagent", exitCode: -1 }] },
  [{ label: "subagent" }],
);
assert.equal(Object.hasOwn(preIdentityProgress[0], "childId"), false, "pre-identity progress fabricated a child identity");

const ordinalChildren = [
  { child: 1, childId: "subagent-child-111111111111111111111111", label: "worker", task: "same" },
  { child: 2, childId: "subagent-child-222222222222222222222222", label: "worker", task: "same" },
];
const ordinalDetails: any = decorateChildResultIdentities({
  results: [{ index: 1, label: "worker", task: "same" }, { index: 0, label: "worker", task: "same" }],
}, ordinalChildren);
assert.deepEqual(ordinalDetails.results.map((result: any) => [result.child, result.child_id]), [
  [2, ordinalChildren[1].childId], [1, ordinalChildren[0].childId],
]);
assert.throws(() => decorateChildResultIdentities({
  results: [{ label: "worker", task: "same" }, { label: "worker", task: "same" }],
}, ordinalChildren, true), /unambiguous launch ordinal/);
assert.throws(() => decorateChildResultIdentities({ results: [{ child: 1 }, { child: 1 }] }, ordinalChildren, true), /duplicate launch ordinal/);
assert.throws(() => decorateChildResultIdentities({ results: [{ index: null }] }, ordinalChildren, true), /invalid launch ordinal/);
assert.throws(() => decorateChildResultIdentities({
  results: [{ child: 2, child_id: ordinalChildren[0].childId }],
}, ordinalChildren, true), /identity and launch ordinal disagree/);

function createPi() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const tools = new Map<string, any>();
  const messages: any[] = [];
  return {
    messages,
    handlers,
    tools,
    on(event: string, handler: (event: any, ctx: any) => any) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
    sendMessage(message: any) { messages.push(message); },
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
  assert.match(tool.parameters.properties.operation.pattern, /prompt/);
  assert.match(tool.parameters.properties.child_id.pattern, /subagent-child/);
  assert.match(tool.parameters.properties.control_mode.pattern, /follow_up/);
  assert(tool.parameters.properties.wait_ms.maximum >= sixHoursMs, "tool schema does not expose hour-scale waits");

  const unsupportedIdentity = {
    childId: createSubagentChildId(), child: 1, label: "subagent", task: "AgentSH-owned work",
  };
  reserveSubagentChildren(sessionId, "agentsh", [unsupportedIdentity]);
  const unsupportedControl = await tool.execute("agentsh-control", {
    operation: "prompt",
    child_id: unsupportedIdentity.childId,
    message: "continue",
  }, undefined, undefined, ctx);
  assert.equal(unsupportedControl.isError, true);
  assert.equal(unsupportedControl.details.failed, true);
  assert.equal(unsupportedControl.details.backend, "agentsh");
  assert.equal(unsupportedControl.details.error_code, "capability");
  assert.match(unsupportedControl.content[0].text, /does not support parent conversation control/);
  completeSubagentChildren(sessionId, [unsupportedIdentity]);

  const nativeIdentity = {
    childId: createSubagentChildId(), child: 1, label: "subagent", task: "native work",
  };
  const nativeCalls: unknown[][] = [];
  reserveSubagentChildren(sessionId, "native", [nativeIdentity]);
  bindNativeSubagentControl(sessionId, nativeIdentity.childId, {
    isActive: () => true,
    async acceptPrompt(mode, message) { nativeCalls.push(["accepted", mode, message]); return { accepted: true, text: "accepted without waiting" }; },
    async control(mode, message, _signal, update) {
      nativeCalls.push([mode, message]);
      update?.("native partial");
      return { text: "native complete" };
    },
  });
  const nativeUpdates: any[] = [];
  const nativeControl = await tool.execute("native-control", {
    operation: "prompt",
    child_id: nativeIdentity.childId,
    message: "continue natively",
    control_mode: "follow_up",
    wait_for_response: true,
  }, undefined, (update: any) => nativeUpdates.push(update), ctx);
  assert.equal(nativeControl.isError, undefined);
  assert.equal(nativeControl.details.failed, false);
  assert.equal(nativeControl.details.backend, "native");
  assert.equal(nativeControl.content[0].text, "native complete");
  assert.deepEqual(nativeCalls, [["follow_up", "continue natively"]]);
  assert.equal(nativeUpdates[0].content[0].text, "native partial");
  const acceptedControl = await tool.execute("native-accepted", { operation: "prompt", child_id: nativeIdentity.childId, message: "keep working" }, undefined, undefined, ctx);
  assert.equal(acceptedControl.details.accepted, true);
  assert.equal(acceptedControl.content[0].text, "accepted without waiting");
  assert.deepEqual(nativeCalls.at(-1), ["accepted", "steer", "keep working"]);
  completeSubagentChildren(sessionId, [nativeIdentity]);

  const managerRoot = path.join(agentDir, "state", "background-subagents-v1");
  const manager = sharedBackgroundSubagentManager(managerRoot);
  const reloadedBackground = await import("./background.js?background-wait-v4-reload");
  assert.equal(reloadedBackground.sharedBackgroundSubagentManager(managerRoot), manager, "same-process reload replaced the V4 manager");
  const tracker = sharedBackgroundSubagentChildTracker();

  const legacyRoot = path.join(agentDir, "state", "legacy-v3-migration");
  let unsafeLegacyCalls = 0;
  let legacyAdoptions = 0;
  const legacyV3Manager = {
    root: legacyRoot,
    async initialize() { unsafeLegacyCalls += 1; throw new Error("V3 initialize must not be reused"); },
    async list() { unsafeLegacyCalls += 1; throw new Error("V3 list must not be reused"); },
    adoptReload(candidateSessionId: string) {
      assert.equal(candidateSessionId, sessionId);
      legacyAdoptions += 1;
      return true;
    },
  };
  const globals = globalThis as any;
  const legacyManagers = globals.__paeBackgroundSubagentManagersV3 instanceof Map
    ? globals.__paeBackgroundSubagentManagersV3
    : new Map();
  globals.__paeBackgroundSubagentManagersV3 = legacyManagers;
  legacyManagers.set(legacyRoot, legacyV3Manager);
  const migratedManager = sharedBackgroundSubagentManager(legacyRoot);
  assert.notEqual(migratedManager, legacyV3Manager, "V4 lookup reused a V3 process-global manager");
  await migratedManager.initialize();
  assert.equal(unsafeLegacyCalls, 0, "V4 migration invoked V3 storage methods");
  assert.equal(migratedManager.activateSession(sessionId), true);
  assert.equal(legacyAdoptions, 1, "V4 migration did not disarm the V3 reload watchdog");
  legacyManagers.delete(legacyRoot);
  const persistedChildId = createSubagentChildId();
  const identityGroup = await manager.start({
    sessionId,
    backend: "native",
    mode: "single",
    summary: "stable child identity",
    children: [{ childId: persistedChildId, label: "subagent", task: "identity check" }],
  }, async () => ({ text: "identity complete", failed: false }));
  const identityRecord = (await manager.wait(identityGroup.id, 500)).record;
  assert.equal(identityRecord.children?.[0]?.childId, persistedChildId);
  const reloadedIdentityManager = new BackgroundSubagentManager(path.join(agentDir, "state", "background-subagents-v1"));
  await reloadedIdentityManager.initialize();
  assert.equal((await reloadedIdentityManager.get(identityGroup.id)).children?.[0]?.childId, persistedChildId);
  const identityStatus = await tool.execute("identity-status", {
    operation: "status", job_id: identityGroup.id,
  }, undefined, undefined, ctx);
  assert.equal(identityStatus.details.children[0].child_id, persistedChildId);
  assert.match(identityStatus.content[0].text, new RegExp(persistedChildId));

  let releaseEscaped!: () => void;
  const escapedText = `\u0001"\\`.repeat(20_000);
  const escapedChildren = Array.from({ length: 8 }, (_unused, index) => ({
    childId: createSubagentChildId(),
    label: `escaped child ${index + 1} "\\`,
    task: `\u0002"\\`.repeat(680),
  }));
  const escapedGroup = await manager.start({
    sessionId,
    backend: "native",
    mode: "parallel",
    summary: `"\\`.repeat(1024),
    children: escapedChildren,
  }, async (_signal, update) => {
    update(escapedText);
    await new Promise<void>((resolve) => { releaseEscaped = resolve; });
    return { text: escapedText, failed: false };
  });
  const escapedStatePath = path.join(managerRoot, "jobs", escapedGroup.id, "state.json");
  let escapedPersisted: any;
  const escapedDeadline = Date.now() + 2_000;
  do {
    escapedPersisted = JSON.parse(await readFile(escapedStatePath, "utf8"));
    if (escapedPersisted.latest !== "(starting…)") break;
    if (Date.now() >= escapedDeadline) throw new Error("escaped progress was not persisted");
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (true);
  assert((await stat(escapedStatePath)).size <= MAX_STATE_BYTES, "running state exceeded its hard serialized byte limit");
  assert.equal(escapedPersisted.status, "running");
  releaseEscaped();
  assert.equal((await manager.wait(escapedGroup.id, 1000)).record.status, "completed");
  assert((await stat(escapedStatePath)).size <= MAX_STATE_BYTES, "terminal state exceeded its hard serialized byte limit");
  const escapedReload = new BackgroundSubagentManager(managerRoot);
  await escapedReload.initialize();
  assert.equal((await escapedReload.get(escapedGroup.id)).status, "completed", "bounded escaped state disappeared on reload");

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
  for (const group of allResult.details.groups) {
    assert.equal(group.children.length, 1, "wait_all omitted structured child metadata");
    assert.equal(group.children[0].child, 1);
    assert.equal(Object.hasOwn(group.children[0], "child_id"), false, "pre-identity wait_all metadata exposed a controllable ID");
  }
  assert.doesNotMatch(allResult.content[0].text, /subagent-child-|undefined/, "pre-identity wait_all text exposed a fabricated ID");
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

  const notificationJob = await manager.start({ sessionId, backend: "native", mode: "single", summary: "visible report" }, async () => ({ text: "completed report body", failed: false }));
  const notificationDeadline = Date.now() + 4000;
  while (!pi.messages.some((message) => message.details?.job_id === notificationJob.id)) {
    assert(Date.now() < notificationDeadline, "completion notification was not delivered");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const completion = pi.messages.find((message) => message.details?.job_id === notificationJob.id);
  assert.equal(completion.display, true, "completion was hidden from transcript");
  assert.match(completion.content, /completed report body/);
  assert.match(completion.content, /operation=result/);
  assert.equal(pi.messages.filter((message) => message.details?.job_id === notificationJob.id).length, 1);

  await emit(pi, "session_shutdown", { reason: "quit" }, ctx);
  await rm(root, { recursive: true, force: true });
}

async function agentSHIdentityCheck() {
  const root = await mkdtemp(path.join(os.tmpdir(), "subagent-child-identity-api-"));
  const agentDir = path.join(root, "agent");
  const sessionId = "background-child-identity-session";
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
  let releaseAdapter!: () => void;
  const previousBridge = (globalThis as any).__AGENTSH_PI__;
  (globalThis as any).__AGENTSH_PI__ = {
    getSupervisorState: () => ({ configured: true, active: true }),
    subagentAdapter: {
      async execute(_toolCallId: string, params: any) {
        await new Promise<void>((resolve) => { releaseAdapter = resolve; });
        return {
          content: [{ type: "text", text: "parallel preview" }],
          details: {
            mode: "parallel",
            // Deliberately duplicate labels and tasks and report in completion
            // order. Only the supervisor's launch ordinal may assign identity.
            results: [
              { child: 2, label: "worker", task: params.tasks[1].task, final: "second child artifact", terminal: { state: "completed" } },
              { child: 1, label: "worker", task: params.tasks[0].task, final: "first child artifact", terminal: { state: "completed" } },
            ],
          },
        };
      },
      detailsFailed: () => false,
      renderCall() {},
      renderResult() {},
    },
  };

  try {
    backgroundSubagentExtension(pi as any);
    await emit(pi, "session_start", { reason: "startup" }, ctx);
    const tool = pi.tools.get("subagent");
    const started = await tool.execute("identity-background", {
      background: true,
      tasks: [{ task: "duplicate source task" }, { task: "duplicate source task" }],
    }, undefined, undefined, ctx);
    assert.equal(started.details.backend, "agentsh");
    assert.deepEqual(started.details.children.map((child: any) => child.child), [1, 2]);
    const [firstChildId, secondChildId] = started.details.children.map((child: any) => child.child_id);
    assert.match(firstChildId, /^subagent-child-[0-9a-f]{24}$/);
    assert.match(secondChildId, /^subagent-child-[0-9a-f]{24}$/);
    assert.notEqual(firstChildId, secondChildId);

    const waitAll = tool.execute("identity-wait-all", { operation: "wait_all", wait_ms: 1000 }, undefined, undefined, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    releaseAdapter();
    const waited = await waitAll;
    assert.equal(waited.details.groups.length, 1);
    assert.deepEqual(
      waited.details.groups[0].children.map((child: any) => [child.child, child.child_id, child.status]),
      [[1, firstChildId, "completed"], [2, secondChildId, "completed"]],
      "wait_all did not preserve stable child metadata",
    );

    const firstByNumber = await tool.execute("identity-result-number", {
      operation: "result", job_id: started.details.job_id, child: 1,
    }, undefined, undefined, ctx);
    assert.match(firstByNumber.content[0].text, /first child artifact/);
    assert.equal(firstByNumber.details.child, 1);
    assert.equal(firstByNumber.details.child_id, firstChildId);

    const secondById = await tool.execute("identity-result-id", {
      operation: "result", job_id: started.details.job_id, child_id: secondChildId,
    }, undefined, undefined, ctx);
    assert.match(secondById.content[0].text, /second child artifact/);
    assert.equal(secondById.details.child, 2);
    assert.equal(secondById.details.child_id, secondChildId);

    const status = await tool.execute("identity-result-metadata", {
      operation: "status", job_id: started.details.job_id,
    }, undefined, undefined, ctx);
    assert.deepEqual(
      status.details.result_children.map((child: any) => [child.child, child.child_id]),
      [[1, firstChildId], [2, secondChildId]],
      "retained artifacts lost their launch identities",
    );
    await emit(pi, "session_shutdown", { reason: "quit" }, ctx);
  } finally {
    if (previousBridge === undefined) delete (globalThis as any).__AGENTSH_PI__;
    else (globalThis as any).__AGENTSH_PI__ = previousBridge;
    await rm(root, { recursive: true, force: true });
  }
}

await operationCheck();
await agentSHIdentityCheck();
console.log("background subagent wait API checks passed");
