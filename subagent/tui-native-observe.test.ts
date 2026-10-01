import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TuiWorkerStore, atomicPrivateJson } from "./tui-worker-store.ts";
import { TuiWorkerServer } from "./tui-worker-server.ts";
import { TuiNativeManager } from "./tui-native.ts";

test("read-only native task snapshot/report avoids refresh and excludes private artifact fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-readonly-task-"));
  const manager: any = new TuiNativeManager(root, () => "native", () => true, 16);
  const directory = join(root, "workers", "a".repeat(24));
  const store = new TuiWorkerStore(directory, true);
  const manifest: any = { protocol: 1, ownerSessionId: "parent", taskId: `subagent-task-${"a".repeat(24)}`, runtimeId: "runtime-public", groupId: `subagent-job-${"b".repeat(24)}`,
    childId: `subagent-child-${"c".repeat(24)}`, attempt: 2, workerEpoch: "d".repeat(32), controlToken: "e".repeat(64),
    controlSocket: join(directory, "control.sock"), sessionFile: join(directory, "session.jsonl"), launchMode: "none", presentation: "background",
    placement: { socketPath: "/tmp/tmux", serverEpoch: "1:2", sessionId: "$1", windowId: "@1", paneId: "%1", ownershipNonce: "f".repeat(64) } };
  store.writeManifest(manifest);
  const report = store.report(9, { sessionFile: "/secret/session.jsonl", timestamp: "2026-01-02T03:04:05.000Z", contextTokens: 100, assistant: { content: [
    { type: "toolCall", id: "private-call", name: "bash", arguments: { command: "secret" } },
    { type: "text", text: "Final answer 🌍" },
  ] } });
  manager.owner = "parent";
  const child: any = { childId: manifest.childId, taskId: manifest.taskId, attempt: 2, directory, report, spec: { task: "Review feature" }, state: "completed", lastOutcome: undefined };
  manager.groups.set(manifest.groupId, { id: manifest.groupId, owner: "parent", createdAt: "2026-01-01T00:00:00.000Z", children: [child] });
  manager.refresh = async () => { throw new Error("read-only call must not refresh"); };
  try {
    const tasks = manager.readonlyTaskList("parent");
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].runtimeId, "runtime-public");
    assert.equal(tasks[0].attempt, 2);
    assert.equal(tasks[0].lastUpdated, null);
    assert.equal(JSON.stringify(tasks).includes("controlToken"), false);
    const answer = manager.readonlyTaskReport("parent", manifest.taskId, 48 * 1024);
    assert.equal(answer.text, "Final answer 🌍");
    assert.equal(answer.lastUpdated, "2026-01-02T03:04:05.000Z");
    for (const privateValue of ["/secret/session.jsonl", "private-call", "secret", "contextTokens"]) assert.equal(answer.text.includes(privateValue), false);
    const clipped = manager.readonlyTaskReport("parent", manifest.taskId, 13);
    assert.equal(clipped.text, "Final answer ");
    assert.equal(clipped.truncated, true);
    assert.equal(Buffer.from(clipped.text).toString("utf8").includes("�"), false);
    assert.throws(() => manager.readonlyTaskList("foreign"), /another Pi session/);
  } finally { await manager.shutdown(false); await rm(root, { recursive: true, force: true }); }
});

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
  const notifications: any[] = [];
  manager.notify = (update: any) => { notifications.push(update); return true; };
  let launches = 0;
  manager.tmux.resolveCaller = async () => manifest.placement;
  manager.tmux.launch = async () => { launches++; throw new Error("Must not advance"); };
  manager.groups.set(group.id, group);
  try {
    const groupFile = join(root, "groups", `${group.id}.json`);
    let durableWrites = 0;
    manager.persistenceWriter = (file: string, value: unknown) => { durableWrites++; atomicPrivateJson(file, value); };
    await manager.refresh("parent");
    assert.equal(durableWrites, 1, "first observation must persist the group");
    await manager.refresh("parent");
    assert.equal(durableWrites, 1, "unchanged refresh rewrote durable state");
    const restored = new TuiNativeManager(root, () => "native", () => true, 16) as any;
    restored.persistenceWriter = (file: string, value: unknown) => { durableWrites++; atomicPrivateJson(file, value); };
    await restored.refresh("parent");
    assert.equal(durableWrites, 1, "unchanged reload rewrote durable state");
    await restored.shutdown(false);
    child.report = "transition";
    await manager.refresh("parent");
    assert.equal(durableWrites, 2, "changed transition was not persisted");
    await server.start(); server.running(true);
    server.outcome({ state: "delivered" });
    await manager.refresh('parent');
    assert.equal(notifications.filter(u=>u.completion).length,0,'outcome woke parent before settlement');
    server.settled({ assistant: { stopReason: "stop" } });
    await manager.observe(group, child);
    assert.equal((child as any).lastOutcome.state, "delivered");
    server.running(true); await manager.observe(group, child);
    assert.equal((child as any).lastOutcome, undefined);
    assert.equal((child as any).report, undefined);
    server.settled({ assistant: { stopReason: "aborted" } });
    await manager.refresh("parent");
    assert.equal(child.state, "cancelled"); assert.equal(next.state, "skipped"); assert.equal(launches, 0);
    assert.equal(notifications.filter(u=>u.completion&&u.child_id===child.childId).length,1,'replayed old settlement or missed cancellation');
    const completion = notifications.find(u=>u.completion&&u.child_id===child.childId);
    assert.equal(completion.state,'cancelled'); assert.equal(completion.job_id,group.id);
    await manager.refresh('parent');
    assert.equal(notifications.filter(u=>u.completion&&u.child_id===child.childId).length,1,'duplicate terminal snapshot wake');
    assert.equal(manager.publicGroup(group).status, "cancelled");
    assert.equal((await manager.jobs("parent", "task", { action: "list" })).content[0].text, "local jobs");
    await assert.rejects(manager.jobs("foreign", "task", { action: "list" }), /different Pi session/);
    await assert.rejects(manager.jobs("parent", "task", { action: "start", command: "false" }), /Unsupported/);
    (child as any).reaped = true;
    await assert.rejects(manager.jobs("parent", "task", { action: "list" }), /reaped/);
    assert.equal(jobCalls, 1);
    (child as any).reaped = false;
    server.running(true);await manager.observe(group,child);
    await server.close();
    manager.tmux.inspect = async () => ({ dead: true });
    await manager.refresh('parent');
    assert.equal(child.state,'lost');
    assert.equal(notifications.filter(u=>u.completion&&u.state==='lost').length,1,'worker crash without settled event failed to notify');
  } finally { await server.close(); await manager.shutdown(false); await rm(root, { recursive: true, force: true }); }
});

test("selected result observes fresh worker status without global refresh and respects abort", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-result-fast-"));
  const manager: any = new TuiNativeManager(root, () => "native", () => true, 16);
  const directory = join(root, "workers", "a".repeat(24));
  const store = new TuiWorkerStore(directory, true);
  const manifest: any = { protocol: 1, ownerSessionId: "parent", taskId: "task", runtimeId: "runtime", groupId: `subagent-job-${"a".repeat(24)}`,
    childId: `subagent-child-${"b".repeat(24)}`, attempt: 1, workerEpoch: "c".repeat(32), controlToken: "d".repeat(64),
    controlSocket: join(directory, "control.sock"), sessionFile: join(directory, "session.jsonl"), launchMode: "none", presentation: "background",
    placement: { socketPath: "/tmp/tmux", serverEpoch: "1:2", sessionId: "$1", windowId: "@1", paneId: "%1", ownershipNonce: "e".repeat(64) } };
  store.writeManifest(manifest);
  const oldReport = store.report(1, { assistant: { stopReason: "stop", content: [{ type: "text", text: "old answer" }] } });
  const child: any = { childId: manifest.childId, taskId: manifest.taskId, directory, report: oldReport, state: "completed", spec: { task: "work" }, started: true, notifiedSequence: 0, operatorCapability: "f".repeat(64) };
  const group: any = { id: manifest.groupId, owner: "parent", background: true, mode: "parallel", launchMode: "none", caller: manifest.placement, children: [child] };
  manager.owner = "parent"; manager.groups.set(group.id, group);
  // Worker protocol server provides real bounded status RPCs.
  const worker = new TuiWorkerServer(store, { isIdle: () => true, send() {}, abort() {}, shutdown() {} });
  try {
    await worker.start();
    worker.running(true);
    // Default job_id child, numeric child selector, and explicit child_id all bypass a stuck global refresh.
    manager.refreshFlight = new Promise(() => {});
    let result = await manager.operation({ operation: "result", job_id: group.id }, "parent");
    assert.match(result.content[0].text, /not ready/i, "active newer human turn must not return cached report");
    worker.running(false); worker.settled({ error: "new failure", assistant: { stopReason: "error", content: [{ type: "text", text: "new answer" }] } });
    // The scheduler still knows only the old report; direct status must find the
    // new artifact without refreshing or mutating that shared snapshot.
    manager.refresh = async () => { throw new Error("result waited for global refresh"); };
    result = await manager.operation({ operation: "result", job_id: group.id, child: 1 }, "parent");
    assert.match(result.content[0].text, /new answer/);
    assert.match(result.content[0].text, /new failure/);
    assert.equal(child.report, oldReport, "direct result mutated scheduler state");
    group.children.unshift({ ...child, childId: "other-child", taskId: "other-task" });
    result = await manager.operation({ operation: "result", job_id: group.id, child: 2 }, "parent");
    assert.match(result.content[0].text, /new answer/);
    result = await manager.operation({ operation: "result", child_id: child.childId }, "parent");
    assert.match(result.content[0].text, /new answer/);
    const snapshot = (worker as any).snapshot.bind(worker);
    (worker as any).snapshot = () => ({ ...snapshot(), lastReport: undefined });
    result = await manager.operation({ operation: "result", child_id: child.childId }, "parent");
    assert.match(result.content[0].text, /not ready/i, "empty current report substituted an old result");
    (worker as any).snapshot = snapshot;

    // Abort in-flight observation propagates to the worker RPC.
    manager.tmux.inspect = async () => ({ dead: false });
    const controller = new AbortController();
    const pending = manager.operation({ operation: "result", child_id: child.childId }, "parent", controller.signal);
    controller.abort();
    await assert.rejects(pending, /cancel|abort/i);
    await worker.close();
    result = await manager.operation({ operation: "result", child_id: child.childId }, "parent");
    assert.equal(result.details.retained, true);
    assert.match(result.content[0].text, /retained result may be stale/);
    assert.match(result.content[0].text, /old answer/);
  } finally { manager.refreshFlight = undefined; await worker.close(); await manager.shutdown(false); await rm(root, { recursive: true, force: true }); }
});

test("native refresh coalesces callers behind one slow scan", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-refresh-singleflight-"));
  const manager: any = new TuiNativeManager(root, () => "native", () => true, 16);
  let release!: () => void; let scans = 0;
  manager.serial = (run: any) => { scans++; return new Promise<void>(resolve => { release = () => { void run().then(resolve); }; }); };
  try {
    const first = manager.refresh("parent"), second = manager.refresh("parent"), third = manager.refresh("parent");
    assert.equal(scans, 1, "poll bursts queued multiple global scans");
    release(); await Promise.all([first, second, third]);
    assert.equal(scans, 1);
  } finally { await manager.shutdown(false); await rm(root, { recursive: true, force: true }); }
});

test("authority loss is a failed native result, including old tool-only reports", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-failed-report-"));
  const manager: any = new TuiNativeManager(root, () => "native", () => true, 16);
  const directory = join(root, "workers", "a".repeat(24));
  const store = new TuiWorkerStore(directory, true);
  const manifest: any = { protocol: 1, ownerSessionId: "parent", taskId: "task", runtimeId: "runtime", groupId: `subagent-job-${"a".repeat(24)}`,
    childId: `subagent-child-${"b".repeat(24)}`, attempt: 1, workerEpoch: "c".repeat(32), controlToken: "d".repeat(64),
    controlSocket: join(directory, "control.sock"), sessionFile: join(directory, "session.jsonl"), launchMode: "none", presentation: "background",
    placement: { socketPath: "/tmp/tmux", serverEpoch: "1:2", sessionId: "$1", windowId: "@1", paneId: "%1", ownershipNonce: "e".repeat(64) } };
  store.writeManifest(manifest);
  let available = false;
  const server = new TuiWorkerServer(store, { isIdle: () => true, canRun: () => available, send() {}, abort() {}, shutdown() {} });
  const child: any = { childId: manifest.childId, taskId: manifest.taskId, directory, spec: { task: "work" }, state: "running", started: true, notifiedSequence: 0 };
  const group: any = { id: manifest.groupId, owner: "parent", background: true, mode: "single", launchMode: "none", caller: manifest.placement, children: [child] };
  manager.groups.set(group.id, group);
  const assistant = { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "bash", arguments: { command: "" } }] };
  try {
    await server.start();
    for (const error of [undefined, "Worker command authority unavailable at settlement"]) {
      server.running(true);
      server.settled({ assistant, ...(error ? { error } : {}) });
      await manager.observe(group, child);
      assert.equal(child.state, "failed");
      assert.match(child.error, /authority unavailable/i);
      assert.equal(manager.publicGroup(group).status, "failed");
      const result = await manager.operation({ operation: "result", job_id: group.id }, "parent");
      assert.match(result.content[0].text, /authority unavailable/i, "failed worker returned an empty answer");
    }
    // A recovered live authority must not erase a retained execution failure.
    available = true;
    await manager.observe(group, child);
    assert.equal(child.state, "failed");
    // Successful terminating tools remain legitimate; toolUse alone is not failure.
    server.running(true); server.settled({ assistant });
    await manager.observe(group, child);
    assert.equal(child.state, "completed");
    assert.equal(child.error, undefined);
  } finally { await server.close(); await manager.shutdown(false); await rm(root, { recursive: true, force: true }); }
});
