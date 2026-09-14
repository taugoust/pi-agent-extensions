import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TuiWorkerStore } from "./tui-worker-store.ts";
import { TuiWorkerServer, type TuiWorkerAdapter } from "./tui-worker-server.ts";
import { callTuiWorker } from "./tui-worker-client.ts";
import type { TuiWorkerManifest } from "../shared/tui-worker-protocol.ts";

async function fixture(adapter: Partial<TuiWorkerAdapter>, run: (server: TuiWorkerServer, store: TuiWorkerStore, manifest: TuiWorkerManifest, shutdowns: () => number) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pi-reap-jobs-"));
  const store = new TuiWorkerStore(root);
  const manifest: TuiWorkerManifest = { protocol: 1, ownerSessionId: "parent", taskId: "task", runtimeId: "runtime",
    groupId: `subagent-job-${"a".repeat(24)}`, childId: `subagent-child-${"b".repeat(24)}`, attempt: 1,
    workerEpoch: "c".repeat(32), controlToken: "d".repeat(64), controlSocket: join(root, "control.sock"), sessionFile: join(root, "session.jsonl"),
    presentation: "background", placement: { socketPath: "/tmp/tmux", serverEpoch: "1:2", sessionId: "$1", windowId: "@1", paneId: "%1", ownershipNonce: "e".repeat(64) } };
  store.writeManifest(manifest);
  let shutdowns = 0;
  const server = new TuiWorkerServer(store, { isIdle: () => true, send() {}, abort() {}, shutdown() { shutdowns++; }, ...adapter });
  try { await server.start(); await run(server, store, manifest, () => shutdowns); }
  finally { await new Promise(resolve => setTimeout(resolve, 40)); await server.close(); await rm(root, { recursive: true, force: true }); }
}

test("pre-reap cleanup preserves bounded output before seal and deduplicates successful cleanup", async () => {
  let cleanups = 0;
  await fixture({ async prepareJobReap(preserve) {
    cleanups++;
    await preserve({ jobs: [{ job_id: "job-fixture", status: "completed", output: "useful result" }] });
    return () => { throw new Error("successful seal must retain job reservation"); };
  } }, async (server, store, manifest) => {
    const result = await callTuiWorker(manifest, { operation: "prepare_reap" }, { requestId: "same" });
    assert.equal(result.ok, true);
    assert.deepEqual(await callTuiWorker(manifest, { operation: "prepare_reap" }, { requestId: "same" }), result);
    assert.equal(cleanups, 1);
    assert.equal(server.sealed, true);
    assert.match(await readFile(store.readState().jobCleanup!.artifact, "utf8"), /useful result/);
  });
});

test("cleanup errors retain live control, expose blocking IDs, and allow same-ID repair/retry", async () => {
  let fail = true;
  await fixture({ async prepareJobReap(preserve) {
    if (fail) throw new Error("Active jobs remain: job-123; adopted jobs require explicit resolution: job-456");
    await preserve({ jobs: [] }); return () => {};
  }, async jobs() { return { jobs: ["job-123"] }; } }, async (server, store, manifest, shutdowns) => {
    const request = { operation: "prepare_reap" as const };
    const response = await callTuiWorker(manifest, request, { requestId: "repairable" });
    assert.equal(response.ok, false);
    if (!response.ok) assert.match(response.message, /job-123.*job-456/);
    assert.equal(server.sealed, false);
    assert.equal(server.preparingReap, false);
    assert.equal(store.readState().sealed, false);
    assert.equal(shutdowns(), 0);
    assert.equal((await callTuiWorker(manifest, { operation: "jobs", params: { action: "list" } })).ok, true);
    fail = false;
    assert.equal((await callTuiWorker(manifest, request, { requestId: "repairable" })).ok, true);
  });
});

test("human-start race during asynchronous cleanup aborts reservation, never seals or shuts down", async () => {
  let enter!: () => void, finish!: () => void, releases = 0;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  await fixture({ async prepareJobReap(preserve) {
    enter(); await pending; await preserve({ jobs: [] }); return () => { releases++; };
  } }, async (server, store, manifest, shutdowns) => {
    const reap = callTuiWorker(manifest, { operation: "prepare_reap" });
    await entered;
    assert.equal(server.preparingReap, true);
    assert.equal(store.readState().sealed, false, "temporary reservation must not be persisted as shutdown seal");
    assert.equal(server.running(true), false);
    finish();
    const result = await reap;
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /activity changed/);
    assert.equal(releases, 1);
    assert.equal(shutdowns(), 0);
    assert.equal(server.running(true), true, "failed cleanup must not disable later human work");
  });
});

test("missing controller and absent preservation verification refuse safely", async () => {
  for (const adapter of [{}, { async prepareJobReap() { return () => {}; } }]) {
    await fixture(adapter, async (server, store, manifest, shutdowns) => {
      assert.equal((await callTuiWorker(manifest, { operation: "prepare_reap" })).ok, false);
      assert.equal(store.readState().sealed, false);
      assert.equal(server.preparingReap, false);
      assert.equal(shutdowns(), 0);
    });
  }
});

test("authentication rejects foreign sessions and sibling epochs before cleanup", async () => {
  let invoked = 0;
  await fixture({ async prepareJobReap(preserve) { invoked++; await preserve({ jobs: [] }); return () => {}; } }, async (_server, _store, manifest) => {
    for (const foreign of [{ ...manifest, ownerSessionId: "other-session" }, { ...manifest, workerEpoch: "0".repeat(32) }, { ...manifest, controlToken: "0".repeat(64) }]) {
      assert.equal((await callTuiWorker(foreign, { operation: "prepare_reap" })).ok, false);
    }
    assert.equal(invoked, 0);
  });
});

test("oversized cleanup errors remain bounded authenticated responses", async () => {
  await fixture({ async prepareJobReap() { throw new Error("界".repeat(100000)); } }, async (_server, _store, manifest) => {
    const result = await callTuiWorker(manifest, { operation: "prepare_reap" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(Buffer.byteLength(result.message) < 9000);
      assert.match(result.message, /truncated/);
      assert.ok(!result.message.includes("\ufffd"));
    }
  });
});

test("artifact write failure prevents successful cleanup and keeps worker usable", async () => {
  let deleted = false;
  await fixture({ async prepareJobReap(preserve) { await preserve({ jobs: [] }); deleted = true; return () => {}; } }, async (server, store, manifest) => {
    store.artifact = () => { throw new Error("disk full"); };
    const result = await callTuiWorker(manifest, { operation: "prepare_reap" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /disk full/);
    assert.equal(deleted, false);
    assert.equal(server.sealed, false);
    assert.equal(server.running(), true);
  });
});
