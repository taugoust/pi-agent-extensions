process.env.PI_SUPERVISED = "1";
const module = await import("./out/background-job/index.js");
const extension = module.default;
const tools = new Map();
const commands = new Map();
const handlers = new Map();
const pi = {
  registerTool(tool) {
    tools.set(tool.name, tool);
  },
  registerCommand(name, command) {
    commands.set(name, command);
  },
  on(name, handler) {
    const previous = handlers.get(name);
    handlers.set(
      name,
      previous
        ? async (...args) => {
            await previous(...args);
            await handler(...args);
          }
        : handler,
    );
  },
  sendMessage() {},
};
extension(pi);
if (tools.size !== 1 || !tools.has("background_job"))
  throw new Error("extension did not register exactly one background_job tool");
if (!commands.has("background-jobs"))
  throw new Error("extension did not register its human job manager");
let blocked = false;
try {
  await tools
    .get("background_job")
    .execute("start-1", { action: "start", command: "printf forbidden" }, undefined, undefined, {
      cwd: process.cwd(),
      sessionManager: {},
    });
} catch (error) {
  blocked = String(error).includes("refusing native");
}
if (!blocked)
  throw new Error("full AgentSH selection did not fail closed before native background execution");

delete process.env.PI_SUPERVISED;
globalThis.__paeCommandAuthorityV1 = { protocol: 1, active: true, consume: () => false };
const nativeExtension = (await import("./out/background-job/index.js?native-contract")).default;
const nativeTools = new Map();
nativeExtension({
  registerTool(tool) {
    nativeTools.set(tool.name, tool);
  },
  registerCommand() {},
  on() {},
  sendMessage() {},
});
let receiptBlocked = false;
try {
  await nativeTools
    .get("background_job")
    .execute(
      "start-mutated",
      { action: "start", command: "printf mutated" },
      undefined,
      undefined,
      {
        cwd: process.cwd(),
        sessionManager: { getSessionId: () => "native-session" },
      },
    );
} catch (error) {
  receiptBlocked = String(error).includes("authorization receipt");
}
if (!receiptBlocked)
  throw new Error("background start was not bound to an exact Permission Gate receipt");
delete globalThis.__paeCommandAuthorityV1;

const reloadContext = {
  cwd: process.cwd(),
  hasUI: false,
  isIdle: () => true,
  sessionManager: { getSessionId: () => "reload-session" },
};
let verificationTools = ["read"];
const loadHarness = async (suffix) => {
  const tools = new Map();
  const handlers = new Map();
  const loaded = (await import(`./out/background-job/index.js?${suffix}`)).default;
  loaded({
    getActiveTools() {
      return verificationTools;
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    on(name, handler) {
      const previous = handlers.get(name);
      handlers.set(
        name,
        previous
          ? async (...args) => {
              await previous(...args);
              await handler(...args);
            }
          : handler,
      );
    },
    sendMessage() {},
  });
  await handlers.get("session_start")({}, reloadContext);
  return { tool: tools.get("background_job"), handlers };
};

const terminalOutput = async (execute, job_id) => {
  const deadline = Date.now() + 5000;
  for (;;) {
    const snapshot = await execute({ action: "yield", job_id });
    if (snapshot.terminate !== true) throw new Error("yield lost the termination signal");
    if (["completed", "failed", "cancelled", "lost"].includes(snapshot.details?.jobs?.[0]?.status))
      return await execute({ action: "output", job_id, lines: 100 });
    if (Date.now() >= deadline) throw new Error("Test job did not finish");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
const beforeReload = await loadHarness("before-reload");
const assert = (await import("node:assert/strict")).default;
const { initialVerification, runVerification, recoverVerification } =
  await import("./out/subagent/acceptance.js");
const controller = globalThis.__paeLocalJobControllerV1;
await assert.rejects(controller.startVerification("readonly", "printf forbidden"), /cannot expand/);
verificationTools = ["bash"];
await assert.rejects(
  controller.startVerification("no-permission", "printf forbidden"),
  /permission authority unavailable/,
);
const receipts = new Map();
globalThis.__paeCommandAuthorityV1 = {
  protocol: 1,
  active: true,
  async authorize(id, command, cwd, owner) {
    assert.equal(owner, "reload-session");
    assert.equal(cwd, reloadContext.cwd);
    receipts.set(id, { command, cwd });
  },
  consume(id, command, cwd) {
    const receipt = receipts.get(id);
    receipts.delete(id);
    return receipt?.command === command && receipt.cwd === cwd;
  },
};
const { mkdtemp, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
// Use a small stable cwd for workspace binding, while the runtime itself is
// authoritatively bound to reloadContext.cwd; the test context has that cwd.
const verifyCwd = await mkdtemp(join(tmpdir(), "runtime-gate-"));
const originalCwd = reloadContext.cwd;
reloadContext.cwd = verifyCwd;
const manifestDir = await mkdtemp(join(tmpdir(), "gate-worker-"));
const { TuiWorkerStore } = await import("./out/subagent/tui-worker-store.js");
const workerStore = new TuiWorkerStore(manifestDir);
const verifyIdentity = {
  ownerSessionId: "parent",
  taskId: "task-test",
  childId: "subagent-child-" + "b".repeat(24),
  attempt: 1,
  workerEpoch: "c".repeat(32),
  runtimeId: "runtime-test",
  cwd: verifyCwd,
};
workerStore.writeManifest({
  protocol: 1,
  ...verifyIdentity,
  groupId: "subagent-job-" + "a".repeat(24),
  controlToken: "d".repeat(64),
  controlSocket: join(manifestDir, "control.sock"),
  sessionFile: join(manifestDir, "session.jsonl"),
  presentation: "background",
  placement: {
    socketPath: "/tmp/fixture-tmux",
    serverEpoch: "1:2",
    sessionId: "$1",
    windowId: "@1",
    paneId: "%1",
    ownershipNonce: "e".repeat(64),
  },
});
const previousManifest = process.env.PI_TUI_WORKER_MANIFEST;
process.env.PI_TUI_WORKER_MANIFEST = workerStore.path("manifest.json");
reloadContext.sessionManager.getSessionFile = () => join(manifestDir, "session.jsonl");
try {
  const supervised = {
    start: (id, command, signal) => controller.startVerification(id, command, signal),
    execute: (...args) => controller.execute(...args),
    resolve: (...args) => controller.resolveVerification(...args),
    attest: (...args) => controller.attestVerification(...args),
  };
  for (const code of [0, 7]) {
    const gates = [
      { command: `printf ' literal stdout\\n'; printf ' literal stderr\\n' >&2; exit ${code}` },
    ];
    const record = initialVerification(verifyIdentity, gates);
    await runVerification(
      record,
      gates,
      {
        start: (id, command, signal) => controller.startVerification(id, command, signal),
        execute: (...args) => controller.execute(...args),
        resolve: (...args) => controller.resolveVerification(...args),
        attest: async (run, identity) => {
          assert.equal(
            await controller.attestVerification({ ...run, stdout: "fabricated" }, identity),
            false,
          );
          assert.equal(
            await controller.attestVerification(run, { ...identity, attempt: 2 }),
            false,
          );
          return await controller.attestVerification(run, identity);
        },
      },
      () => {},
    );
    assert.equal(record.status, code === 0 ? "passed" : "failed", JSON.stringify(record));
    assert.equal(record.runs[0].exitCode, code);
    assert.equal(record.runs[0].stdout, " literal stdout\n");
    assert.equal(record.runs[0].stderr, " literal stderr\n");
  }
  const authorize = globalThis.__paeCommandAuthorityV1.authorize;
  globalThis.__paeCommandAuthorityV1.authorize = async () => {
    throw new Error("explicit permission denial");
  };
  const deniedGates = [{ command: "printf MUST_NOT_RUN" }],
    denied = initialVerification(verifyIdentity, deniedGates);
  await runVerification(denied, deniedGates, supervised, () => {});
  assert.equal(denied.status, "unavailable");
  assert.equal(denied.runs[0].dispatchState, "not-dispatched");
  globalThis.__paeCommandAuthorityV1.authorize = authorize;
  // A real supervised process exists even when the launch receipt is lost.
  const lostGates = [{ command: "printf 'before lost receipt'; sleep 30", timeoutMs: 10000 }];
  const lost = initialVerification(verifyIdentity, lostGates);
  await runVerification(
    lost,
    lostGates,
    {
      ...supervised,
      start: async (...args) => {
        await supervised.start(...args);
        throw new Error("receipt lost after dispatch");
      },
    },
    () => {},
  );
  assert.notEqual(lost.status, "passed");
  assert.equal(lost.runs[0].dispatchState, "cleaned", JSON.stringify(lost));
  // Failed output retrieval must retain the real terminal job and its logs.
  const heldGates = [{ command: "printf 'retained literal evidence'" }];
  const held = initialVerification(verifyIdentity, heldGates);
  await runVerification(
    held,
    heldGates,
    {
      ...supervised,
      execute: async (id, params, signal) =>
        params.action === "output"
          ? { isError: true, details: { streams: { available: false } } }
          : supervised.execute(id, params, signal),
    },
    () => {},
  );
  assert.equal(held.status, "unavailable");
  assert.equal(held.runs[0].dispatchState, "cleanup-pending");
  const heldStatus = await controller.execute("retained-evidence", {
    action: "status",
    job_id: held.runs[0].jobId,
  });
  assert.equal(heldStatus.details.status, "completed");
  await recoverVerification(held, supervised, () => {});
  assert.equal(held.runs[0].stdout, "retained literal evidence");
  assert.equal(held.runs[0].dispatchState, "cleaned");
  assert.equal(
    (await controller.execute("no-orphans", { action: "list", limit: 50 })).details.jobs.length,
    0,
  );
} finally {
  reloadContext.cwd = originalCwd;
  delete globalThis.__paeCommandAuthorityV1;
  if (previousManifest === undefined) delete process.env.PI_TUI_WORKER_MANIFEST;
  else process.env.PI_TUI_WORKER_MANIFEST = previousManifest;
  delete reloadContext.sessionManager.getSessionFile;
  await rm(verifyCwd, { recursive: true, force: true });
  await rm(manifestDir, { recursive: true, force: true });
}
const started = await beforeReload.tool.execute(
  "reload-start",
  { action: "start", command: "printf 'before-reload\\n'; sleep 1; printf 'after-reload\\n'" },
  undefined,
  undefined,
  reloadContext,
);
if (!started.details?.job_id || started.details.status !== "running")
  throw new Error("reload fixture did not start");
const oldReadonly = globalThis.__paeHarnessReadOnlyV1;
if (oldReadonly?.protocol !== 1 || oldReadonly.jobs?.sessionId !== "reload-session")
  throw new Error("read-only jobs API was not published for the owner session");
const ownedSnapshot = await oldReadonly.jobs.list({ sessionId: "reload-session", limit: 10 });
if (!ownedSnapshot.items.some((job) => job.jobId === started.details.job_id))
  throw new Error("read-only list omitted owner job");
await new Promise((resolve) => setTimeout(resolve, 300));
const ownerOutput = await oldReadonly.jobs.output({
  sessionId: "reload-session",
  jobId: started.details.job_id,
  maxBytes: 100,
});
if (!ownerOutput.item?.text.includes("before-reload"))
  throw new Error("read-only output omitted job output");
let foreignOutputBlocked = false;
try {
  await oldReadonly.jobs.output({ sessionId: "other-session", jobId: started.details.job_id });
} catch {
  foreignOutputBlocked = true;
}
if (!foreignOutputBlocked) throw new Error("read-only output accepted foreign session");
await beforeReload.handlers.get("session_shutdown")({ reason: "reload" }, reloadContext);

const afterReload = await loadHarness("after-reload");
let staleServiceRejected = false;
try {
  await oldReadonly.jobs.list({ sessionId: "reload-session", limit: 10 });
} catch {
  staleServiceRejected = true;
}
if (!staleServiceRejected) throw new Error("stale read-only service survived reload");
const recovered = await terminalOutput(
  (params) =>
    afterReload.tool.execute("reload-output", params, undefined, undefined, reloadContext),
  started.details.job_id,
);
const broker = globalThis.__paeParentJobBrokerV1;
const { resolveLocalPlacement } = await import("./out/background-job/tmux.js");
const identity = {
  sessionId: "reload-session",
  childId: "subagent-child-111111111111111111111111",
  cwd: process.cwd(),
  placement: await resolveLocalPlacement(process.env.TEST_TMUX),
};
let placementBlocked = false;
try {
  await broker.execute({ ...identity, placement: undefined }, "no-placement", {
    action: "start",
    command: ":",
  });
} catch (error) {
  placementBlocked = /trusted caller tmux placement/.test(String(error));
}
if (!placementBlocked) throw new Error("delegated start guessed the parent pane");
const childJob = await broker.execute(identity, "child-start", {
  action: "start",
  command: "printf child-owned",
});
const childInventory = await broker.execute(identity, "child-yield-all", { action: "yield" });
if (
  childInventory.details.jobs.length !== 1 ||
  childInventory.details.jobs[0].job_id !== childJob.details.job_id
)
  throw new Error("broker yield crossed child ownership boundary");
const childYield = await broker.execute(identity, "child-yield", {
  action: "yield",
  job_id: childJob.details.job_id,
});
if (childYield.terminate !== true) throw new Error("broker yield lost termination signal");
const childDone = await terminalOutput(
  (params) => broker.execute(identity, "child-output", params),
  childJob.details.job_id,
);
if (childDone.details.status !== "completed") throw new Error("broker job did not complete");
let foreignBlocked = false;
try {
  await broker.execute(
    { ...identity, childId: "subagent-child-222222222222222222222222" },
    "foreign",
    { action: "output", job_id: childJob.details.job_id },
  );
} catch {
  foreignBlocked = true;
}
if (!foreignBlocked) throw new Error("sibling read another child's job");
let denied = false;
try {
  await broker.execute(
    identity,
    "denied-start",
    { action: "start", command: "printf forbidden" },
    undefined,
    async () => {
      throw new Error("denied");
    },
  );
} catch {
  denied = true;
}
if (!denied) throw new Error("broker ignored command authorization");
const parentView = await afterReload.tool.execute(
  "parent-view",
  { action: "status", job_id: childJob.details.job_id },
  undefined,
  undefined,
  reloadContext,
);
if (parentView.details.child_id !== identity.childId)
  throw new Error("parent lost child job ownership metadata");
const reaped = await broker.execute(identity, "child-reap", {
  action: "reap",
  job_id: childJob.details.job_id,
});
if (!reaped.details.reaped) throw new Error("explicit reap tool action failed");
const retained = await afterReload.tool.execute(
  "parent-retained",
  { action: "status", job_id: started.details.job_id },
  undefined,
  undefined,
  reloadContext,
);
if (
  retained.details.status !== "completed" ||
  retained.details.retention !== "five-minutes-after-output-retrieval"
)
  throw new Error("child reap removed sibling job or omitted retention policy");
await afterReload.handlers.get("session_shutdown")({ reason: "quit" }, reloadContext);
if (recovered.details?.status !== "completed" || recovered.details?.exit_code !== 0) {
  throw new Error(
    "session reload did not recover the running background job: " +
      JSON.stringify(recovered.details) +
      " " +
      JSON.stringify(recovered.content),
  );
}
const recoveredText = recovered.content?.find((part) => part.type === "text")?.text ?? "";
if (!recoveredText.includes("before-reload") || !recoveredText.includes("after-reload")) {
  throw new Error("session reload lost background job output");
}
