// Real offline Pi RPC parent and native subagent processes for named-profile acceptance.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [binaryArg, extensionArg, fixtureArg] = process.argv.slice(2);
const binaryPath = binaryArg ?? process.env.PI_PROFILE_TEST_PI;
if (!binaryPath) throw new Error("Pass the immutable Pi runtime binary or set PI_PROFILE_TEST_PI");
const binary = resolve(binaryPath);
const extension = resolve(extensionArg ?? join(here, "../subagent/index.ts"));
const fixture = resolve(fixtureArg ?? join(here, "subagent-profiles-native-fixture.ts"));
const profile = (model = "legacy-profile-provider/scout-v1", thinking = "high", body = "PROFILE_SCOUT_INSTRUCTION_V1") =>
  `---\nname: fixture-scout\ndescription: Offline named profile acceptance fixture\nmodel: ${model}\nthinking: ${thinking}\ntools: read, bash\n---\n${body}\n`;

async function startParent(root, scenario, { projectTrust = false, agentSH = false } = {}) {
  const home = join(root, "home"), agentDir = join(home, "agent"), cwd = join(root, "workspace");
  await mkdir(join(agentDir, "agents"), { recursive: true });
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, defaultProjectTrust: "never", extensions: [fixture] }));
  await writeFile(join(agentDir, "agents", "fixture-scout.md"), profile());
  const log = join(root, "dispatch.jsonl"), stateRoot = join(root, "worker-state");
  const launcher = process.env.PI_TUI_WORKER_LAUNCHER;
  if (!launcher) throw new Error("Set PI_TUI_WORKER_LAUNCHER to the immutable Nix pi-tui-worker executable for native acceptance tests");
  const env = {
    PATH: process.env.PATH ?? "", HOME: home, TMPDIR: root,
    XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
    PROFILE_FIXTURE_LOG: log, PROFILE_SCENARIO: JSON.stringify(scenario), PI_TUI_WORKER_LAUNCHER: launcher,
    PI_TUI_WORKER_LAUNCH_MODE: process.env.PI_TUI_WORKER_LAUNCH_MODE ?? "none", PI_TUI_WORKER_STATE_ROOT: stateRoot,
    ...(projectTrust ? { PROFILE_FIXTURE_UNTRUSTED_PROJECT: "1" } : {}),
    ...(agentSH ? { PI_AGENTSH_MOCK_SUPERVISOR: "fixture", PROFILE_FIXTURE_AGENTSH: "1" } : {}),
  };
  if (projectTrust) {
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ retry: { enabled: false } }));
    await writeFile(join(cwd, ".pi", "agents", "fixture-project.md"), `---\nname: fixture-project\ndescription: Project trust fixture\n---\nPROJECT_PROFILE_INSTRUCTION\n`);
  }
  const args = ["--mode", "rpc", "--offline", "--no-session", "--no-skills",
    "--extension", fixture, "--extension", extension,
    "--provider", "offline-profile-fixture", "--model", "parent"];
  const child = spawn(binary, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const events = [], errors = [], bus = new EventEmitter();
  let exited;
  const exitPromise = new Promise((resolveExit) => child.once("exit", (code, signal) => { exited = { code, signal }; bus.emit("change"); resolveExit(exited); }));
  const stdout = createInterface({ input: child.stdout }), stderr = createInterface({ input: child.stderr });
  stdout.on("line", (line) => { try { events.push(JSON.parse(line)); } catch { errors.push(line); } bus.emit("change"); });
  stderr.on("line", (line) => { errors.push(line); bus.emit("change"); });
  const wait = (predicate, label, timeoutMs = 20_000) => new Promise((resolveWait, reject) => {
    const timer = setTimeout(() => finish(new Error(`Timeout waiting for ${label}: ${errors.join("\n")}; events=${JSON.stringify(events.filter((event) => event.type.includes("tool") || event.type.includes("agent_") || event.message?.role === "toolResult").slice(-20))}`)), timeoutMs);
    const check = () => { const value = predicate(); if (value) finish(undefined, value); else if (exited) finish(new Error(`Pi exited ${JSON.stringify(exited)}: ${errors.join("\n")}`)); };
    const finish = (error, value) => { clearTimeout(timer); bus.off("change", check); error ? reject(error) : resolveWait(value); };
    bus.on("change", check); check();
  });
  let requestId = 0;
  const rpc = async (type, fields = {}) => {
    const id = `profile-${++requestId}`;
    child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    const response = await wait(() => events.find((event) => event.type === "response" && event.id === id), `${type} response`);
    assert.equal(response.success, true, JSON.stringify(response));
    return response.data;
  };
  await rpc("get_state");
  let settledCount = events.filter((event) => event.type === "agent_settled").length;
  const promptAndWait = async (message) => {
    await rpc("prompt", { message });
    await wait(() => events.filter((event) => event.type === "agent_settled").length > settledCount, "agent_settled");
    settledCount = events.filter((event) => event.type === "agent_settled").length;
  };
  const close = async () => {
    if (!exited) child.kill("SIGTERM");
    await exitPromise;
    stdout.close(); stderr.close();
  };
  return { agentDir, cwd, log, stateRoot, events, errors, rpc, promptAndWait, close };
}

async function dispatches(log) {
  try { return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
}
async function taskRecords(stateRoot) {
  const root = join(stateRoot, "headless-groups");
  const files = await readdir(root).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
  const groups = await Promise.all(files.filter((file) => /^subagent-job-[a-f0-9]{24}\.json$/.test(file)).map(async (file) =>
    JSON.parse(await readFile(join(root, file), "utf8"))));
  return groups.flatMap((group) => group.children.map((child) => ({ ...child, groupId: group.id, groupStatus: group.status })));
}
async function cleanup(instance) {
  try {
    const groups = new Set((await taskRecords(instance.stateRoot)).map((task) => task.groupId));
    for (const groupId of groups) await instance.promptAndWait(`reap-group: ${groupId}`);
  } finally { await instance.close(); }
}
function activeTools(request) {
  const active = new Set();
  for (const system of request.systems ?? []) {
    for (const name of system.toolsRemoved ?? []) active.delete(name);
    for (const name of system.toolsAdded ?? []) active.add(name);
  }
  return [...active].sort();
}
async function assertOffline(log) {
  const rows = await dispatches(log);
  assert.equal(rows.some((row) => row.network !== false), false, "fixture attempted network I/O");
  return rows;
}

const root = await mkdtemp(join(tmpdir(), "pf-"));
let parent;
try {
  // A narrowed launch stays inside the profile ceiling. This is a real child Pi
  // model request, not a mock of profile resolution or backend dispatch.
  parent = await startParent(join(root, "single"), { params: { task: "inspect offline fixture", acceptance: ["inspect fixture acceptance"], agent: "fixture-scout", tools: ["read"] } });
  await parent.promptAndWait("launch fixture profile");
  let rows = await assertOffline(parent.log);
  const childRequest = rows.find((row) => row.role === "child");
  assert(childRequest, `no actual native child provider request was recorded; rows=${JSON.stringify(rows)}; toolEvents=${JSON.stringify(parent.events.filter((event) => event.type.includes("tool") || event.message?.role === "toolResult"))}; stderr=${parent.errors.join("\\n")}`);
  assert.equal(childRequest.provider, "offline-profile-fixture");
  assert.equal(childRequest.model, "scout-v1");
  assert.equal(childRequest.reasoning, "high");
  assert.deepEqual(activeTools(childRequest), ["notify_parent", "read", "task_outcome"].sort());
  const requestText = JSON.stringify(childRequest);
  assert.match(requestText, /PROFILE_SCOUT_INSTRUCTION_V1/);
  assert.match(requestText, /inspect fixture acceptance/);
  const record = (await taskRecords(parent.stateRoot))[0];
  assert(record);
  assert.equal(record.spec.model, "offline-profile-fixture/scout-v1:high");
  assert.deepEqual(record.spec.tools, ["read"]);
  assert.match(record.spec.systemPrompt, /PROFILE_SCOUT_INSTRUCTION_V1/);
  assert.deepEqual(record.spec.acceptance, ["inspect fixture acceptance"]);

  // Editing the profile after completion must not change the retained spec or
  // actual resumed request. The same parent RPC session owns both attempts.
  await writeFile(join(parent.agentDir, "agents", "fixture-scout.md"), profile("offline-profile-fixture/changed-v2", "low", "PROFILE_SCOUT_INSTRUCTION_V2"));
  await parent.promptAndWait(`resume-task: ${record.taskId}`);
  rows = await assertOffline(parent.log);
  const childRequests = rows.filter((row) => row.role === "child");
  assert.equal(childRequests.length, 2);
  const resumed = childRequests[1];
  assert.equal(resumed.model, "scout-v1");
  assert.equal(resumed.reasoning, "high");
  assert.deepEqual(activeTools(resumed), ["notify_parent", "read", "task_outcome"].sort());
  assert.match(JSON.stringify(resumed), /PROFILE_SCOUT_INSTRUCTION_V1/);
  assert.doesNotMatch(JSON.stringify(resumed), /PROFILE_SCOUT_INSTRUCTION_V2/);
  const resumedRecord = (await taskRecords(parent.stateRoot))[0];
  assert.equal(resumedRecord.attempt, 1, "live headless resume retains the same task attempt");
  assert.equal(resumedRecord.spec.model, record.spec.model);
  assert.equal(resumedRecord.spec.systemPrompt, record.spec.systemPrompt);
  assert.deepEqual(resumedRecord.spec.tools, record.spec.tools);
  await cleanup(parent); parent = undefined;

  // Native dispatch supports named profiles for single, parallel, and chain items.
  for (const [label, params, count] of [
    ["zero-tools", { task: "report without business tools", acceptance: ["report fixture completion"], agent: "fixture-scout", tools: [] }, 1],
    ["parallel", { tasks: [
      { task: "parallel scout A", acceptance: ["A acceptance"], agent: "fixture-scout" },
      { task: "parallel scout B", acceptance: ["B acceptance"], agent: "fixture-scout" },
    ] }, 2],
    ["chain", { chain: [
      { task: "chain scout A", acceptance: ["chain A acceptance"], agent: "fixture-scout" },
      { task: "chain scout B {previous}", acceptance: ["chain B acceptance"], agent: "fixture-scout" },
    ] }, 2],
  ]) {
    const instance = await startParent(join(root, label), { params });
    try {
      await instance.promptAndWait(`launch ${label}`);
      const actual = (await assertOffline(instance.log)).filter((row) => row.role === "child");
      assert.equal(actual.length, count, `${label} did not dispatch every named-profile child`);
      assert(actual.every((row) => row.model === "scout-v1" && row.reasoning === "high"), `${label} child model/thinking differs`);
      assert(actual.every((row) => /PROFILE_SCOUT_INSTRUCTION_V1/.test(JSON.stringify(row))), `${label} missed profile instruction`);
      if (label === "zero-tools") assert.deepEqual(activeTools(actual[0]), ["notify_parent", "task_outcome"].sort(), "empty native profile allowlist must not inherit business tools");
    } finally { await cleanup(instance); }
  }

  // Profile-only arguments are removed before the AgentSH adapter boundary,
  // after profiles are resolved and expanded. The stub adapter logs received
  // params; a child provider request would indicate an unsafe native fallback.
  {
    const instance = await startParent(join(root, "adapter"), { params: { agentScope: "user", tasks: [
      { task: "adapter scout A", acceptance: ["adapter A acceptance"], agent: "fixture-scout", tools: ["read"] },
      { task: "adapter scout B", acceptance: ["adapter B acceptance"], agent: "fixture-scout", tools: ["read"] },
    ] } }, { agentSH: true });
    try {
      await instance.promptAndWait("dispatch through AgentSH adapter");
      const rows = await assertOffline(instance.log);
      const adapterCall = rows.find((row) => row.event === "adapter_call");
      assert(adapterCall, "selected AgentSH backend did not invoke the adapter");
      assert.equal(Object.hasOwn(adapterCall.args, "agent"), false);
      assert.equal(Object.hasOwn(adapterCall.args, "agentScope"), false);
      assert(adapterCall.args.tasks.every((task) => !Object.hasOwn(task, "agent") && !Object.hasOwn(task, "agentScope")));
      assert(adapterCall.args.tasks.every((task) => task.model === "offline-profile-fixture/scout-v1:high" && task.tools[0] === "read"));
      assert.equal(rows.filter((row) => row.role === "child").length, 0, "AgentSH adapter test launched native workers");
    } finally { await cleanup(instance); }
  }

  // Profiles catalogue operation is local and returns profile metadata without launching a worker.
  {
    const instance = await startParent(join(root, "catalogue"), { params: { operation: "profiles", agentScope: "user" } });
    try {
      await instance.promptAndWait("list profiles");
      assert.equal((await assertOffline(instance.log)).filter((row) => row.role === "child").length, 0);
      const toolResult = instance.events.find((event) => event.type === "message_end" && event.message?.role === "toolResult" && event.message?.toolName === "subagent");
      assert(toolResult, "profiles operation produced no subagent tool result");
      assert.match(JSON.stringify(toolResult.message.content), /fixture-scout/);
    } finally { await cleanup(instance); }
  }

  // Invalid profile selection, malformed catalogue input, trust failures, and
  // attempts to widen the declared profile tool ceiling all fail before launch.
  const rejectedCases = [
    { name: "unknown", params: { task: "must not launch", acceptance: ["required"], agent: "missing-profile" }, reason: /Unknown agent profile 'missing-profile'/ },
    { name: "widen", params: { task: "must not launch", acceptance: ["required"], agent: "fixture-scout", tools: ["write"] }, reason: /cannot widen profile 'fixture-scout' allowlist/ },
    { name: "malformed", params: { task: "must not launch", acceptance: ["required"], agent: "fixture-scout" }, malformed: true, reason: /unsupported field 'unsupported'/ },
    { name: "missing-acceptance", params: { task: "must not launch", agent: "fixture-scout" }, reason: /New delegation requires acceptance: supply 1–16 explicit, task-specific, verifiable completion criteria\. No worker was launched\./ },
    { name: "agentsh-empty-tools", agentSH: true, params: { task: "must not inherit defaults", acceptance: ["no dispatch"], agent: "fixture-scout", tools: [] }, reason: /AgentSH cannot enforce an empty profile tool allowlist; no work was started/ },
    { name: "trust", params: { task: "must not launch", acceptance: ["required"], agent: "fixture-project", agentScope: "project" }, projectTrust: true, reason: /agentScope: "project" requires project trust/ },
  ];
  for (const scenario of rejectedCases) {
    const instance = await startParent(join(root, scenario.name), { params: scenario.params }, { projectTrust: scenario.projectTrust, agentSH: scenario.agentSH });
    try {
      if (scenario.malformed) await writeFile(join(instance.agentDir, "agents", "fixture-scout.md"), "---\nname: fixture-scout\ndescription: broken\nunsupported: true\n---\nBROKEN\n");
      await instance.promptAndWait(`rejected ${scenario.name}`);
      const invocation = instance.events.find((event) => event.type === "tool_execution_start" && event.toolName === "subagent");
      assert.deepEqual(invocation?.args, scenario.params, `${scenario.name} did not reach the extension with the requested parameters`);
      const rejectedRows = await assertOffline(instance.log);
      assert.equal(rejectedRows.filter((row) => row.role === "child").length, 0, `${scenario.name} launched a worker`);
      assert.equal(rejectedRows.filter((row) => row.event === "adapter_call").length, 0, `${scenario.name} reached an adapter despite failed validation`);
      const toolResult = instance.events.findLast((event) => event.type === "message_end" && event.message?.role === "toolResult" && event.message?.toolName === "subagent");
      assert(toolResult?.message?.isError, `${scenario.name} did not produce a failed subagent tool result`);
      const callRow = (await dispatches(instance.log)).find((row) => row.event === "subagent_call");
      if (scenario.name === "trust") {
        const rows = await dispatches(instance.log);
        assert.equal(callRow?.cwd, instance.cwd, `project trust checked against unexpected cwd: ${JSON.stringify(rows)}`);
        assert.equal(callRow?.processCwd, instance.cwd, `Pi process cwd mismatch: ${JSON.stringify(rows)}`);
        assert.equal(callRow?.projectTrusted, false, `test project unexpectedly trusted: ${JSON.stringify(rows)}`);
        assert(rows.some((row) => row.event === "project_trust" && row.cwd === instance.cwd && row.processCwd === instance.cwd && row.decision === "no"), `personal project_trust handler was not observed: ${JSON.stringify(rows)}`);
      }
      const toolText = Array.isArray(toolResult.message.content)
        ? toolResult.message.content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n")
        : String(toolResult.message.content);
      assert.match(toolText, scenario.reason, `${scenario.name} rejected for an unexpected reason; call=${JSON.stringify(callRow)}`);
    } finally { await cleanup(instance); }
  }

  console.log("PASS native Pi named-profile acceptance: actual offline child requests, saved/resumed contract, single/parallel/chain dispatch, and fail-before-launch boundaries");
} finally {
  if (parent) await parent.close();
  await rm(root, { recursive: true, force: true });
}
