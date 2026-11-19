import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

function createPi(flag) {
  const handlers = new Map();
  const commands = new Map();
  const tools = new Map();
  return {
    handlers,
    commands,
    tools,
    registerFlag() {},
    getFlag(name) {
      return name === "ssh" ? flag : undefined;
    },
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
    on(name, handler) {
      const values = handlers.get(name) || [];
      values.push(handler);
      handlers.set(name, values);
    },
  };
}

function createContext(cwd, sessionFile) {
  const notices = [];
  const statuses = new Map();
  let shutdown = false;
  let waited = false;
  return {
    cwd,
    mode: "tui",
    hasUI: true,
    notices,
    statuses,
    get shutdown() {
      return shutdown;
    },
    get waited() {
      return waited;
    },
    ui: {
      theme: { fg: (_color, text) => text },
      notify(message, level) {
        notices.push({ message, level });
      },
      setStatus(name, value) {
        statuses.set(name, value);
      },
    },
    sessionManager: { getSessionFile: () => sessionFile },
    async waitForIdle() {
      waited = true;
    },
    shutdown() {
      shutdown = true;
    },
  };
}

async function first(pi, name, ...args) {
  const handler = (pi.handlers.get(name) || [])[0];
  assert(handler, `missing handler ${name}`);
  return await handler(...args);
}

const modulePath = path.join(process.argv[2], "ssh/index.js");
const imported = await import(pathToFileURL(modulePath).href);
const transforms = await import(
  pathToFileURL(path.join(process.argv[2], "shared/bash-command-transform.js")).href
);
const extension = imported.default?.default ?? imported.default ?? imported;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-target-test-"));
const sessionFile = path.join(root, "session.jsonl");

// Supervised mode selects the AgentSH backend and writes a wrapper request.
// A brand-new Pi session reserves a path but does not create the file until
// the first assistant response, so immediate retargeting must request a
// fresh empty session rather than reject the handoff.
const requestDir = path.join(root, "control");
fs.mkdirSync(requestDir, { mode: 0o700 });
const requestPath = path.join(requestDir, "retarget.json");
process.env.PI_SUPERVISED = "1";
process.env.AGENTSH_SESSION_SUPERVISOR = "unix:///tmp/supervisor.sock";
process.env.PI_AGENTSH_TARGET_KIND = "ssh";
process.env.PI_AGENTSH_REMOTE_TARGET = "old-host";
process.env.PI_AGENTSH_REMOTE_CWD = "/old/work";
process.env.PI_AGENTSH_RETARGET_REQUEST = requestPath;
process.env.PI_AGENTSH_RETARGET_LOCAL_SUPPORTED = "1";
let published;
const execCalls = [];
globalThis.__AGENTSH_PI__ = {
  setExecutionTarget(target) {
    published = target;
  },
  getExecutionTarget() {
    return published;
  },
  getSupervisorState() {
    return { configured: true, active: true, protocol: "rest", status: "connected" };
  },
  async exec(command, options) {
    execCalls.push({ command, options });
    return { exitCode: 0 };
  },
};

const supervisedPi = createPi(undefined);
extension(supervisedPi);
const supervisedCtx = createContext(root, sessionFile);
await first(supervisedPi, "session_start", {}, supervisedCtx);
assert(
  published?.kind === "ssh" && published.remote === "old-host" && published.cwd === "/old/work",
  "supervised target was not published",
);
assert(supervisedPi.tools.size === 0, "ssh extension must not replace sandbox tools");
const userBash = await first(supervisedPi, "user_bash", { command: "pwd" }, supervisedCtx);
await userBash.operations.exec("pwd", root, { onData() {} });
assert(
  execCalls[0]?.command?.cwd === "/old/work",
  "supervised ! command did not use AgentSH target cwd",
);
const prompt = await first(
  supervisedPi,
  "before_agent_start",
  { systemPrompt: `Current working directory: ${process.cwd()}` },
  supervisedCtx,
);
assert(
  prompt.systemPrompt.includes("remote AgentSH sandbox over SSH: old-host"),
  "supervised prompt did not describe the target",
);
await supervisedPi.commands.get("retarget").handler("new-host:/new/work", supervisedCtx);
assert(
  supervisedCtx.waited && supervisedCtx.shutdown,
  "supervised retarget did not wait and shut down gracefully",
);
const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
assert(
  request.schema_version === 1 &&
    request.target === "new-host:/new/work" &&
    request.session_file === null,
  "invalid wrapper retarget request for a fresh session",
);
assert((fs.statSync(requestPath).mode & 0o777) === 0o600, "retarget request is not private");

delete globalThis.__AGENTSH_PI__;
const unavailablePi = createPi(undefined);
extension(unavailablePi);
for (const toolName of ["bash", "write", "edit", "read"]) {
  const blocked = await first(
    unavailablePi,
    "tool_call",
    { toolName, input: { command: "printf no-fallback" } },
    supervisedCtx,
  );
  assert(blocked?.block === true, "unavailable full mode did not block native " + toolName);
}

// Legacy mode owns raw SSH and can switch back to local in-process.
for (const name of [
  "PI_SUPERVISED",
  "AGENTSH_SESSION_SUPERVISOR",
  "PI_AGENTSH_TARGET_KIND",
  "PI_AGENTSH_REMOTE_TARGET",
  "PI_AGENTSH_REMOTE_CWD",
  "PI_AGENTSH_RETARGET_REQUEST",
  "PI_AGENTSH_RETARGET_LOCAL_SUPPORTED",
])
  delete process.env[name];
delete globalThis.__AGENTSH_PI__;
const legacyPi = createPi("legacy:/repo");
extension(legacyPi);
const legacyCtx = createContext(root, sessionFile);
await first(legacyPi, "session_start", {}, legacyCtx);
assert(legacyPi.tools.size === 3, "legacy SSH tools were not registered");
const event = { toolName: "bash", input: { command: "echo ok" } };
// Simulate Permission Gate running before SSH. Both handlers share the
// same idempotent transform, so the gate sees the final command and SSH
// cannot wrap it again later.
transforms.applyBashCommandTransforms(event.input);
Object.freeze(event.input);
await first(legacyPi, "tool_call", event, legacyCtx);
assert(event.input.command.includes("ssh 'legacy'"), "legacy bash was not routed through SSH");
assert(
  (event.input.command.match(/ssh 'legacy'/g) || []).length === 1,
  "legacy Bash was transformed more than once",
);
await legacyPi.commands.get("retarget").handler("", legacyCtx);
const localBash = await first(legacyPi, "user_bash", { command: "pwd" }, legacyCtx);
assert(localBash === undefined, "legacy local retarget still intercepted user bash");
await legacyPi.commands.get("retarget").handler("other-host", legacyCtx);
const remoteBash = await first(legacyPi, "user_bash", { command: "pwd" }, legacyCtx);
assert(remoteBash?.operations, "legacy host retarget did not restore SSH routing");
assert(
  fs.readFileSync(process.env.SSH_TEST_LOG, "utf8").includes("other-host pwd"),
  "host-only retarget did not resolve remote pwd",
);

let invalidRejected = false;
try {
  imported.parseSshArg("\n");
} catch (error) {
  invalidRejected = /non-empty single-line/.test(String(error));
}
assert(invalidRejected, "invalid target accepted");
console.log("ssh extension checks passed");
