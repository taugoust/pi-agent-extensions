import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workerExtension from "./tui-worker-extension.ts";
import { TuiWorkerStore } from "./tui-worker-store.ts";
import { processIdentity } from "./tui-worker-tmux.ts";
import { callTuiWorker } from "./tui-worker-client.ts";
import type { TuiWorkerManifest } from "../shared/tui-worker-protocol.ts";

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
      handlers.get("agent_start")!({}, ctx);
      const state = ["blocked", "checkpointed"].includes(scenario) ? scenario : "partial";
      const outcome = { version: 1, state, summary: "Work remains", acceptance: [], artifacts: [], remaining: ["test"], next_action: "Run tests",
        ...(state === "partial" && scenario !== "legacy-partial" ? { continuation: scenario === "needs-input" ? "needs_input" : "routine" } : {}) };
      await tools.get("task_outcome").execute("outcome", outcome);
      if (scenario === "guidance") await tools.get("notify_parent").execute("notify", { message: "Need decision", requires_guidance: true });
      if (scenario === "ui") handlers.get("ui_prompt_start")!({}, ctx);
      if (scenario === "user-input") {
        handlers.get("input")!({ text: "User intervention", source: "interactive" }, ctx);
        assert.equal(store.readState().autoContinuation?.inhibited, true);
      }
      if (scenario === "tool-error") handlers.get("tool_result")!({ isError: true }, ctx);
      if (scenario === "cancel") await callTuiWorker(manifest, { operation: "cancel" });
      if (scenario === "sealed") { await handlers.get("session_shutdown")!({}, ctx); }
      const event = { outcome: ["error", "aborted"].includes(scenario) ? scenario : "completed", continue: false, context: { canContinue: false, pendingMessages: [] } };
      const result = handlers.get("agent_before_settle")!(event, ctx);
      assert.equal(result?.continue, scenario === "routine" ? true : undefined, scenario);
      if (scenario === "routine") {
        assert.equal(result.entries.length, 1);
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
    sessionManager: { getSessionFile: () => manifest.sessionFile, getSessionId: () => "child-session" } };
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
  const handlers = new Map<string, Function>();
  let sent = 0, aborted = 0, shutdown = 0;
  const ctx = { mode: "tui", hasUI: false, isIdle: () => true, hasPendingMessages: () => false,
    abort: () => { aborted++; }, shutdown: () => { shutdown++; },
    getContextUsage: () => undefined,
    sessionManager: { getSessionFile: () => manifest.sessionFile, getSessionId: () => "child-session" } };
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
    const report = JSON.parse(await readFile(store.readState().lastReport!, "utf8"));
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
