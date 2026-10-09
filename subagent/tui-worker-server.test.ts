import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { TuiWorkerStore } from "./tui-worker-store.ts";
import { TuiWorkerServer } from "./tui-worker-server.ts";
import { callTuiWorker, applyTuiWorkerOperatorMode, workerRequest } from "./tui-worker-client.ts";
import type { TuiWorkerManifest } from "../shared/tui-worker-protocol.ts";

export function manifestAt(directory: string): TuiWorkerManifest {
  return { protocol: 1, ownerSessionId: "parent", taskId: "task-1", runtimeId: "runtime-1",
    groupId: `subagent-job-${"a".repeat(24)}`, childId: `subagent-child-${"b".repeat(24)}`,
    attempt: 1, workerEpoch: "c".repeat(32), controlToken: "d".repeat(64),
    controlSocket: join(directory, "control.sock"), sessionFile: join(directory, "session.jsonl"),
    placement: { socketPath: "/tmp/tmux-test", serverEpoch: "123:456", sessionId: "$1", windowId: "@1", paneId: "%1", ownershipNonce: "e".repeat(64) },
    presentation: "background", launchMode: "none" };
}

test("routine continuation is durably single-use and interventions win before dispatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-continuation-"));
  const store = new TuiWorkerStore(directory), manifest = manifestAt(directory);
  store.writeManifest(manifest);
  let authority = true;
  const adapter = { isIdle: () => true, canRun: () => authority, send() {}, abort() {}, shutdown() {} };
  let server = new TuiWorkerServer(store, adapter);
  const partial = { version: 1, state: "partial", summary: "Routine tests remain", acceptance: [], artifacts: [], remaining: ["test"], next_action: "Run tests", continuation: "routine" };
  try {
    server.running(true); server.outcome(partial);
    authority = false;
    assert.equal(server.claimAutoContinuation(), undefined);
    authority = true;
    const first = server.claimAutoContinuation();
    assert.match(first!, /No additional authority/);
    assert.equal(store.readState().autoContinuation?.used, true);
    assert.equal(store.readState().lastOutcome, undefined);
    assert.equal(store.readState().lastReport, undefined, "no intermediate completion published");
    assert.equal(server.claimAutoContinuation(), undefined);
    await server.close();
    server = new TuiWorkerServer(store, adapter);
    server.running(true); server.outcome(partial);
    assert.equal(server.claimAutoContinuation(), undefined, "reload must not replenish budget");
    server.settled({ final: "Only final result" });
    const settledSequence = store.readState().sequence, report = store.readState().lastReport;
    server.settled({ final: "Duplicate boundary" });
    assert.equal(store.readState().sequence, settledSequence, "duplicate settled event must not wake parent twice");
    assert.equal(store.readState().lastReport, report);
    await server.close();
    server = new TuiWorkerServer(store, adapter);
    server.settled({ final: "Reload replay" });
    assert.equal(store.readState().sequence, settledSequence);
    // A fresh explicit assignment is a new worker state, not a repeated report.
    store.writeState({ version: 1, sequence: 0, active: false, sealed: false, phase: "ready", receipts: {}, events: [] });
    server = new TuiWorkerServer(store, adapter);
    server.running(true); server.outcome(partial);
    await server.handle(workerRequest(manifest, { operation: "cancel" }, "cancel"));
    assert.equal(server.claimAutoContinuation(), undefined);
    assert.equal(store.readState().autoContinuation?.inhibited, true);
    await server.close();
    server = new TuiWorkerServer(store, adapter);
    server.running(true); server.outcome(partial);
    assert.equal(server.claimAutoContinuation(), undefined, "cancel inhibition survives reload and new outcomes");
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("cancel intent inhibits continuation before asynchronous queue clearing; failed persistence fails closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-continuation-race-"));
  const store = new TuiWorkerStore(directory), manifest = manifestAt(directory);
  store.writeManifest(manifest);
  let release!: () => void, started!: () => void, aborts = 0;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const adapter = { isIdle: () => true, send() {}, abort() { aborts++; }, shutdown() {},
    clearQueue() { started(); return new Promise<void>(resolve => { release = resolve; }); } };
  const server = new TuiWorkerServer(store, adapter);
  try {
    server.running(true);
    server.outcome({ version: 1, state: "partial", summary: "Routine work", acceptance: [], artifacts: [], remaining: ["test"], next_action: "test", continuation: "routine" });
    const cancelling = server.handle(workerRequest(manifest, { operation: "cancel" }, "cancel-race"));
    await entered;
    assert.equal(server.claimAutoContinuation(), undefined, "cancel must win while clearQueue is pending");
    assert.equal(store.readState().autoContinuation?.inhibited, true);
    release(); await cancelling;
    assert.equal(aborts, 1);
    // Persistence failure before a boundary reservation must never dispatch.
    server.state.autoContinuation = undefined;
    const originalWrite = store.writeState.bind(store);
    store.writeState = () => { throw new Error("disk failed"); };
    assert.throws(() => server.claimAutoContinuation(), /disk failed/);
    assert.equal(server.sealed, true);
    assert.equal(server.claimAutoContinuation(), undefined);
    store.writeState = originalWrite;
  } finally { release?.(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("child-hosted control reconnects, deduplicates, observes direct work and seals idle reap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-worker-"));
  const store = new TuiWorkerStore(directory);
  const manifest = manifestAt(directory);
  const operator = "f".repeat(64);
  manifest.operatorCapabilityHash = createHash("sha256").update(operator).digest("hex");
  store.writeManifest(manifest);
  let idle = true, sends = 0, shutdowns = 0, mode: boolean | undefined;
  const cancellations: string[] = [];
  const prepareJobReap = async (preserve: (report: unknown) => Promise<void>) => { await preserve({ jobs: [] }); return () => {}; };
  let server = new TuiWorkerServer(store, { isIdle: () => idle, prepareJobReap,
    send: () => { sends++; idle = false; }, clearQueue: () => { cancellations.push("clear_queue"); }, abort: () => { cancellations.push("abort"); idle = true; },
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
    assert.deepEqual(cancellations, ["clear_queue", "abort"], "queued instructions must be cleared before abort");
    assert.equal(store.readState().sealed, false, "Stop/cancel must not seal or reap the worker");
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

test("interrupt barrier retains partial receipts on timeout, abort error, shutdown, and new local activity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-interrupt-"));
  const store = new TuiWorkerStore(directory), manifest = manifestAt(directory);
  store.writeManifest(manifest);
  let idle = false, sends = 0, aborts = 0;
  let behavior = () => {};
  const adapter = { isIdle: () => idle, send() { sends++; }, abort() { aborts++; behavior(); }, shutdown() {} };
  let server = new TuiWorkerServer(store, adapter, 25);
  const request = (id: string) => workerRequest(manifest, { operation: "prompt", mode: "interrupt", message: "replacement" }, id);
  try {
    const timeout = await server.handle(request("timeout"));
    assert.equal(timeout.code, "interrupt_incomplete");
    assert.match(timeout.message, /timeout/);
    assert.deepEqual(timeout.data, { abortRequested: true, replacementDispatched: false });
    assert.equal(store.readState().active, true);
    idle = true; server.settled({ final: "eventually cancelled" });
    await server.close();
    server = new TuiWorkerServer(store, adapter, 25);
    assert.deepEqual(await server.handle(request("timeout")), timeout, "reload replay lost definitive partial receipt");
    assert.equal(aborts, 1); assert.equal(sends, 0);
    assert.equal((await server.handle(request("explicit-retry"))).ok, true, "explicit new-ID retry at idle failed");
    assert.equal(sends, 1);
    idle = false;
    behavior = () => { throw new Error("abort failed"); };
    const failed = await server.handle(request("abort-error"));
    assert.equal(failed.code, "interrupt_incomplete"); assert.match(failed.message, /cancellation may have occurred/);
    behavior = () => { idle = true; server.running(true); };
    const raced = await server.handle(request("local-input"));
    assert.equal(raced.code, "interrupt_incomplete");
    assert.equal(server.state.active, true, "new local input reservation was lost");
    behavior = () => { void server.close(); };
    const closed = await server.handle(request("shutdown"));
    assert.equal(closed.code, "interrupt_incomplete");
    assert.equal(store.readState().receipts["model:shutdown"].response?.code, "interrupt_incomplete");
    assert.equal(sends, 1);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("headless interactions persist, authenticate, validate, and resolve idempotently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-worker-interaction-"));
  const store = new TuiWorkerStore(directory);
  const manifest = { ...manifestAt(directory), placement: undefined, execution: "rpc-headless" as const,
    presentation: "headless-foreground" as const, processPid: process.pid, processToken: "pid:start", fifoPath: join(directory, "stdin.fifo"), foregroundOwner: { pid: process.pid + 1, token: "owner:start" } } as any;
  store.writeManifest(manifest);
  const server = new TuiWorkerServer(store, { isIdle: () => false, send: () => {}, abort: () => {}, shutdown: () => {} });
  try {
    await server.start();
    const input = { kind: "questionnaire" as const, questions: [{ id: "continue", prompt: "Continue?", options: [{ value: "yes", label: "Yes" }], allowOther: false }] };
    const waiting = server.requestInteraction(input);
    const pending = store.readState().interactions?.[0];
    assert.ok(pending);
    assert.equal(pending.workerEpoch, manifest.workerEpoch);
    const status = await callTuiWorker(manifest, { operation: "status" });
    assert.equal((status.data as any).interactions.length, 1);
    const answer = { kind: "questionnaire" as const, cancelled: false, answers: [{ id: "continue", value: "yes", wasCustom: false }] };
    const response = await callTuiWorker(manifest, { operation: "respond_interaction", interactionId: pending.id, answer }, { requestId: "ui:answer-1" });
    assert.equal(response.ok, true);
    assert.deepEqual(await waiting, answer);
    assert.deepEqual(await callTuiWorker(manifest, { operation: "respond_interaction", interactionId: pending.id, answer }, { requestId: "ui:answer-1" }), response);
    assert.equal((store.readState().interactions?.[0] as any).answer.answers[0].value, "yes");
    const timeline = store.readTimeline();
    assert.ok(timeline.some(event => event.kind === "interaction_pending"));
    assert.ok(timeline.some(event => event.kind === "interaction_resolved"));
    assert.deepEqual(timeline.map(event => event.sequence), [...timeline.map(event => event.sequence)].sort((a, b) => a - b));
    const forged = await callTuiWorker({ ...manifest, controlToken: "0".repeat(64) }, { operation: "respond_interaction", interactionId: pending.id, answer }, { requestId: "ui:answer-forged" });
    assert.equal(forged.ok, false);
    const permissionWait = server.requestInteraction({ kind: "permission", title: "Allow?", options: ["allow", "deny"] });
    const permission = store.readState().interactions?.at(-1)!;
    const denied = { kind: "permission" as const, cancelled: true };
    const deniedReceipt = await callTuiWorker(manifest, { operation: "respond_interaction", interactionId: permission.id, answer: denied }, { requestId: "ui:deny-2" });
    assert.equal(deniedReceipt.ok, true);
    assert.deepEqual(await permissionWait, denied);
    const invalid = await callTuiWorker(manifest, { operation: "respond_interaction", interactionId: permission.id, answer: { kind: "permission", cancelled: false, value: "approve" } as any }, { requestId: "ui:invalid-3" });
    assert.equal(invalid.ok, false);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("compact failures restore idle state and persist non-replayable failure receipts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-worker-compact-failure-"));
  const store = new TuiWorkerStore(directory);
  const manifest = manifestAt(directory);
  store.writeManifest(manifest);
  let idle = true, compactCalls = 0, sends = 0, shutdowns = 0;
  let compactBehavior: () => Promise<void | { compaction: "not-needed"; reason: "nothing-to-compact" }> = () => { throw new Error("Nothing to compact (session too small): provider unavailable"); };
  const prepareJobReap = async (preserve: (report: unknown) => Promise<void>) => { await preserve({ jobs: [] }); return () => {}; };
  const server = new TuiWorkerServer(store, { isIdle: () => idle, prepareJobReap,
    compact: () => { compactCalls++; return compactBehavior(); },
    send: () => { sends++; idle = false; }, abort: () => { idle = true; }, shutdown: () => { shutdowns++; } });
  try {
    await server.start();
    const compact = { operation: "compact" as const };
    const syncFailure = await callTuiWorker(manifest, compact, { requestId: "compact-sync" });
    assert.equal(syncFailure.ok, false); assert.equal(syncFailure.code, "compact_failed");
    assert.match(syncFailure.message ?? "", /Compaction failed: Nothing to compact \(session too small\): provider unavailable/);
    assert.deepEqual(await callTuiWorker(manifest, compact, { requestId: "compact-sync" }), syncFailure);
    assert.equal(compactCalls, 1, "failed compact was replayed");
    assert.equal((await callTuiWorker(manifest, { operation: "status" })).data?.active, false);
    assert.equal(store.readState().active, false);
    assert.equal(store.readState().phase, "ready");
    assert.deepEqual(store.readState().receipts["model:compact-sync"].response, syncFailure);

    compactBehavior = async () => { throw new Error("provider rejected compact"); };
    const asyncFailure = await callTuiWorker(manifest, compact, { requestId: "compact-async" });
    assert.equal(asyncFailure.code, "compact_failed");
    assert.deepEqual(await callTuiWorker(manifest, compact, { requestId: "compact-async" }), asyncFailure);
    assert.equal(compactCalls, 2);
    assert.equal(store.readState().active, false);

    compactBehavior = async () => { throw new Error("界".repeat(3000)); };
    const longFailure = await callTuiWorker(manifest, compact, { requestId: "compact-long-error" });
    assert.equal(longFailure.code, "compact_failed");
    assert.ok(Buffer.byteLength(longFailure.message ?? "") <= 2048, "failure response exceeded UTF-8 byte bound");
    assert.ok(longFailure.message?.endsWith(" [truncated]"));
    assert.deepEqual(await callTuiWorker(manifest, compact, { requestId: "compact-long-error" }), longFailure);
    assert.equal(compactCalls, 3);

    compactBehavior = async () => ({ compaction: "not-needed", reason: "nothing-to-compact" });
    const noOp = await callTuiWorker(manifest, compact, { requestId: "compact-noop" });
    assert.equal(noOp.ok, true);
    assert.deepEqual(noOp.data, { compaction: "not-needed", reason: "nothing-to-compact" });
    assert.deepEqual(await callTuiWorker(manifest, compact, { requestId: "compact-noop" }), noOp);
    assert.equal(compactCalls, 4, "no-op receipt replay re-invoked compact");
    compactBehavior = async () => {};
    assert.equal((await callTuiWorker(manifest, compact, { requestId: "compact-success" })).ok, true);
    assert.equal(store.readState().active, false);
    assert.equal((await callTuiWorker(manifest, { operation: "prompt", mode: "steer", message: "resume" })).ok, true);
    assert.equal(sends, 1);
    await callTuiWorker(manifest, { operation: "cancel" });
    assert.equal(store.readState().active, false);

    idle = false; server.running();
    assert.equal((await callTuiWorker(manifest, { operation: "prepare_reap" })).code, "busy");
    idle = true; server.settled({ final: "human turn settled" });
    assert.equal((await callTuiWorker(manifest, { operation: "prepare_reap" })).ok, true);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(shutdowns, 1);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("parent prompt invalidates prior turn receipt before custom-message agent_start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-worker-prompt-turn-"));
  const store = new TuiWorkerStore(directory);
  const manifest = manifestAt(directory);
  store.writeManifest(manifest);
  let idle = true, sends = 0;
  let server!: TuiWorkerServer;
  server = new TuiWorkerServer(store, { isIdle: () => idle,
    send: () => { sends++; idle = false; server.running(); }, abort: () => { idle = true; }, shutdown() {} });
  try {
    await server.start();
    server.settled({ final: "previous checkpoint turn" });
    server.outcome({ version: 1, state: "checkpointed" });
    assert.ok(store.readState().lastReport);
    assert.ok(store.readState().lastOutcome);

    const prompt = { operation: "prompt" as const, mode: "follow_up" as const, message: "resume checkpoint" };
    assert.equal((await callTuiWorker(manifest, prompt, { requestId: "resume-new-turn" })).ok, true);
    assert.equal(sends, 1);
    assert.equal(store.readState().active, true);
    assert.equal(store.readState().phase, "running");
    assert.equal(store.readState().lastReport, undefined);
    assert.equal(store.readState().lastOutcome, undefined);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("human activity starting during pending compaction stays authoritative after rejection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-worker-compact-race-"));
  const store = new TuiWorkerStore(directory);
  const manifest = manifestAt(directory);
  store.writeManifest(manifest);
  let idle = true, compactCalls = 0;
  let entered!: () => void, rejectCompact!: (error: Error) => void;
  const compactPending = new Promise<void>((_resolve, reject) => { rejectCompact = reject; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const prepareJobReap = async (preserve: (report: unknown) => Promise<void>) => { await preserve({ jobs: [] }); return () => {}; };
  const server = new TuiWorkerServer(store, { isIdle: () => idle, prepareJobReap,
    compact: () => { compactCalls++; entered(); return compactPending; },
    send: () => {}, abort: () => { idle = true; }, shutdown() {} });
  try {
    await server.start();
    server.settled({ previous: "report" });
    server.outcome({ previous: "outcome" });
    assert.ok(store.readState().lastReport);
    assert.ok(store.readState().lastOutcome);

    const request = { operation: "compact" as const };
    const pending = callTuiWorker(manifest, request, { requestId: "compact-race" });
    await started;
    // Pi can announce input/before_agent_start before its streaming idle signal
    // flips; the explicit generation/state reservation must remain authoritative.
    assert.equal(idle, true);
    assert.equal(server.running(true), true, "human activity was not accepted during compact");
    rejectCompact(new Error("Compaction provider temporarily unavailable"));
    const failure = await pending;
    assert.equal(failure.code, "compact_failed");
    assert.equal(compactCalls, 1);
    assert.equal(store.readState().active, true);
    assert.equal(store.readState().phase, "running");
    assert.equal(store.readState().lastReport, undefined, "prior turn report survived new human turn");
    assert.equal(store.readState().lastOutcome, undefined, "prior turn outcome survived new human turn");
    assert.equal((await callTuiWorker(manifest, { operation: "prepare_reap" })).code, "busy");

    idle = true;
    server.settled({ final: "human turn" });
    assert.equal((await callTuiWorker(manifest, { operation: "prepare_reap" })).ok, true);
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
    assert.equal(refused.ok, false); assert.equal(refused.code, "interrupt_incomplete");
    assert.match(refused.message, /Cancellation was requested; replacement was not dispatched/);
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
