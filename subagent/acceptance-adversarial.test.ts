import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialVerification, runVerification, recoverVerification, workspaceIdentity, type VerificationJobs } from "./acceptance.ts";
import { TuiWorkerStore } from "./tui-worker-store.ts";
import { TuiWorkerServer } from "./tui-worker-server.ts";
import { workerRequest } from "./tui-worker-client.ts";

const jobId = `job-${"a".repeat(24)}`;
const dispatchId = `verify:${"c".repeat(32)}:${"b".repeat(24)}`;
const identity = (cwd: string) => ({ ownerSessionId: "parent", taskId: "task-1", childId: `subagent-child-${"b".repeat(24)}`, attempt: 1, workerEpoch: "c".repeat(32), runtimeId: "runtime-1", cwd });
const temp = () => mkdtempSync(join(tmpdir(), "gate-adversarial-"));
const delivered = { version: 1, state: "delivered", summary: "fabricated", acceptance: [{ criterion: "fixture", status: "passed", evidence: "fabricated" }], artifacts: [], remaining: [] };
function manifestAt(directory: string, cwd: string, gates: any[]) {
  return { protocol: 1 as const, ...identity(cwd), acceptance: ["fixture"], verification: gates, groupId: `subagent-job-${"a".repeat(24)}`,
    controlToken: "d".repeat(64), controlSocket: join(directory, "control.sock"), sessionFile: join(directory, "session.jsonl"),
    placement: { socketPath: "/tmp/tmux-test", serverEpoch: "123:456", sessionId: "$1", windowId: "@1", paneId: "%1", ownershipNonce: "e".repeat(64) }, presentation: "background" as const };
}

test("review P1: perfectly shaped persisted pass cannot authorize an unexecuted exit-7 gate", async () => {
  const directory = temp(), cwd = temp(), store = new TuiWorkerStore(directory);
  const gates = [{ command: "exit 7" }], id = identity(cwd);
  const manifest = manifestAt(directory, cwd, gates);
  store.writeManifest(manifest);
  const w = workspaceIdentity(cwd), record = initialVerification(id, gates);
  record.status = "passed";
  record.runs = [{ gate: gates[0], status: "passed", startedAt: "invented", exitCode: 0, stdout: "fake", stderr: "", truncated: false, workspaceBefore: w, workspaceAfter: w }];
  store.writeState({ version: 1, sequence: 0, active: false, sealed: false, phase: "settled", receipts: {}, events: [],
    lastOutcome: store.artifact("outcome", 1, delivered), lastReport: store.report(2, { assistant: { content: "done" } }), verification: record });
  const server = new TuiWorkerServer(store, { isIdle: () => true, verificationCwd: () => cwd, send() {}, abort() {}, shutdown() {} });
  try {
    const reply = await server.handle(workerRequest(manifest, { operation: "status" }, "forged"));
    assert.equal((reply.data as any).verification.status, "interrupted");
    assert.equal((reply.data as any).accepted_delivery, false);
  } finally { await server.close(); rmSync(directory, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); }
});

test("review P1: receipt lost after durable dispatch is resolved/cancelled without relaunch, including unavailable recovery", async () => {
  const cwd = temp(), gates = [{ command: "sleep 60" }], record = initialVerification(identity(cwd), gates);
  let resolves = 0, starts = 0, cancelled = false, reaped = false, available = false;
  const calls: string[] = [];
  const evidence = () => ({ details: { job_id: jobId, status: cancelled ? "cancelled" : "running", exit_code: null, streams: { available: true, stdout: "real partial stdout", stderr: "real partial stderr" } } });
  const jobs: VerificationJobs = {
    async start() { starts++; throw new Error("receipt lost after dispatch"); },
    async resolve() { calls.push("resolve"); resolves++; return available ? jobId : undefined; },
    async attest() { return true; },
    async execute(_id, params) { calls.push(params.action); if (params.action === "cancel") cancelled = true; if (params.action === "reap") reaped = true; return evidence(); },
  };
  try {
    await runVerification(record, gates, jobs, () => {});
    assert.equal(record.status, "unavailable"); assert.ok(record.runs[0].dispatchId); assert.equal(record.runs[0].jobId, undefined);
    available = true;
    await recoverVerification(record, jobs, () => {});
    assert.equal(starts, 1); assert.ok(resolves >= 2); assert.ok(cancelled); assert.ok(reaped);
    assert.equal(record.runs[0].stdout, "real partial stdout");
    assert.deepEqual(calls.slice(-5), ["resolve", "status", "cancel", "output", "reap"]);
    assert.notEqual(record.status, "passed");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("review P2: unavailable/failed output retrieval retains logs and durable cleanup intent; repair can retry", async () => {
  const cwd = temp(), gates = [{ command: "check" }], record = initialVerification(identity(cwd), gates);
  record.status = "checking";
  record.runs = [{ gate: gates[0], status: "checking", startedAt: new Date().toISOString(), dispatchId, jobId, dispatchState: "observed", exitCode: null, stdout: "", stderr: "", truncated: false }];
  let readable = false, reaped = 0, durableEvidence = false;
  const jobs: VerificationJobs = {
    async start() { throw new Error("must not replay"); }, async resolve() { return jobId; }, async attest() { return true; },
    async execute(_id, params) {
      if (params.action === "reap") { assert.ok(durableEvidence); reaped++; }
      if (params.action === "output" && !readable) return { isError: true, details: { streams: { available: false } } };
      return { details: { job_id: jobId, status: "completed", exit_code: 0, streams: { available: true, stdout: "preserved real stdout", stderr: "preserved real stderr" } } };
    },
  };
  const persist = () => { if (record.runs[0].evidenceCaptured && record.runs[0].stdout === "preserved real stdout") durableEvidence = true; };
  try {
    await recoverVerification(record, jobs, persist);
    assert.equal(reaped, 0); assert.equal(record.runs[0].status, "unavailable"); assert.equal(record.runs[0].dispatchState, "cleanup-pending");
    readable = true; await recoverVerification(record, jobs, persist);
    assert.equal(reaped, 1); assert.equal(record.runs[0].stderr, "preserved real stderr"); assert.equal(record.runs[0].dispatchState, "cleaned");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("unresolved verification output also blocks the ordinary recursive worker reap path", async () => {
  const directory = temp(), cwd = temp(), store = new TuiWorkerStore(directory), gates = [{ command: "check" }];
  const manifest = manifestAt(directory, cwd, gates), record = initialVerification(identity(cwd), gates);
  store.writeManifest(manifest); record.status = "checking";
  record.runs = [{ gate: gates[0], status: "checking", startedAt: new Date().toISOString(), dispatchId, jobId, dispatchState: "observed", exitCode: null, stdout: "", stderr: "", truncated: false }];
  store.writeState({ version: 1, sequence: 0, active: true, sealed: false, phase: "running", receipts: {}, events: [], verification: record,
    verificationReport: store.report(0, { assistant: { content: "worker finished" } }) });
  let ordinaryCleanup = 0, removed = false;
  const jobs: VerificationJobs = { async start() { throw new Error("never replay"); }, async resolve() { return jobId; }, async attest() { return true; },
    async execute(_id, params) { if (params.action === "reap") removed = true;
      return params.action === "output" ? { isError: true, details: { streams: { available: false } } }
        : { details: { job_id: jobId, status: "completed", exit_code: 0 } }; } };
  const server = new TuiWorkerServer(store, { isIdle: () => true, verificationCwd: () => cwd, verificationJobs: () => jobs,
    recursiveCleanup: true, async prepareJobReap() { ordinaryCleanup++; return () => {}; }, send() {}, abort() {}, shutdown() {} });
  try {
    await server.start();
    const reply = await server.handle(workerRequest(manifest, { operation: "prepare_reap" }, "must-retain-logs"));
    assert.equal(reply.ok, false); assert.equal((reply as any).code, "verification_cleanup_incomplete");
    assert.equal(ordinaryCleanup, 0); assert.equal(removed, false);
    assert.equal(store.readState().verification?.runs[0].jobId, jobId);
    assert.equal(store.readState().verification?.runs[0].dispatchState, "cleanup-pending");
  } finally { await server.close(); rmSync(directory, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); }
});
