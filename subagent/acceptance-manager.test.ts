import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TuiNativeManager } from "./tui-native.ts";
import { TuiWorkerStore, readPrivateJson, atomicPrivateJson } from "./tui-worker-store.ts";
import { TuiWorkerServer } from "./tui-worker-server.ts";
import { callTuiWorker } from "./tui-worker-client.ts";
import type { VerificationJobs } from "./acceptance.ts";

/** Actual manager operations and authenticated native worker socket, no provider. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "accept-manager-")), cwd = mkdtempSync(join(tmpdir(), "accept-workspace-"));
  const directory = join(root, "workers", "a".repeat(24));
  const store = new TuiWorkerStore(directory, true), gates = [{ command: "fixture check" }];
  const manifest: any = { protocol: 1, ownerSessionId: "parent", taskId: `subagent-task-${"b".repeat(24)}`, runtimeId: "runtime-1",
    groupId: `subagent-job-${"c".repeat(24)}`, childId: `subagent-child-${"d".repeat(24)}`, attempt: 1,
    workerEpoch: "e".repeat(32), controlToken: "f".repeat(64), controlSocket: join(directory, "control.sock"), sessionFile: join(directory, "session.jsonl"),
    acceptance: ["fixture"], verification: gates, presentation: "background", launchMode: "none",
    placement: { socketPath: "/tmp/test-tmux", serverEpoch: "1:2", sessionId: "$1", windowId: "@1", paneId: "%1", ownershipNonce: "a".repeat(64) } };
  store.writeManifest(manifest);
  writeFileSync(manifest.sessionFile, JSON.stringify({ type: "session", id: "worker-session" }) + "\n", { mode: 0o600 });
  const jobId = `job-${"a".repeat(24)}`;
  const jobs: VerificationJobs = { async start() { return { details: { job_id: jobId } }; }, async resolve() { return jobId; }, async attest() { return true; },
    async execute() { return { details: { job_id: jobId, status: "completed", exit_code: 0, streams: { available: true, stdout: "literal historical stdout\n", stderr: "literal historical stderr\n" } } }; } };
  const server = new TuiWorkerServer(store, { isIdle: () => true, verificationCwd: () => cwd, verificationJobs: () => jobs, send() {}, abort() {}, shutdown() {} });
  await server.start(); server.running(true);
  await server.outcome({ version: 1, state: "delivered", summary: "Worker reported delivery", acceptance: [{ criterion: "fixture", status: "passed", evidence: "worker evidence" }], artifacts: [], remaining: [] });
  server.settled({ assistant: { content: "Historical worker answer café 🐈", stopReason: "stop" }, timestamp: new Date().toISOString() });
  await (server as any).verificationFlight;
  const group: any = { version: 1, id: manifest.groupId, owner: "parent", createdAt: new Date().toISOString(), mode: "single", background: true,
    cancelled: false, caller: manifest.placement, parentOwnerToken: "test", operatorEnabled: true, launcher: "unused", launchMode: "none", children: [{
      childId: manifest.childId, taskId: manifest.taskId, attempt: 1, directory, spec: { task: "fixture", cwd, acceptance: ["fixture"], verification: gates },
      state: "running", operatorCapability: "a".repeat(64), started: true, notifiedSequence: 0, terminalNotification: "" }] };
  const notifications: any[] = [];
  const configure = (manager: any) => {
    manager.owner = "parent";
    manager.notify = (update: any) => { notifications.push(update); return true; };
    manager.tmux.inspect = async () => ({ dead: false }); // disconnect is not proof of process death
    return manager;
  };
  const manager = configure(new TuiNativeManager(root, () => "native", () => false, 16));
  manager.groups.set(group.id, group);
  const operation = (m: any, op: string, extra: any = {}) => m.operation({ operation: op, ...(op === "list" ? {} : { job_id: group.id }), ...extra }, "parent");
  const close = async (...managers: any[]) => { await server.close(); for (const m of managers) await m.shutdown(false); rmSync(root, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); };
  return { root, cwd, store, manifest, group, manager, server, notifications, configure, operation, close };
}
const child = (response: any) => (response.details.group ?? response.details.groups[0]).children[0];
function unaccepted(c: any) {
  assert.notEqual(c.verification.status, "passed"); assert.equal(c.accepted_delivery, false);
  for (const run of c.verification.runs ?? []) assert.notEqual(run.status, "passed", "historical per-command pass leaked into current check state");
}

test("parent verify operation independently invokes configured worker gates", async () => {
  const f = await fixture();
  try {
    const result = await f.operation(f.manager, "verify");
    assert.equal(result.details.operation, "verify");
    assert.ok(["checking", "passed"].includes(result.details.results[0].verification.status));
    assert.equal(result.details.pending, result.details.results.some((entry: any) => entry.verification.status === "checking"));
    assert.equal(result.details.failed, false, "checking is pending, not a failed gate result");
    assert.equal(result.isError, false);
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = child(await f.operation(f.manager, "status"));
      if (current.verification.status === "passed") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const finished = child(await f.operation(f.manager, "status"));
    assert.equal(finished.verification.status, "passed");
    assert.equal(finished.accepted_delivery, true);
  } finally { await f.close(f.manager); }
});

test("normal reap gate stays outside manager serialization; status and cancel remain responsive", async () => {
  const f = await fixture();
  let releaseStart!: () => void;
  const blocked = new Promise<void>(resolve => { releaseStart = resolve; });
  const jobId = `job-${"9".repeat(24)}`;
  let starts = 0;
  try {
    writeFileSync(join(f.cwd, "invalidate-pass"), "workspace changed");
    (f.server as any).adapter.verificationJobs = () => ({
      async start() { starts++; await blocked; return { details: { job_id: jobId } }; },
      async resolve() { return jobId; }, async attest() { return true; },
      async execute(_id: string, params: any) {
        if (params.action === "reap" || params.action === "cancel") return { isError: false };
        return { details: { job_id: jobId, status: "completed", exit_code: 0,
          streams: { available: true, stdout: "cancelled check output", stderr: "" } } };
      },
    });
    f.manager.tmux.reap = async (manifest: any, _timeout: any, options: any) => {
      const reply = await callTuiWorker(manifest, { operation: "prepare_reap", ...(options?.force ? options : {}) }, { requestId: "reap-gate" });
      if (!reply.ok) throw new Error(`${reply.code}: ${reply.message}`);
    };
    const reap = f.operation(f.manager, "reap");
    for (let attempt = 0; attempt < 100 && starts === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(starts, 1, "normal reap started the invalidated gate");
    const status = await f.operation(f.manager, "status");
    assert.equal(status.details.group.reaping, true);
    assert.equal(child(status).verification.status, "checking");
    const cancelled = await Promise.race([f.operation(f.manager, "cancel"), new Promise(resolve => setTimeout(() => resolve(undefined), 100))]);
    assert.ok(cancelled, "parent cancellation is not serialized behind the gate");
    releaseStart();
    await assert.rejects(reap, /unavailable|cancelled/i, "cancelled verification prevents normal reap");
    assert.equal(f.store.readState().sealed, false, "failed/cancelled verification never seals the worker");
    assert.equal(child(await f.operation(f.manager, "status")).reaped, false, "worker remains available for repair");
    assert.equal(f.manager.groups.get(f.group.id).reaping, undefined);
    assert.equal(f.store.readState().verification?.status, "cancelled");
  } finally { releaseStart(); await f.close(f.manager); }
});

test("forced mixed-group reap audits only gated children and does not alter acceptance", async () => {
  const f = await fixture();
  try {
    const gated = f.group.children[0];
    await f.manager.observe(f.group, gated);
    assert.equal(gated.state, "completed", "force-reap fixture must reconcile the settled worker before cleanup");
    const ungatedId = `subagent-child-${"1".repeat(24)}`;
    const ungatedTaskId = `subagent-task-${"2".repeat(24)}`;
    const directory = join(f.root, "workers", "f".repeat(24));
    const ungatedManifest = { ...f.manifest, childId: ungatedId, taskId: ungatedTaskId, directory,
      controlSocket: join(directory, "control.sock"), sessionFile: join(directory, "session.jsonl"), verification: undefined,
      placement: { ...f.manifest.placement, paneId: "%2", ownershipNonce: "9".repeat(64) } };
    const { mkdirSync } = await import("node:fs"); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const ungatedStore = new TuiWorkerStore(directory, true); ungatedStore.writeManifest(ungatedManifest);
    writeFileSync(ungatedManifest.sessionFile, JSON.stringify({ type: "session", id: "ungated-session" }) + "\n", { mode: 0o600 });
    const ungated: any = { ...gated, childId: ungatedId, taskId: ungatedTaskId, directory,
      spec: { ...gated.spec, verification: undefined, worktree: { path: join(f.root, "retained-worktree") } },
      state: "completed", reaped: false, verificationBypasses: undefined };
    f.group.children.push(ungated);
    gated.acceptedDelivery = false;
    gated.verification = { status: "failed", runs: [] } as any;
    const calls: any[] = [];
    f.manager.tmux.reap = async (manifest: any, timeout: any, options: any) => { calls.push({ manifest, timeout, options }); };
    await (f.manager as any).reapChild(f.group, gated, { force: true, reason: "retain failed worker" });
    await (f.manager as any).reapChild(f.group, ungated, { force: true, reason: "retain failed worker" });
    assert.equal(calls.length, 2, "force reaches both gated and ungated children");
    assert.equal(calls[0].options.force, true); assert.equal(calls[1].options.force, true);
    assert.equal(gated.verificationBypasses.length, 1);
    assert.equal(ungated.verificationBypasses, undefined, "ungated sibling has no verification bypass to audit");
    assert.equal(gated.acceptedDelivery, false, "force never turns a failed check into accepted delivery");
    assert.equal(ungated.reaped, true);
    assert.equal(ungated.spec.worktree.path, join(f.root, "retained-worktree"), "force retains worktree metadata for coordinator review");
  } finally { await f.close(f.manager); }
});

test("manager status/list/result revoke a disconnected completed worker's cached acceptance and retain historical evidence", async () => {
  const f = await fixture(); let restored: any;
  try {
    assert.equal(child(await f.operation(f.manager, "status")).accepted_delivery, true);
    assert.equal(child(await f.operation(f.manager, "list")).accepted_delivery, true);
    const savedPass = readPrivateJson(join(f.root, "groups", `${f.group.id}.json`));
    const report = f.store.readState().lastReport!;
    await f.server.close(); writeFileSync(join(f.cwd, "changed"), "workspace changed while worker disconnected");
    const status = child(await f.operation(f.manager, "status"));
    unaccepted(status); assert.equal(status.verification.status, "unavailable");
    assert.equal(status.historical_verification.historical, true);
    assert.equal(status.historical_verification.last_observed_status, "passed");
    assert.equal(status.historical_verification.provenance, "live-worker-observation");
    assert.equal(status.task_outcome.state, "delivered", "worker claims must remain distinct, not rewritten");
    unaccepted(child(await f.operation(f.manager, "list")));
    for (const op of ["output", "tasks"]) unaccepted(child(await f.operation(f.manager, op)));
    for (const diagnostics of [false, true]) {
      const result = await f.operation(f.manager, "result", { diagnostics });
      assert.equal(result.details.accepted_delivery, false); assert.equal(result.details.failed, true);
      assert.notEqual(result.details.verification.status, "passed");
      if (diagnostics) {
        assert.ok(result.content[0].text.startsWith("Historical worker answer"));
        assert.match(result.content[0].text, /Accepted delivery: false/);
        assert.match(result.content[0].text, /Retained command evidence: historical only/);
        assert.match(result.content[0].text, /Current verification: unavailable/);
        assert.doesNotMatch(result.content[0].text, /sessionFile|textSignature|runtimeVerification/);
        const pages: string[] = []; let offset = 0;
        for (;;) {
          const page = await f.operation(f.manager, "result", { diagnostics: true, offset, limit: 40 });
          assert.ok(Buffer.byteLength(page.content[0].text) <= 40);
          assert.doesNotMatch(page.content[0].text, /\uFFFD/);
          pages.push(page.content[0].text);
          if (page.details.complete) break;
          assert.ok(page.details.next_offset > offset); offset = page.details.next_offset;
        }
        assert.equal(pages.join(""), result.content[0].text);
      } else assert.match(result.content[0].text, /historical.*accepted_delivery=false/);
    }
    await f.operation(f.manager, "status"); await f.operation(f.manager, "list");
    assert.equal(f.notifications.filter(n => n.completion && n.state === "completed").length, 1, "disconnection replayed a success notification");
    assert.equal(f.notifications.filter(n => n.completion && n.state === "failed").length, 1, "invalidated acceptance must notify once, not repeatedly");
    assert.equal((readPrivateJson(report) as any).runtimeVerification.runs[0].stdout, "literal historical stdout\n");
    // Simulate a parent crash/reload with the previously persisted GREEN cache.
    await f.manager.shutdown(false); atomicPrivateJson(join(f.root, "groups", `${f.group.id}.json`), savedPass);
    restored = f.configure(new TuiNativeManager(f.root, () => "native", () => false, 16));
    const loaded = restored.groups.get(f.group.id);
    const cold = restored.publicGroup(loaded).children[0];
    unaccepted(cold); assert.equal(cold.historical_verification.provenance, "retained-unverified");
    assert.equal(cold.historical_verification.last_observed_status, undefined);
    unaccepted(child(await f.operation(restored, "status"))); unaccepted(child(await f.operation(restored, "list")));
    assert.equal((await f.operation(restored, "result")).details.accepted_delivery, false);
  } finally { await f.close(f.manager, ...(restored ? [restored] : [])); }
});

test("manager missing/non-ok observations and live workspace changes cannot leak cached pass on public surfaces", async () => {
  const f = await fixture();
  try {
    assert.equal(child(await f.operation(f.manager, "status")).accepted_delivery, true);
    unlinkSync(f.store.path("manifest.json"));
    unaccepted(child(await f.operation(f.manager, "status"))); unaccepted(child(await f.operation(f.manager, "list")));
    assert.equal((await f.operation(f.manager, "result")).details.accepted_delivery, false);
    f.store.writeManifest(f.manifest);
    assert.equal(child(await f.operation(f.manager, "status")).accepted_delivery, true, "fresh authenticated observation may restore acceptance");
    f.store.writeManifest({ ...f.manifest, controlToken: "b".repeat(64) }); // real non-ok authenticated RPC response
    unaccepted(child(await f.operation(f.manager, "status"))); unaccepted(child(await f.operation(f.manager, "list")));
    assert.equal((await f.operation(f.manager, "result")).details.accepted_delivery, false);
    f.store.writeManifest(f.manifest);
    assert.equal(child(await f.operation(f.manager, "status")).accepted_delivery, true);
    writeFileSync(join(f.cwd, "changed"), "changed after successful observation, before rendering");
    const current = f.manager.publicGroup(f.group).children[0];
    unaccepted(current); assert.equal(current.verification.status, "stale");
    const result = await f.operation(f.manager, "result");
    assert.equal(result.details.verification.status, "stale"); assert.equal(result.details.accepted_delivery, false); assert.equal(result.details.failed, true);
    unaccepted(child(await f.operation(f.manager, "status"))); unaccepted(child(await f.operation(f.manager, "list")));
  } finally { await f.close(f.manager); }
});

test("parent reload needs a fresh authenticated worker observation, then permits an unchanged live result", async () => {
  const f = await fixture(); let restored: any;
  try {
    assert.equal(child(await f.operation(f.manager, "status")).accepted_delivery, true);
    await f.manager.shutdown(false);
    restored = f.configure(new TuiNativeManager(f.root, () => "native", () => false, 16));
    unaccepted(restored.publicGroup(restored.groups.get(f.group.id)).children[0]);
    assert.equal(child(await f.operation(restored, "status")).accepted_delivery, true);
    assert.equal(child(await f.operation(restored, "list")).accepted_delivery, true);
    const result = await f.operation(restored, "result", { diagnostics: true });
    assert.equal(result.details.accepted_delivery, true);
    assert.equal(result.details.verification.status, "passed");
    assert.ok(result.content[0].text.startsWith("Historical worker answer"));
    assert.match(result.content[0].text, /Accepted delivery: true/);
    assert.match(result.content[0].text, new RegExp(`Task: ${f.manifest.taskId}`));
    assert.equal(f.notifications.filter(n => n.completion && n.state === "completed").length, 1, "parent reload duplicated successful terminal receipt");
  } finally { await f.close(f.manager, ...(restored ? [restored] : [])); }
});
