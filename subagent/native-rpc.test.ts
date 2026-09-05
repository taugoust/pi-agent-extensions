import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NativeSubagentRpcSession, spawnNativeSubagentProcess } from "./native-rpc.js";

const fixtureSource = String.raw`
let input = "";
let tail = Promise.resolve();
let initial = true;
let initialPromptId;
let initialRunning = false;
let agentStreaming = false;
let uiCancelled = false;
let controlCount = 0;
let steering = [];
let followUp = [];
const mode = process.argv[2];
const commands = [];

function send(value, ending = "\n") {
  process.stdout.write(JSON.stringify(value) + ending);
}
async function sendSplit(value) {
  const frame = Buffer.from(JSON.stringify(value) + "\n", "utf8");
  const marker = frame.indexOf(Buffer.from("🌍"));
  if (marker < 0) return send(value);
  process.stdout.write(frame.subarray(0, marker + 1));
  await new Promise((resolve) => setImmediate(resolve));
  process.stdout.write(frame.subarray(marker + 1, marker + 3));
  await new Promise((resolve) => setImmediate(resolve));
  process.stdout.write(frame.subarray(marker + 3));
}
function response(command, id, data) {
  send({ id, type: "response", command, success: true, ...(data === undefined ? {} : { data }) });
}
function stateResponse(id) {
  response("get_state", id, {
    isStreaming: agentStreaming,
    pendingMessageCount: steering.length + followUp.length,
  });
}
function queueControl(command, deliveredText = command.message) {
  const queue = command.streamingBehavior === "followUp" ? followUp : steering;
  queue.push(deliveredText);
  send({ type: "queue_update", steering: [...steering], followUp: [...followUp] });
  response("prompt", command.id);
  return () => {
    queue.shift();
    send({ type: "queue_update", steering: [...steering], followUp: [...followUp] });
  };
}
function userEnd(text) {
  const message = { role: "user", content: text };
  send({ type: "message_start", message });
  send({ type: "message_end", message });
}
function assistantStart() {
  send({ type: "message_start", message: { role: "assistant", content: [] } });
  send({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 }, usage: {} });
}
function assistantDelta(text) {
  send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text }, usage: {} });
}
function assistantEnd(text, stopReason = "stop") {
  send({ type: "message_end", message: {
    role: "assistant", content: [{ type: "text", text }], stopReason,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
  } });
}
function beginInitialRun(message) {
  initialRunning = true;
  agentStreaming = true;
  send({ type: "agent_start" });
  userEnd(message);
  assistantStart();
  assistantDelta("old response");
}
async function finishControlled(message, answer = "controlled \u2028 🌍 answer", deliver = () => {}) {
  if (initialRunning) {
    assistantEnd("old response");
    initialRunning = false;
  }
  deliver();
  userEnd(message);
  assistantStart();
  await sendSplit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: answer }, usage: {} });
  assistantEnd(answer);
  send({ type: "fixture_commands", commands });
  send({ type: "agent_end", messages: [] });
  agentStreaming = false;
  send({ type: "agent_settled" });
}
function expectedBehavior(command) {
  return command.message.includes("follow_up") ? "followUp" : "steer";
}
async function handle(command) {
  if (mode === "parent-job" && command.type === "extension_ui_response") {
    const result = JSON.parse(command.value);
    assistantEnd(result.content?.[0]?.text ?? result.error);
    agentStreaming = false;
    send({ type: "agent_settled" });
    return;
  }
  if (mode === "parent-job" && command.type === "prompt" && initial) {
    initial = false;
    response("prompt", command.id);
    agentStreaming = true;
    send({ type: "agent_start" }); userEnd(command.message);
    send({ type: "extension_ui_request", id: "owned-job", method: "input", title: "pi-parent-background-job-v1", placeholder: JSON.stringify({toolCallId:"job-call",params:{action:"start",command:"printf fixture"}}) });
    return;
  }
  if (command.type === "compact") {
    send({type:"fixture_compacted"});
    response("compact", command.id, {summary:"saved checkpoint"});
    return;
  }
  if (command.type === "get_state") {
    stateResponse(command.id);
    return;
  }
  commands.push({ type: command.type, message: command.message, streamingBehavior: command.streamingBehavior });

  if (mode === "unexpected-exit") {
    process.exit(42);
  }
  if (mode === "invalid-utf8") {
    response("prompt", command.id);
    process.stdout.write(Buffer.from([0xff, 0x0a]));
    return;
  }
  if (mode === "non-lf") {
    send({ id: command.id, type: "response", command: "prompt", success: true }, "");
    process.exit(0);
  }
  if (mode === "empty-frame") {
    response("prompt", command.id);
    process.stdout.write("\n");
    return;
  }
  if (mode === "unknown-ui") {
    response("prompt", command.id);
    send({ type: "extension_ui_request", id: "unknown-dialog", method: "futureAuthorityDialog" });
    return;
  }

  if (command.type === "extension_ui_response") {
    if (command.id !== "child-dialog" || command.cancelled !== true) throw new Error("generic child dialog was not cancelled");
    uiCancelled = true;
    response("prompt", initialPromptId);
    beginInitialRun("initial task");
    return;
  }
  if (command.type === "prompt" && initial) {
    initial = false;
    if (mode === "handled-initial" || mode === "handled-initial-pending") {
      if (mode === "handled-initial-pending") await new Promise((resolve) => setTimeout(resolve, 30));
      response("prompt", command.id);
      return;
    }
    initialPromptId = command.id;
    send({ type: "extension_ui_request", id: "child-notify", method: "notify", message: "ignore safely" });
    send({ type: "extension_ui_request", id: "child-dialog", method: "confirm", title: "must fail closed" });
    return;
  }
  if (command.type === "clear_queue") {
    if (mode !== "interrupt") throw new Error("unexpected clear_queue");
    steering = [];
    followUp = [];
    send({ type: "queue_update", steering: [], followUp: [] });
    response("clear_queue", command.id, { steering: [], followUp: [] });
    return;
  }
  if (command.type === "abort") {
    if (mode !== "interrupt") throw new Error("unexpected abort");
    assistantEnd("old response", "aborted");
    initialRunning = false;
    agentStreaming = false;
    send({ type: "agent_end", messages: [] });
    send({ type: "agent_settled" });
    // Real Pi can acknowledge abort after the logical boundary.
    response("abort", command.id);
    return;
  }
  if (command.type === "prompt" && mode === "interrupt") {
    if (command.streamingBehavior !== undefined) throw new Error("interrupt replacement prompt must start idle");
    response("prompt", command.id);
    agentStreaming = true;
    send({ type: "agent_start" });
    await finishControlled(command.message);
    return;
  }
  if (command.type === "prompt" && mode === "settle-race") {
    if (command.streamingBehavior !== "steer") throw new Error("settle race did not use prompt steering");
    assistantEnd("old response");
    initialRunning = false;
    send({ type: "agent_end", messages: [] });
    send({ type: "agent_settled" });
    // Pi read this command after the old run became idle. A dedicated steer
    // command would strand; prompt starts another logical run.
    response("prompt", command.id);
    agentStreaming = true;
    send({ type: "agent_start" });
    await finishControlled(command.message, "race-safe answer");
    return;
  }
  if (command.type === "prompt" && mode === "logical-timeout") {
    queueControl(command);
    return;
  }
  if (command.type === "prompt" && mode === "handled-control") {
    response("prompt", command.id);
    setTimeout(() => {
      assistantEnd("unrelated old response");
      initialRunning = false;
      agentStreaming = false;
      send({ type: "agent_end", messages: [] });
      send({ type: "agent_settled" });
    }, 80);
    return;
  }
  if (command.type === "prompt" && mode === "serial") {
    const behavior = expectedBehavior(command);
    if (command.streamingBehavior !== behavior) throw new Error("serialized prompt used the wrong streaming behavior");
    controlCount += 1;
    if (controlCount === 1) {
      const deliver = queueControl(command);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await finishControlled(command.message, "answer:" + command.message, deliver);
    } else {
      response("prompt", command.id);
      agentStreaming = true;
      send({ type: "agent_start" });
      await finishControlled(command.message, "answer:" + command.message);
    }
    return;
  }
  if (command.type === "prompt" && mode === "cancel-serialization") {
    controlCount += 1;
    if (controlCount === 1) {
      const deliver = queueControl(command);
      send({ type: "fixture_control_accepted", message: command.message });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await finishControlled(command.message, "answer:" + command.message, deliver);
    } else {
      response("prompt", command.id);
      agentStreaming = true;
      send({ type: "agent_start" });
      await finishControlled(command.message, "answer:" + command.message);
    }
    return;
  }
  if (command.type === "prompt" && (mode === "steer" || mode === "follow_up" || mode === "transform")) {
    const behavior = mode === "follow_up" ? "followUp" : "steer";
    if (command.streamingBehavior !== behavior || !uiCancelled) throw new Error("unexpected conversational control command");
    const deliveredText = mode === "transform" ? "rewritten child input" : command.message;
    const deliver = queueControl(command, deliveredText);
    await finishControlled(deliveredText, mode === "transform" ? "transformed answer" : undefined, deliver);
    return;
  }
  throw new Error("unexpected command " + JSON.stringify(command));
}
process.stdin.on("data", (chunk) => {
  input += chunk.toString("utf8");
  for (;;) {
    const newline = input.indexOf("\n");
    if (newline < 0) break;
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === "prompt") send({ type: "fixture_received", message: command.message });
    tail = tail.then(() => handle(command)).catch((error) => {
      console.error(error.stack || error.message);
      process.exitCode = 2;
      process.stdin.destroy();
    });
  }
});
process.stdin.on("end", () => {
  void tail.finally(() => process.exit(process.exitCode || 0));
});
`;

const root = await mkdtemp(path.join(os.tmpdir(), "subagent-native-rpc-test-"));
const fixture = path.join(root, "fixture.mjs");
await writeFile(fixture, fixtureSource, { mode: 0o600 });

const processFixture = path.join(root, "process-fixture.mjs");
await writeFile(processFixture, String.raw`
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

function startToken(pid) {
  const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

if (process.argv[2] === "descendant") {
  process.on("SIGTERM", () => {});
  process.on("disconnect", () => {});
  process.send?.({ ready: true });
  setInterval(() => {}, 1000);
} else {
  const statePath = process.argv[3];
  const descendant = spawn(process.execPath, [process.argv[1], "descendant"], {
    detached: false,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  descendant.once("message", () => {
    writeFileSync(statePath, JSON.stringify({ pid: descendant.pid, startToken: startToken(descendant.pid) }));
    process.stdout.write("descendant-ready\n");
  });
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
}
`, { mode: 0o600 });

function createSession(mode: string, controlTimeoutMs?: number, onJobRequest?: any) {
  const proc = spawn(process.execPath, [fixture, mode], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const events: any[] = [];
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const rpc = new NativeSubagentRpcSession({
    process: proc,
    onJobRequest,
    onEvent(event) {
      events.push(event);
      if (mode === "observer-failure") throw new Error("private payload must not be retained");
      if (event.type === "agent_start") started();
    },
    terminateProcess: () => proc.kill("SIGTERM"),
    controlTimeoutMs,
  });
  return { proc, rpc, events, startedPromise, stderr: () => stderr };
}

async function exercise(mode: "steer" | "follow_up" | "interrupt") {
  const session = createSession(mode);
  const exited = session.rpc.start("initial task");
  await session.startedPromise;
  assert.equal(session.rpc.isActive(), true);
  const updates: string[] = [];
  const controlled = await session.rpc.control(mode, `parent ${mode} message`, undefined, (text) => {
    if (text) updates.push(text);
  });
  assert.deepEqual(controlled, { text: "controlled \u2028 🌍 answer" });
  const exit = await exited;
  assert.equal(exit.code, 0, session.stderr());
  assert.equal(session.rpc.protocolError, undefined, session.stderr());
  assert.deepEqual(session.rpc.diagnostics.rawExit, { code: 0, signal: null });
  const trace = session.rpc.diagnostics.trace.map((entry) => entry.event);
  assert(trace.indexOf("agent_settled") < trace.indexOf("stdin_end"));
  assert(trace.indexOf("stdin_end") < trace.indexOf("stdout_end"));
  assert.equal(trace.at(-1), "process_close");
  assert(updates.some((text) => text.includes("controlled \u2028 🌍 answer")), `${mode} response did not stream`);
  assert(updates.every((text) => !text.includes("old response")), `${mode} streamed pre-control assistant text`);
  const fixtureCommands = session.events.findLast((event) => event.type === "fixture_commands")?.commands ?? [];
  const types = fixtureCommands.map((command: any) => command.type);
  if (mode === "interrupt") {
    assert.deepEqual(types, ["prompt", "extension_ui_response", "clear_queue", "abort", "prompt"]);
    assert.equal(fixtureCommands.at(-1).message, "parent interrupt message");
  } else {
    assert.deepEqual(types, ["prompt", "extension_ui_response", "prompt"]);
    assert.equal(fixtureCommands.at(-1).streamingBehavior, mode === "steer" ? "steer" : "followUp");
    assert.equal(fixtureCommands.at(-1).message, `parent ${mode} message`);
  }
  assert(!types.includes("steer") && !types.includes("follow_up"), "a dedicated queue command was used");
}

async function waitForEvent(session: ReturnType<typeof createSession>, predicate: (event: any) => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!session.events.some(predicate)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for fixture event; stderr: ${session.stderr()}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function withTimeout<T>(promise: Promise<T>, message: string, timeoutMs = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function exerciseSettleRace() {
  const session = createSession("settle-race");
  const exited = session.rpc.start("initial task");
  await session.startedPromise;
  assert.deepEqual(await session.rpc.control("steer", "race parent message"), { text: "race-safe answer" });
  assert.equal((await exited).code, 0, session.stderr());
  assert.equal(session.rpc.protocolError, undefined, session.stderr());
}

async function exerciseSerialization() {
  const session = createSession("serial");
  const exited = session.rpc.start("initial task");
  await session.startedPromise;
  const first = session.rpc.control("steer", "first steer");
  const second = session.rpc.control("follow_up", "second follow_up");
  assert.deepEqual(await first, { text: "answer:first steer" });
  assert.deepEqual(await second, { text: "answer:second follow_up" });
  assert.equal((await exited).code, 0, session.stderr());
  const commands = session.events.findLast((event) => event.type === "fixture_commands")?.commands ?? [];
  assert.deepEqual(commands.filter((command: any) => command.type === "prompt").map((command: any) => [command.message, command.streamingBehavior]), [
    ["initial task", undefined],
    ["first steer", "steer"],
    ["second follow_up", "followUp"],
  ]);
}

async function exerciseHandledInitialPrompt() {
  const session = createSession("handled-initial");
  const exit = await withTimeout(
    session.rpc.start("handled by child input extension"),
    "handled initial prompt did not terminate",
    500,
  );
  assert.equal(exit.code, 0, session.stderr());
  assert.equal(session.rpc.protocolError, undefined, session.stderr());
  assert.equal(session.rpc.isActive(), false);
}

async function exerciseControlReservedWhileInitialPromptIsHandled() {
  const session = createSession("handled-initial-pending");
  const exited = session.rpc.start("delayed handled initial prompt");
  await waitForEvent(session, (event) => event.type === "fixture_received");
  const controlled = session.rpc.control("steer", "must not strand this reservation");
  await assert.rejects(
    withTimeout(controlled, "control reservation leaked after the initial prompt was handled", 500),
    /handled its initial prompt without starting an agent run/,
  );
  const exit = await withTimeout(exited, "reserved control prevented handled-initial shutdown", 500);
  assert.equal(exit.code, 0, session.stderr());
  assert.equal(session.rpc.protocolError, undefined, session.stderr());
  assert.equal(session.rpc.isActive(), false);
}

async function exerciseHandledControlPrompt() {
  const session = createSession("handled-control");
  const exited = session.rpc.start("initial task");
  await session.startedPromise;
  const controlled = session.rpc.control("steer", "/handled-child-command");
  const early = await Promise.race([
    controlled.then(
      () => ({ completed: true, error: undefined }),
      (error: unknown) => ({ completed: true, error }),
    ),
    new Promise<{ completed: false; error?: undefined }>((resolve) => setTimeout(() => resolve({ completed: false }), 40)),
  ]);
  assert.equal(early.completed, true, "handled control waited for the unrelated active run");
  if (early.completed) {
    assert(early.error instanceof Error, "handled control claimed an empty child response");
    assert.match(early.error.message, /handled the control prompt without starting an agent run/);
    assert.equal((early.error as any).code, "handled");
  }
  assert.equal((await exited).code, 0, session.stderr());
  assert.equal(session.rpc.protocolError, undefined, session.stderr());
}

async function exerciseTransformedPrompt() {
  const session = createSession("transform");
  const exited = session.rpc.start("initial task");
  await session.startedPromise;
  assert.deepEqual(
    await session.rpc.control("steer", "raw parent text that the child rewrites"),
    { text: "transformed answer" },
  );
  assert.equal((await exited).code, 0, session.stderr());
  const delivered = session.events.find((event) => event.type === "message_end" && event.message?.role === "user"
    && event.message?.content === "rewritten child input");
  assert(delivered, "fixture did not deliver transformed child input");
}

async function exerciseCancellationKeepsReservation() {
  const session = createSession("cancel-serialization");
  const exited = session.rpc.start("initial task");
  await session.startedPromise;
  const controller = new AbortController();
  const updates: string[] = [];
  const cancelled = session.rpc.control("steer", "cancelled caller", controller.signal, (text) => updates.push(text));
  await waitForEvent(session, (event) => event.type === "fixture_control_accepted");
  controller.abort(new Error("caller stopped waiting"));
  await assert.rejects(cancelled, /caller stopped waiting/);

  const second = session.rpc.control("follow_up", "after cancelled caller");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(
    session.events.some((event) => event.type === "fixture_received" && event.message === "after cancelled caller"),
    false,
    "caller cancellation released the RPC reservation before the dispatched command settled",
  );
  assert.deepEqual(await second, { text: "answer:after cancelled caller" });
  assert.equal((await exited).code, 0, session.stderr());
  assert.deepEqual(updates, [], "cancelled caller kept receiving child stream updates");
}

async function exerciseProtocolFailure(mode: string, expected: RegExp) {
  const session = createSession(mode);
  await session.rpc.start("initial task");
  assert.match(session.rpc.protocolError?.message ?? "", expected, session.stderr());
}

async function exerciseExitDiagnostics() {
  const session = createSession("unexpected-exit");
  await withTimeout(session.rpc.start("private prompt"), "unexpected exit did not settle");
  assert.deepEqual(session.rpc.diagnostics.rawExit, { code: 42, signal: null });
  assert.match(session.rpc.protocolError?.message ?? "", /stdout ended|process exited/);
  const diagnostics = session.rpc.diagnostics;
  assert(diagnostics.trace.some((entry) => entry.event === "stdout_end"));
  assert(diagnostics.trace.some((entry) => entry.event === "process_exit"));
  assert(diagnostics.trace.length <= 64);
  assert(!JSON.stringify(diagnostics).includes("private prompt"));
  diagnostics.trace.length = 0;
  assert(session.rpc.diagnostics.trace.length > 0, "diagnostics leaked mutable state");
}

async function exerciseNonBlockingPrompts() {
  const session = createSession("logical-timeout");
  const exited = session.rpc.start("long-running supervisor");
  await session.startedPromise;
  try {
    for (const mode of ["steer", "follow_up"] as const) {
      const result = await withTimeout(session.rpc.acceptPrompt(mode, "continue supervising"), "accepted prompt waited for child completion", 500);
      assert.equal(result.accepted, true);
      assert.equal(session.rpc.isActive(), true);
      assert(!session.events.some(event => event.type === "agent_settled"));
    }
    const blocking = session.rpc.control("steer", "explicitly wait for full response");
    const rejected = assert.rejects(blocking, /no longer active|channel is closed/);
    await assert.rejects(session.rpc.acceptPrompt("steer", "do not queue behind a full run"), (error: any) => error.code === "busy");
    session.rpc.terminate();
    await rejected;
  } finally {
    session.rpc.terminate();
    await withTimeout(exited, "non-blocking test child did not exit");
  }
}

async function exerciseLogicalControlTimeout() {
  const session = createSession("logical-timeout", 50);
  const exited = session.rpc.start("initial task");
  await session.startedPromise;
  await assert.rejects(
    session.rpc.control("steer", "never delivered"),
    (error: any) => error?.code === "timeout" && /bounded control deadline/.test(error.message),
  );
  await withTimeout(exited, "timed-out control did not terminate its child");
  assert.equal(session.rpc.isActive(), false);
}

async function exerciseStdoutFailure() {
  const session = createSession("steer");
  const exited = session.rpc.start("initial task");
  await session.startedPromise;
  session.proc.stdout.destroy(new Error("synthetic read-side failure"));
  await withTimeout(exited, "stdout failure did not terminate the native child");
  assert.match(session.rpc.protocolError?.message ?? "", /RPC stdout failed: synthetic read-side failure/);
}

async function processStillMatches(pid: number, startToken: string): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] === startToken;
  } catch {
    return false;
  }
}

async function waitForLine(stream: NodeJS.ReadableStream): Promise<string> {
  let buffer = "";
  return await new Promise<string>((resolve, reject) => {
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        cleanup();
        resolve(buffer.slice(0, newline));
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("process fixture stdout ended before its ready marker"));
    };
    const cleanup = () => {
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
  });
}

async function exerciseSequentialProcessGroups() {
  if (process.platform === "win32") return;
  const options = {
    shellPath: process.env.TEST_POSIX_SHELL ?? "/bin/sh",
    fifoPath: process.env.TEST_MKFIFO ?? "/usr/bin/mkfifo",
    termGraceMs: 50,
  };
  await (async () => {
    const first = spawnNativeSubagentProcess(process.execPath, ["-e", "setTimeout(() => {}, 200)"], options);
    const closed = once(first.process, "close");
    await first.ready;
    assert.deepEqual(await closed, [0, null]);
  })();
  const next = spawnNativeSubagentProcess(process.execPath, ["-e", "setTimeout(() => {}, 500)"], options);
  const closed = once(next.process, "close");
  await next.ready;
  const gc = setInterval(() => {
    (globalThis as any).Bun?.gc(true);
    (globalThis as any).gc?.();
  }, 10);
  try {
    assert.deepEqual(await withTimeout(closed, "successive process group did not close", 2000), [0, null],
      "collecting a completed child closed a later child's control channel");
  } finally { clearInterval(gc); next.terminate(); }
}

async function exerciseProcessGroupEscalation() {
  if (process.platform !== "linux") return;
  const statePath = path.join(root, "descendant.json");
  const owned = spawnNativeSubagentProcess(process.execPath, [processFixture, "leader", statePath], {
    shellPath: process.env.TEST_POSIX_SHELL ?? "/bin/sh",
    fifoPath: process.env.TEST_MKFIFO ?? "/usr/bin/mkfifo",
    termGraceMs: 500,
  });
  await owned.ready;
  assert.equal(await withTimeout(waitForLine(owned.process.stdout), "process fixture did not become ready"), "descendant-ready");
  const identity = JSON.parse(await readFile(statePath, "utf8")) as { pid: number; startToken: string };
  try {
    const leaderExit = once(owned.process, "exit");
    let closeObserved = false;
    const groupClose = once(owned.process, "close").then(() => { closeObserved = true; });
    owned.terminate();
    await withTimeout(leaderExit, "TERM-responsive process-group leader did not exit");
    assert.equal(closeObserved, false, "child close was reported before process-group escalation");
    assert.equal(await processStillMatches(identity.pid, identity.startToken), true, "TERM unexpectedly killed the ignoring descendant");
    const deadline = Date.now() + 2_000;
    while (await processStillMatches(identity.pid, identity.startToken)) {
      if (Date.now() >= deadline) throw new Error("TERM-ignoring descendant survived process-group escalation");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await withTimeout(groupClose, "process-group close was not reported after escalation");
  } finally {
    if (await processStillMatches(identity.pid, identity.startToken)) {
      try { process.kill(identity.pid, "SIGKILL"); } catch {}
    }
  }
}

try {
  let jobRequestSeen = false;
  const jobSession = createSession("parent-job", undefined, async (request: any, signal: AbortSignal) => {
    assert.equal(request.params.command, "printf fixture");
    assert.equal(signal.aborted, false);
    jobRequestSeen = true;
    return { content: [{ type: "text", text: "parent-owned job accepted" }] };
  });
  assert.equal((await jobSession.rpc.start("job fixture")).code, 0);
  assert(jobRequestSeen);
  assert(jobSession.events.some(event => event.message?.content?.[0]?.text === "parent-owned job accepted"));
  const deniedJob = createSession("parent-job");
  assert.equal((await deniedJob.rpc.start("no broker")).code, 0);
  assert(deniedJob.events.some(event => event.message?.content?.[0]?.text?.includes("unavailable")));
  await exercise("steer");
  await exercise("follow_up");
  await exercise("interrupt");
  await exerciseSettleRace();
  await exerciseSerialization();
  await exerciseHandledInitialPrompt();
  const compacted = createSession("handled-initial");
  assert.equal((await compacted.rpc.start("continue retained task", true)).code, 0);
  assert(compacted.events.some(event => event.type === "fixture_compacted"));
  await exerciseControlReservedWhileInitialPromptIsHandled();
  await exerciseHandledControlPrompt();
  await exerciseTransformedPrompt();
  await exerciseCancellationKeepsReservation();
  await exerciseNonBlockingPrompts();
  await exerciseLogicalControlTimeout();
  await exerciseProtocolFailure("invalid-utf8", /not valid UTF-8/);
  await exerciseProtocolFailure("non-lf", /non-LF-terminated/);
  await exerciseProtocolFailure("empty-frame", /empty JSONL frame/);
  await exerciseProtocolFailure("unknown-ui", /unsupported extension UI method/);
  await exerciseProtocolFailure("observer-failure", /event observer failed/);
  await exerciseExitDiagnostics();
  await exerciseStdoutFailure();
  await exerciseSequentialProcessGroups();
  await exerciseProcessGroupEscalation();
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("native subagent RPC control checks passed");
