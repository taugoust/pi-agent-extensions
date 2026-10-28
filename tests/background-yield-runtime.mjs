// Offline stock-Pi runtime integration for terminate + real quiet-state producers.
// Usage: node tests/background-yield-runtime.mjs PI_MONOREPO_DIR [EXPECTED_NODE_VERSION]
// Optionally set PI_YIELD_EVIDENCE_PATH to retain the JSON evidence separately.
// Uses stock Session.steer as the child-prompt transport; native/RPC transport is covered separately.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
const sdkRoot = process.argv[2] ?? process.env.PI_STOCK_SDK_ROOT;
assert.ok(sdkRoot, "Supply the stock Pi 1.4.0 SDK directory (PI_MONOREPO_DIR or PI_STOCK_SDK_ROOT)");
const base = resolve(sdkRoot);
const root = await mkdtemp(join(tmpdir(), "background-yield-runtime-"));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_TUI_WORKER_STATE_ROOT = join(root, "tui-workers");
process.env.XDG_STATE_HOME = join(root, "state");
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.XDG_CACHE_HOME = join(root, "cache");
for (const key of [
  "PI_AGENTSH_SOCKET",
  "PI_AGENTSH_TOKEN",
  "AGENTSH_SOCKET",
  "AGENTSH_TOKEN",
  "PI_SUBAGENT_PERMISSION_SOCKET",
  "PI_SUBAGENT_PERMISSION_TOKEN",
  "PI_AGENTSH_ENABLE",
  "PI_AGENTSH_MOCK_SUPERVISOR",
  "PI_AGENTSH_REMOTE",
  "PI_AGENTSH_READ_MODE",
  "AGENTSH_SESSION_SUPERVISOR",
  "AGENTSH_APPROVAL_UI_SOCKET",
  "AGENTSH_PERMISSION_GATE_SOCKET",
  "AGENTSH_CHILD_CAPABILITY",
])
  delete process.env[key];
if (process.argv[3]) assert.equal(process.version, process.argv[3]);
const {
  AgentSessionRuntime,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
} = await import(base + "/dist/index.js");
const { createAssistantMessageEventStream } = await import(
  base + "/node_modules/@earendil-works/pi-ai/dist/index.js"
);
const { createJiti } = createRequire(join(base, "package.json"))("jiti");
process.env.PAE_QUIET_STATE_DISABLED = "0";
globalThis.fetch = () => {
  throw Error("NETWORK FORBIDDEN");
};
const jiti = createJiti(import.meta.url, {
  alias: {
    "@mariozechner/pi-coding-agent": join(base, "dist/index.js"),
    "@earendil-works/pi-coding-agent": join(base, "dist/index.js"),
    "@mariozechner/pi-ai": join(
      base,
      "node_modules/@earendil-works/pi-ai/dist/index.js",
    ),
    "@mariozechner/pi-tui": join(
      base,
      "node_modules/@earendil-works/pi-tui/dist/index.js",
    ),
    "@sinclair/typebox": join(base, "node_modules/typebox/build/index.mjs"),
  },
});
const { installQuietState, notifyParent } = await jiti.import(
  "../shared/quiet-state.ts",
);
const { default: installSubagent } = await jiti.import("../subagent/index.ts");
const { default: installBackgroundJob } = await jiti.import("../background-job/index.ts");
assert.equal(VERSION, "1.4.0");
const log = [];
const sessions = {};
const quietDeliveries = [];
let parentCalls = 0,
  childCalls = 0,
  mixedCalls = 0,
  jobYieldCalls = 0,
  queuedCalls = 0,
  childDone = false,
  childToolActive = false,
  parentCtx,
  busyCtx,
  quietState,
  releaseChild;
const childGate = new Promise((r) => (releaseChild = r));
let releaseBusy,
  busyActive = false;
const busyGate = new Promise((r) => (releaseBusy = r));
const childId = "subagent-child-0123456789abcdef01234567";
let ownerId = "";
const model = {
  id: "fake",
  name: "fake",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 1000,
};
const waitForCalls = (count, label) =>
  new Promise((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(Error(`${label}: timed out at ${parentCalls} calls`)),
      5000,
    );
    const poll = () => {
      if (parentCalls >= count) {
        clearTimeout(timer);
        resolvePromise();
      } else setTimeout(poll, 10);
    };
    poll();
  });
const provider = (role) => ({
  api: "openai-completions",
  baseUrl: "https://example.invalid",
  apiKey: "fake",
  models: [model],
  streamSimple: (m) => {
    const stream = createAssistantMessageEventStream();
    const n =
      role === "parent"
        ? ++parentCalls
        : role === "mixed"
          ? ++mixedCalls
          : role === "job-yield" ? ++jobYieldCalls : role === "queued" ? ++queuedCalls : ++childCalls;
    log.push(`${role}:dispatch:${n}`);
    let content,
      stopReason = "stop";
    if (["parent", "mixed", "job-yield", "queued"].includes(role) && n === 1) {
      content = [
        { type: "toolCall", id: "yield", name: "yield_fixture", arguments: {} },
        ...(role === "mixed"
          ? [
              {
                type: "toolCall",
                id: "sibling",
                name: "sibling_fixture",
                arguments: {},
              },
            ]
          : []),
      ];
      stopReason = "toolUse";
    } else if (role === "parent" && n === 4) {
      content = [
        {
          type: "toolCall",
          id: "answer",
          name: "answer_fixture",
          arguments: {},
        },
      ];
      stopReason = "toolUse";
    } else if (role === "parent" && n === 6) {
      content = [
        { type: "toolCall", id: "busy", name: "busy_fixture", arguments: {} },
      ];
      stopReason = "toolUse";
    } else if (role === "child" && n === 1) {
      content = [
        {
          type: "toolCall",
          id: "guidance",
          name: "guidance_fixture",
          arguments: {},
        },
      ];
      stopReason = "toolUse";
    } else content = [{ type: "text", text: "done" }];
    queueMicrotask(() =>
      stream.end({
        role: "assistant",
        api: m.api,
        provider: m.provider,
        model: m.id,
        content,
        stopReason,
        timestamp: Date.now(),
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      }),
    );
    return stream;
  },
});
let productionSubagentTool, productionJobTool;
const successfulYields = new Set();
const makeFactory = (role) => (pi) => {
  pi.registerProvider("offline", provider(role));
  if (["parent", "mixed", "job-yield", "queued"].includes(role)) {
    const proxy = new Proxy(pi, {
      get(target, key, receiver) {
        if (key === "registerTool")
          return (tool) => {
            if (tool.name === "subagent") productionSubagentTool = tool;
            if (tool.name === "background_job") productionJobTool = tool;
            return target.registerTool(tool);
          };
        if (key === "sendMessage")
          return (message, options) => {
            if (message?.customType === "harness-state")
              quietDeliveries.push(options?.deliverAs);
            return target.sendMessage(message, options);
          };
        return Reflect.get(target, key, receiver);
      },
    });
    if (role === "job-yield") installBackgroundJob(proxy);
    else installSubagent(proxy);
    if (role === "parent") {
      quietState = installQuietState(proxy, 5);
      pi.on("session_start", (_e, ctx) => { parentCtx = ctx; });
    }
  }
  pi.registerTool({
    name: "yield_fixture",
    label: "yield",
    description: "offline production yield",
    parameters: { type: "object", properties: {} },
    async execute(_id, _args, _signal, _update, ctx) {
      log.push(`${role}:yield`);
      const tool = role === "job-yield" ? productionJobTool : productionSubagentTool;
      assert.ok(tool, "production tool registered");
      const result = await tool.execute(
        `yield-${role}`,
        role === "job-yield" ? { action: "yield" } : { operation: "yield" },
        undefined,
        undefined,
        ctx,
      );
      assert.equal(
        result.terminate,
        true,
        "production yield must terminate the current run",
      );
      assert.equal(result.details.operation ?? result.details.action, "yield");
      assert.notEqual(result.accepted_delivery, true);
      assert.notEqual(result.details.accepted_delivery, true);
      successfulYields.add(role);
      if (role === "queued") assert.equal(await sessions.queued.followUp("user queued during yield"), "queued");
      return result;
    },
  });
  pi.registerTool({
    name: "sibling_fixture",
    label: "sibling",
    description: "mixed-batch sibling",
    parameters: { type: "object", properties: {} },
    async execute() {
      log.push("mixed:sibling");
      return { content: [{ type: "text", text: "sibling ran" }], details: {} };
    },
  });
  pi.registerTool({
    name: "answer_fixture",
    label: "answer guidance",
    description: "reply using prompt control",
    parameters: { type: "object", properties: {} },
    async execute() {
      log.push("parent:answer");
      assert.equal(
        childDone,
        false,
        "parent must answer while child prompt is still running",
      );
      assert.equal(
        childToolActive,
        true,
        "child guidance tool remains active until parent reply",
      );
      log.push(
        "steer:" + String(await sessions.child.steer("reply from parent")),
      );
      releaseChild();
      return { content: [{ type: "text", text: "replied" }], details: {} };
    },
  });
  pi.registerTool({
    name: "busy_fixture",
    label: "busy parent",
    description: "hold parent while wake updates queue",
    parameters: { type: "object", properties: {} },
    async execute(_id, _args, _signal, _update, ctx) {
      busyCtx = ctx;
      log.push(`parent:busy-enter:idle=${ctx.isIdle()}`);
      busyActive = true;
      await busyGate;
      busyActive = false;
      log.push("parent:busy-release");
      return { content: [{ type: "text", text: "released" }], details: {} };
    },
  });
  pi.registerTool({
    name: "guidance_fixture",
    label: "request guidance then wait",
    description: "real quiet producer",
    parameters: { type: "object", properties: {} },
    async execute(_id, _args, _signal, _update, ctx) {
      childToolActive = true;
      log.push("child:guidance-request");
      const r = notifyParent(ownerId, childId, "guidance-tool-call", {
        message: "Need a decision",
        requires_guidance: true,
      });
      assert.equal(r.details.accepted, true);
      await childGate;
      childToolActive = false;
      log.push("child:released");
      return { content: [{ type: "text", text: "answered" }], details: {} };
    },
  });
};
const create = async (role) => {
  const cwd = join(root, role);
  const sm = SettingsManager.inMemory({
    defaultProvider: "offline",
    defaultModel: "fake",
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const mr = await ModelRuntime.create({
    authPath: join(cwd, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: root,
    settingsManager: sm,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [makeFactory(role)],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir: root,
    modelRuntime: mr,
    settingsManager: sm,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    noTools: "builtin",
  });
  const owner = new AgentSessionRuntime(
    session,
    {
      cwd,
      agentDir: root,
      modelRuntime: mr,
      settingsManager: sm,
      resourceLoader: loader,
      diagnostics: [],
    },
    async () => {
      throw Error("no replacement");
    },
  );
  await session.bindExtensions({
    onError: (e) => {
      throw Error(JSON.stringify(e));
    },
  });
  await session.setModel(mr.getModel("offline", "fake"));
  sessions[role] = session;
  return { session, owner };
};
let p, c, m, j, q, restoreDateNow;
try {
  j = await create("job-yield");
  await sessions["job-yield"].prompt("yield with the production background_job tool");
  assert.equal(jobYieldCalls, 1, "sole production background_job yield ends the run");
  assert.ok(successfulYields.has("job-yield"), "background_job yield must succeed, not return a tool error");
  m = await create("mixed");
  await sessions.mixed.prompt("mixed yield and sibling");
  assert.equal(mixedCalls, 2, "mixed yield is not sole and must continue");
  assert.ok(log.includes("mixed:sibling"));
  assert.ok(successfulYields.has("mixed"), "mixed batch must contain a successful terminating yield");
  q = await create("queued");
  await sessions.queued.prompt("yield while user follow-up is queued");
  assert.ok(successfulYields.has("queued"));
  assert.equal(queuedCalls, 2, "queued user input may continue after a sole terminating yield");
  p = await create("parent");
  c = await create("child");
  ownerId = sessions.parent.sessionManager.getSessionId();
  // The real parent extension context is captured at session_start via a minimal extension listener.
  // quietState enqueue is driven by production notifyParent; this yields a real two-session guidance wake.
  await sessions.parent.prompt("yield before worker guidance");
  assert.equal(
    parentCalls,
    1,
    "sole production-shaped terminate:true must end the current parent run",
  );
  await sessions.parent.prompt("queued user message after yield");
  assert.equal(
    parentCalls,
    2,
    "a separate queued user prompt starts its own run",
  );
  const processResult = spawnSync(
    process.execPath,
    ["-e", 'process.stdout.write("offline-job-ok")'],
    { encoding: "utf8" },
  );
  assert.equal(processResult.status, 0);
  assert.equal(processResult.stdout, "offline-job-ok");
  const jobUpdate = {
    kind: "job",
    id: "job-offline-child-process",
    state: "completed",
    completion: true,
  };
  assert.ok(parentCtx);
  assert.equal(quietState.enqueue(parentCtx, jobUpdate), true);
  assert.equal(
    quietState.enqueue(parentCtx, jobUpdate),
    true,
    "duplicate terminal update is coalesced",
  );
  await waitForCalls(3, "process completion wake");
  await sessions.parent.waitForIdle();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(
    parentCalls,
    3,
    "duplicate process completion schedules exactly one extra model call",
  );
  const childRun = sessions.child.prompt("request guidance").then(() => {
    childDone = true;
  });
  // Parent must have been registered in notifyParent ownership namespace; discover exact SDK session id.
  const parentSid = sessions.parent.sessionManager.getSessionId();
  assert.equal(
    parentSid,
    ownerId,
    "offline fixture session id must match notifyParent owner",
  );
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(
      () =>
        reject(Error(`guidance wake did not arrive: ${JSON.stringify(log)}`)),
      5000,
    );
    const poll = () => {
      if (parentCalls >= 4) {
        clearTimeout(timer);
        resolvePromise();
      } else setTimeout(poll, 10);
    };
    poll();
  });
  assert.ok(log.includes("parent:answer"));
  assert.ok(log.indexOf("parent:answer") < log.indexOf("child:released"));
  await childRun;
  await sessions.parent.waitForIdle();
  assert.ok(parentCalls >= 2);
  assert.equal(log.filter((x) => x === "child:released").length, 1);
  const childCompletion = {
    kind: "subagent",
    id: "offline-child-terminal",
    job_id: "subagent-job-0123456789abcdef01234567",
    child_id: childId,
    state: "completed",
    completion: true,
    through_sequence: 2,
  };
  assert.equal(quietState.enqueue(parentCtx, childCompletion), true);
  assert.equal(quietState.enqueue(parentCtx, childCompletion), true);
  await waitForCalls(6, "child completion wake");
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(Error("parent busy tool did not start")),
      5000,
    );
    const poll = () => {
      if (busyActive) {
        clearTimeout(timer);
        resolvePromise();
      } else setTimeout(poll, 10);
    };
    poll();
  });
  assert.equal(
    busyCtx.isIdle(),
    false,
    "parent context must report the held tool as active",
  );
  const queuedJob = {
    kind: "job",
    id: "job-arrived-while-parent-busy",
    state: "completed",
    completion: true,
  };
  assert.equal(quietState.enqueue(busyCtx, queuedJob), true);
  assert.equal(quietState.enqueue(busyCtx, queuedJob), true);
  restoreDateNow = Date.now;
  Date.now = () => restoreDateNow() + 31_000;
  assert.equal(
    notifyParent(ownerId, childId, "guidance-while-parent-busy", {
      message: "One more decision",
      requires_guidance: true,
    }).details.accepted,
    true,
  );
  await new Promise((r) => setTimeout(r, 1_200));
  assert.ok(
    quietDeliveries.includes("steer"),
    `guidance is sent as steer while parent is busy (${JSON.stringify(quietDeliveries)})`,
  );
  assert.ok(
    parentCtx.sessionManager
      .getBranch()
      .some(
        (entry) =>
          entry.type === "custom_message" &&
          entry.customType === "harness-state",
      ),
    "busy parent retains guidance as queued input",
  );
  assert.equal(
    parentCalls,
    6,
    "busy parent must queue completions/guidance without dispatching a model call",
  );
  releaseBusy();
  await sessions.parent.waitForIdle();
  await waitForCalls(7, "busy-queued wake");
  assert.equal(parentCalls, 7, "queued guidance resumes the parent once");
  // Completion is a separate event from guidance. The existing completion
  // producer waits for idle, so it may legitimately start one later run.
  await waitForCalls(8, "completion retained while parent was busy");
  await sessions.parent.waitForIdle();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1100));
  assert.equal(parentCalls, 8, "duplicate busy completion must not schedule a ninth call");
  assert.ok(
    log.indexOf("parent:busy-release") <
      log.findIndex((x) => x === "parent:dispatch:7"),
  );
  const evidence = {
    version: VERSION,
    node: process.version,
    scenarios: {
      productionYieldResultInspected: true,
      productionBackgroundJobYieldTerminates: true,
      mixedYieldSucceeded: true,
      queuedUserWorkContinues: true,
      soleTerminate: true,
      mixedBatchContinues: true,
      queuedUserPromptAfterYield: true,
      realChildProcessJobCompletion: true,
      duplicateCompletionCoalesced: true,
      realNotifyParentGuidance: true,
      realChildCompletionWake: true,
      parentReplyViaSteer: true,
      childToolActiveAtReply: true,
      busyParentQueuesWithoutDispatch: true,
      postReleaseWake: true,
      busyCompletionDeliveredAfterRelease: true,
      busyGuidanceDeliveredAsSteer: true,
    },
    quietDeliveries,
    parentCalls,
    childCalls,
    log,
  };
  if (process.env.PI_YIELD_EVIDENCE_PATH) {
    await writeFile(process.env.PI_YIELD_EVIDENCE_PATH, JSON.stringify(evidence, null, 2) + "\n");
  }
  console.log(JSON.stringify(evidence));
} finally {
  if (restoreDateNow) Date.now = restoreDateNow;
  releaseChild();
  releaseBusy();
  await Promise.allSettled([
    sessions.parent?.waitForIdle(),
    sessions.child?.waitForIdle(),
  ]);
  await q?.owner.dispose();
  sessions.queued?.dispose();
  await j?.owner.dispose();
  sessions["job-yield"]?.dispose();
  await m?.owner.dispose();
  await p?.owner.dispose();
  await c?.owner.dispose();
  sessions.mixed?.dispose();
  sessions.parent?.dispose();
  sessions.child?.dispose();
  await rm(root, { recursive: true, force: true });
}
