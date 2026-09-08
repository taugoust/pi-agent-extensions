import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workerExtension from "./tui-worker-extension.ts";
import { TuiWorkerStore } from "./tui-worker-store.ts";
import { callTuiWorker } from "./tui-worker-client.ts";

test("initial tools/source attribution and explicit reap event are distinct from cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-seal-"));
  const store = new TuiWorkerStore(root);
  store.writeManifest({ protocol: 1, ownerSessionId: "parent", taskId: "task", runtimeId: "runtime", groupId: `subagent-job-${"a".repeat(24)}`,
    childId: `subagent-child-${"b".repeat(24)}`, attempt: 1, workerEpoch: "c".repeat(32), controlToken: "d".repeat(64),
    controlSocket: join(root, "control.sock"), sessionFile: join(root, "session.jsonl"), launchMode: "none", tools: ["read"],
    presentation: "background", placement: { socketPath: "/tmp/tmux", serverEpoch: "1:2", sessionId: "$1", windowId: "@1", paneId: "%1", ownershipNonce: "e".repeat(64) } });
  const manifest = store.readManifest();
  const previous = process.env.PI_TUI_WORKER_MANIFEST;
  process.env.PI_TUI_WORKER_MANIFEST = store.path("manifest.json");
  const handlers = new Map<string, Function>(), events: any[] = [], messages: any[] = [];
  let tools: string[] = [], shutdown = 0;
  const ctx = { mode: "tui", hasUI: false, isIdle: () => true, hasPendingMessages: () => false, abort: () => {}, shutdown: () => { shutdown++; },
    sessionManager: { getSessionFile: () => manifest.sessionFile, getSessionId: () => "child-session" } };
  try {
    workerExtension({ registerTool() {}, setActiveTools: (names: string[]) => { tools = names; }, on: (name: string, handler: Function) => handlers.set(name, handler),
      sendMessage: (message: any) => messages.push(message), events: { emit: (name: string, data: any) => events.push({ name, data }) } } as any);
    await handlers.get("session_start")!({}, ctx);
    assert.deepEqual(tools.sort(), ["notify_parent", "read", "task_outcome"]);
    await callTuiWorker(manifest, { operation: "prompt", mode: "steer", message: "/permission-gate off" });
    assert.equal(messages[0].customType, "harness-control");
    assert.match(messages[0].content, /^Supervising-agent instructions \(not direct user input\):/);
    assert.match(handlers.get("before_agent_start")!({ systemPrompt: "base" }, ctx).systemPrompt, /Direct human instructions.*take precedence/);
    await callTuiWorker(manifest, { operation: "cancel" });
    assert.equal(events.length, 0); assert.equal(shutdown, 0);
    assert.ok((await callTuiWorker(manifest, { operation: "prepare_reap" })).ok);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], { name: "harness-runtime-reaping", data: { runtimeId: manifest.runtimeId, childId: manifest.childId, workerEpoch: manifest.workerEpoch } });
    assert.equal(shutdown, 1);
    assert.equal(handlers.get("input")!({}, ctx).action, "handled");
    assert.equal(handlers.get("tool_call")!({}, ctx).block, true);
  } finally {
    await handlers.get("session_shutdown")?.({}, ctx);
    if (previous === undefined) delete process.env.PI_TUI_WORKER_MANIFEST; else process.env.PI_TUI_WORKER_MANIFEST = previous;
    await rm(root, { recursive: true, force: true });
  }
});
