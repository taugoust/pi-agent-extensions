import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, lstat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TuiWorkerStore, atomicPrivateJson, validateWorkerManifest } from "./tui-worker-store.ts";
import { HeadlessForegroundManager } from "./headless-foreground.ts";
import { processIdentity, processIsAlive } from "./tui-worker-tmux.ts";
import { pageHeadlessHistory } from "./headless-foreground.ts";
import { parseTuiWorkerRequest, publicTuiWorkerManifest } from "../shared/tui-worker-protocol.ts";

const identity = { protocol: 1, requestId: "request-1", token: "a".repeat(64), ownerSessionId: "owner-session", taskId: "subagent-task-" + "1".repeat(24),
  runtimeId: "rpc-" + "2".repeat(24), groupId: "subagent-job-" + "3".repeat(24), childId: "subagent-child-" + "4".repeat(24), attempt: 1, workerEpoch: "5".repeat(32) };

test("headless manifest is placement-free and public discovery omits FIFO path", async () => {
  const root = await mkdtemp(join(tmpdir(), "headless-manifest-"));
  try {
    await chmod(root, 0o700);
    const store = new TuiWorkerStore(root, true);
    const manifest = { ...identity, controlSocket: store.path("control.sock"), controlToken: identity.token, sessionFile: store.path("session.jsonl"),
      execution: "rpc-headless", presentation: "headless-foreground", processPid: process.pid, processToken: `${process.pid}:start`, fifoPath: store.path("stdin.fifo"), foregroundOwner: { pid: process.pid + 1, token: `${process.pid + 1}:start` }, launchMode: "none" } as any;
    assert.equal(validateWorkerManifest(manifest).placement, undefined);
    const exposed = publicTuiWorkerManifest(manifest);
    assert.equal((exposed as any).placement, undefined);
    assert.equal((exposed as any).fifoPath, undefined);
    await assert.rejects(async () => validateWorkerManifest({ ...manifest, placement: { paneId: "%1" } }), /placement|invalid/i);
    await assert.rejects(async () => validateWorkerManifest({ ...manifest, fifoPath: join(root, "..", "escape") }), /identity|headless/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("history pages default to newest, use stable entry cursors and report expiration/truncation", () => {
  const history = Array.from({ length: 101 }, (_, index) => ({ id: `entry-${index}`, role: "assistant" as const,
    text: `message-${index}`, timestamp: new Date(1_000 + index).toISOString() }));
  const latest = pageHeadlessHistory(history.slice(-100), "epoch-1");
  assert.equal(latest.messages.length, 50);
  assert.equal(latest.messages[0]!.id, "entry-51");
  assert.equal(latest.messages.at(-1)!.id, "entry-100");
  assert.equal(latest.truncated, true);
  const older = pageHeadlessHistory(history.slice(-100), "epoch-1", latest.nextCursor);
  assert.equal(older.messages.length, 50);
  assert.equal(older.messages[0]!.id, "entry-1");
  assert.equal(older.nextCursor, undefined);
  assert.throws(() => pageHeadlessHistory(history.slice(-49), "epoch-1", latest.nextCursor), /expired/);
  assert.throws(() => pageHeadlessHistory(history, "epoch-2", latest.nextCursor), /Invalid history cursor/);
  assert.equal(pageHeadlessHistory([{ ...history[0]!, truncated: true }], "epoch-1").truncated, true);
});

test("interaction socket DTOs are epoch-bound and reject malformed/oversized input", () => {
  const answer = { ...identity, operation: "respond_interaction", interactionId: "interaction:abc",
    answer: { kind: "questionnaire", cancelled: false, answers: [{ id: "q1", value: "yes", wasCustom: false }] } };
  assert.equal(parseTuiWorkerRequest(answer as any).operation, "respond_interaction");
  assert.throws(() => parseTuiWorkerRequest({ ...identity, operation: "pending_interaction", interaction: {} } as any), /Unknown worker operation/);
  assert.throws(() => parseTuiWorkerRequest({ ...identity, operation: "respond_interaction", interactionId: "../../state", answer: { kind: "permission", cancelled: false, value: "allow" } } as any));
});

test("durable timeline ignores a torn final frame and repairs before appending", async () => {
  const root = await mkdtemp(join(tmpdir(), "headless-timeline-"));
  try {
    await chmod(root, 0o700);
    const store = new TuiWorkerStore(root, true);
    const manifest = { ...identity, controlSocket: store.path("control.sock"), controlToken: identity.token, sessionFile: store.path("session.jsonl"),
      execution: "rpc-headless", presentation: "headless-foreground", processPid: 100, processToken: "100:1", fifoPath: store.path("stdin.fifo"),
      foregroundOwner: { pid: 101, token: "101:1" }, launchMode: "none" } as any;
    store.writeManifest(manifest);
    store.appendTimeline({ protocol: 1, workerEpoch: identity.workerEpoch, sequence: 1, timestamp: new Date().toISOString(), kind: "ready" });
    await writeFile(store.path("timeline.jsonl"), "{incomplete", { flag: "a" });
    assert.deepEqual(store.readTimeline().map(event => event.sequence), [1]);
    store.appendTimeline({ protocol: 1, workerEpoch: identity.workerEpoch, sequence: 2, timestamp: new Date().toISOString(), kind: "running" });
    assert.deepEqual(store.readTimeline().map(event => event.sequence), [1, 2]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("RPC stdout/stderr are retained in private byte-bounded files", async () => {
  const root = await mkdtemp(join(tmpdir(), "headless-rpc-logs-"));
  try {
    await chmod(root, 0o700);
    const store = new TuiWorkerStore(root, true);
    await writeFile(store.path("rpc.stdout.log"), "x".repeat(8192), { mode: 0o600 });
    await writeFile(store.path("rpc.stderr.log"), "diagnostic\\n", { mode: 0o600 });
    store.trimRpcLogs(4096);
    const out = await lstat(store.path("rpc.stdout.log"));
    const err = await lstat(store.path("rpc.stderr.log"));
    assert.equal(out.size, 4096);
    assert.ok((out.mode & 0o077) === 0 && (err.mode & 0o077) === 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("dead launcher identity cannot authorize resume or reap while authenticated Pi identity is still alive", async () => {
  const root = await mkdtemp(join(tmpdir(), "headless-wrapper-death-"));
  const manager = new HeadlessForegroundManager(root, () => "native", () => true);
  const owner = "owner-runtime-identity";
  const ownerToken = await processIdentity(process.pid);
  let runtime: ReturnType<typeof spawn> | undefined;
  let wrapper: ReturnType<typeof spawn> | undefined;
  let recovered: HeadlessForegroundManager | undefined;
  let runtimeToken: string | undefined;
  try {
    manager.activate(owner);
    runtime = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    runtime.unref();
    assert.ok(runtime.pid);
    runtimeToken = await processIdentity(runtime.pid!);
    wrapper = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 100)"], { stdio: "ignore" });
    assert.ok(wrapper.pid);
    const wrapperExit = once(wrapper, "exit");
    const wrapperToken = await processIdentity(wrapper.pid!);
    await wrapperExit;
    assert.equal(await processIsAlive(wrapper.pid!, wrapperToken), false);
    assert.equal(await processIsAlive(runtime.pid!, runtimeToken), true);

    const groupId = `subagent-job-${"6".repeat(24)}`, taskId = `subagent-task-${"7".repeat(24)}`, childId = `subagent-child-${"8".repeat(24)}`;
    const directory = join(root, "workers", "5".repeat(24));
    await mkdir(directory, { mode: 0o700 });
    const store = new TuiWorkerStore(directory);
    await writeFile(store.path("session.jsonl"), "", { mode: 0o600 });
    const manifest = { protocol: 1, ownerSessionId: owner, taskId, runtimeId: "rpc-runtime-death",
      groupId, childId, attempt: 1, workerEpoch: "9".repeat(32), controlSocket: store.path("control.sock"),
      controlToken: "a".repeat(64), sessionFile: store.path("session.jsonl"), execution: "rpc-headless",
      presentation: "headless-foreground", launchMode: "none", processPid: wrapper.pid, processToken: wrapperToken,
      runtimePid: runtime.pid, runtimeProcessToken: runtimeToken, fifoPath: store.path("stdin.fifo"),
      foregroundOwner: { pid: process.pid, token: ownerToken } };
    store.writeManifest(manifest as any);
    const createdAt = new Date().toISOString();
    atomicPrivateJson(join(root, "headless-groups", `${groupId}.json`), { version: 1, id: groupId, owner, ownerToken,
      createdAt, mode: "single", cancelled: false, launchMode: "none", launcher: "/nix/store/not-used",
      children: [{ taskId, childId, attempt: 1, directory, spec: { task: "retained", cwd: process.cwd() }, status: "completed",
        createdAt, updatedAt: createdAt, started: true, ownerToken, operatorCapability: "b".repeat(64), workerAlive: true }] });
    // Reconstruct a new parent manager, as after reload. The wrapper is dead,
    // the authenticated runtime PID is alive, and its socket is unavailable.
    await manager.shutdown(false);
    recovered = new HeadlessForegroundManager(root, () => "native", () => true);
    recovered.activate(owner);
    await assert.rejects(recovered.operation({ operation: "resume", task_id: taskId }, owner), /connect|runtime identity|still live/i);
    await assert.rejects(recovered.operation({ operation: "reap", job_id: groupId }, owner), /connect|socket|control/i);
    await assert.rejects(readFile(store.path("reaped.json")), { code: "ENOENT" });
    await recovered.shutdown(false);
  } finally {
    if (recovered) await recovered.shutdown(false).catch(() => undefined);
    if (runtime?.pid && runtimeToken && await processIsAlive(runtime.pid, runtimeToken)) { try { process.kill(runtime.pid, "SIGKILL"); } catch {} }
    if (wrapper?.pid) { try { process.kill(wrapper.pid, "SIGKILL"); } catch {} }
    await manager.shutdown(false).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("headless launch contract cannot authorize a tmux placement or implicit promotion", async () => {
  const root = await mkdtemp(join(tmpdir(), "headless-contract-"));
  try {
    await mkdir(join(root, "state"), { mode: 0o700 });
    const store = new TuiWorkerStore(join(root, "state"), true);
    const headless = { ...identity, controlSocket: store.path("control.sock"), controlToken: identity.token, sessionFile: store.path("session.jsonl"),
      execution: "rpc-headless", presentation: "headless-foreground", processPid: 100, processToken: "100:1", fifoPath: store.path("stdin.fifo"), foregroundOwner: { pid: 101, token: "101:1" }, launchMode: "none" };
    assert.doesNotThrow(() => validateWorkerManifest(headless as any));
    assert.throws(() => validateWorkerManifest({ ...headless, execution: "rpc-headless", presentation: "background", placement: { paneId: "%1" } } as any));
  } finally { await rm(root, { recursive: true, force: true }); }
});
