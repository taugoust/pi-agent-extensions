import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TuiNativeManager } from "./tui-native.ts";
import { HeadlessForegroundManager } from "./headless-foreground.ts";
import { TuiWorkerStore } from "./tui-worker-store.ts";
import { TuiWorkerServer } from "./tui-worker-server.ts";

for (const kind of ["tui", "headless"] as const) {
  test(`${kind} prompt accepts matching job_id and rejects mismatched ownership before delivery`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-prompt-group-"));
    const manager: any = kind === "tui"
      ? new TuiNativeManager(root, () => "native", () => true, 16)
      : new HeadlessForegroundManager(root, () => "native", () => true);
    const store = new TuiWorkerStore(join(root, "worker"), true);
    const manifest: any = {
      protocol: 1, ownerSessionId: "parent", taskId: `subagent-task-${"a".repeat(24)}`,
      runtimeId: "runtime", groupId: `subagent-job-${"b".repeat(24)}`, childId: `subagent-child-${"c".repeat(24)}`,
      attempt: 1, workerEpoch: "d".repeat(32), controlToken: "e".repeat(64),
      controlSocket: store.path("control.sock"), sessionFile: store.path("session.jsonl"), launchMode: "none",
      presentation: "background", placement: { socketPath: "/tmp/tmux", serverEpoch: "1:2", sessionId: "$1",
        windowId: "@1", paneId: "%1", ownershipNonce: "f".repeat(64) },
    };
    store.writeManifest(manifest);
    const messages: string[] = [];
    const server = new TuiWorkerServer(store, {
      isIdle: () => true, send(message) { messages.push(message); }, abort() {}, shutdown() {},
    });
    const now = new Date().toISOString();
    const child = { childId: manifest.childId, taskId: manifest.taskId, attempt: 1, directory: store.directory,
      spec: { task: "saved task", cwd: root }, state: "completed", status: "completed", started: true,
      createdAt: now, updatedAt: now, notifiedSequence: 0, operatorCapability: "f".repeat(64) };
    const group = { id: manifest.groupId, owner: "parent", background: true, mode: "single", launchMode: "none",
      createdAt: now, caller: manifest.placement, children: [child] };
    manager.owner = "parent";
    manager.groups.set(group.id, group);
    // Stub only process observation/persistence; delivery uses the authenticated
    // worker protocol. No test can spawn a replacement worker.
    manager.manifest = () => ({ ...manifest, runtimePid: process.pid });
    manager.refresh = async () => {};
    manager.save = () => {};
    manager.persist = () => {};
    manager.runtimeState = async () => "alive";
    if (kind === "tui") manager.tmux.inspect = async () => ({ dead: false });
    let launches = 0;
    manager.launch = async () => { launches++; throw new Error("unexpected relaunch"); };
    try {
      await server.start();
      const request = { operation: "prompt", child_id: child.childId, job_id: group.id, message: "continue", control_mode: "steer" };
      await manager.operation(request, "parent");
      assert.deepEqual(messages, ["continue"]);
      server.running(false);
      await manager.operation({ ...request, job_id: undefined, message: "child only" }, "parent");
      assert.deepEqual(messages, ["continue", "child only"]);
      await assert.rejects(manager.operation({ ...request, job_id: `subagent-job-${"1".repeat(24)}` }, "parent"), /does not belong/);
      group.owner = "foreign";
      await assert.rejects(manager.operation(request, "parent"), /different Pi session/);
      group.owner = "parent";
      assert.equal(messages.length, 2, "failed identity assertion sent a message");
      assert.equal(launches, 0, "prompt relaunched work");
    } finally {
      manager.groups.clear();
      await server.close();
      await manager.shutdown(false);
      await rm(root, { recursive: true, force: true });
    }
  });
}
