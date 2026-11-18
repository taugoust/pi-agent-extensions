import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import gate from "./out/permission-gate/index.js";
import { registerBashCommandTransform } from "./out/shared/bash-command-transform.js";

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const rejectsMode = (call) => {
  let failed = false;
  try {
    call();
  } catch {
    failed = true;
  }
  assert(failed, "invalid operator authority accepted");
};

function createPi() {
  const handlers = new Map();
  const commands = new Map();
  const emitted = [];
  const modeEvents = [];
  return {
    handlers,
    commands,
    emitted,
    modeEvents,
    events: {
      emit(name, data) {
        emitted.push(name);
        if (name === "permission-gate:mode-changed") modeEvents.push(data);
      },
    },
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
    on(name, handler) {
      handlers.set(name, handler);
    },
  };
}

function createContext(options = {}) {
  const statuses = [];
  const notifications = [];
  const selections = [];
  const controller = options.controller || new AbortController();
  return {
    cwd: "/exact/workspace",
    mode: "tui",
    sessionManager: { getSessionId: () => options.sessionId || "permission-gate-test-session" },
    hasUI: options.hasUI !== false,
    signal: controller.signal,
    controller,
    statuses,
    notifications,
    selections,
    ui: {
      theme: { fg: (_color, text) => text },
      setStatus(name, value) {
        statuses.push({ name, value });
      },
      notify(message, level) {
        notifications.push({ message, level });
      },
      async select(title, choices, settings) {
        selections.push({ title, choices, signal: settings?.signal });
        if (options.onSelect) return await options.onSelect(title, choices, settings, controller);
        return options.choice;
      },
    },
  };
}

async function runInheritedChild(name) {
  assert(
    process.env.AGENTSH_PERMISSION_GATE_SOCKET === undefined,
    "gate socket marker was not claimed and deleted during import",
  );
  let pi = createPi();
  let remoteSelections = [];
  const structuredSelections = [];
  let contextOptions = { choice: "Allow" };
  if (name === "local-deny") contextOptions.choice = "Deny";
  if (name === "cancel") contextOptions.choice = undefined;
  if (name === "headless") contextOptions.hasUI = false;
  if (name === "prompt-timeout") {
    contextOptions.onSelect = async () => await new Promise(() => {});
  }
  if (name === "abort" || name === "transport-eof") {
    contextOptions.onSelect = async (_title, _choices, settings, controller) => {
      assert(settings?.signal, "AgentSH terminal prompt omitted its signal");
      if (name === "abort") setTimeout(() => controller.abort(), 5);
      await new Promise((resolve) =>
        settings.signal.addEventListener("abort", resolve, { once: true }),
      );
      return undefined;
    };
  }
  if (name === "remote-allow") {
    globalThis.__piPaseoRemoteUiV1 = {
      isConnected: () => true,
      async select(title, choices, settings) {
        remoteSelections.push({ title, choices, signal: Boolean(settings?.signal) });
        return "Allow";
      },
      async selectMirrored(title, choices, localSelect, settings) {
        remoteSelections.push({ title, choices, signal: Boolean(settings?.signal) });
        const controller = new AbortController();
        const local = localSelect(controller.signal);
        await new Promise((resolve) => setTimeout(resolve, 0));
        controller.abort();
        await local;
        return "Allow";
      },
    };
    contextOptions.onSelect = async (_title, _choices, settings) => {
      await new Promise((resolve) =>
        settings.signal.addEventListener("abort", resolve, { once: true }),
      );
      return undefined;
    };
  }

  let ctx = createContext(contextOptions);
  if (name.startsWith("structured-")) {
    ctx.mode = "rpc";
    ctx.ui.select = async () => {
      throw new Error("Structured headless permission used terminal UI");
    };
    globalThis.__paeWorkerInteractionsV1 = {
      protocol: 1,
      mode: "headless",
      workerEpoch: "test-worker",
      async request(input, signal) {
        structuredSelections.push({ input, signal: Boolean(signal) });
        assert(
          signal && input.kind === "permission" && input.options.join(",") === "Deny,Allow",
          "invalid structured permission schema",
        );
        assert(input.detail.includes("sudo true"), "structured approval omitted the command");
        if (name === "structured-pending-off") {
          operator.applyMode(sessionId, false);
          assert(signal.aborted, "mode change did not dismiss structured request");
          throw new Error("mode changed");
        }
        if (["structured-abort", "structured-transport-eof", "structured-timeout"].includes(name)) {
          if (name === "structured-abort") setTimeout(() => ctx.controller.abort(), 5);
          await new Promise((resolve) =>
            signal.aborted ? resolve() : signal.addEventListener("abort", resolve, { once: true }),
          );
          throw new Error("structured request aborted");
        }
        if (name === "structured-failure") throw new Error("UI unavailable");
        if (name === "structured-invalid")
          return { kind: "permission", cancelled: false, value: "unexpected" };
        if (name === "structured-cancel") return { kind: "permission", cancelled: true };
        return {
          kind: "permission",
          cancelled: false,
          value: name === "structured-deny" ? "Deny" : "Allow",
        };
      },
    };
  }
  if (name === "transform-order") {
    registerBashCommandTransform(
      "test-wrapper",
      (command) => `ssh 'test-host' ${JSON.stringify(command)}`,
    );
  }
  if (name === "invalid-command") registerBashCommandTransform("ssh-target", (command) => command);
  if (name === "broken-transform") registerBashCommandTransform("broken", () => "");
  gate(pi);
  assert(
    JSON.stringify(globalThis.__paeSubagentPermissionSelectionV1) ===
      JSON.stringify({ protocol: 1, selected: true, conflict: false }),
    "guard selection was not published before session start",
  );
  const operator = globalThis.__PAE_PERMISSION_GATE_OPERATOR_V1__;
  const sessionId = ctx.sessionManager.getSessionId();
  assert(
    operator?.version === 1 && Object.isFrozen(operator),
    "missing versioned operator service",
  );
  rejectsMode(() => operator.applyMode(sessionId, false));
  await pi.handlers.get("session_start")({}, ctx);
  if (
    !["bad-hello", "transport-eof"].includes(name) &&
    globalThis.__paeSubagentPermissionAuthorityV1.active
  ) {
    assert(operator.status(sessionId).enabled, "independent session did not default on");
    rejectsMode(() => operator.status("stale-session"));
    rejectsMode(() => operator.applyMode("stale-session", false));
    rejectsMode(() => operator.applyMode(sessionId, "off"));
  }
  if (name === "operator-off") {
    const commandAuthority = globalThis.__paeCommandAuthorityV1;
    commandAuthority.active = false;
    rejectsMode(() => operator.applyMode(sessionId, false));
    commandAuthority.active = true;
    globalThis.__paeCommandAuthorityV1 = {};
    rejectsMode(() => operator.status(sessionId));
    globalThis.__paeCommandAuthorityV1 = commandAuthority;
    globalThis.__AGENTSH_PI__ = {
      getSupervisorState: () => ({ configured: true, active: true, protocol: "rest" }),
      exec() {},
    };
    rejectsMode(() => operator.applyMode(sessionId, false));
    delete globalThis.__AGENTSH_PI__;
    assert(operator.status(sessionId).enabled, "authority loss changed prompt mode");
    assert(pi.modeEvents.length === 0, "rejected mode operation emitted an event");
    assert(operator.applyMode(sessionId, false).enabled === false, "operator mode not applied");
    assert(operator.status(sessionId).enabled === false, "operator status not updated");
    assert(
      JSON.stringify(pi.modeEvents) === JSON.stringify([{ sessionId, enabled: false }]),
      "operator event lost exact mode",
    );
    assert(
      ctx.statuses
        .findLast((entry) => entry.name === "permission-gate")
        ?.value?.includes("AgentSH gate ✗"),
      "disabled prompt mode must show gate cross",
    );
    assert(
      ctx.statuses.findLast((entry) => entry.name === "permission-gate-mode")?.value === undefined,
      "separate prompt-mode label must be cleared",
    );
  }
  if (
    ["mode-off", "mode-on", "reload-child", "new-session-child", "structured-mode-off"].includes(
      name,
    )
  ) {
    await pi.commands.get("permission-gate").handler("off", ctx);
    assert(
      JSON.stringify(pi.modeEvents[0]) === JSON.stringify({ sessionId, enabled: false }),
      "command did not use operator mode helper",
    );
    if (name === "mode-on") await pi.commands.get("permission-gate").handler("on", ctx);
  }
  if (name === "pending-off" || name === "operator-pending-off")
    contextOptions.onSelect = async (_title, _choices, settings) => {
      if (name === "operator-pending-off") operator.applyMode(sessionId, false);
      else await pi.commands.get("permission-gate").handler("off", ctx);
      assert(settings.signal.aborted, "off did not dismiss pending UI");
    };
  const tool = pi.handlers.get("tool_call");
  const results = [];
  if (name === "invalid-command") {
    const invalid = [undefined, null, {}, { command: 42 }, { command: "" }, { command: " \n\t" }];
    for (const input of invalid) {
      const denied = await tool({ toolName: "bash", toolCallId: "invalid-bash", input }, ctx);
      assert(
        denied?.block === true && denied.terminate !== true,
        "invalid Bash did not return a recoverable rejection",
      );
      assert(
        globalThis.__paeSubagentPermissionAuthorityV1.active,
        "invalid Bash poisoned child authority",
      );
    }
    for (const command of [undefined, null, 42, "", " \n\t"]) {
      const denied = await tool(
        {
          toolName: "background_job",
          toolCallId: "invalid-job",
          input: { action: "start", command },
        },
        ctx,
      );
      assert(
        denied?.block === true && denied.terminate !== true,
        "invalid job did not return a recoverable rejection",
      );
      assert(
        globalThis.__paeSubagentPermissionAuthorityV1.active,
        "invalid job poisoned child authority",
      );
    }
    assert(operator.status(sessionId).enabled, "invalid input disabled the operator service");
  }
  let childAuthorization;
  let authorityStable;
  let oldAuthorityActive;
  if (name === "local-allow") {
    results.push(
      await tool(
        { toolName: "bash", toolCallId: "tool-safe", input: { command: "printf safe" } },
        ctx,
      ),
    );
  }
  if (name === "background-allow") {
    results.push(
      await tool(
        {
          toolName: "background_job",
          toolCallId: "tool-background-list",
          input: { action: "list" },
        },
        ctx,
      ),
    );
    results.push(
      await tool(
        {
          toolName: "background_job",
          toolCallId: "tool-background-start",
          input: { action: "start", command: "printf background" },
        },
        ctx,
      ),
    );
  } else if (name === "child-allow") {
    const authority = globalThis.__paeSubagentPermissionAuthorityV1;
    assert(authority?.active === true, "child authority was not published after session start");
    childAuthorization = await authority.authorize(
      {
        subagentId: "native-child-1",
        label: "task 1",
        task: "inspect the remote safely",
        command: "ssh example.test",
        cwd: "/child/workspace",
        toolCallId: "child-tool-dangerous",
      },
      ctx.signal,
    );
  } else if (name === "reload-child") {
    const authority = globalThis.__paeSubagentPermissionAuthorityV1;
    assert(authority?.active === true, "reload child authority was not active initially");
    await pi.handlers.get("session_shutdown")({ reason: "reload" }, ctx);
    assert(authority.active === false, "reload-suspended child authority remained launchable");
    rejectsMode(() => operator.status(sessionId));
    rejectsMode(() => operator.applyMode(sessionId, false));
    const pending = authority.authorize(
      {
        subagentId: "native-child-reload",
        label: "reload child",
        task: "request after reload",
        command: "ssh reload.example.test",
        cwd: "/child/workspace",
        toolCallId: "child-tool-after-reload",
      },
      ctx.signal,
    );
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    await delay(10);
    assert(!settled, "child authorization did not wait for reload rebinding");

    const reloadedGate = (await import("./out/permission-gate/index.js?hot-reload")).default;
    pi = createPi();
    ctx = createContext({ ...contextOptions, sessionId: "permission-gate-test-session" });
    reloadedGate(pi);
    authorityStable = globalThis.__paeSubagentPermissionAuthorityV1 === authority;
    await pi.handlers.get("session_start")({ reason: "reload" }, ctx);
    rejectsMode(() => operator.applyMode(sessionId, true));
    assert(
      globalThis.__PAE_PERMISSION_GATE_OPERATOR_V1__ !== operator,
      "reload reused stale operator handle",
    );
    assert(
      globalThis.__PAE_PERMISSION_GATE_OPERATOR_V1__.status(sessionId).enabled === false,
      "reload forgot mode",
    );
    childAuthorization = await pending;
  } else if (name === "new-session-child") {
    const oldAuthority = globalThis.__paeSubagentPermissionAuthorityV1;
    await pi.handlers.get("session_shutdown")({ reason: "new" }, ctx);
    oldAuthorityActive = oldAuthority.active;
    ctx = createContext({ ...contextOptions, sessionId: "permission-gate-second-session" });
    await pi.handlers.get("session_start")({ reason: "new" }, ctx);
    rejectsMode(() => operator.applyMode(sessionId, false));
    assert(
      globalThis.__PAE_PERMISSION_GATE_OPERATOR_V1__.status(ctx.sessionManager.getSessionId())
        .enabled,
      "new session inherited off mode",
    );
    const newAuthority = globalThis.__paeSubagentPermissionAuthorityV1;
    authorityStable = newAuthority === oldAuthority;
    childAuthorization = await newAuthority.authorize(
      {
        subagentId: "native-child-new-session",
        label: "new session child",
        task: "request in replacement session",
        command: "ssh new-session.example.test",
        cwd: "/child/workspace",
        toolCallId: "child-tool-new-session",
      },
      ctx.signal,
    );
  } else {
    results.push(
      await tool(
        { toolName: "bash", toolCallId: "tool-dangerous", input: { command: "sudo true" } },
        ctx,
      ),
    );
  }
  delete globalThis.__piPaseoRemoteUiV1;
  delete globalThis.__paeWorkerInteractionsV1;
  process.stdout.write(
    JSON.stringify({
      structuredSelections,
      allowed: results.map((result) => result === undefined),
      blocked: results.map((result) => result?.block === true),
      reasons: results.map((result) => result?.reason || ""),
      childAuthorization,
      authorityStable,
      oldAuthorityActive,
      childAuthorityActive: globalThis.__paeSubagentPermissionAuthorityV1?.active,
      selections: ctx.selections.map((selection) => ({
        title: selection.title,
        choices: selection.choices,
        signal: Boolean(selection.signal),
      })),
      remoteSelections: remoteSelections.map((selection) => ({
        title: selection.title,
        choices: selection.choices,
        signal: selection.signal,
      })),
      emitted: pi.emitted,
      notifications: ctx.notifications,
    }),
  );
}

function lineReader(socket) {
  const lines = readline.createInterface({ input: socket, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  return async () => {
    let timer;
    try {
      const result = await Promise.race([
        iterator.next(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("timed out waiting for client frame")), 2000);
        }),
      ]);
      if (result.done) throw new Error("permission gate client closed before its next frame");
      return JSON.parse(result.value);
    } finally {
      clearTimeout(timer);
    }
  };
}

function send(socket, message) {
  socket.write(JSON.stringify(message) + "\n");
}

async function expectHello(read, socket, fragmented = false) {
  const hello = await read();
  assert(
    JSON.stringify(hello) === JSON.stringify({ v: 1, type: "hello", client: "pi-permission-gate" }),
    "invalid client hello: " + JSON.stringify(hello),
  );
  const response =
    JSON.stringify({
      v: 1,
      type: "hello",
      service: "agentsh-permission-gate",
      capabilities: ["bash", "resolve", "cancel"],
    }) + "\n";
  if (fragmented) {
    socket.write(response.slice(0, 9));
    await delay(2);
    socket.write(response.slice(9));
  } else {
    socket.write(response);
  }
}

function assertAuthorize(request, command, toolCallId) {
  assert(
    request.v === 1 && request.type === "authorize" && request.kind === "bash",
    "invalid authorize envelope",
  );
  assert(request.command === command, "authorize changed the exact Bash command");
  assert(request.cwd === "/exact/workspace", "authorize changed the exact cwd");
  assert(request.tool_call_id === toolCallId, "authorize changed the exact toolCallId");
  assert(
    typeof request.id === "string" && request.id.length > 0,
    "authorize omitted its correlation ID",
  );
}

const prompt = {
  title: "Dangerous command requires approval",
  message: "Detected: sudo",
  labels: ["sudo"],
  command_preview: "sudo true",
};

async function promptedBroker(socket, expectedFinish, fragmentedHello = false) {
  const read = lineReader(socket);
  await expectHello(read, socket, fragmentedHello);
  const request = await read();
  assertAuthorize(request, "sudo true", "tool-dangerous");
  send(socket, { v: 1, type: "decision", id: request.id, decision: "prompt", prompt });
  const finish = await read();
  assert(
    finish.v === 1 && finish.id === request.id && finish.type === expectedFinish.type,
    "client sent the wrong terminal prompt frame",
  );
  if (expectedFinish.type === "resolve") {
    assert(finish.decision === expectedFinish.decision, "client sent the wrong resolution");
  } else {
    assert(
      finish.reason === expectedFinish.reason,
      "client sent the wrong cancellation reason: " + finish.reason,
    );
  }
  send(socket, {
    v: 1,
    type: "complete",
    id: request.id,
    decision: expectedFinish.decision || "deny",
    reason:
      expectedFinish.decision === "allow"
        ? "approved by Pi user interface"
        : finish.reason || "denied by Pi user interface",
  });
}

async function spawnInheritedChild(name, broker, timeout) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "permission-gate-check-"));
  const socketPath = path.join(root, "gate.sock");
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  const accepted = new Promise((resolve) => server.once("connection", resolve));

  const environment = {
    ...process.env,
    AGENTSH_PERMISSION_GATE_SOCKET: socketPath,
    PERMISSION_GATE_CHILD_CASE: name,
  };
  if (timeout !== undefined) environment.PI_AGENTSH_PERMISSION_GATE_TIMEOUT_MS = String(timeout);
  for (const variable of [
    "PI_SUPERVISED",
    "PI_AUTO",
    "PI_AGENTSH_REMOTE",
    "PI_AGENTSH_READ_MODE",
    "AGENTSH_SESSION_SUPERVISOR",
    "AGENTSH_APPROVAL_UI_SOCKET",
    "PI_AGENTSH_MOCK_SUPERVISOR",
    "PI_AGENTSH_ENABLE",
    "AGENTSH_CHILD_CAPABILITY",
  ])
    delete environment[variable];

  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const peer = await accepted;
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    await broker(peer, () => stdout);
    let timer;
    const [code, childSignal] = await Promise.race([
      once(child, "close"),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("permission gate child hung")), 3000);
      }),
    ]).finally(() => clearTimeout(timer));
    assert(code === 0, "permission gate child failed (signal " + childSignal + "): " + stderr);
    return JSON.parse(stdout);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  } finally {
    peer.destroy();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function spawnMalformedStartup(name, socketValue, timeoutValue) {
  const environment = {
    ...process.env,
    AGENTSH_PERMISSION_GATE_SOCKET: socketValue,
    PI_AGENTSH_PERMISSION_GATE_TIMEOUT_MS: timeoutValue,
    PERMISSION_GATE_CHILD_CASE: name,
  };
  for (const variable of [
    "PI_SUPERVISED",
    "PI_AUTO",
    "PI_AGENTSH_REMOTE",
    "PI_AGENTSH_READ_MODE",
    "AGENTSH_SESSION_SUPERVISOR",
    "AGENTSH_APPROVAL_UI_SOCKET",
    "PI_AGENTSH_MOCK_SUPERVISOR",
    "PI_AGENTSH_ENABLE",
    "AGENTSH_CHILD_CAPABILITY",
  ])
    delete environment[variable];
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  let timer;
  const [code, childSignal] = await Promise.race([
    once(child, "close"),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("malformed startup child hung")), 3000);
    }),
  ]).finally(() => clearTimeout(timer));
  assert(code === 0, "malformed startup child failed (signal " + childSignal + "): " + stderr);
  return JSON.parse(stdout);
}

async function runInheritedChecks() {
  for (const name of [
    "mode-off",
    "mode-on",
    "pending-off",
    "operator-off",
    "operator-pending-off",
  ]) {
    const result = await spawnInheritedChild(name, async (socket, stdout) => {
      const read = lineReader(socket);
      await expectHello(read, socket);
      const request = await read();
      assertAuthorize(request, "sudo true", "tool-dangerous");
      send(socket, { v: 1, type: "decision", id: request.id, decision: "prompt", prompt });
      const resolution = await read();
      assert(
        resolution.type === "resolve" &&
          resolution.decision === "allow" &&
          resolution.id === request.id,
        "mode lost exact resolve",
      );
      await delay(25);
      assert(stdout() === "", "off bypassed authoritative receipt");
      send(socket, {
        v: 1,
        type: "complete",
        id: request.id,
        decision: "allow",
        reason: "operator mode test",
      });
    });
    assert(result.allowed[0], name + " blocked");
    assert(
      result.selections.length === (["mode-off", "operator-off"].includes(name) ? 0 : 1),
      name + " incorrect UI count",
    );
  }
  const allowed = await spawnInheritedChild("local-allow", async (socket, stdout) => {
    const read = lineReader(socket);
    await expectHello(read, socket, true);
    const harmless = await read();
    assertAuthorize(harmless, "printf safe", "tool-safe");
    send(socket, { v: 1, type: "decision", id: harmless.id, decision: "allow" });
    const dangerous = await read();
    assertAuthorize(dangerous, "sudo true", "tool-dangerous");
    send(socket, { v: 1, type: "decision", id: dangerous.id, decision: "prompt", prompt });
    const resolution = await read();
    assert(
      resolution.type === "resolve" && resolution.decision === "allow",
      "allow prompt was not resolved",
    );
    await delay(25);
    assert(stdout() === "", "client allowed before AgentSH sent complete");
    send(socket, {
      v: 1,
      type: "complete",
      id: dangerous.id,
      decision: "allow",
      reason: "approved by Pi user interface",
    });
  });
  assert(
    allowed.allowed.join(",") === "true,true",
    "AgentSH allow decisions did not allow both exact commands",
  );
  assert(allowed.selections.length === 1, "AgentSH prompt did not use terminal UI exactly once");
  assert(
    allowed.selections[0].choices.join(",") === "Deny,Allow",
    "AgentSH prompt was not deny-first",
  );
  assert(allowed.selections[0].signal, "AgentSH terminal prompt omitted cancellation signal");
  assert(
    allowed.selections[0].title.includes("Dangerous command requires approval") &&
      allowed.selections[0].title.includes("sudo true"),
    "AgentSH prompt metadata was not rendered",
  );

  const recovered = await spawnInheritedChild("invalid-command", async (socket) => {
    const read = lineReader(socket);
    await expectHello(read, socket);
    // Invalid inputs must not reach the broker. The next valid command
    // still needs an authoritative decision; no unguarded fallback.
    const request = await read();
    assertAuthorize(request, "sudo true", "tool-dangerous");
    send(socket, { v: 1, type: "decision", id: request.id, decision: "allow" });
  });
  assert(
    recovered.allowed[0] && recovered.childAuthorityActive,
    "valid command could not continue after malformed input",
  );
  const brokenTransform = await spawnInheritedChild("broken-transform", async (socket) => {
    const read = lineReader(socket);
    await expectHello(read, socket);
  });
  assert(
    brokenTransform.blocked[0] && brokenTransform.childAuthorityActive === false,
    "genuine transform failure did not fail closed",
  );

  const transformed = await spawnInheritedChild("transform-order", async (socket) => {
    const read = lineReader(socket);
    await expectHello(read, socket);
    const request = await read();
    assertAuthorize(request, `ssh 'test-host' ${JSON.stringify("sudo true")}`, "tool-dangerous");
    send(socket, { v: 1, type: "decision", id: request.id, decision: "allow" });
  });
  assert(
    transformed.allowed[0],
    "Permission Gate did not authorize the final transformed Bash command",
  );

  const childAllowed = await spawnInheritedChild("child-allow", async (socket) => {
    const read = lineReader(socket);
    await expectHello(read, socket);
    const request = await read();
    assert(
      request.v === 1 && request.type === "authorize" && request.kind === "bash",
      "child authority sent an invalid authorize envelope",
    );
    assert(
      request.command === "ssh example.test" && request.cwd === "/child/workspace",
      "child authority changed the exact command or cwd",
    );
    assert(
      request.tool_call_id === "child-tool-dangerous",
      "child authority changed the child tool call ID",
    );
    assert(
      request.session_id === "subagent:native-child-1",
      "child authority omitted its subagent audit identity",
    );
    send(socket, {
      v: 1,
      type: "decision",
      id: request.id,
      decision: "prompt",
      prompt: {
        title: "Dangerous command requires approval",
        message: "Detected: ssh",
        labels: ["ssh"],
        command_preview: "ssh example.test",
      },
    });
    const resolution = await read();
    assert(
      resolution.type === "resolve" && resolution.decision === "allow",
      "parent did not approve the child command",
    );
    send(socket, {
      v: 1,
      type: "complete",
      id: request.id,
      decision: "allow",
      reason: "approved by Pi user interface",
    });
  });
  assert(
    childAllowed.childAuthorization?.allowed === true,
    "parent child authority did not return AgentSH allow",
  );
  assert(
    childAllowed.selections.length === 1,
    "child authorization did not surface in the parent UI",
  );
  assert(
    childAllowed.selections[0].title.includes("Requested by native subagent task 1"),
    "child authorization prompt omitted its parent-owned origin",
  );
  assert(
    childAllowed.selections[0].title.includes("inspect the remote safely"),
    "child authorization prompt omitted its task summary",
  );

  const reloadChild = await spawnInheritedChild("reload-child", async (socket) => {
    const read = lineReader(socket);
    await expectHello(read, socket);
    const request = await read();
    assert(
      request.v === 1 && request.type === "authorize" && request.kind === "bash",
      "reloaded child authority sent an invalid envelope",
    );
    assert(
      request.command === "ssh reload.example.test" && request.cwd === "/child/workspace",
      "reloaded child authority changed the exact command or cwd",
    );
    assert(
      request.tool_call_id === "child-tool-after-reload",
      "reloaded child authority changed the tool call ID",
    );
    assert(
      request.session_id === "subagent:native-child-reload",
      "reloaded child authority changed audit attribution",
    );
    send(socket, {
      v: 1,
      type: "decision",
      id: request.id,
      decision: "prompt",
      prompt: {
        title: "Reloaded child command requires approval",
        message: "Detected: ssh",
        labels: ["ssh"],
        command_preview: "ssh reload.example.test",
      },
    });
    const resolution = await read();
    assert(
      resolution.type === "resolve" && resolution.decision === "allow",
      "reloaded parent did not approve the child command",
    );
    send(socket, {
      v: 1,
      type: "complete",
      id: request.id,
      decision: "allow",
      reason: "approved after reload",
    });
  });
  assert(
    reloadChild.authorityStable === true,
    "hot reload replaced the authority object captured by the child relay",
  );
  assert(
    reloadChild.childAuthorization?.allowed === true,
    "child authorization did not resume after hot reload",
  );
  assert(
    reloadChild.childAuthorization?.reason === "approved after reload",
    "reloaded child lost the audited completion reason",
  );
  assert(reloadChild.selections.length === 0, "off did not survive reload for existing children");

  const newSessionChild = await spawnInheritedChild("new-session-child", async (socket) => {
    const read = lineReader(socket);
    await expectHello(read, socket);
    const request = await read();
    assert(
      request.v === 1 &&
        request.type === "authorize" &&
        request.command === "ssh new-session.example.test",
      "replacement Pi session sent an invalid child authorization",
    );
    assert(
      request.session_id === "subagent:native-child-new-session",
      "replacement Pi session changed child audit attribution",
    );
    send(socket, { v: 1, type: "decision", id: request.id, decision: "prompt", prompt });
    const resolution = await read();
    assert(
      resolution.type === "resolve" && resolution.decision === "allow",
      "new session prompt not resolved",
    );
    send(socket, {
      v: 1,
      type: "complete",
      id: request.id,
      decision: "allow",
      reason: "new session approval",
    });
  });
  assert(newSessionChild.selections.length === 1, "off leaked into an independent new session");
  assert(
    newSessionChild.oldAuthorityActive === false,
    "session replacement did not revoke the authority captured by old children",
  );
  assert(
    newSessionChild.authorityStable === false,
    "session replacement reused the old child authority object",
  );
  assert(
    newSessionChild.childAuthorityActive === true &&
      newSessionChild.childAuthorization?.allowed === true,
    "replacement Pi session did not publish a fresh child authority",
  );

  const backgroundAllowed = await spawnInheritedChild("background-allow", async (socket) => {
    const read = lineReader(socket);
    await expectHello(read, socket);
    const request = await read();
    assertAuthorize(request, "printf background", "tool-background-start");
    send(socket, { v: 1, type: "decision", id: request.id, decision: "allow" });
  });
  assert(
    backgroundAllowed.allowed.join(",") === "true,true",
    "AgentSH did not ignore background list and allow the exact background start",
  );

  const denied = await spawnInheritedChild("local-deny", (socket) =>
    promptedBroker(socket, { type: "resolve", decision: "deny" }),
  );
  assert(denied.blocked[0], "AgentSH explicit denial did not block");

  const remote = await spawnInheritedChild("remote-allow", (socket) =>
    promptedBroker(socket, { type: "resolve", decision: "allow" }),
  );
  assert(
    remote.allowed[0] && remote.selections.length === 1 && remote.remoteSelections.length === 1,
    "AgentSH prompt was not mirrored to Paseo and the terminal",
  );
  assert(
    remote.remoteSelections[0].choices.join(",") === "Deny,Allow" &&
      remote.remoteSelections[0].signal,
    "Paseo AgentSH prompt was not deny-first or omitted signal",
  );

  const cancelled = await spawnInheritedChild("cancel", (socket) =>
    promptedBroker(socket, { type: "cancel", reason: "authorization prompt cancelled" }),
  );
  assert(cancelled.blocked[0], "dismissed AgentSH prompt did not fail closed");

  for (const [name, finish, allowed, count] of [
    ["structured-allow", { type: "resolve", decision: "allow" }, true, 1],
    ["structured-deny", { type: "resolve", decision: "deny" }, false, 1],
    ["structured-cancel", { type: "cancel", reason: "authorization prompt cancelled" }, false, 1],
    [
      "structured-invalid",
      { type: "cancel", reason: "authorization prompt returned an invalid option" },
      false,
      1,
    ],
    ["structured-failure", { type: "cancel", reason: "authorization prompt failed" }, false, 1],
    ["structured-abort", { type: "cancel", reason: "caller aborted" }, false, 1],
    ["structured-timeout", { type: "cancel", reason: "authorization prompt timed out" }, false, 1],
    ["structured-mode-off", { type: "resolve", decision: "allow" }, true, 0],
    ["structured-pending-off", { type: "resolve", decision: "allow" }, true, 1],
  ]) {
    const structured = await spawnInheritedChild(
      name,
      (socket) => promptedBroker(socket, finish),
      name === "structured-timeout" ? 40 : undefined,
    );
    assert(structured.allowed[0] === allowed, name + " authorization mismatch");
    assert(
      structured.structuredSelections.length === count,
      name + " structured UI call count mismatch",
    );
    assert(structured.selections.length === 0, name + " invoked a terminal selector");
  }
  const structuredTransport = await spawnInheritedChild(
    "structured-transport-eof",
    async (socket) => {
      const read = lineReader(socket);
      await expectHello(read, socket);
      const request = await read();
      assertAuthorize(request, "sudo true", "tool-dangerous");
      send(socket, { v: 1, type: "decision", id: request.id, decision: "prompt", prompt });
      await delay(10);
      socket.end();
    },
  );
  assert(structuredTransport.blocked[0], "structured transport failure authorized execution");
  const structuredDeniedReceipt = await spawnInheritedChild(
    "structured-allow-denied-receipt",
    async (socket) => {
      const read = lineReader(socket);
      await expectHello(read, socket);
      const request = await read();
      assertAuthorize(request, "sudo true", "tool-dangerous");
      send(socket, { v: 1, type: "decision", id: request.id, decision: "prompt", prompt });
      const finish = await read();
      assert(
        finish.type === "resolve" && finish.decision === "allow",
        "structured UI did not submit allow",
      );
      send(socket, {
        v: 1,
        type: "complete",
        id: request.id,
        decision: "deny",
        reason: "Authoritative policy denied",
      });
    },
  );
  assert(
    structuredDeniedReceipt.blocked[0],
    "structured UI bypassed authoritative AgentSH receipt",
  );

  const headless = await spawnInheritedChild("headless", (socket) =>
    promptedBroker(socket, { type: "cancel", reason: "no UI available" }),
  );
  assert(headless.blocked[0], "headless AgentSH prompt did not fail closed");

  const aborted = await spawnInheritedChild("abort", (socket) =>
    promptedBroker(socket, { type: "cancel", reason: "caller aborted" }),
  );
  assert(aborted.blocked[0], "aborted AgentSH prompt did not fail closed");

  const promptTimeout = await spawnInheritedChild(
    "prompt-timeout",
    (socket) =>
      promptedBroker(socket, { type: "cancel", reason: "authorization prompt timed out" }),
    40,
  );
  assert(promptTimeout.blocked[0], "AgentSH prompt timeout did not fail closed");

  const malformed = await spawnInheritedChild("malformed", async (socket) => {
    const read = lineReader(socket);
    const hello = await read();
    assert(hello.type === "hello", "malformed test did not receive hello");
    socket.write(
      '{"v":1,"v":1,"type":"hello","service":"agentsh-permission-gate","capabilities":["bash","resolve","cancel"]}\n',
    );
  });
  assert(
    malformed.blocked[0] && malformed.reasons[0].includes("failed closed"),
    "duplicate JSON field did not fail closed",
  );

  const eof = await spawnInheritedChild("eof", async (socket) => {
    const read = lineReader(socket);
    await read();
    socket.end();
  });
  assert(eof.blocked[0], "unexpected gate EOF did not fail closed");

  const eofDuringPrompt = await spawnInheritedChild("transport-eof", async (socket) => {
    const read = lineReader(socket);
    await expectHello(read, socket);
    const request = await read();
    assertAuthorize(request, "sudo true", "tool-dangerous");
    send(socket, { v: 1, type: "decision", id: request.id, decision: "prompt", prompt });
    await delay(10);
    socket.end();
  });
  assert(eofDuringPrompt.blocked[0], "gate EOF did not abort and fail closed an open prompt");
  assert(
    eofDuringPrompt.childAuthorityActive === false,
    "dead Permission Gate transport remained advertised to native subagents",
  );

  const eofBeforeComplete = await spawnInheritedChild("eof-complete", async (socket) => {
    const read = lineReader(socket);
    await expectHello(read, socket);
    const request = await read();
    assertAuthorize(request, "sudo true", "tool-dangerous");
    send(socket, { v: 1, type: "decision", id: request.id, decision: "prompt", prompt });
    const resolution = await read();
    assert(resolution.type === "resolve", "EOF completion test did not receive a resolution");
    socket.end();
  });
  assert(eofBeforeComplete.blocked[0], "gate EOF before complete did not fail closed");

  const timedOut = await spawnInheritedChild(
    "timeout",
    async (socket) => {
      const read = lineReader(socket);
      await read();
    },
    40,
  );
  assert(
    timedOut.blocked[0] && timedOut.reasons[0].includes("timed out"),
    "gate timeout did not fail closed",
  );

  const malformedSocket = await spawnMalformedStartup(
    "malformed-startup-socket",
    "relative.sock",
    "100",
  );
  assert(
    malformedSocket.blocked[0] && malformedSocket.reasons[0].includes("failed closed"),
    "malformed gate socket removed parent Bash protection",
  );
  const malformedTimeout = await spawnMalformedStartup(
    "malformed-startup-timeout",
    "/tmp/unused-gate.sock",
    "not-a-number",
  );
  assert(
    malformedTimeout.blocked[0] && malformedTimeout.reasons[0].includes("failed closed"),
    "malformed gate timeout removed parent Bash protection",
  );
}

async function runLegacyChecks() {
  const pi = createPi();
  gate(pi);
  let localCalls = 0;
  const localSignals = [];
  const controller = new AbortController();
  const ctx = createContext({
    controller,
    choice: "Yes",
    onSelect: async (_title, _choices, settings) => {
      localCalls += 1;
      localSignals.push(settings?.signal);
      assert(
        settings?.signal instanceof AbortSignal,
        "legacy terminal prompt dropped its cancellation signal",
      );
      return "Yes";
    },
  });
  const dangerous = {
    toolName: "bash",
    toolCallId: "legacy-tool",
    input: { command: "sudo true" },
  };
  const remoteCalls = [];
  globalThis.__piPaseoRemoteUiV1 = {
    isConnected: () => true,
    async select(title, options, settings) {
      remoteCalls.push({ title, options, settings });
      return "Yes";
    },
    async selectMirrored(title, options, localSelect, settings) {
      remoteCalls.push({ title, options, settings });
      const localController = new AbortController();
      void localSelect(localController.signal);
      localController.abort();
      return "Yes";
    },
  };
  let result = await pi.handlers.get("tool_call")(dangerous, ctx);
  assert(result === undefined, "legacy remote approval did not allow the command");
  assert(
    remoteCalls.length === 1 && localCalls === 1,
    "legacy approval was not mirrored to Paseo and the terminal",
  );
  assert(remoteCalls[0].options.join(",") === "Yes,No", "legacy remote approval options changed");
  assert(
    remoteCalls[0].settings.signal === controller.signal,
    "legacy Paseo prompt dropped ctx.signal",
  );

  globalThis.__piPaseoRemoteUiV1.selectMirrored = async (_title, _options, localSelect) => {
    const localController = new AbortController();
    void localSelect(localController.signal);
    localController.abort();
    return "No";
  };
  result = await pi.handlers.get("tool_call")(dangerous, ctx);
  assert(result?.block === true, "legacy remote denial did not block the command");

  globalThis.__piPaseoRemoteUiV1.selectMirrored = async () => {
    throw new Error("disconnected");
  };
  result = await pi.handlers.get("tool_call")(dangerous, ctx);
  assert(result?.block === true, "legacy remote UI failure did not fail closed");

  globalThis.__piPaseoRemoteUiV1.isConnected = () => false;
  result = await pi.handlers.get("tool_call")(dangerous, ctx);
  assert(
    result === undefined && localCalls === 3,
    "detached Paseo did not fall back to terminal selection",
  );
  assert(localSignals.at(-1) === controller.signal, "detached Paseo fallback dropped ctx.signal");
  delete globalThis.__piPaseoRemoteUiV1;

  result = await pi.handlers.get("tool_call")(
    {
      toolName: "background_job",
      toolCallId: "legacy-background",
      input: { action: "start", command: "sudo true" },
    },
    ctx,
  );
  assert(
    result === undefined && localCalls === 4,
    "legacy gate did not authorize a dangerous background start like Bash",
  );
  const headlessBackground = await pi.handlers.get("tool_call")(
    {
      toolName: "background_job",
      toolCallId: "legacy-background-headless",
      input: { action: "start", command: "sudo true" },
    },
    createContext({ hasUI: false }),
  );
  assert(
    headlessBackground?.block === true,
    "legacy gate did not fail closed for a headless dangerous background start",
  );

  for (const [name, value] of [
    ["PI_SUPERVISED", "1"],
    ["PI_AUTO", "1"],
    ["AGENTSH_SESSION_SUPERVISOR", "unix:///tmp/supervisor.sock"],
    ["PI_AGENTSH_MOCK_SUPERVISOR", "/tmp/mock-supervisor.sock"],
    ["PI_AGENTSH_ENABLE", "1"],
  ]) {
    process.env[name] = value;
    const supervisedPi = createPi();
    gate(supervisedPi);
    const supervisedCtx = createContext({
      onSelect: () => {
        throw new Error("legacy prompt opened in " + name + " mode");
      },
    });
    const supervisedResult = await supervisedPi.handlers.get("tool_call")(dangerous, supervisedCtx);
    assert(
      supervisedResult?.block === true && supervisedCtx.selections.length === 0,
      "unavailable full mode did not synchronously block native Bash for " + name,
    );
    const backgroundResult = await supervisedPi.handlers.get("tool_call")(
      {
        toolName: "background_job",
        toolCallId: "bg-unavailable",
        input: { action: "start", command: "printf no" },
      },
      supervisedCtx,
    );
    assert(
      backgroundResult?.block === true && supervisedCtx.selections.length === 0,
      "unavailable full mode did not synchronously block native background start for " + name,
    );
    delete process.env[name];
  }

  process.env.PI_SUPERVISED = "1";
  globalThis.__AGENTSH_PI__ = {
    getSupervisorState() {
      return { configured: true, active: true, protocol: "rest", status: "connected" };
    },
    async exec() {
      return { exitCode: 0 };
    },
  };
  const activePi = createPi();
  gate(activePi);
  const activeResult = await activePi.handlers.get("tool_call")(dangerous, createContext());
  assert(
    activeResult === undefined,
    "active full AgentSH mode was blocked by the duplicate permission gate",
  );
  const activeBackgroundResult = await activePi.handlers.get("tool_call")(
    {
      toolName: "background_job",
      toolCallId: "bg-active",
      input: { action: "start", command: "printf no-native" },
    },
    createContext(),
  );
  assert(
    activeBackgroundResult === undefined,
    "active full AgentSH background start was blocked by the duplicate permission gate rather than its own backend guard",
  );
  delete globalThis.__AGENTSH_PI__;
  delete process.env.PI_SUPERVISED;
}

if (process.env.PERMISSION_GATE_CHILD_CASE) {
  await runInheritedChild(process.env.PERMISSION_GATE_CHILD_CASE);
} else {
  await runLegacyChecks();
  await runInheritedChecks();
  console.log("permission-gate checks passed");
}
