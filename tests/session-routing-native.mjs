// Real standalone Pi processes; no provider HTTP or user agent state.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readSessionRoutingProfile } from "../shared/session-routing.ts";

const CODEX = "openai-codex";
const [binaryArg, fixtureArg] = process.argv.slice(2);
const binary = binaryArg ? resolve(binaryArg) : "pi";
const fixture = resolve(
  fixtureArg ?? new URL("./session-routing-native-fixture.ts", import.meta.url).pathname,
);
const root = await mkdtemp(join(tmpdir(), "pi-routing-native-"));
const home = join(root, "home"), agent = join(home, "agent"), cwd = join(root, "work");
const log = join(root, "dispatch.jsonl");
await mkdir(agent, { recursive: true });
await mkdir(cwd);
await writeFile(join(agent, "settings.json"),
  JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
const base = {
  PATH: process.env.PATH ?? "", HOME: home, TMPDIR: root, XDG_CONFIG_HOME: join(home, "config"),
  XDG_CACHE_HOME: join(home, "cache"), PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", ROUTING_FIXTURE_LOG: log,
};
const startModels = {
  parent: [CODEX, "main-fixture"],
  "plain-parent": ["openai", "main-fixture"],
};

async function start(role, extra = {}) {
  const session = extra.ROUTING_FIXTURE_SESSION_FILE;
  const [provider, model] = startModels[role] ?? [CODEX, "small-fixture"];
  const args = [
    "--mode", "rpc", ...(session ? ["--session", session] : ["--no-session"]),
    "--no-extensions", "--no-skills",
    ...(extra.ROUTING_FIXTURE_RESUME ? [] : ["--provider", provider, "--model", model]),
    "--extension", fixture,
  ];
  const child = spawn(binary, args, {
    cwd, env: { ...base, ...extra, ROUTING_FIXTURE_ROLE: role }, stdio: ["pipe", "pipe", "pipe"],
  });
  const events = [], errors = [], bus = new EventEmitter();
  let ended;
  const exitPromise = new Promise((done) => child.once("exit", (code, signal) => {
    ended = { code, signal }; bus.emit("change"); done(ended);
  }));
  const stdout = createInterface({ input: child.stdout });
  const stderr = createInterface({ input: child.stderr });
  stdout.on("line", (line) => {
    try { events.push(JSON.parse(line)); } catch { errors.push(line); }
    bus.emit("change");
  });
  stderr.on("line", (line) => { errors.push(line); bus.emit("change"); });
  const wait = (fn, label) => new Promise((res, rej) => {
    const timeout = () => done(new Error(`Timeout ${label}: ${errors.join("\n")}`));
    const timer = setTimeout(timeout, 15000);
    function done(error, value) {
      clearTimeout(timer); bus.off("change", check);
      if (error) rej(error); else res(value);
    }
    function check() {
      const value = fn();
      if (value) done(null, value);
      else if (ended) done(new Error(`Pi exited ${JSON.stringify(ended)}: ${errors.join("\n")}`));
    }
    bus.on("change", check); check();
  });
  let n = 0;
  async function rpc(type, fields = {}) {
    const id = `native-${++n}`;
    child.stdin.write(JSON.stringify({ id, type, ...fields }) + "\n");
    const response = await wait(
      () => events.find((e) => e.type === "response" && e.id === id), type);
    assert.equal(response.success, true, JSON.stringify(response));
    return response.data;
  }
  await rpc("get_state");
  return {
    child, events, errors, rpc, wait,
    close: async () => {
      child.stdin.end();
      if (!ended) child.kill("SIGTERM");
      await exitPromise; stdout.close(); stderr.close();
    },
  };
}

const lines = (file) =>
  readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const claims = (id) => ({ sub: id, "https://api.openai.com/auth": { chatgpt_account_id: id } });
const token = (id) => [
  Buffer.from('{"alg":"none"}').toString("base64url"),
  Buffer.from(JSON.stringify(claims(id))).toString("base64url"),
  "fixture",
].join(".");
const routingPath = (sessionId) => join(agent, "state", "session-routing-v1",
  `${createHash("sha256").update(sessionId).digest("hex")}.json`);
const oauth = (id) => ({
  type: "oauth", access: token(id), refresh: `fixture-${id}-refresh`,
  expires: Date.now() + 86400000, accountId: id,
});
const personal = token("personal"), work = token("work"), alpha = token("alpha");
// Legacy section from the former OpenAI account namespace; it must stay byte-for-byte equal.
const legacyOpenAI = {
  active: "Legacy",
  accounts: { Legacy: { type: "api_key", key: "fixture-legacy-openai" } },
  note: "kept by Codex-only accounts",
};
const accountsFile = join(agent, "pi-accounts.json");

let parent, child, sibling, grandchild, plainParent, orphan;
try {
  await writeFile(join(agent, "auth.json"), JSON.stringify({
    openai: { type: "api_key", key: "fixture-openai-default" },
    [CODEX]: oauth("personal"),
  }), { mode: 0o600 });
  await writeFile(accountsFile, JSON.stringify({
    version: 1,
    providers: {
      openai: legacyOpenAI,
      [CODEX]: { active: "Alpha", accounts: { Alpha: oauth("alpha"), Work: oauth("work") } },
    },
  }), { mode: 0o600 });

  const notified = (target, before) => target.events.slice(before)
    .some((e) => e.type === "extension_ui_request" && e.method === "notify");
  const settled = (target) => target.events.filter((e) => e.type === "agent_settled").length;
  const command = async (target, message, label) => {
    const before = target.events.length;
    await target.rpc("prompt", { message });
    await target.wait(() => notified(target, before), label);
  };
  const switchAt = async (target, account) => {
    await command(target, `/routing-switch ${CODEX} ${account}`, "account switch");
    const result = lines(log).filter((r) => r.role === "control").at(-1);
    assert.equal(result.accountId, account);
    assert.equal(result.result.ok, true, JSON.stringify(result));
  };
  const turn = async (target, label) => {
    const before = settled(target);
    await target.rpc("prompt", { message: "offline fixture dispatch" });
    await target.wait(() => settled(target) > before, label);
  };
  const dispatch = async (target, role) => {
    const admitted = lines(log).filter((r) => r.role === role).length;
    await turn(target, `${role} turn`);
    const rows = lines(log).filter((r) => r.role === role);
    assert.equal(rows.length, admitted + 1, `${role} must dispatch this turn`);
    return rows.at(-1);
  };
  const restore = async (target, leaf) => {
    await command(target, `/routing-restore ${leaf}`, "branch history restore");
    assert.equal(lines(log).filter((r) => r.role === "history").at(-1).cancelled, false);
  };

  parent = await start("parent");
  await turn(parent, "parent warm turn");
  const state = (await parent.rpc("get_state")).sessionId;
  const routingFile = routingPath(state);
  const childSessionFile = join(root, "owned-child-session.jsonl");
  await writeFile(childSessionFile, JSON.stringify({
    type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd,
  }) + "\n", { mode: 0o600 });
  const parentEnv = {
    PI_SESSION_ROUTING_FILE: routingFile, PI_SESSION_ROUTING_OWNER_SESSION: state,
  };
  child = await start("child", { ...parentEnv, ROUTING_FIXTURE_SESSION_FILE: childSessionFile });
  const pid = child.child.pid;
  const childInitial = (await child.rpc("get_state")).model;
  assert.equal(childInitial.provider, CODEX);
  assert.equal(childInitial.id, "small-fixture", "native follower preserves child role model ID");
  const profile = JSON.parse(await readFile(routingFile, "utf8"));
  assert.equal(profile.providerId, CODEX, "legacy alias migrates to the physical Codex model");
  assert.equal(profile.accountId, "Alpha", "new sessions adopt the stored Codex default");
  assert.equal(JSON.stringify(profile).includes("fixture-"), false);

  // Unsupported requests are rejected before any state changes.
  const storeBefore = await readFile(accountsFile, "utf8");
  const routeBefore = await readFile(routingFile, "utf8");
  await command(parent, "/routing-unsupported", "unsupported requests");
  const unsupported = lines(log).filter((r) => r.role === "unsupported").at(-1);
  for (const [name, outcome] of Object.entries(unsupported.outcomes))
    assert.equal(outcome, "unsupported-provider", `${name} must be rejected as unsupported`);
  assert.equal(Object.keys(unsupported.outcomes).length, 6);
  assert.deepEqual(unsupported.after, unsupported.before, "Codex snapshot unchanged");
  assert.equal(unsupported.before.providerId, CODEX);
  for (const field of ["supportedProviders", "sessionRouting", "guardedDefaultSwitchVersion"])
    assert.equal(field in unsupported.before, false, `snapshot must not publish ${field}`);
  for (const field of ["nativeRegistrationKey", "nativeRegistrationVersion"])
    assert.equal(field in unsupported.before.usage, false, `usage must not publish ${field}`);
  assert.equal(await readFile(accountsFile, "utf8"), storeBefore, "store unchanged");
  assert.equal(await readFile(routingFile, "utf8"), routeBefore, "route unchanged");

  for (const account of ["Work", "default", "Alpha"]) {
    await switchAt(parent, account);
    await dispatch(child, "child");
  }
  assert.deepEqual(
    lines(log).filter((r) => r.role === "child").map((r) => [r.provider, r.model, r.key]),
    [[CODEX, "small-fixture", work], [CODEX, "small-fixture", personal],
      [CODEX, "small-fixture", alpha]],
  );
  assert.equal(child.child.pid, pid);
  assert.equal((await child.rpc("get_state")).model.provider, CODEX);
  assert.equal((await parent.rpc("get_state")).model.provider, CODEX);
  assert.equal(lines(log).some((r) => r.network), false, "all HTTP is blocked and none attempted");
  const finalProfile = await readFile(routingFile, "utf8");
  assert.doesNotMatch(finalProfile, /fixture-|eyJhbGci/,
    "routing descriptor stores no credentials");
  console.log("PASS native Pi parent/retained-child Codex routing: " +
    "named/default accounts, zero HTTP");

  const earlyInheritedLeaf = (await child.rpc("get_tree")).leafId;
  sibling = await start("sibling", parentEnv);
  await switchAt(child, "Work");
  const childState = (await child.rpc("get_state")).sessionId;
  const childFile = routingPath(childState);
  grandchild = await start("grandchild", {
    PI_SESSION_ROUTING_FILE: childFile, PI_SESSION_ROUTING_OWNER_SESSION: childState,
  });
  assert.equal((await dispatch(grandchild, "grandchild")).key, work,
    "new descendant follows child override");
  const resume = { ROUTING_FIXTURE_SESSION_FILE: childSessionFile, ROUTING_FIXTURE_RESUME: "1" };
  await child.close(); child = await start("child", resume);
  assert.equal((await child.rpc("get_state")).sessionId, childState);
  assert.equal((await child.rpc("get_state")).model.provider, CODEX,
    "cold resume restores native provider identity");
  assert.equal((await dispatch(child, "child")).key, work,
    "explicit override survives cold process resume without parent environment");
  assert.equal((await dispatch(grandchild, "grandchild")).key, work,
    "existing descendant stays bound across parent process restart");
  assert.equal((await dispatch(sibling, "sibling")).key, alpha,
    "sibling remains on root selection");
  assert.equal(JSON.parse(await readFile(routingFile, "utf8")).accountId, "Alpha",
    "child never changes root selection");
  await switchAt(parent, "default");
  assert.equal((await dispatch(grandchild, "grandchild")).key, work,
    "child override survives ancestor change");
  await switchAt(grandchild, "default");
  await switchAt(child, "inherit");
  assert.equal((await dispatch(child, "child")).key, personal, "cleared child follows parent");
  const earlyClearLeaf = (await child.rpc("get_tree")).leafId;
  await switchAt(parent, "Alpha");
  await child.close(); child = await start("child", resume);
  assert.equal((await dispatch(child, "child")).key, alpha,
    "cleared override survives cold resume and follows later ancestor changes");
  assert.equal((await dispatch(grandchild, "grandchild")).key, personal,
    "grandchild explicit default survives ancestor clear and changes");
  await switchAt(grandchild, "inherit");
  assert.equal((await dispatch(grandchild, "grandchild")).key, alpha,
    "cleared grandchild follows dynamic nearest ancestor");
  assert.equal((await grandchild.rpc("get_state")).model.provider, CODEX,
    "native identity persists without session-follow");
  await switchAt(child, "Work");
  assert.equal((await dispatch(grandchild, "grandchild")).key, work);
  await switchAt(child, "inherit");
  assert.equal((await dispatch(grandchild, "grandchild")).key, alpha);
  const laterClearProfile = readSessionRoutingProfile(childFile, childState);
  await restore(child, earlyInheritedLeaf);
  const restoredInitial = readSessionRoutingProfile(childFile, childState);
  assert.ok(restoredInitial.revision > laterClearProfile.revision,
    "earlier inherited branch issues a fresh monotonic epoch");
  assert.equal((await dispatch(grandchild, "grandchild")).key, alpha,
    "existing descendant accepts restored inherited branch");
  await restore(child, earlyClearLeaf);
  const restoredClear = readSessionRoutingProfile(childFile, childState);
  assert.ok(restoredClear.revision > restoredInitial.revision,
    "historical clear-inherit offset is not replayed");
  assert.equal((await dispatch(grandchild, "grandchild")).key, alpha,
    "existing descendant accepts restored clear branch");
  await child.close(); child = await start("child", resume);
  const resumed = readSessionRoutingProfile(childFile, childState);
  assert.ok(resumed.revision > restoredClear.revision,
    "cold resume republishes a fresh inheritance epoch");
  assert.deepEqual(
    [resumed.ownerSessionId, resumed.providerId, resumed.accountId],
    [restoredClear.ownerSessionId, restoredClear.providerId, restoredClear.accountId],
    "fresh epoch preserves account/provider/owner scope",
  );
  assert.equal((await dispatch(grandchild, "grandchild")).key, alpha,
    "already-observing descendant survives branch restore and process restart");
  assert.equal((await dispatch(sibling, "sibling")).key, alpha);

  // A Codex child of a session on plain `openai` fails closed instead of using either login.
  plainParent = await start("plain-parent");
  const plainRow = await dispatch(plainParent, "plain-parent");
  assert.deepEqual([plainRow.provider, plainRow.key], ["openai", "fixture-openai-default"],
    "plain openai keeps its built-in login without any account wrapper");
  const plainState = (await plainParent.rpc("get_state")).sessionId;
  assert.equal(readSessionRoutingProfile(routingPath(plainState), plainState).providerId, "openai");
  orphan = await start("orphan", {
    PI_SESSION_ROUTING_FILE: routingPath(plainState), PI_SESSION_ROUTING_OWNER_SESSION: plainState,
  });
  await turn(orphan, "orphan turn");
  assert.equal(lines(log).filter((r) => r.role === "orphan").length, 0,
    "Codex child with a non-Codex parent route must not dispatch");

  // A Codex store write keeps the legacy `openai` section exactly as it was.
  await command(parent, "/routing-default Work", "Codex default update");
  assert.equal(lines(log).filter((r) => r.role === "manage").at(-1).result.ok, true);
  const stored = JSON.parse(await readFile(accountsFile, "utf8"));
  assert.equal(stored.providers[CODEX].active, "Work");
  assert.deepEqual(stored.providers.openai, legacyOpenAI, "providers.openai preserved on disk");

  assert.equal(lines(log).some((r) => r.network), false);
  console.log("PASS native Pi Codex subtree override/clear/history restore, unsupported provider " +
    "rejection, legacy openai section preserved, non-Codex parent route fails closed, zero HTTP");
} finally {
  for (const target of [orphan, plainParent, grandchild, sibling, child, parent])
    if (target) await target.close();
  await rm(root, { recursive: true, force: true });
}
