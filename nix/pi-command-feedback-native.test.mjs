// Exercise the shipped standalone Bun runtime through its real offline RPC process.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

const [runtimeArg, fixtureArg] = process.argv.slice(2);
const nodeSdk = runtimeArg?.startsWith("node-sdk:") ?? false;
const binary = nodeSdk ? resolve(runtimeArg.slice("node-sdk:".length), "dist/cli.js") : resolve(runtimeArg ?? "");
const fixture = resolve(fixtureArg ?? "");
assert.ok(runtimeArg && fixtureArg, "Usage: pi-command-feedback-native.test.mjs PI_BINARY|node-sdk:PACKAGE_ROOT FIXTURE_EXTENSION");
const directory = await mkdtemp(join(tmpdir(), "pi-command-feedback-"));
const home = join(directory, "home"), agentDir = join(home, "agent"), cwd = join(directory, "workspace");
await mkdir(agentDir, { recursive: true });
await mkdir(cwd);
await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
const args = ["--mode", "rpc", "--offline", "--no-session", "--no-extensions", "--no-skills", "--extension", fixture];
const child = nodeSdk ? spawn(process.execPath, [binary, ...args], { cwd, env: {
    PATH: process.env.PATH ?? "", HOME: home, TMPDIR: directory,
    XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
  }, stdio: ["pipe", "pipe", "pipe"] }) : spawn(binary, args, {
  cwd,
  env: {
    PATH: process.env.PATH ?? "", HOME: home, TMPDIR: directory,
    XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
  },
  stdio: ["pipe", "pipe", "pipe"],
});
const events = [], stderr = [], bus = new EventEmitter();
let exited, requestId = 0;
const exit = new Promise((resolveExit) => child.once("exit", (code, signal) => {
  exited = { code, signal };
  bus.emit("change");
  resolveExit(exited);
}));
const stdout = createInterface({ input: child.stdout });
const stderrReader = createInterface({ input: child.stderr });
stdout.on("line", (line) => {
  try {
    const event = JSON.parse(line);
    events.push(event);
    if (event.type === "extension_ui_request" && event.method === "input" && event.title === "Feedback local input") {
      child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: event.id, value: "local-answer" }) + "\n");
    }
  } catch { stderr.push(`Non-JSON stdout: ${line}`); }
  bus.emit("change");
});
stderrReader.on("line", (line) => { stderr.push(line); bus.emit("change"); });
function waitFor(read, label, timeout = 10000) {
  return new Promise((resolveWait, reject) => {
    const timer = setTimeout(() => finish(new Error(`Timeout: ${label}; stderr=${stderr.join("\n")}`)), timeout);
    function finish(error, value) { clearTimeout(timer); bus.off("change", check); error ? reject(error) : resolveWait(value); }
    function check() {
      const value = read();
      if (value) finish(undefined, value);
      else if (exited) finish(new Error(`Pi exited before ${label}: ${JSON.stringify(exited)}; stderr=${stderr.join("\n")}`));
    }
    bus.on("change", check);
    check();
  });
}
async function rpc(type, fields = {}) {
  const id = `feedback-${++requestId}`;
  child.stdin.write(JSON.stringify({ id, type, ...fields }) + "\n");
  const response = await waitFor(() => events.find((event) => event.type === "response" && event.id === id), `${type} response`);
  assert.equal(response.success, true, JSON.stringify(response));
  return response.data;
}
const uiRequests = () => events.filter((event) => event.type === "extension_ui_request" && event.method === "notify");
try {
  await rpc("get_state");
  const startedAt = Date.now();
  const result = await rpc("prompt", { message: "/feedback_probe" });
  const elapsed = Date.now() - startedAt;
  assert.equal(result.disposition, "handled");
  assert.ok(elapsed >= 150, `RPC prompt returned before delayed command settled (${elapsed}ms)`);

  await waitFor(() => uiRequests().find((event) => event.message === "late local notice"), "late local UI notification");
  const messages = uiRequests().map((event) => event.message);
  assert.deepEqual(messages, [
    "stream:literal delayed notice α",
    "literal delayed notice α",
    "receipt:completed:1",
    "stream:literal before throw",
    "literal before throw",
    "failure:failed:expected dispatch failure:1",
    "missing:not_found:0",
    "counts:1:1:2",
    "late local notice",
  ]);
  assert.equal(uiRequests()[0].notifyType, "warning");
  assert.equal(uiRequests()[1].notifyType, "warning");
  assert.equal(uiRequests()[3].notifyType, "error");
  assert.equal(uiRequests()[4].notifyType, "error");
  assert.equal(messages.includes("stream:late local notice"), false, "late callback escaped its settled dispatch observer");
  assert.equal(events.filter((event) => event.type === "extension_error").length, 0, "awaitable dispatch emitted a legacy extension_error");

  // Rebind the live session and prove dispatch creates fresh command context after a switch.
  const switched = await rpc("new_session");
  assert.equal(switched.cancelled, false);
  await rpc("prompt", { message: "/feedback_probe" });
  await waitFor(() => uiRequests().filter((event) => event.message === "late local notice").length === 2, "replacement-session late local UI notification");
  const secondMessages = uiRequests().slice(9).map((event) => event.message);
  assert.deepEqual(secondMessages.slice(0, 7), [
    "stream:literal delayed notice α", "literal delayed notice α", "receipt:completed:1",
    "stream:literal before throw", "literal before throw", "failure:failed:expected dispatch failure:1",
    "missing:not_found:0",
  ]);
  assert.match(secondMessages[7], /^counts:[12]:[12]:2$/, "replacement session did not run one fresh invocation");
  assert.equal(secondMessages[8], "late local notice");
  assert.equal(secondMessages.includes("stream:late local notice"), false, "replacement dispatch observer remained live after settlement");
  const beforeAdmission = uiRequests().length;
  await rpc("prompt", { message: "/feedback_admission" });
  const admissionMessages = uiRequests().slice(beforeAdmission).map(event => event.message);
  assert.equal(admissionMessages[0], "admission:handled");
  assert.ok(admissionMessages[1].startsWith("admission-rejected:"), JSON.stringify(admissionMessages));
  assert.ok(!admissionMessages[1].includes("UNEXPECTED_NETWORK"));
  assert.match(admissionMessages[2], /^dialog-blocked:failed:.*requires terminal UI/);
  assert.equal(admissionMessages[3], "dialog-value:local-answer");
  assert.equal(admissionMessages[4], "dialog-allowed:completed");
  assert.equal(admissionMessages[5], "network-calls:0");
  assert.equal(events.filter(event => event.type === "extension_ui_request" && event.method === "input").length, 1, "blocked UI emitted an invisible dialog");
  assert.equal(events.filter(event => event.type === "agent_start").length, 0, "consumed/rejected input started a model run");
  await rpc("prompt", { message: "/feedback_model_admission" });
  assert.ok(uiRequests().some(event => event.message === "model-admission:started"));
  assert.ok(uiRequests().some(event => event.message === "model-admission:queued"));
  assert.equal((await rpc("get_state")).isStreaming, true, "admission waited for generation instead of returning its receipt");
  await rpc("prompt", { message: "/feedback_release" });
  await waitFor(() => events.find(event => event.type === "agent_settled"), "offline model completion");
  assert.equal((await rpc("get_state")).isStreaming, false);
  const history = (await rpc("get_messages")).messages;
  const text = message => typeof message.content === "string" ? message.content : (message.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");
  assert.ok(history.some(message => message.role === "user" && text(message) === "model-queued"), "queued admission lost the actual user message");
  assert.equal(history.filter(message => message.role === "assistant" && text(message) === "Offline completion").length, 2);
  await rpc("prompt", { message: "/feedback_network" });
  assert.ok(uiRequests().some(event => event.message === "network-final:0"));
  console.log("PASS Node/native Pi: command outcomes, scoped notifications, handled/started/queued admission before generation, terminal-dialog policy, zero live provider/network calls");
} finally {
  child.stdin.end();
  if (!exited) child.kill("SIGTERM");
  const killDeadline = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 2000);
  killDeadline.unref();
  await exit;
  clearTimeout(killDeadline);
  stdout.close();
  stderrReader.close();
  await rm(directory, { recursive: true, force: true });
}
