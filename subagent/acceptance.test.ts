// Typed gate controls adapted from nicobailon/pi-subagents test/unit/typed-gate-output.test.ts
// at 3ce6185a. MIT Copyright (c) 2026 Nico Bailon; see agents/LICENSE.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialVerification, runVerification, recoverVerification, currentVerification, validateVerification, workspaceIdentity, type VerificationGate, type VerificationJobs, type VerificationIdentity } from "./acceptance.ts";
import { TuiWorkerStore, readPrivateJson } from "./tui-worker-store.ts";
import { TuiWorkerServer } from "./tui-worker-server.ts";
import { workerRequest } from "./tui-worker-client.ts";
import type { TuiWorkerManifest } from "../shared/tui-worker-protocol.ts";

const jobId = `job-${"a".repeat(24)}`;
const temp = () => mkdtempSync(join(tmpdir(), "verify-"));
const identity = (cwd: string): VerificationIdentity => ({ ownerSessionId: "parent", taskId: "task-1", childId: `subagent-child-${"b".repeat(24)}`, attempt: 1, workerEpoch: "c".repeat(32), runtimeId: "runtime-1", cwd });
function supervisor(options: { code?: number; stdout?: string; stderr?: string; truncated?: boolean; running?: boolean; deny?: boolean; cleanupFail?: boolean; onWait?: () => void } = {}) {
  let cancelled = false, reaped = false, starts = 0;
  const calls: string[] = [];
  const data = () => ({ job_id: jobId, status: cancelled ? "cancelled" : options.running ? "running" : options.code ? "failed" : "completed", exit_code: cancelled ? null : options.code ?? 0,
    streams: { available: true, stdout: options.stdout ?? "literal stdout\n", stderr: options.stderr ?? "literal stderr\n", stdout_truncated: options.truncated } });
  const jobs: VerificationJobs = {
    async start(_id, command) { starts++; calls.push(`start:${command}`); if (options.deny) throw new Error("Permission denied"); return { details: { job_id: jobId } }; },
    async resolve() { calls.push("resolve"); return starts || options.running ? jobId : undefined; },
    async attest() { calls.push("attest"); return true; },
    async execute(_id, params) {
      calls.push(params.action);
      if (params.action === "wait") options.onWait?.();
      if (params.action === "cancel") cancelled = true;
      if (params.action === "reap") { if (options.cleanupFail) return { isError: true }; reaped = true; }
      return { details: data(), isError: options.code !== undefined && options.code !== 0 };
    },
  };
  // Reap is not a command execution verdict: ordinary supervisor returns a successful removal.
  const execute = jobs.execute;
  jobs.execute = async (...args) => { const response = await execute(...args); if (["reap", "cancel"].includes(args[1].action) && !options.cleanupFail) response.isError = false; return response; };
  return { jobs, calls, get starts() { return starts; }, get cancelled() { return cancelled; }, get reaped() { return reaped; } };
}
async function evaluate(gates: VerificationGate[], s: ReturnType<typeof supervisor>, signal?: AbortSignal) {
  const cwd = temp(), record = initialVerification(identity(cwd), gates), snapshots: string[] = [];
  try { await runVerification(record, gates, s.jobs, () => snapshots.push(JSON.stringify(record)), signal); return { record, snapshots }; }
  finally { rmSync(cwd, { recursive: true, force: true }); }
}

test("explicit gate parser rejects unsupported authority overrides and invalid schemas", () => {
  assert.deepEqual(validateVerification(undefined), []);
  for (const gate of [{ command: " " }, { command: "x", cwd: "/" }, { command: "x", env: {} }, { command: "x", allowFailure: true }, { command: "x", timeoutMs: 0 }, { command: "x", output: "yaml" }, { command: "x", schema: {} }, { command: "x", output: "json", schema: { $ref: "https://example.com/schema" } }]) assert.throws(() => validateVerification([gate]));
});

test("unconfigured never passes; supervisor exit beats fabricated worker success and preserves literal streams", async () => {
  const none = await evaluate([], supervisor()); assert.equal(none.record.status, "not-configured");
  const s = supervisor({ code: 7, stdout: '  worker says {"passed":true}\n', stderr: "ERROR\u001b[31m\n" });
  const { record, snapshots } = await evaluate([{ command: "actual test" }], s);
  assert.equal(record.status, "failed"); assert.equal(record.runs[0].exitCode, 7);
  assert.equal(record.runs[0].stdout, '  worker says {"passed":true}\n'); assert.equal(record.runs[0].stderr, "ERROR\u001b[31m\n");
  assert.ok(s.reaped); assert.ok(snapshots.some(s => s.includes('"jobId"')));
  const good = await evaluate([{ command: "actual test" }], supervisor());
  assert.equal(good.record.status, "passed"); assert.equal(good.record.runs[0].exitCode, 0);
  assert.ok(good.record.runs[0].workspaceAfter); assert.ok(good.record.identity.cwd.startsWith(tmpdir()));
});

test("typed gates distinguish schema, business verdict, and process success", async () => {
  const gate: VerificationGate = { command: "classify", output: "json", schema: { type: "object", properties: { verdict: { type: "string", enum: ["ok", "blocked"] } }, required: ["verdict"], additionalProperties: false } };
  const blockedData = await evaluate([gate], supervisor({ stdout: '{"verdict":"blocked"}' }));
  assert.equal(blockedData.record.status, "passed", "JSON data is not an implicit business verdict");
  assert.deepEqual(blockedData.record.runs[0].structuredOutput, { verdict: "blocked" });
  const rejected = await evaluate([{ ...gate, verdict: { path: ["verdict"], equals: "ok" } }], supervisor({ stdout: '{"verdict":"blocked"}' }));
  assert.equal(rejected.record.status, "failed"); assert.equal(rejected.record.runs[0].exitCode, 0); assert.equal(rejected.record.runs[0].businessVerdict, false);
  for (const stdout of ["", "no json", '{"verdict":"maybe"}', '{"verdict":"ok"}\n{}']) {
    const bad = await evaluate([gate], supervisor({ stdout })); assert.equal(bad.record.status, "failed");
  }
  const truncated = await evaluate([gate], supervisor({ stdout: '{"verdict":"ok"}', truncated: true })); assert.equal(truncated.record.status, "failed");
  assert.equal((await evaluate([gate], supervisor({ stdout: '{"verdict":"ok"}' }))).record.status, "passed");
});

test("timeout, cancellation, denied permission, and unavailable backend cannot pass; cancellation reaps", async () => {
  const timeout = supervisor({ running: true });
  assert.equal((await evaluate([{ command: "wait forever", timeoutMs: 20 }], timeout)).record.status, "timed-out");
  assert.ok(timeout.cancelled); assert.ok(timeout.reaped);
  const controller = new AbortController(), cancel = supervisor({ running: true, onWait: () => controller.abort() });
  assert.equal((await evaluate([{ command: "cancel" }], cancel, controller.signal)).record.status, "cancelled");
  assert.ok(cancel.cancelled); assert.ok(cancel.reaped);
  const denied = supervisor({ deny: true }); assert.equal((await evaluate([{ command: "denied" }], denied)).record.status, "unavailable");
  const cwd = temp(); try { const record = initialVerification(identity(cwd), [{ command: "missing" }]); await runVerification(record, [{ command: "missing" }], undefined, () => {}); assert.equal(record.status, "unavailable"); } finally { rmSync(cwd, { recursive: true, force: true }); }
  const cleanup = supervisor({ cleanupFail: true }); assert.equal((await evaluate([{ command: "pass but cannot cleanup" }], cleanup)).record.status, "unavailable");
});

test("workspace changes including ignored/untracked bytes invalidate evidence; symlinks fail closed", async () => {
  const cwd = temp(), gates = [{ command: "check" }];
  try {
    writeFileSync(join(cwd, "input"), "before"); const record = initialVerification(identity(cwd), gates);
    await runVerification(record, gates, supervisor().jobs, () => {});
    assert.equal(currentVerification(record, identity(cwd), gates).status, "passed");
    const corrupted = structuredClone(record); corrupted.runs[0].exitCode = 7;
    assert.notEqual(currentVerification(corrupted, identity(cwd), gates).status, "passed", "durable status alone cannot override real exit");
    writeFileSync(join(cwd, "input"), "after"); assert.equal(currentVerification(record, identity(cwd), gates).status, "stale");
    writeFileSync(join(cwd, "ignored-new"), "input"); assert.equal(currentVerification(record, identity(cwd), gates).status, "stale");
    assert.equal(currentVerification(record, { ...identity(cwd), attempt: 2 }, gates).status, "interrupted");
    assert.equal(currentVerification(record, identity(cwd), [{ command: "different" }]).status, "interrupted");
    symlinkSync("input", join(cwd, "link")); assert.throws(() => workspaceIdentity(cwd));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("nested worktree identity includes sibling inputs and detects mutation during a gate", async () => {
  const cwd = temp(), gates = [{ command: "read input" }];
  try {
    mkdirSync(join(cwd, ".git")); mkdirSync(join(cwd, "nested")); writeFileSync(join(cwd, "sibling"), "before");
    const nested = join(cwd, "nested"), record = initialVerification(identity(nested), gates);
    await runVerification(record, gates, supervisor({ onWait: () => writeFileSync(join(cwd, "sibling"), "after") }).jobs, () => {});
    assert.equal(record.status, "stale"); assert.notEqual(record.runs[0].workspaceBefore, record.runs[0].workspaceAfter);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("timeout includes permission wait before dispatch", async () => {
  const cwd = temp(), gates = [{ command: "await approval", timeoutMs: 5 }], record = initialVerification(identity(cwd), gates);
  const jobs = supervisor().jobs;
  jobs.start = async (_id, _command, signal) => await new Promise((_resolve, reject) => {
    if (signal?.aborted) reject(new Error("approval cancelled"));
    else signal?.addEventListener("abort", () => reject(new Error("approval cancelled")), { once: true });
  });
  try { await runVerification(record, gates, jobs, () => {}); assert.equal(record.status, "timed-out"); assert.equal(record.runs[0].jobId, undefined); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("a storage failure after dispatch cancels active work but retains terminal logs", async () => {
  const cwd = temp(), gates = [{ command: "persist fails" }], s = supervisor({ running: true });
  const record = initialVerification(identity(cwd), gates);
  try {
    await assert.rejects(runVerification(record, gates, s.jobs, () => { if (record.runs.some(r => r.jobId)) throw new Error("disk full"); }), /persistence failed/);
    assert.ok(s.cancelled); assert.equal(s.reaped, false); assert.equal(record.status, "checking");
    assert.equal(record.runs[0].status, "unavailable");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("restart recovers interrupted supervised work without replay and keeps cleanup evidence durable", async () => {
  const cwd = temp(), gates = [{ command: "interrupted" }], s = supervisor({ running: true });
  try {
    const record = initialVerification(identity(cwd), gates); record.status = "checking";
    record.runs.push({ gate: gates[0], status: "checking", startedAt: new Date().toISOString(), jobId, dispatchId: `verify:${"c".repeat(32)}:${"a".repeat(24)}`, dispatchState: "observed", exitCode: null, stdout: "", stderr: "", truncated: false });
    const restored = currentVerification(JSON.parse(JSON.stringify(record)), identity(cwd), gates);
    assert.equal(restored.status, "interrupted"); let persisted = 0;
    await recoverVerification(restored, s.jobs, () => persisted++);
    assert.equal(s.starts, 0); assert.ok(s.cancelled); assert.ok(s.reaped); assert.ok(persisted >= 2);
    assert.equal(restored.status, "interrupted"); assert.equal(restored.runs[0].stdout, "literal stdout\n");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

function manifestAt(directory: string, gates?: VerificationGate[]): TuiWorkerManifest {
  return { protocol: 1, ...identity(directory), groupId: `subagent-job-${"a".repeat(24)}`, controlToken: "d".repeat(64),
    controlSocket: join(directory, "control.sock"), sessionFile: join(directory, "session.jsonl"),
    placement: { socketPath: "/tmp/tmux-test", serverEpoch: "123:456", sessionId: "$1", windowId: "@1", paneId: "%1", ownershipNonce: "e".repeat(64) },
    presentation: "background", launchMode: "none", acceptance: ["real check"], verification: gates };
}
const delivered = { version: 1, state: "delivered", summary: "All work passed (fabricated)", acceptance: [{ criterion: "real check", status: "passed", evidence: "worker claim" }], artifacts: [], remaining: [] };

test("native worker cannot publish premature delivered receipt; report exposes unmodified evidence", async () => {
  const directory = temp(), cwd = temp(), gates = [{ command: "test gate" }], store = new TuiWorkerStore(directory), manifest = manifestAt(directory, gates);
  store.writeManifest(manifest);
  let release!: () => void; const blocked = new Promise<void>(r => release = r), s = supervisor({ code: 9 });
  const start = s.jobs.start; s.jobs.start = async (...args) => { await blocked; return start(...args); };
  const adapter = { isIdle: () => true, verificationCwd: () => cwd, verificationJobs: () => s.jobs, send() {}, abort() {}, shutdown() {} };
  const worker = new TuiWorkerServer(store, adapter);
  try {
    worker.running(true); worker.outcome(delivered); worker.settled({ assistant: { content: "worker fabricated success" } });
    let reply = await worker.handle(workerRequest(manifest, { operation: "status" }, "pending"));
    assert.equal((reply.data as any).active, true); assert.equal((reply.data as any).accepted_delivery, false);
    assert.equal(store.readState().lastReport, undefined); assert.equal(store.readState().events.some(e => e.kind === "outcome" || e.kind === "settled"), false);
    release(); await (worker as any).verificationFlight;
    reply = await worker.handle(workerRequest(manifest, { operation: "status" }, "finished"));
    assert.equal((reply.data as any).worker_finished, true); assert.equal((reply.data as any).verification.status, "failed");
    assert.equal((reply.data as any).accepted_delivery, false); assert.equal((reply.data as any).review, "not-configured");
    const report = readPrivateJson(store.readState().lastReport!) as any;
    assert.equal(report.runtimeVerification.runs[0].exitCode, 9); assert.equal(report.runtimeVerification.runs[0].stdout, "literal stdout\n");
    assert.equal(store.readState().events.filter(e => e.kind === "settled").length, 1);
    worker.settled({ duplicate: true }); assert.equal(store.readState().events.filter(e => e.kind === "settled").length, 1);
    chmodSync(store.path("state.json"), 0o644); assert.throws(() => store.readState());
  } finally { release(); await worker.close(); rmSync(directory, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); }
});

test("native passing check permits only delivered claim; backend missing and epoch mismatch fail closed", async () => {
  const directory = temp(), cwd = temp(), gates = [{ command: "test gate" }], store = new TuiWorkerStore(directory), manifest = manifestAt(directory, gates);
  store.writeManifest(manifest); const s = supervisor();
  const adapter = { isIdle: () => true, verificationCwd: () => cwd, verificationJobs: () => s.jobs, send() {}, abort() {}, shutdown() {} };
  let worker = new TuiWorkerServer(store, adapter);
  try {
    worker.running(true); worker.outcome(delivered); worker.settled({ assistant: { content: "done" } }); await (worker as any).verificationFlight;
    let reply = await worker.handle(workerRequest(manifest, { operation: "status" }, "pass")); assert.equal((reply.data as any).accepted_delivery, true);
    writeFileSync(join(cwd, "changed"), "stale"); reply = await worker.handle(workerRequest(manifest, { operation: "status" }, "stale")); assert.equal((reply.data as any).verification.status, "stale"); assert.equal((reply.data as any).accepted_delivery, false);
    await worker.close(); worker = new TuiWorkerServer(store, { ...adapter, verificationJobs: () => undefined });
    worker.running(true); worker.outcome(delivered); worker.settled({ assistant: { content: "done" } }); await (worker as any).verificationFlight;
    reply = await worker.handle(workerRequest(manifest, { operation: "status" }, "missing")); assert.equal((reply.data as any).verification.status, "unavailable"); assert.equal((reply.data as any).accepted_delivery, false);
    const request = workerRequest(manifest, { operation: "status" }, "foreign"); request.workerEpoch = "f".repeat(32);
    assert.equal((await worker.handle(request)).ok, false);
  } finally { await worker.close(); rmSync(directory, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); }
});
