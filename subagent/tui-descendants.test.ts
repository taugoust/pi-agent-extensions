import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { TuiWorkerStore, atomicPrivateJson, readPrivateJson } from "./tui-worker-store.ts";
import { TuiWorkerServer } from "./tui-worker-server.ts";
import { TuiNativeManager } from "./tui-native.ts";
import { TuiWorkerTmux } from "./tui-worker-tmux.ts";
import { HeadlessForegroundManager } from "./headless-foreground.ts";
import { callTuiWorker } from "./tui-worker-client.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-tree-"));
  const groups: any[] = [], stores: TuiWorkerStore[] = [], manifests: any[] = [];
  for (let i = 0; i < 4; i++) {
    const digit = String(i + 1), directory = join(root, "workers", digit.repeat(24));
    const store = new TuiWorkerStore(directory, true);
    const groupId = `subagent-job-${digit.repeat(24)}`;
    const manifest: any = { protocol: 1, ownerSessionId: i === 3 ? "unrelated" : `session-${i}`, taskId: `subagent-task-${digit.repeat(24)}`,
      runtimeId: `runtime-${i}`, groupId, childId: `subagent-child-${digit.repeat(24)}`, attempt: 1,
      workerEpoch: digit.repeat(32), controlToken: digit.repeat(64), controlSocket: join(directory, "control.sock"),
      sessionFile: join(directory, "session.jsonl"), launchMode: "none", presentation: "background",
      placement: { socketPath: "/tmp/tmux", serverEpoch: "1:2", sessionId: "$1", windowId: `@${i}`, paneId: `%${i}`, ownershipNonce: digit.repeat(64) } };
    store.writeManifest(manifest);
    await writeFile(manifest.sessionFile, JSON.stringify({ type: "session", id: `session-${i + 1}` }) + "\n", { mode: 0o600 });
    const report = store.report(1, { assistant: { stopReason: "stop", content: [{ type: "text", text: `result-${i}` }] } });
    const group = { version: 1, id: groupId, owner: manifest.ownerSessionId, createdAt: "2026-01-01", mode: "single", background: true,
      cancelled: false, parentOwnerToken: "dead-owner", operatorEnabled: true, launcher: "unused", launchMode: "none", caller: manifest.placement,
      children: [{ childId: manifest.childId, taskId: manifest.taskId, attempt: 1, directory, spec: { task: "fixture", cwd: root },
        state: i < 2 ? "completed" : "running", reaped: i < 2, report: i < 2 ? report : undefined,
        operatorCapability: digit.repeat(64), started: true, notifiedSequence: 0 }] };
    groups.push(group); stores.push(store); manifests.push(manifest);
  }
  // Create the private group directory through the production constructor.
  const initial = new TuiNativeManager(root, () => "native", () => true, 16);
  await initial.shutdown(false);
  for (const g of groups) atomicPrivateJson(join(root, "groups", `${g.id}.json`), g);
  const server = new TuiWorkerServer(stores[2], { isIdle: () => true, send() {}, abort() {}, shutdown() {} });
  await server.start(); server.running(true);
  const manager: any = new TuiNativeManager(root, () => "native", () => true, 16);
  manager.owner = "session-0";
  const reaped: string[] = [];
  manager.tmux.reap = async (m: any) => { reaped.push(m.childId); };
  manager.tmux.inspect = async () => ({ dead: false });
  return { root, groups, server, manager, reaped, stores, manifests,
    close: async () => { await server.close(); await manager.shutdown(false); await rm(root, { recursive: true, force: true }); } };
}

test("root discovers multilevel orphan, blocks active ancestor reap, reconciles settlement and retains result", async () => {
  const f = await fixture();
  try {
    const listing = await f.manager.operation({ operation: "list" }, "session-0");
    assert.equal(listing.details.descendants.length, 2);
    assert.match(listing.content[0].text, new RegExp(f.groups[2].id));
    await assert.rejects(f.manager.operation({ operation: "reap", job_id: f.groups[0].id }, "session-0"), /Active descendants/);
    assert.deepEqual(f.reaped, []);
    f.server.outcome({ state: "delivered" });
    await assert.rejects(f.manager.operation({ operation: "reap", job_id: f.groups[0].id }, "session-0"), /Active descendants/);
    f.server.settled({ assistant: { stopReason: "stop", content: [{ type: "text", text: "leaf final answer" }] } });
    const done = await f.manager.operation({ operation: "list" }, "session-0");
    assert.equal(done.details.descendants[1].children[0].status, "completed");
    const saved: any = readPrivateJson(join(f.root, "groups", `${f.groups[2].id}.json`));
    assert.equal(saved.children[0].state, "completed", "stopped-parent state must be reconciled durably");
    assert.equal(saved.children[0].notifiedSequence, 0, "root must not consume child notifications");
    await f.manager.operation({ operation: "reap", job_id: f.groups[0].id }, "session-0");
    assert.deepEqual(f.reaped, [f.manifests[2].childId]);
    const result = await f.manager.operation({ operation: "result", job_id: f.groups[2].id }, "session-0");
    assert.equal(result.content[0].text, "leaf final answer");
    const unrelated: any = readPrivateJson(join(f.root, "groups", `${f.groups[3].id}.json`));
    assert.equal(unrelated.children[0].state, "running");
    for (const operation of ["status", "result", "reap", "prompt"]) {
      await assert.rejects(f.manager.operation({ operation, job_id: f.groups[3].id }, "session-0"), /different Pi session/);
    }
    await assert.rejects(f.manager.operation({ operation: "prompt", child_id: f.manifests[2].childId, message: "do work" }, "session-0"), /different Pi session/);
  } finally { await f.close(); }
});

test("selecting a reaped intermediate ancestor still blocks and then recovers its nested orphan", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.manager.operation({ operation: "reap", job_id: f.groups[1].id }, "session-0"), /Active descendants/);
    assert.deepEqual(f.reaped, []);
    f.server.settled({ assistant: { stopReason: "stop", content: "leaf" } });
    await f.manager.operation({ operation: "reap", job_id: f.groups[1].id }, "session-0");
    assert.deepEqual(f.reaped, [f.manifests[2].childId]);
  } finally { await f.close(); }
});

test("live multilevel cleanup preserves every result and seals descendants before their parents", async () => {
  const f = await fixture();
  const managers: any[] = [], servers: TuiWorkerServer[] = [];
  try {
    for (const group of f.groups.slice(0, 3)) {
      group.children[0].reaped = false;
      atomicPrivateJson(join(f.root, "groups", `${group.id}.json`), group);
    }
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      const manager: any = new TuiNativeManager(f.root, () => "native", () => true, 16);
      manager.owner = `session-${i}`;
      manager.tmux.reap = async (manifest: any) => {
        const result = await callTuiWorker(manifest, { operation: "prepare_reap" });
        assert.equal(result.ok, true, JSON.stringify(result));
        const state = new TuiWorkerStore(join(f.root, "workers", String(i + 1).repeat(24))).readState();
        assert.equal(state.sealed, true);
        assert.ok((readPrivateJson(state.jobCleanup!.artifact) as any).report);
        order.push(manifest.childId);
      };
      managers.push(manager);
    }
    for (let i = 0; i < 2; i++) {
      const server = new TuiWorkerServer(f.stores[i], { isIdle: () => true, send() {}, abort() {}, shutdown() {}, recursiveCleanup: true,
        prepareJobReap: preserve => managers[i + 1].prepareReap(`session-${i + 1}`, preserve) });
      await server.start(); server.settled({ assistant: { stopReason: "stop", content: `result-${i}` } }); servers.push(server);
    }
    (f.server as any).adapter.prepareJobReap = (preserve: any) => managers[3].prepareReap("session-3", preserve);
    f.server.settled({ assistant: { stopReason: "stop", content: "leaf" } });
    let rootReport: any;
    const release = await managers[0].prepareReap("session-0", async (report: any) => { rootReport = report; });
    assert.equal(rootReport.results[0].report.assistant.content, "result-0");
    assert.deepEqual(order, [f.manifests[2].childId, f.manifests[1].childId, f.manifests[0].childId]);
    release();
  } finally {
    for (const server of servers) await server.close();
    for (const manager of managers) await manager.shutdown(false);
    await f.close();
  }
});

test("old live worker cannot be stopped by reap without recursive cleanup capability", async () => {
  const f = await fixture();
  try {
    f.server.settled({ assistant: { stopReason: "stop", content: "done" } });
    const tmux: any = new TuiWorkerTmux();
    tmux.inspect = async () => ({ dead: false, panePid: 123 });
    tmux.run = async () => { throw new Error("No tmux mutation is permitted"); };
    await assert.rejects(tmux.reap(f.manifests[2]), /reload the live worker/);
    assert.equal(f.server.state.sealed, false);
    assert.equal(f.server.state.reapReservation, undefined);
  } finally { await f.close(); }
});

test("live descendant owner prevents persistence and ancestor takeover", async () => {
  const f = await fixture();
  try {
    f.server.settled({ assistant: { stopReason: "stop", content: "done" } });
    const lock = join(f.root, `owner-${createHash("sha256").update("session-2").digest("hex").slice(0, 32)}.lock`);
    atomicPrivateJson(lock, { pid: process.pid, token: f.manager.processToken(process.pid) });
    await f.manager.operation({ operation: "list" }, "session-0");
    assert.equal((readPrivateJson(join(f.root, "groups", `${f.groups[2].id}.json`)) as any).children[0].state, "running");
    await assert.rejects(f.manager.operation({ operation: "reap", job_id: f.groups[2].id }, "session-0"), /owner is live/);
    assert.deepEqual(f.reaped, []);
  } finally { await f.close(); }
});

test("corrupt retained inventory cannot authorize ancestor cleanup or escape the worker root", async () => {
  const f = await fixture();
  try {
    f.server.settled({ assistant: { stopReason: "stop", content: "done" } });
    const corrupt = structuredClone(f.groups[2]);
    corrupt.children[0].directory = join(f.root, "workers", "..", "outside", "3".repeat(24));
    atomicPrivateJson(join(f.root, "groups", `${corrupt.id}.json`), corrupt);
    await assert.rejects(f.manager.operation({ operation: "reap", job_id: f.groups[0].id }, "session-0"), /inventory is unverifiable/);
    await assert.rejects(f.manager.prepareReap("session-0", async () => {}), /inventory is unverifiable/);
    assert.deepEqual(f.reaped, []);
    assert.equal(f.manager.reapReserved, false);
  } finally { await f.close(); }
});

test("headless descendants block cleanup while active and preserve terminal results before reap", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-headless-clean-"));
  const manager: any = new HeadlessForegroundManager(root, () => "native", () => true, 16);
  manager.owner = "owner";
  const child = { childId: "child", taskId: "task", status: "running", directory: root };
  const group = { id: "group", owner: "owner", children: [child] };
  manager.groups.set("group", group);
  manager.observe = async () => {};
  manager.manifest = () => ({ execution: "rpc-headless" });
  manager.persist = () => {};
  let retained = false, reaps = 0;
  manager.sealAndReap = async () => { assert.equal(retained, true); reaps++; };
  try {
    await assert.rejects(manager.prepareReap("owner", async () => {}), /Active foreground descendants/);
    assert.equal(reaps, 0); assert.equal(manager.reapReserved, false);
    child.status = "completed";
    const release = await manager.prepareReap("owner", async () => { retained = true; });
    assert.equal(reaps, 1);
    await assert.rejects(manager.operation({ operation: "reap" }, "owner"), /cleanup reserved/);
    release(); assert.equal(manager.reapReserved, false);
  } finally { await manager.shutdown(false); await rm(root, { recursive: true, force: true }); }
});

test("local native cleanup reserves delegation and preserves results before recursive reap", async () => {
  const f = await fixture();
  try {
    f.manager.owner = "session-2";
    await assert.rejects(f.manager.prepareReap("session-2", async () => {}), /Active descendant/);
    assert.equal(f.manager.reapReserved, false);
    f.server.settled({ assistant: { stopReason: "stop", content: "done" } });
    let preserved = false;
    f.manager.tmux.reap = async () => { assert.equal(preserved, true); };
    const release = await f.manager.prepareReap("session-2", async (report: any) => {
      assert.equal(report.results[0].report.assistant.content, "done"); preserved = true;
    });
    await assert.rejects(f.manager.operation({ operation: "prompt", child_id: f.manifests[2].childId }, "session-2"), /cleanup reserved/);
    assert.equal(f.manager.reapReserved, true); release(); assert.equal(f.manager.reapReserved, false);
  } finally { await f.close(); }
});
