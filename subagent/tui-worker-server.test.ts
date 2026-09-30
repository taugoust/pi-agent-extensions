import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { TuiWorkerStore } from "./tui-worker-store.ts";
import { TuiWorkerServer } from "./tui-worker-server.ts";
import { callTuiWorker, applyTuiWorkerOperatorMode } from "./tui-worker-client.ts";
import type { TuiWorkerManifest } from "../shared/tui-worker-protocol.ts";

export function manifestAt(directory: string): TuiWorkerManifest {
  return { protocol: 1, ownerSessionId: "parent", taskId: "task-1", runtimeId: "runtime-1",
    groupId: `subagent-job-${"a".repeat(24)}`, childId: `subagent-child-${"b".repeat(24)}`,
    attempt: 1, workerEpoch: "c".repeat(32), controlToken: "d".repeat(64),
    controlSocket: join(directory, "control.sock"), sessionFile: join(directory, "session.jsonl"),
    placement: { socketPath: "/tmp/tmux-test", serverEpoch: "123:456", sessionId: "$1", windowId: "@1", paneId: "%1", ownershipNonce: "e".repeat(64) },
    presentation: "background", launchMode: "none" };
}

test("child-hosted control reconnects, deduplicates, observes direct work and seals idle reap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-worker-"));
  const store = new TuiWorkerStore(directory);
  const manifest = manifestAt(directory);
  const operator = "f".repeat(64);
  manifest.operatorCapabilityHash = createHash("sha256").update(operator).digest("hex");
  store.writeManifest(manifest);
  let idle = true, sends = 0, shutdowns = 0, mode: boolean | undefined;
  const prepareJobReap = async (preserve: (report: unknown) => Promise<void>) => { await preserve({ jobs: [] }); return () => {}; };
  let server = new TuiWorkerServer(store, { isIdle: () => idle, prepareJobReap,
    send: () => { sends++; idle = false; }, abort: () => { idle = true; },
    shutdown: () => { shutdowns++; }, applyOperatorMode: enabled => { mode = enabled; } });
  try {
    await server.start();
    assert.equal((await callTuiWorker(manifest, { operation: "status" })).ok, true);
    assert.equal((await callTuiWorker({ ...manifest, controlToken: "0".repeat(64) }, { operation: "status" })).ok, false);
    const prompt = { operation: "prompt" as const, mode: "steer" as const, message: "/permission-gate off" };
    const receipt = await callTuiWorker(manifest, prompt, { requestId: "same" });
    assert.equal(receipt.ok, true);
    assert.deepEqual(await callTuiWorker(manifest, prompt, { requestId: "same" }), receipt);
    assert.equal(sends, 1);
    assert.equal((await callTuiWorker(manifest, { ...prompt, message: "different" }, { requestId: "same" })).ok, false);
    assert.equal((await callTuiWorker(manifest, { operation: "prepare_reap" })).ok, false);
    assert.equal((await applyTuiWorkerOperatorMode(manifest, manifest.controlToken, false)).ok, false);
    assert.equal(mode, undefined);
    assert.equal((await applyTuiWorkerOperatorMode(manifest, operator, false)).ok, true);
    assert.equal(mode, false);
    await callTuiWorker(manifest, { operation: "cancel" });
    assert.equal(shutdowns, 0);
    server.settled({ final: "retained report" });
    const retained = store.readState().lastReport;
    assert.ok(retained);
    // Human turn starts after completion: the live idle check defeats stale parent status.
    idle = false;
    server.running();
    assert.equal((await callTuiWorker(manifest, { operation: "prepare_reap" })).ok, false);
    idle = true;
    server.settled({ final: "second report" });
    await server.close();
    // Extension reload keeps receipts and reports, without restarting the Pi process.
    server = new TuiWorkerServer(store, { isIdle: () => idle, prepareJobReap, send: () => { sends++; }, abort: () => {}, shutdown: () => { shutdowns++; } });
    await server.start();
    assert.deepEqual(await callTuiWorker(manifest, prompt, { requestId: "same" }), receipt);
    assert.equal(sends, 1);
    assert.equal((await callTuiWorker(manifest, { operation: "prepare_reap" }, { requestId: "reap" })).ok, true);
    assert.equal(server.running(), false);
    assert.equal((await callTuiWorker(manifest, prompt)).ok, false);
    assert.equal(store.readState().sealed, true);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(shutdowns >= 1);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("known prompt refusal stays idle; uncertain dispatch remains non-replayable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-worker-refusal-"));
  const store = new TuiWorkerStore(directory);
  const manifest = manifestAt(directory);
  store.writeManifest(manifest);
  let idle = true, available = false, sends = 0, aborts = 0, revokeOnAbort = false, uncertainSend = false;
  const server = new TuiWorkerServer(store, {
    isIdle: () => idle, canRun: () => available, shutdown() {},
    abort() { aborts++; idle = true; if (revokeOnAbort) available = false; },
    send() { sends++; if (uncertainSend) throw new Error("uncertain dispatch"); idle = false; },
  });
  try {
    await server.start();
    for (const mode of ["steer", "follow_up", "interrupt"] as const) {
      const refused = await callTuiWorker(manifest, { operation: "prompt", mode, message: "work" });
      assert.equal(refused.ok, false);
      assert.equal(refused.code, "unavailable");
      assert.equal(store.readState().active, false);
      assert.equal(store.readState().phase, "ready");
      assert.equal(Object.keys(store.readState().receipts).length, 0);
    }
    assert.equal(sends, 0); assert.equal(aborts, 0);
    available = true; revokeOnAbort = true; idle = false; server.running(true);
    const prompt = { operation: "prompt" as const, mode: "interrupt" as const, message: "replacement" };
    const refused = await callTuiWorker(manifest, prompt, { requestId: "interrupt" });
    assert.equal(refused.ok, false); assert.equal(refused.code, "unavailable");
    assert.equal(sends, 0); assert.equal(aborts, 1);
    assert.equal(store.readState().active, false);
    assert.deepEqual(await callTuiWorker(manifest, prompt, { requestId: "interrupt" }), refused);
    available = true; revokeOnAbort = false; uncertainSend = true;
    const uncertain = { operation: "prompt" as const, mode: "steer" as const, message: "uncertain" };
    assert.equal((await callTuiWorker(manifest, uncertain, { requestId: "uncertain" })).code, "ambiguous");
    assert.equal((await callTuiWorker(manifest, uncertain, { requestId: "uncertain" })).code, "ambiguous");
    assert.equal(sends, 1, "uncertain dispatch was automatically replayed");
    assert.equal(store.readState().active, true, "uncertain dispatch became reapable");
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});
