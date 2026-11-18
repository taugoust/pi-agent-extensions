import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createPi() {
  const handlers = new Map();
  return {
    handlers,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
}

function createContext(cwd, hasUI = true) {
  const statuses = [];
  const notifications = [];
  return {
    cwd,
    hasUI,
    statuses,
    notifications,
    ui: {
      theme: { fg: (_color, text) => text },
      setStatus(name, value) {
        statuses.push({ name, value });
      },
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  };
}

async function emit(pi, event, payload, ctx) {
  for (const handler of pi.handlers.get(event) ?? []) await handler(payload, ctx);
}

async function main() {
  const moduleUrl = pathToFileURL(path.join(process.argv[2], "direnv/index.js")).href;
  const imported = await import(moduleUrl);
  const direnv = imported.default?.default ?? imported.default ?? imported;
  assert(typeof direnv === "function", "direnv module did not export a function");

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "direnv-check-"));
  const bin = path.join(tempRoot, "bin");
  const spawnMarker = path.join(tempRoot, "spawned.log");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "direnv"),
    [
      "#!/bin/sh",
      "printf 'spawned\\n' >> \"$DIRENV_SPAWN_MARKER\"",
      'printf \'%s\\n\' \'{"DIRENV_CHECK_SET":"from-local","DIRENV_CHECK_UNSET":null}\'',
    ].join("\n"),
    { mode: 0o755 },
  );
  process.env.PATH = bin + path.delimiter + process.env.PATH;
  process.env.DIRENV_SPAWN_MARKER = spawnMarker;

  // pi-unsafe/non-AgentSH behaviour remains the local process.env hook.
  for (const name of [
    "PI_SUPERVISED",
    "PI_AUTO",
    "PI_AGENTSH_REMOTE",
    "PI_AGENTSH_READ_MODE",
    "AGENTSH_SESSION_SUPERVISOR",
    "PI_AGENTSH_MOCK_SUPERVISOR",
    "PI_AGENTSH_ENABLE",
    "AGENTSH_CHILD_CAPABILITY",
    "AGENTSH_APPROVAL_UI_SOCKET",
    "AGENTSH_PERMISSION_GATE_SOCKET",
  ])
    delete process.env[name];
  delete globalThis.__AGENTSH_PI__;
  process.env.DIRENV_CHECK_UNSET = "remove-me";
  {
    const pi = createPi();
    direnv(pi);
    const ctx = createContext(tempRoot);
    await emit(pi, "session_start", {}, ctx);
    assert(
      process.env.DIRENV_CHECK_SET === "from-local",
      "unsupervised direnv did not set process.env",
    );
    assert(
      process.env.DIRENV_CHECK_UNSET === undefined,
      "unsupervised direnv did not unset process.env",
    );
    assert(
      fs.readFileSync(spawnMarker, "utf8").trim() === "spawned",
      "unsupervised direnv did not invoke the local binary",
    );
  }

  // Supervised mode delegates session-start and post-bash refreshes, uses
  // the supplied execution cwd, serializes calls, and never spawns locally.
  process.env.PI_SUPERVISED = "1";
  process.env.AGENTSH_SESSION_ID = "sess-direnv";
  fs.writeFileSync(spawnMarker, "");
  process.env.AGENTSH_CONTROL_SENTINEL = "parent-owned";
  const calls = [];
  let active = 0;
  let maxActive = 0;
  let nextState = "loaded";
  globalThis.__AGENTSH_PI__ = {
    getSupervisorState() {
      return { configured: true, active: true, protocol: "rest", status: "connected" };
    },
    async refreshDirenv(options) {
      calls.push(options);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return {
        state: nextState,
        set_count: 1,
        unset_count: 0,
        rejected_count: 1,
        generation: calls.length,
        duration_ms: 1,
      };
    },
  };
  {
    const pi = createPi();
    direnv(pi);
    const ctx = createContext("/execution/workspace");
    await emit(pi, "session_start", {}, ctx);
    await Promise.all([
      emit(pi, "tool_result", { toolName: "bash" }, ctx),
      emit(pi, "tool_result", { toolName: "bash" }, ctx),
    ]);
    assert(
      calls.length === 3,
      "supervised direnv did not refresh on startup and both bash results",
    );
    assert(
      calls.every((call) => call.cwd === "/execution/workspace"),
      "supervised direnv sent the wrong cwd",
    );
    assert(
      calls.every((call) => call.actor?.kind === "extension"),
      "supervised direnv omitted its typed extension actor",
    );
    assert(maxActive === 1, "supervised direnv refreshes were not serialized");
    assert(
      fs.readFileSync(spawnMarker, "utf8") === "",
      "supervised direnv spawned the local binary",
    );
    assert(
      process.env.AGENTSH_CONTROL_SENTINEL === "parent-owned",
      "supervised response mutated protected parent environment",
    );

    nextState = "no_envrc";
    await emit(pi, "tool_result", { toolName: "bash" }, ctx);
    assert(
      ctx.statuses.some((entry) => entry.name === "direnv" && entry.value === undefined),
      "no_envrc did not clear the status",
    );

    nextState = "not_allowed";
    await emit(pi, "tool_result", { toolName: "bash" }, ctx);
    await emit(pi, "tool_result", { toolName: "bash" }, ctx);
    const allowWarnings = ctx.notifications.filter(
      (entry) => entry.level === "warning" && entry.message.includes("direnv allow"),
    );
    assert(allowWarnings.length === 1, "repeated not_allowed refreshes emitted duplicate warnings");
  }

  // A separate supervised session still reports an initial policy denial.
  nextState = "policy_denied";
  {
    const pi = createPi();
    direnv(pi);
    const ctx = createContext("/execution/workspace");
    await emit(pi, "session_start", {}, ctx);
    assert(
      ctx.notifications.some(
        (entry) => entry.level === "error" && entry.message.includes("policy denied"),
      ),
      "policy_denied was not clear and non-fatal",
    );
  }

  // Missing/old sandbox integration fails closed: no trusted-parent fallback.
  delete globalThis.__AGENTSH_PI__;
  fs.writeFileSync(spawnMarker, "");
  {
    const pi = createPi();
    direnv(pi);
    const ctx = createContext(tempRoot);
    await emit(pi, "session_start", {}, ctx);
    assert(
      fs.readFileSync(spawnMarker, "utf8") === "",
      "missing AgentSH API fell back to local direnv",
    );
    assert(
      ctx.notifications.some((entry) =>
        entry.message.includes("will not run direnv in the parent"),
      ),
      "missing AgentSH API diagnostic was not fail-closed",
    );
  }
}

await main();
