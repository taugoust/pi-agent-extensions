import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workerExtension, { isAcceptedGoalCompletion } from "./tui-worker-extension.ts";
import { TuiWorkerStore } from "./tui-worker-store.ts";
import { processIdentity } from "./tui-worker-tmux.ts";
import { callTuiWorker, awaitTuiWorkerVerification } from "./tui-worker-client.ts";
import type { TuiWorkerManifest } from "../shared/tui-worker-protocol.ts";

test("worker trust skips only unresolved asks without persisting trust or loading project policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-trust-policy-"));
  const config = join(root, "config"), cwd = join(root, "project");
  const previous = { manifest: process.env.PI_TUI_WORKER_MANIFEST, config: process.env.PI_CODING_AGENT_DIR };
  try {
    await mkdir(config); await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
    process.env.PI_TUI_WORKER_MANIFEST = join(root, "manifest.json");
    process.env.PI_CODING_AGENT_DIR = config;
    const handlers = new Map<string, Function>();
    workerExtension({ registerTool() {}, on: (name: string, fn: Function) => handlers.set(name, fn) } as any);
    const decide = () => handlers.get("project_trust")!({ cwd });
    assert.deepEqual(decide(), { trusted: "no", remember: false });
    await assert.rejects(readFile(join(config, "trust.json")), { code: "ENOENT" });
    for (const policy of ["always", "never"]) {
      await writeFile(join(config, "settings.json"), JSON.stringify({ defaultProjectTrust: policy }));
      assert.deepEqual(decide(), { trusted: "undecided" });
    }
    await writeFile(join(config, "settings.json"), JSON.stringify({ defaultProjectTrust: "ask" }));
    for (const saved of [true, false]) {
      new ProjectTrustStore(config).set(root, saved);
      const before = await readFile(join(config, "trust.json"), "utf8");
      assert.deepEqual(decide(), { trusted: "undecided" });
      assert.equal(await readFile(join(config, "trust.json"), "utf8"), before);
    }
  } finally {
    if (previous.manifest === undefined) delete process.env.PI_TUI_WORKER_MANIFEST; else process.env.PI_TUI_WORKER_MANIFEST = previous.manifest;
    if (previous.config === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.config;
    await rm(root, { recursive: true, force: true });
  }
});

test("verification tools await final verdict and abort only a flight they started", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-tool-verification-"));
  const cwd = join(root, "workspace"), workerDirectory = join(root, "workers", "a".repeat(24));
  await mkdir(cwd); await mkdir(workerDirectory, { recursive: true, mode: 0o700 });
  const store = new TuiWorkerStore(workerDirectory);
  const sessionFile = store.path("session.jsonl");
  await writeFile(sessionFile, "", { mode: 0o600 });
  const manifest: TuiWorkerManifest = {
    protocol: 1, ownerSessionId: "parent", taskId: "task", runtimeId: "runtime", groupId: `subagent-job-${"a".repeat(24)}`,
    childId: `subagent-child-${"b".repeat(24)}`, attempt: 1, workerEpoch: "c".repeat(32), controlToken: "d".repeat(64),
    controlSocket: store.path("control.sock"), sessionFile, launchMode: "none", acceptance: ["complete"],
    verification: [{ command: "echo fixture", timeoutMs: 5000 }], tools: ["bash"], presentation: "background",
    placement: { socketPath: "/tmp/tmux", serverEpoch: "1:2", sessionId: "$1", windowId: "@1", paneId: "%1", ownershipNonce: "e".repeat(64) },
  };
  store.writeManifest(manifest);
  const previous = { manifest: process.env.PI_TUI_WORKER_MANIFEST, canonicalNames: process.env.PI_SUBAGENT_CANONICAL_NAMES,
    jobs: (globalThis as any).__paeLocalJobControllerV1 };
  delete process.env.PI_SUBAGENT_CANONICAL_NAMES;
  process.env.PI_TUI_WORKER_MANIFEST = store.path("manifest.json");
  let starts = 0;
  const states = new Map<string, string>(), abortedJobs = new Set<string>(), cancelledJobs = new Set<string>();
  (globalThis as any).__paeLocalJobControllerV1 = {
    protocol: 1, sessionId: "child-session",
    async startVerification(_callId: string, _command: string, signal?: AbortSignal) {
      const jobId = `job-${String(++starts).padStart(24, "0")}`;
      states.set(jobId, "running");
      signal?.addEventListener("abort", () => abortedJobs.add(jobId), { once: true });
      return { details: { job_id: jobId } };
    },
    async execute(_callId: string, params: any) {
      const jobId = params.job_id;
      if (params.action === "cancel") { cancelledJobs.add(jobId); states.set(jobId, "cancelled"); }
      if (params.action === "reap") states.set(jobId, "reaped");
      const status = states.get(jobId) ?? "lost";
      if (params.action === "output" || ["completed", "failed", "cancelled", "lost"].includes(status)) return { details: { job_id: jobId, status, exit_code: status === "completed" ? 0 : 130,
        streams: { available: true, stdout: status === "completed" ? "pass\\n" : "", stderr: "", stdout_truncated: false, stderr_truncated: false } } };
      return { details: { job_id: jobId, status } };
    },
    async resolveVerification(_callId: string, _command: string, jobId?: string) { return jobId; },
    async attestVerification() { return true; },
  };
  const handlers = new Map<string, Function>(), tools = new Map<string, any>(), startupErrors: string[] = [];
  const ctx = { mode: "tui", cwd, hasUI: true, ui: { notify(message: string) { startupErrors.push(message); }, setStatus() {} },
    isIdle: () => true, hasPendingMessages: () => false, abort() {}, shutdown() {}, getContextUsage: () => undefined,
    sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "child-session", getLeafId: () => null, getSessionName: () => undefined } };
  const waitForStarts = async (expected: number) => {
    const deadline = Date.now() + 3000;
    while (starts < expected && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(starts, expected, "verification gate did not start");
  };
  try {
    workerExtension({ registerTool(tool: any) { tools.set(tool.name, tool); }, on: (name: string, fn: Function) => handlers.set(name, fn) } as any);
    await handlers.get("session_start")!({}, ctx);
    assert.deepEqual(startupErrors, [], "worker startup must succeed before testing tool-owned verification");
    const verifyAbort = new AbortController();
    const verifyPending = tools.get("verify").execute("verify-owned", {}, verifyAbort.signal);
    await waitForStarts(1); verifyAbort.abort();
    const verifyResult = await verifyPending;
    const verifyJob = `job-${String(1).padStart(24, "0")}`;
    assert.equal(abortedJobs.has(verifyJob), true, "verify tool abort must reach the supervisor gate signal");
    assert.equal(cancelledJobs.has(verifyJob), true);
    assert.equal(verifyResult.details.verification.status, "cancelled");
    assert.equal(verifyResult.isError, true);

    const outcomeAbort = new AbortController();
    const delivered = { version: 1, state: "delivered", summary: "Done", acceptance: [{ criterion: "complete", status: "passed", evidence: "fixture" }], artifacts: [], remaining: [] };
    const outcomePending = tools.get("task_outcome").execute("outcome-owned", delivered, outcomeAbort.signal);
    await waitForStarts(2); outcomeAbort.abort();
    const outcomeResult = await outcomePending;
    const outcomeJob = `job-${String(2).padStart(24, "0")}`;
    assert.equal(abortedJobs.has(outcomeJob), true, "delivered task_outcome abort must reach the supervisor gate signal");
    assert.equal(cancelledJobs.has(outcomeJob), true);
    assert.equal(outcomeResult.details.verification.status, "cancelled");
    assert.equal(outcomeResult.isError, true);

    const parentStarted = await callTuiWorker(manifest, { operation: "verify" }, { requestId: "parent-started-shared-check" });
    assert.equal(parentStarted.ok, true);
    await waitForStarts(3);
    const sharedAbort = new AbortController();
    const sharedWait = tools.get("verify").execute("verify-shared", {}, sharedAbort.signal);
    sharedAbort.abort();
    await assert.rejects(sharedWait, /shared check continues/);
    const sharedJob = `job-${String(3).padStart(24, "0")}`;
    assert.equal(abortedJobs.has(sharedJob), false, "joining tool cancellation must not abort a prior parent-owned check");
    assert.equal(cancelledJobs.has(sharedJob), false);
    states.set(sharedJob, "completed");
    const final = await awaitTuiWorkerVerification(manifest, "parent-started-shared-check", 5000);
    assert.equal(final.response.ok, true);
    assert.equal((final.response.data as any)?.verification?.status, "passed", JSON.stringify(final.response));
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    if (previous.manifest === undefined) delete process.env.PI_TUI_WORKER_MANIFEST; else process.env.PI_TUI_WORKER_MANIFEST = previous.manifest;
    if (previous.canonicalNames === undefined) delete process.env.PI_SUBAGENT_CANONICAL_NAMES; else process.env.PI_SUBAGENT_CANONICAL_NAMES = previous.canonicalNames;
    if (previous.jobs === undefined) delete (globalThis as any).__paeLocalJobControllerV1; else (globalThis as any).__paeLocalJobControllerV1 = previous.jobs;
    await rm(root, { recursive: true, force: true });
  }
});

test("final boundary continues routine partial once, never blockers, errors or intervention", async () => {
  for (const scenario of ["routine", "legacy-partial", "needs-input", "blocked", "checkpointed", "error", "aborted", "pending", "guidance", "ui", "user-input", "tool-error", "cancel", "sealed"] ) {
    const root = await mkdtemp(join(tmpdir(), "pi-boundary-")), store = new TuiWorkerStore(root);
    const manifest: TuiWorkerManifest = {
      protocol: 1, ownerSessionId: "parent", taskId: "task", runtimeId: "runtime", groupId: `subagent-job-${"a".repeat(24)}`,
      childId: `subagent-child-${"b".repeat(24)}`, attempt: 1, workerEpoch: "c".repeat(32), controlToken: "d".repeat(64),
      controlSocket: join(root, "control.sock"), sessionFile: join(root, "session.jsonl"), launchMode: "none",
      presentation: "background", placement: { socketPath: "/tmp/tmux", serverEpoch: "1:2", sessionId: "$1", windowId: "@1", paneId: "%1", ownershipNonce: "e".repeat(64) },
    };
    store.writeManifest(manifest);
    const previous = process.env.PI_TUI_WORKER_MANIFEST;
    process.env.PI_TUI_WORKER_MANIFEST = store.path("manifest.json");
    const handlers = new Map<string, Function>(), tools = new Map<string, any>();
    const ctx = { mode: "tui", hasUI: false, isIdle: () => true, hasPendingMessages: () => scenario === "pending",
      abort() {}, shutdown() {}, getContextUsage: () => undefined,
      sessionManager: { getSessionFile: () => manifest.sessionFile, getSessionId: () => "child-session" } };
    try {
      workerExtension({ registerTool(tool: any) { tools.set(tool.name, tool); }, on: (name: string, fn: Function) => handlers.set(name, fn) } as any);
      await handlers.get("session_start")!({}, ctx);
      assert.ok(tools.has("verify"), "worker-facing standalone verification tool is registered");
      handlers.get("agent_start")!({}, ctx);
      const state = ["blocked", "checkpointed"].includes(scenario) ? scenario : "partial";
      const outcome = { version: 1, state, summary: "Work remains", acceptance: [], artifacts: [], remaining: ["test"], next_action: "Run tests",
        ...(state === "partial" && scenario !== "legacy-partial" ? { continuation: scenario === "needs-input" ? "needs_input" : "routine" } : {}) };
      await tools.get("task_outcome").execute("outcome", outcome);
      if (scenario === "guidance") {
        const receipt = await tools.get("notify_parent").execute("notify", { message: "Need decision", requires_guidance: true });
        // Same receipt shape as the RPC path; the ID is the one the parent retains the finding under.
        assert.deepEqual(Object.keys(receipt.details).sort(), ["accepted", "notification_id", "requires_guidance"]);
        assert.equal(receipt.details.accepted, true);
        assert.equal(receipt.details.requires_guidance, true);
        assert.equal(receipt.details.notification_id, `${manifest.groupId}:${manifest.childId}:${store.readState().sequence}`);
      }
      if (scenario === "ui") handlers.get("ui_prompt_start")!({}, ctx);
      if (scenario === "user-input") {
        handlers.get("input")!({ text: "User intervention", source: "interactive" }, ctx);
        assert.equal(store.readState().autoContinuation?.inhibited, true);
      }
      if (scenario === "tool-error") handlers.get("tool_result")!({ isError: true }, ctx);
      if (scenario === "cancel") await callTuiWorker(manifest, { operation: "cancel" });
      if (scenario === "sealed") { await handlers.get("session_shutdown")!({}, ctx); }
      // Pi composes boundary handlers by replacing entries with each returned
      // array. Simulate drafts supplied by an earlier extension in the chain.
      const earlierDrafts = [{ type: "custom", customType: "earlier-extension-state", data: { preserved: true } },
        { type: "custom_message", customType: "earlier-extension-guidance", content: "Preserve this guidance", display: false }];
      const event = { outcome: ["error", "aborted"].includes(scenario) ? scenario : "completed", entries: earlierDrafts,
        continue: false, context: { canContinue: false, pendingMessages: [] } };
      const result = handlers.get("agent_before_settle")!(event, ctx);
      assert.equal(result?.continue, scenario === "routine" ? true : undefined, scenario);
      if (scenario === "routine") {
        assert.equal(result.entries.length, 3);
        assert.deepEqual(result.entries.slice(0, 2), earlierDrafts, "continuation must preserve preceding extensions' boundary drafts in order");
        assert.equal(result.entries[2].customType, "harness-auto-continuation");
        assert.equal(event.entries.length, 2, "boundary composition must not mutate the incoming drafts");
        assert.equal(store.readState().lastReport, undefined);
        // A repeat outcome and another boundary cannot schedule a second request.
        await tools.get("task_outcome").execute("outcome2", outcome);
        assert.equal(handlers.get("agent_before_settle")!(event, ctx), undefined);
      }
    } finally {
      await handlers.get("session_shutdown")?.({}, ctx);
      if (previous === undefined) delete process.env.PI_TUI_WORKER_MANIFEST; else process.env.PI_TUI_WORKER_MANIFEST = previous;
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("TUI void abort waits for delayed settlement before sending replacement exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-void-abort-")), store = new TuiWorkerStore(root);
  const manifest: TuiWorkerManifest = {
    protocol: 1, ownerSessionId: "parent", taskId: "task", runtimeId: "runtime", groupId: `subagent-job-${"a".repeat(24)}`,
    childId: `subagent-child-${"b".repeat(24)}`, attempt: 1, workerEpoch: "c".repeat(32), controlToken: "d".repeat(64),
    controlSocket: join(root, "control.sock"), sessionFile: join(root, "session.jsonl"), launchMode: "none",
    presentation: "background", placement: { socketPath: "/tmp/tmux", serverEpoch: "1:2", sessionId: "$1", windowId: "@1", paneId: "%1", ownershipNonce: "e".repeat(64) },
  };
  store.writeManifest(manifest);
  const previous = process.env.PI_TUI_WORKER_MANIFEST;
  process.env.PI_TUI_WORKER_MANIFEST = store.path("manifest.json");
  const handlers = new Map<string, Function>();
  let idle = false, sends = 0, aborts = 0, entered!: () => void;
  const abortStarted = new Promise<void>(resolve => { entered = resolve; });
  const ctx = { mode: "tui", hasUI: false, isIdle: () => idle, hasPendingMessages: () => false,
    abort() { aborts++; entered(); }, shutdown() {}, getContextUsage: () => undefined,
    sessionManager: { getSessionFile: () => manifest.sessionFile, getSessionId: () => "child-session", getLeafId: () => null, getSessionName: () => undefined } };
  try {
    workerExtension({ registerTool() {}, on: (name: string, fn: Function) => handlers.set(name, fn),
      sendMessage() { assert.equal(idle, true); sends++; idle = false; } } as any);
    await handlers.get("session_start")!({}, ctx);
    handlers.get("agent_start")!({}, ctx);
    const request = { operation: "prompt" as const, mode: "interrupt" as const, message: "replacement" };
    const pending = callTuiWorker(manifest, request, { requestId: "void-interrupt" });
    await abortStarted;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(sends, 0, "void abort was mistaken for settled cancellation");
    idle = true;
    handlers.get("message_end")!({ message: { role: "assistant", stopReason: "error", errorMessage: "The operation was aborted.", content: [] } }, ctx);
    handlers.get("agent_settled")!({}, ctx);
    const accepted = await pending;
    assert.equal(accepted.ok, true); assert.equal(sends, 1); assert.equal(aborts, 1);
    assert.equal(store.readState().lastReport, undefined);
    assert.equal(store.readState().active, true);
    assert.deepEqual(await callTuiWorker(manifest, request, { requestId: "void-interrupt" }), accepted);
    assert.equal(sends, 1); assert.equal(aborts, 1);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    if (previous === undefined) delete process.env.PI_TUI_WORKER_MANIFEST; else process.env.PI_TUI_WORKER_MANIFEST = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi's exact too-small compaction error is an explicit idempotent no-op only", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-compact-noop-"));
  const store = new TuiWorkerStore(root);
  const manifest: TuiWorkerManifest = {
    protocol: 1, ownerSessionId: "parent", taskId: "task", runtimeId: "runtime", groupId: `subagent-job-${"a".repeat(24)}`,
    childId: `subagent-child-${"b".repeat(24)}`, attempt: 1, workerEpoch: "c".repeat(32), controlToken: "d".repeat(64),
    controlSocket: join(root, "control.sock"), sessionFile: join(root, "session.jsonl"), launchMode: "none",
    presentation: "background", placement: { socketPath: "/tmp/tmux", serverEpoch: "1:2", sessionId: "$1", windowId: "@1", paneId: "%1", ownershipNonce: "e".repeat(64) },
  };
  store.writeManifest(manifest);
  const previous = process.env.PI_TUI_WORKER_MANIFEST;
  process.env.PI_TUI_WORKER_MANIFEST = store.path("manifest.json");
  const handlers = new Map<string, Function>();
  let compactCalls = 0, compactError = new Error("Nothing to compact (session too small)"), compactMode: "callback" | "throw" = "callback";
  const ctx = { mode: "tui", hasUI: false, isIdle: () => true, hasPendingMessages: () => false,
    abort: () => {}, shutdown: () => {}, getContextUsage: () => undefined,
    sessionManager: { getSessionFile: () => manifest.sessionFile, getSessionId: () => "child-session" },
    compact: ({ onError }: { onError: (error: Error) => void }) => {
      compactCalls++;
      if (compactMode === "throw") throw compactError;
      onError(compactError);
    },
  };
  try {
    workerExtension({ registerTool() {}, on: (name: string, handler: Function) => handlers.set(name, handler) } as any);
    await handlers.get("session_start")!({}, ctx);
    const request = { operation: "compact" as const };
    const noOp = await callTuiWorker(manifest, request, { requestId: "small" });
    assert.equal(noOp.ok, true);
    assert.deepEqual(noOp.data, { compaction: "not-needed", reason: "nothing-to-compact" });
    assert.deepEqual(await callTuiWorker(manifest, request, { requestId: "small" }), noOp);
    assert.equal(compactCalls, 1);
    assert.equal(store.readState().active, false);

    compactMode = "throw";
    const syncNoOp = await callTuiWorker(manifest, request, { requestId: "sync-small" });
    assert.equal(syncNoOp.ok, true);
    assert.deepEqual(syncNoOp.data, { compaction: "not-needed", reason: "nothing-to-compact" });
    assert.equal(compactCalls, 2);

    compactMode = "callback";
    compactError = new Error("Nothing to compact (session too small) — provider temporarily unavailable");
    const lookalike = await callTuiWorker(manifest, request, { requestId: "lookalike" });
    assert.equal(lookalike.ok, false);
    assert.equal(lookalike.code, "compact_failed");
    assert.match(lookalike.message ?? "", /provider temporarily unavailable/);
    assert.equal(compactCalls, 3);
    assert.equal(store.readState().active, false);
    compactError = new Error("Already compacted");
    const existing = await callTuiWorker(manifest, request, { requestId: "already" });
    assert.equal(existing.ok, true);
    assert.deepEqual(existing.data, { compaction: "not-needed", reason: "already-compacted" });
    assert.deepEqual(await callTuiWorker(manifest, request, { requestId: "already" }), existing);
    assert.equal(compactCalls, 4);
    assert.equal(store.readState().active, false);
    compactError = new Error("Already compacted: invalid history");
    const invalidHistory = await callTuiWorker(manifest, request, { requestId: "already-lookalike" });
    assert.equal(invalidHistory.ok, false);
    assert.equal(invalidHistory.code, "compact_failed");
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    if (previous === undefined) delete process.env.PI_TUI_WORKER_MANIFEST; else process.env.PI_TUI_WORKER_MANIFEST = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("headless RPC workers require child-local AgentSH authority before prompts or delegation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-headless-guard-"));
  const store = new TuiWorkerStore(root);
  const manifest = { protocol: 1 as const, ownerSessionId: "parent", taskId: "task", runtimeId: "runtime",
    groupId: `subagent-job-${"a".repeat(24)}`, childId: `subagent-child-${"b".repeat(24)}`, attempt: 1,
    workerEpoch: "c".repeat(32), controlToken: "d".repeat(64), controlSocket: join(root, "control.sock"), sessionFile: join(root, "session.jsonl"),
    launchMode: "guard-only" as const, operatorCapabilityHash: "f".repeat(64), presentation: "headless-foreground" as const,
    execution: "rpc-headless" as const, processPid: process.pid + 1, processToken: `${process.pid + 1}:1`, fifoPath: join(root, "stdin.fifo"),
    foregroundOwner: { pid: process.pid, token: await processIdentity(process.pid) } };
  store.writeManifest(manifest as any);
  const previous = process.env.PI_TUI_WORKER_MANIFEST;
  process.env.PI_TUI_WORKER_MANIFEST = store.path("manifest.json");
  const handlers = new Map<string, Function>();
  const ctx = { mode: "rpc", hasUI: true, isIdle: () => true, hasPendingMessages: () => false,
    abort: () => {}, shutdown: () => {}, sessionManager: { getSessionFile: () => manifest.sessionFile, getSessionId: () => "headless-child" } };
  let sent = 0;
  const oldJobs = (globalThis as any).__paeLocalJobControllerV1;
  const oldSubagents = (globalThis as any).__paeLocalSubagentControllerV1;
  try {
    workerExtension({ registerTool() {}, on: (name: string, handler: Function) => handlers.set(name, handler), sendMessage: () => { sent++; } } as any);
    await handlers.get("session_start")!({}, ctx);
    assert.equal((await callTuiWorker(manifest as any, { operation: "status" })).data?.readyForPrompts, false);
    const rejected = await callTuiWorker(manifest as any, { operation: "prompt", mode: "steer", message: "must fail closed" });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, "unavailable");
    assert.equal(sent, 0);
    assert.equal(handlers.get("tool_call")!({ toolName: "subagent" }, ctx).block, true);
    assert.equal(handlers.get("tool_call")!({ toolName: "background_job" }, ctx).block, true);
    assert.equal(store.readState().active, false);
    delete (globalThis as any).__paeLocalSubagentControllerV1;
    (globalThis as any).__paeLocalJobControllerV1 = { protocol: 1, sessionId: "headless-child",
      async prepareReap(preserve: (report: unknown) => Promise<void>) { await preserve({ jobs: [] }); return () => {}; } };
    assert.equal((await callTuiWorker(manifest as any, { operation: "prepare_reap" })).ok, true);
    const cleanup = JSON.parse(await readFile(store.readState().jobCleanup!.artifact, "utf8"));
    assert.deepEqual(cleanup.report.subagents, { groups: [], flatHeadless: true });
  } finally {
    if (oldJobs === undefined) delete (globalThis as any).__paeLocalJobControllerV1;
    else (globalThis as any).__paeLocalJobControllerV1 = oldJobs;
    if (oldSubagents === undefined) delete (globalThis as any).__paeLocalSubagentControllerV1;
    else (globalThis as any).__paeLocalSubagentControllerV1 = oldSubagents;
    await handlers.get("session_shutdown")?.({}, ctx);
    if (previous === undefined) delete process.env.PI_TUI_WORKER_MANIFEST; else process.env.PI_TUI_WORKER_MANIFEST = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("worker extension with missing selected guard authority never dispatches prompts or tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-guard-"));
  const store = new TuiWorkerStore(root);
  const manifest: TuiWorkerManifest = {
    protocol: 1, ownerSessionId: "parent", taskId: "task", runtimeId: "runtime", groupId: `subagent-job-${"a".repeat(24)}`,
    childId: `subagent-child-${"b".repeat(24)}`, attempt: 1, workerEpoch: "c".repeat(32), controlToken: "d".repeat(64),
    controlSocket: join(root, "control.sock"), sessionFile: join(root, "session.jsonl"), launchMode: "guard-only",
    presentation: "background", placement: { socketPath: "/tmp/tmux", serverEpoch: "1:2", sessionId: "$1", windowId: "@1", paneId: "%1", ownershipNonce: "e".repeat(64) },
  };
  store.writeManifest(manifest);
  const previous = process.env.PI_TUI_WORKER_MANIFEST;
  process.env.PI_TUI_WORKER_MANIFEST = store.path("manifest.json");
  const manifestPath = store.path("manifest.json");
  const handlers = new Map<string, Function>();
  let sent = 0, aborted = 0, shutdown = 0;
  const ctx = { mode: "tui", hasUI: false, isIdle: () => true, hasPendingMessages: () => false,
    abort: () => { aborted++; }, shutdown: () => { shutdown++; },
    getContextUsage: () => undefined,
    sessionManager: { getSessionFile: () => manifest.sessionFile, getSessionId: () => "child-session", getLeafId: () => null, getSessionName: () => undefined } };
  try {
    workerExtension({ registerTool() {}, on: (name: string, handler: Function) => handlers.set(name, handler), sendMessage: () => { sent++; } } as any);
    await handlers.get("session_start")!({}, ctx);
    const status = await callTuiWorker(manifest, { operation: "status" });
    assert.ok(status.ok);
    assert.equal((status.data as any).readyForPrompts, false);
    const result = await callTuiWorker(manifest, { operation: "prompt", mode: "steer", message: "run command" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "unavailable");
    assert.equal(sent, 0);
    assert.equal(store.readState().active, false, "rejected prompt left a phantom running worker");
    assert.equal(store.readState().phase, "ready");
    assert.equal(Object.keys(store.readState().receipts).length, 0, "known rejection created an ambiguous dispatch intent");
    assert.equal(handlers.get("tool_call")!({}, ctx).block, true);
    handlers.get("message_end")!({ message: { role: "assistant", stopReason: "toolUse", content: [] } }, ctx);
    handlers.get("agent_settled")!({}, ctx);
    const reportPath = store.readState().lastReport;
    assert.equal(typeof reportPath, "string", "authority-loss settlement should persist a report artifact");
    const report = JSON.parse(await readFile(reportPath!, "utf8"));
    assert.match(report.error, /authority unavailable/i, "authority loss was retained as a successful settlement");
    assert.equal(handlers.get("input")!({}, ctx).action, "handled");
    handlers.get("before_agent_start")!({}, ctx);
    assert.ok(aborted > 0);
    assert.ok(shutdown > 0);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    if (previous === undefined) delete process.env.PI_TUI_WORKER_MANIFEST; else process.env.PI_TUI_WORKER_MANIFEST = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("only an accepted goal_complete counts as a completion to prove", () => {
  const refusal = { toolName: "goal_complete", isError: false, details: { goal_id: "goal", summary: "too early" } };
  assert.equal(isAcceptedGoalCompletion(refusal), false, "a refused completion is an ordinary result, not a completion");
  assert.equal(isAcceptedGoalCompletion({ ...refusal, details: { ...refusal.details, accepted: true } }), true);
  assert.equal(isAcceptedGoalCompletion({ toolName: "goal_complete", isError: true, details: { accepted: true } }), false);
  assert.equal(isAcceptedGoalCompletion({ toolName: "goal_wait", details: { accepted: true } }), false);
});
