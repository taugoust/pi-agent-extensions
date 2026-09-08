import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TuiWorkerStore } from "./tui-worker-store.ts";
import { TuiWorkerServer } from "./tui-worker-server.ts";
import { TuiNativeManager } from "./tui-native.ts";

test("direct human turn clears old outcome; aborted assistant cancels chain instead of launching successor", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-observe-"));
  const manager: any = new TuiNativeManager(root, () => "native", () => true, 16);
  const directory = join(root, "workers", "a".repeat(24));
  const store = new TuiWorkerStore(directory, true);
  const manifest: any = { protocol: 1, ownerSessionId: "parent", taskId: "task", runtimeId: "runtime", groupId: `subagent-job-${"a".repeat(24)}`,
    childId: `subagent-child-${"b".repeat(24)}`, attempt: 1, workerEpoch: "c".repeat(32), controlToken: "d".repeat(64),
    controlSocket: join(directory, "control.sock"), sessionFile: join(directory, "session.jsonl"), launchMode: "none", presentation: "background",
    placement: { socketPath: "/tmp/tmux", serverEpoch: "1:2", sessionId: "$1", windowId: "@1", paneId: "%1", ownershipNonce: "e".repeat(64) } };
  store.writeManifest(manifest);
  let jobCalls = 0;
  const server = new TuiWorkerServer(store, { isIdle: () => true, send() {}, abort() {}, shutdown() {},
    jobs: async () => { jobCalls++; return { content: [{ type: "text", text: "local jobs" }], details: { jobs: [] } }; } });
  const child = { childId: manifest.childId, taskId: manifest.taskId, directory, spec: { task: "first" }, state: "running", started: true, notifiedSequence: 0 };
  const next = { childId: `subagent-child-${"f".repeat(24)}`, taskId: "next", directory: join(root, "workers", "f".repeat(24)), spec: { task: "next" }, state: "pending", notifiedSequence: 0 };
  const group = { id: manifest.groupId, owner: "parent", background: true, mode: "chain", launchMode: "none", caller: manifest.placement, children: [child, next] };
  let launches = 0;
  manager.tmux.resolveCaller = async () => manifest.placement;
  manager.tmux.launch = async () => { launches++; throw new Error("Must not advance"); };
  manager.groups.set(group.id, group);
  try {
    await server.start(); server.running(true);
    server.outcome({ state: "delivered" }); server.settled({ assistant: { stopReason: "stop" } });
    await manager.observe(group, child);
    assert.equal((child as any).lastOutcome.state, "delivered");
    server.running(true); await manager.observe(group, child);
    assert.equal((child as any).lastOutcome, undefined);
    assert.equal((child as any).report, undefined);
    server.settled({ assistant: { stopReason: "aborted" } });
    await manager.refresh("parent");
    assert.equal(child.state, "cancelled"); assert.equal(next.state, "skipped"); assert.equal(launches, 0);
    assert.equal(manager.publicGroup(group).status, "cancelled");
    assert.equal((await manager.jobs("parent", "task", { action: "list" })).content[0].text, "local jobs");
    await assert.rejects(manager.jobs("foreign", "task", { action: "list" }), /different Pi session/);
    await assert.rejects(manager.jobs("parent", "task", { action: "start", command: "false" }), /Unsupported/);
    (child as any).reaped = true;
    await assert.rejects(manager.jobs("parent", "task", { action: "list" }), /reaped/);
    assert.equal(jobCalls, 1);
  } finally { await server.close(); await manager.shutdown(false); await rm(root, { recursive: true, force: true }); }
});
