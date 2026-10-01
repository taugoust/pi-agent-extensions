import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workerExtension from "./tui-worker-extension.ts";
import { TuiWorkerStore } from "./tui-worker-store.ts";
import { callTuiWorker } from "./tui-worker-client.ts";
import type { TuiWorkerManifest } from "../shared/tui-worker-protocol.ts";

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
  } finally {
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
