import assert from "node:assert/strict";
import { test } from "node:test";
import { link, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeadlessForegroundManager } from "./headless-foreground.ts";
import { TuiNativeManager } from "./tui-native.ts";
import { TuiWorkerStore } from "./tui-worker-store.ts";
import { TuiWorkerServer } from "./tui-worker-server.ts";

const taskId = `subagent-task-${"a".repeat(24)}`;
const childId = `subagent-child-${"b".repeat(24)}`;
const groupId = `subagent-job-${"c".repeat(24)}`;
const runtimeId = "runtime-session-test";

for (const kind of ["foreground", "tui"] as const) test(`${kind} sessionSource validates identity and only returns retained session reference`, async () => {
  const root = await mkdtemp(join(tmpdir(), `pi-session-source-${kind}-`));
  const owner = `owner-${kind}`;
  const directory = join(root, "workers", "d".repeat(24));
  try {
    const store = new TuiWorkerStore(directory, true);
    const manifest: any = {
      protocol: 1, ownerSessionId: owner, taskId, runtimeId, groupId, childId, attempt: 2,
      workerEpoch: "e".repeat(32), controlSocket: join(directory, "control.sock"),
      controlToken: "f".repeat(64), sessionFile: join(directory, "session.jsonl"),
      presentation: kind === "tui" ? "background" : "headless-foreground", launchMode: "none",
      ...(kind === "tui" ? { placement: { socketPath: "/tmp/test.sock", serverEpoch: "1:2", sessionId: "$1", windowId: "@1", paneId: "%1", ownershipNonce: "1".repeat(64) } }
        : { execution: "rpc-headless", fifoPath: join(directory, "stdin.fifo"), processPid: process.pid, processToken: "1:2", foregroundOwner: { pid: process.pid + 1, token: "3:4" } }),
    };
    store.writeManifest(manifest);
    await writeFile(manifest.sessionFile, `${JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "hello" } })}\n`, { mode: 0o600 });
    const child: any = kind === "tui"
      ? { taskId, childId, attempt: 2, directory, state: "completed", operatorCapability: "2".repeat(64), started: true, reaped: true, spec: { task: "test", cwd: root }, notifiedSequence: 0 }
      : { taskId, childId, attempt: 2, directory, status: "pending", ownerToken: "3:4", operatorCapability: "2".repeat(64), started: true, reaped: false, spec: { task: "test", cwd: root } };
    const group: any = { id: groupId, owner, ownerToken: "3:4", children: [child], cancelled: false };
    const manager: any = kind === "tui" ? new TuiNativeManager(root, () => "native", () => true, 16)
      : new HeadlessForegroundManager(root, () => "native", () => true);
    manager.owner = owner;
    manager.groups.set(groupId, group);
    const source = kind === "tui" ? manager.readonlyTaskSessionSource(owner, { taskId, childId, attempt: 2 })
      : manager.readonlyTaskSessionSource(owner, { taskId, childId, attempt: 2 });
    assert.equal(source.sessionFile, manifest.sessionFile);
    assert.equal(source.runtimeId, runtimeId);
    assert.equal(source.groupId, groupId);
    assert.equal(source.status, kind === "tui" ? "completed" : "running", "a pending manifest must not become a terminal lost source");
    if (kind === "foreground") assert.equal(manager.readonlyTaskList(owner).find((row: any) => row.childId === childId).status, source.status);
    if (kind === "tui") {
      assert.equal(source.reaped, true);
      child.reaped = false;
      assert.equal(manager.readonlyTaskSessionSource(owner, { taskId, childId, attempt: 2 }).reaped, false);
      child.reaped = true;
      assert.equal((await manager.readonlyTaskConversation(owner, { taskId, childId, attempt: 2, runtimeId })).messages[0].text, "hello");
      let fixtureIdle = false;
      const server = new TuiWorkerServer(store, { isIdle: () => fixtureIdle, send() {}, abort() {}, shutdown() {} });
      try {
        await server.start();
        server.running(true);
        child.state = "running";
        child.reaped = false;
        const independent = manager.readonlyIndependentSource(owner, { taskId, childId, attempt: 2, runtimeId });
        assert.equal(independent.file, manifest.sessionFile, "active workers expose a pinned copy source, not mutable control");
        assert.equal(independent.report, null);
        assert.throws(() => manager.readonlyIndependentSource(owner, { taskId, childId, attempt: 1, runtimeId }));
        assert.throws(() => manager.readonlyIndependentSource(owner, { taskId, childId, attempt: 2, runtimeId: "wrong" }));
        assert.throws(() => manager.readonlyIndependentSource("wrong-owner", { taskId, childId, attempt: 2, runtimeId }));
        const toolCallId = "call_123|fc_456";
        server.conversationTool("end", { toolCallId, name: "read", result: { content: [{ type: "text", text: "actual structured result" }] } });
        const live = await manager.readonlyTaskConversation(owner, { taskId, childId, attempt: 2, runtimeId });
        assert.equal(live.stale, false);
        assert.equal(live.liveEvents.at(-1).toolCallId, toolCallId);
        assert.equal(typeof live.liveEvents.at(-1).result, "string", "authenticated worker result objects must satisfy the public string DTO");
        assert.equal(live.liveEvents.at(-1).result, "actual structured result", "presentation event exposes normalized text, not a serialized transport envelope");
        server.conversationTool("end", { toolCallId, name: "read", result: { content: "é".repeat(4000) } });
        const bounded = await manager.readonlyTaskConversation(owner, { taskId, childId, attempt: 2, runtimeId });
        assert.ok(Buffer.byteLength(bounded.liveEvents.at(-1).result) <= 2048, "serialized live result remains within the wire byte bound");
      } finally { child.state = "completed"; child.reaped = true; fixtureIdle = true; server.settled({}); await server.close(); }
      group.cancelled = true;
      assert.equal(manager.readonlyTaskSessionSource(owner, { taskId, childId, attempt: 2 }).status, "completed", "cancelling siblings cannot cancel a completed child");
      group.cancelled = false;
    }
    assert.deepEqual(Object.keys(source).sort(), ["attempt", "childId", "cwd", "groupId", "runtimeId", "sessionFile", "status", "taskId", "title", ...(kind === "tui" ? ["reaped"] : [])].sort());
    assert.throws(() => manager.readonlyTaskSessionSource(owner, { taskId, childId, attempt: 1 }));
    assert.throws(() => manager.readonlyTaskSessionSource(owner, { taskId, childId: `subagent-child-${"9".repeat(24)}`, attempt: 2 }));
    assert.throws(() => manager.readonlyTaskSessionSource("other-owner", { taskId, childId, attempt: 2 }));
    assert.throws(() => manager.readonlyTaskSessionSource(owner, { taskId, childId, attempt: 2, runtimeId: "wrong-runtime" }));
    if (kind === "foreground") {
      const conversation = manager.readonlyTaskConversation(owner, { taskId, childId, attempt: 2, runtimeId });
      assert.equal(conversation.messages[0].text, "hello");
    }
    const extraLink = join(directory, "extra-link");
    await link(manifest.sessionFile, extraLink);
    const linkedStatus = manager.readonlyTaskSessionSource(owner, { taskId, childId, attempt: 2 });
    assert.equal(linkedStatus.status, source.status);
    assert.equal("sessionFile" in linkedStatus, false, "a multiply-linked transcript is never published");
    await unlink(extraLink);
    assert.equal(manager.readonlyTaskSessionSource(owner, { taskId, childId, attempt: 2 }).sessionFile, manifest.sessionFile);
    await unlink(manifest.sessionFile);
    const statusOnly = manager.readonlyTaskSessionSource(owner, { taskId, childId, attempt: 2 });
    assert.equal(statusOnly.status, source.status);
    assert.equal(statusOnly.runtimeId, runtimeId);
    assert.equal("sessionFile" in statusOnly, false);
    if (kind === "foreground") {
      assert.throws(() => manager.readonlyTaskConversation(owner, { taskId, childId, attempt: 2, runtimeId }));
    }
    await writeFile(manifest.sessionFile, `${JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "hello" } })}\n`, { mode: 0o600 });
    if (kind === "foreground") {
      child.status = "reaped";
      const lost = manager.readonlyTaskSessionSource(owner, { taskId, childId, attempt: 2 });
      assert.equal(lost.status, "lost", "reap without execution proof must not imply success");
      const reportName = `report-1-${"5".repeat(16)}.json`;
      await writeFile(join(directory, reportName), JSON.stringify({ assistant: { stopReason: "error" } }), { mode: 0o600 });
      store.writeState({ version: 1, sequence: 1, active: false, sealed: true, phase: "settled", receipts: {}, events: [], lastReport: join(directory, reportName) });
      const failedSource = manager.readonlyTaskSessionSource(owner, { taskId, childId, attempt: 2 });
      const failedList = manager.readonlyTaskList(owner).find((row: any) => row.childId === childId);
      assert.equal(failedSource.status, "failed");
      assert.equal(failedList.status, failedSource.status, "Work and source status must share the authoritative outcome");
    }
    await manager.shutdown(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("foreground sessionSource resolves the current resumed attempt, not the retained prior attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-session-source-resume-"));
  const owner = "resume-owner";
  const priorGroup = groupId;
  const currentGroup = `subagent-job-${"8".repeat(24)}`;
  const currentChild = `subagent-child-${"7".repeat(24)}`;
  const priorDirectory = join(root, "workers", "d".repeat(24));
  const currentDirectory = join(root, "workers", "9".repeat(24));
  try {
    const priorStore = new TuiWorkerStore(priorDirectory, true);
    const currentStore = new TuiWorkerStore(currentDirectory, true);
    const makeManifest = (directory: string, child: string, group: string, attempt: number, runtime: string) => ({
      protocol: 1, ownerSessionId: owner, taskId, runtimeId: runtime, groupId: group, childId: child, attempt,
      workerEpoch: "e".repeat(32), controlSocket: join(directory, "control.sock"), controlToken: "f".repeat(64),
      sessionFile: join(directory, "session.jsonl"), execution: "rpc-headless", presentation: "headless-foreground",
      launchMode: "none", processPid: process.pid, processToken: "1:2", fifoPath: join(directory, "stdin.fifo"),
      foregroundOwner: { pid: process.pid + 1, token: "3:4" },
    });
    const priorManifest: any = makeManifest(priorDirectory, childId, priorGroup, 1, "old-runtime");
    const currentManifest: any = makeManifest(currentDirectory, currentChild, currentGroup, 2, "resumed-runtime");
    priorStore.writeManifest(priorManifest);
    currentStore.writeManifest(currentManifest);
    const jsonl = `${JSON.stringify({ type: "message", id: "resume", message: { role: "user", content: "resumed context" } })}\n`;
    await writeFile(priorManifest.sessionFile, jsonl, { mode: 0o600 });
    await writeFile(currentManifest.sessionFile, jsonl, { mode: 0o600 });
    const oldChild: any = { taskId, childId, attempt: 1, directory: priorDirectory, status: "reaped", ownerToken: "3:4", operatorCapability: "2".repeat(64), started: true, reaped: true, spec: { task: "resume", cwd: root } };
    const newChild: any = { taskId, childId: currentChild, attempt: 2, directory: currentDirectory, status: "pending", ownerToken: "3:4", operatorCapability: "2".repeat(64), started: true, spec: { task: "resume", cwd: root } };
    const manager: any = new HeadlessForegroundManager(root, () => "native", () => true);
    manager.owner = owner;
    manager.groups.set(priorGroup, { id: priorGroup, owner, ownerToken: "3:4", children: [oldChild], cancelled: false });
    manager.groups.set(currentGroup, { id: currentGroup, owner, ownerToken: "3:4", children: [newChild], cancelled: false });

    const source = manager.readonlyTaskSessionSource(owner, { taskId, childId: currentChild, attempt: 2 });
    assert.equal(source.groupId, currentGroup);
    assert.equal(source.childId, currentChild);
    assert.equal(source.attempt, 2);
    assert.equal(source.runtimeId, "resumed-runtime");
    assert.equal(source.sessionFile, currentManifest.sessionFile);
    assert.equal(source.status, "running");
    assert.throws(() => manager.readonlyTaskSessionSource(owner, { taskId, childId: currentChild, attempt: 2, runtimeId: "old-runtime" }));
    assert.throws(() => manager.readonlyTaskSessionSource(owner, { taskId, childId, attempt: 1, runtimeId: "resumed-runtime" }));
    await manager.shutdown(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
