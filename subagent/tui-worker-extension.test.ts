import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workerExtension from "./tui-worker-extension.ts";
import { TuiWorkerStore } from "./tui-worker-store.ts";
import { callTuiWorker } from "./tui-worker-client.ts";
import type { TuiWorkerManifest } from "../shared/tui-worker-protocol.ts";

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
    sessionManager: { getSessionFile: () => manifest.sessionFile, getSessionId: () => "child-session" } };
  try {
    workerExtension({ registerTool() {}, on: (name: string, handler: Function) => handlers.set(name, handler), sendMessage: () => { sent++; } } as any);
    await handlers.get("session_start")!({}, ctx);
    const status = await callTuiWorker(manifest, { operation: "status" });
    assert.ok(status.ok);
    assert.equal((status.data as any).readyForPrompts, false);
    const result = await callTuiWorker(manifest, { operation: "prompt", mode: "steer", message: "run command" });
    assert.equal(result.ok, false);
    assert.equal(sent, 0);
    assert.equal(handlers.get("tool_call")!({}, ctx).block, true);
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
