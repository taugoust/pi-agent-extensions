import { registerHooks } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
registerHooks({ load(url, context, next) { if (url.endsWith(".json")) return { shortCircuit: true, format: "module", source: `export default ${readFileSync(new URL(url), "utf8")}` }; return next(url, context); }, resolve(specifier, context, next) {
  if (specifier === "@earendil-works/pi-coding-agent") return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent('export const getAgentDir=()=>process.env.PI_WORKTREE_FIXTURE_AGENT_DIR; export const SessionManager={}')}` };
  if (specifier.endsWith(".js") && specifier.startsWith(".")) { try { return next(specifier.replace(/\.js$/, ".ts"), context); } catch {} }
  if (specifier.endsWith(".json")) return next(specifier, { ...context, importAttributes: { type: "json" } });
  return next(specifier, context);
} });
const { saveOwnedWorktree, ownedWorktrees, worktreeGit: git, serialized, provisionWorktrees, releaseWorktree } = await import("./subagent-worktrees.ts");
const { ownedWorktreeCompletionHost, worktreeHasActiveUsers, currentOwnerWorktreeSafety } = await import("./worktree-completion-host.ts");
const { markWorktreeComplete: mark, cleanupCompletedWorktree: cleanup } = await import("./worktree-completion.ts");
const { registerWorktreeCommand } = await import("../workflows/worktree/command.ts");
// Restrict process inventory to processes created by these fixtures. No live session is inspected/deleted.
const fixturePids = new Set([String(process.pid)]), realReaddir = fs.readdir.bind(fs);
fs.readdir = async (path, ...args) => path === "/proc" ? [...fixturePids] : realReaddir(path, ...args);
const task = "subagent-task-" + "a".repeat(24), owner = "fixture-owner";
async function fixture(action) {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-completion-fixture-"));
  process.env.PI_WORKTREE_FIXTURE_AGENT_DIR = join(root, "agent");
  try {
    const repo = join(root, "repo"), path = join(root, "worker"); await fs.mkdir(repo);
    await git(["init", "-b", "main"], repo); await git(["config", "user.email", "fixture@example.invalid"], repo); await git(["config", "user.name", "Fixture"], repo);
    await fs.writeFile(join(repo, "tracked"), "fixture\n"); await fs.writeFile(join(repo, ".gitignore"), "ignored\n");
    await git(["add", "."], repo); await git(["commit", "-m", "fixture"], repo);
    await git(["worktree", "add", "-b", "pi/fixture", path], repo);
    const commonDir = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], repo)).trim();
    const admin = (await git(["rev-parse", "--path-format=absolute", "--git-dir"], path)).trim(), stat = await fs.stat(admin);
    const row = { version: 1, ownerSessionId: owner, taskId: task, childId: "subagent-child-" + "b".repeat(24), title: "fixture", repo, commonDir, path, cwd: path, branch: "pi/fixture", baseCommit: (await git(["rev-parse", "HEAD"], path)).trim(), includedChanges: false, createdAt: new Date().toISOString(), released: true, state: "ready", physicalIdentity: { dev: String(stat.dev), ino: String(stat.ino), birthtimeMs: String(stat.birthtimeMs) } };
    await saveOwnedWorktree(row);
    const ctx = { cwd: repo, sessionManager: { getSessionId: () => owner }, isIdle: () => true, hasPendingMessages: () => false };
    const host = ownedWorktreeCompletionHost(ctx, async () => ({ active: false, retained: false }));
    await action({ root, repo, path, row, ctx, host });
  } finally { delete process.env.PI_WORKTREE_FIXTURE_AGENT_DIR; await fs.rm(root, { recursive: true, force: true }); }
}
test("real Git lifecycle removes only fixture checkout and completed branch; durable marker survives", () => fixture(async f => {
  await mark(f.host, task, "Owner reviewed fixture output");
  assert.equal((await cleanup(f.host, task)).phase, "cleaned");
  await assert.rejects(fs.stat(f.path), { code: "ENOENT" });
  assert.equal((await git(["branch", "--list", "pi/fixture"], f.repo)).trim(), "");
  assert.equal((await cleanup(f.host, task)).phase, "cleaned");
  assert.equal((await ownedWorktrees(owner))[0].completion.decidedBySessionId, owner);
  assert.ok(await fs.stat(f.repo));
}));
for (const artifact of ["untracked", "ignored"]) test(`${artifact} fixture artifact blocks deletion`, () => fixture(async f => {
  await mark(f.host, task, "Reviewed"); await fs.writeFile(join(f.path, artifact), "valuable");
  assert.match((await cleanup(f.host, task)).blockedReason, /remaining files/);
  assert.equal(await fs.readFile(join(f.path, artifact), "utf8"), "valuable");
}));
test("advance then reset to same OID remains blocked by ref history", () => fixture(async f => {
  const initial = await mark(f.host, task, "Reviewed"); await fs.writeFile(join(f.path, "tracked"), "advanced");
  await git(["add", "."], f.path); await git(["commit", "-m", "advanced"], f.path); await git(["reset", "--hard", initial.branchOid], f.path);
  assert.match((await cleanup(f.host, task)).blockedReason, /history changed/);
}));
test("deleted and recreated branch at the same OID is not the completed ref", () => fixture(async f => {
  const marker = await mark(f.host, task, "Reviewed");
  await git(["update-ref", "-d", "refs/heads/pi/fixture", marker.branchOid], f.repo);
  await git(["update-ref", "--create-reflog", "refs/heads/pi/fixture", marker.branchOid], f.repo);
  assert.match((await cleanup(f.host, task)).blockedReason, /history changed/);
  assert.ok(await fs.stat(f.path));
}));
test("active user shell cwd is protected", () => fixture(async f => {
  await mark(f.host, task, "Reviewed");
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: f.path, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  fixturePids.add(String(child.pid));
  try { assert.equal(await worktreeHasActiveUsers(f.path), true); assert.match((await cleanup(f.host, task)).blockedReason, /using/); }
  finally { fixturePids.delete(String(child.pid)); child.kill(); await new Promise(resolve => child.once("close", resolve)); }
}));
test("foreign owner and explicit retention are rejected", () => fixture(async f => {
  const foreign = ownedWorktreeCompletionHost({ ...f.ctx, sessionManager: { getSessionId: () => "other" } }, async () => ({ active: false, retained: false }));
  await assert.rejects(mark(foreign, task, "Forged"), /not owned/);
  await mark(f.host, task, "Reviewed"); await saveOwnedWorktree({ ...(await ownedWorktrees(owner))[0], retain: true });
  assert.match((await cleanup(f.host, task)).blockedReason, /retention/);
}));
test("replaced checkout administrative identity blocks cleanup", () => fixture(async f => {
  await mark(f.host, task, "Reviewed"); await git(["worktree", "remove", f.path], f.repo); await git(["worktree", "add", f.path, "pi/fixture"], f.repo);
  assert.match((await cleanup(f.host, task)).blockedReason, /identity changed/);
  assert.ok(await fs.stat(f.path));
}));
test("failure after actual fixture worktree removal is recoverable", () => fixture(async f => {
  await mark(f.host, task, "Reviewed");
  const save = f.host.save; let fail = true;
  f.host.save = async marker => { if (marker.phase === "worktree-removed" && fail) { fail = false; throw new Error("fixture write interruption"); } return save(marker); };
  assert.match((await cleanup(f.host, task)).blockedReason, /interruption/);
  assert.equal((await cleanup(f.host, task)).phase, "cleaned");
}));
test("registry lock prevents concurrent mutation and preserves interrupted lock", () => fixture(async f => {
  const files = await fs.readdir(join(process.env.PI_WORKTREE_FIXTURE_AGENT_DIR, "state", "subagent-worktrees-v1"));
  const file = files.find(n => n.endsWith(".json"));
  const lock = join(process.env.PI_WORKTREE_FIXTURE_AGENT_DIR, "state", "subagent-worktrees-v1", file + ".lock");
  await fs.mkdir(lock); await assert.rejects(serialized(owner, task, async () => {}), /locked/); assert.ok(await fs.stat(lock));
}));
test("production completion flow confirms and uses verified owner session source, no Goal required", () => fixture(async f => {
  let approved = false; const notices = [];
  const ctx = { ...f.ctx, hasUI: true, waitForIdle: async () => {}, ui: { confirm: async () => approved, notify: text => notices.push(text) } };
  let command;
  registerWorktreeCommand({ registerCommand: (name, spec) => { assert.equal(name, "worktree"); command = spec; } }, {}, () => ({ signal: new AbortController().signal, isCurrent: () => true }));
  globalThis.__paeHarnessReadOnlyV1 = { protocol: 1, subagents: { protocol: 1, sessionId: owner,
    list: async () => ({ state: "available", sessionId: owner, stale: true, items: [{ taskId: task, childId: f.row.childId, attempt: 1, runtimeId: "fixture-runtime", stale: true }] }),
    sessionSource: async input => { assert.equal(input.sessionId, owner); return { taskId: task, childId: f.row.childId, attempt: 1, runtimeId: "fixture-runtime", cwd: f.path, status: "completed", reaped: true }; },
  } };
  try {
    await command.handler(`complete ${task} Reviewed fixture`, ctx);
    assert.equal((await ownedWorktrees(owner))[0].completion, undefined);
    approved = true; await command.handler(`complete ${task} Reviewed fixture`, ctx);
    assert.equal((await ownedWorktrees(owner))[0].completion.phase, "marked");
    await command.handler(`cleanup ${task}`, ctx);
    assert.match(notices.at(-1), /cleaned/);
  } finally { delete globalThis.__paeHarnessReadOnlyV1; }
}));
test("unavailable active-user evidence is a durable blocked reason, not implicit deletion permission", () => fixture(async f => {
  await mark(f.host, task, "Reviewed"); const readlink = fs.readlink;
  fs.readlink = async (...args) => { if (args[0] === `/proc/${process.pid}/cwd`) throw Object.assign(new Error("fixture access denied"), { code: "EACCES" }); return readlink(...args); };
  try { assert.match((await cleanup(f.host, task)).blockedReason, /Cannot verify active users/); assert.ok(await fs.stat(f.path)); }
  finally { fs.readlink = readlink; }
}));
test("empty untracked directory and late ignored artifact are protected", () => fixture(async f => {
  await mark(f.host, task, "Reviewed"); await fs.mkdir(join(f.path, "empty"));
  assert.match((await cleanup(f.host, task)).blockedReason, /remaining files/); await fs.rmdir(join(f.path, "empty"));
  const remove = f.host.removeWorktree;
  f.host.removeWorktree = async (...args) => { await fs.writeFile(join(f.path, "ignored"), "late artifact"); return remove(...args); };
  assert.match((await cleanup(f.host, task)).blockedReason, /preconditions changed/);
  assert.equal(await fs.readFile(join(f.path, "ignored"), "utf8"), "late artifact");
}));
test("failed worker/crash evidence and unavailable verified source remain retained", () => fixture(async f => {
  await mark(f.host, task, "Reviewed"); await saveOwnedWorktree({ ...(await ownedWorktrees(owner))[0], state: "failed", error: "Retained crash evidence" });
  assert.match((await cleanup(f.host, task)).blockedReason, /retained evidence/);
  const guarded = ownedWorktreeCompletionHost(f.ctx, r => currentOwnerWorktreeSafety(f.ctx, r));
  const result = await cleanup(guarded, task);
  assert.ok(result.blockedReason); assert.ok(await fs.stat(f.path));
}));
test("branch checked out at another linked path blocks cleanup", () => fixture(async f => {
  await mark(f.host, task, "Reviewed"); await git(["checkout", "--detach"], f.path);
  await git(["worktree", "add", join(f.root, "linked"), "pi/fixture"], f.repo);
  assert.match((await cleanup(f.host, task)).blockedReason, /identity changed/); assert.ok(await fs.stat(f.path));
}));
test("actual harness provisioning/release interoperates with completion and refuses completed resume", () => fixture(async f => {
  await fs.writeFile(join(process.env.PI_WORKTREE_FIXTURE_AGENT_DIR, "pi-worktree.json"), JSON.stringify({ worktreeRoot: join(f.root, "managed") }));
  const managedTask = "subagent-task-" + "c".repeat(24), childId = "subagent-child-" + "d".repeat(24);
  const child = { taskId: managedTask, childId, spec: { task: "Disposable fixture", cwd: f.repo, worktree: { changes: "exclude" } } };
  await provisionWorktrees([child], owner, undefined, () => true);
  assert.ok(child.spec.cwd.startsWith(f.root + "/"));
  await mark(f.host, managedTask, "Reviewed provisioned fixture");
  assert.match((await cleanup(f.host, managedTask)).blockedReason, /using/);
  await assert.rejects(provisionWorktrees([child], owner, undefined, () => true, true), /Completed worktree cannot be resumed/);
  await releaseWorktree(owner, managedTask, childId);
  assert.equal((await cleanup(f.host, managedTask)).phase, "cleaned");
}));
