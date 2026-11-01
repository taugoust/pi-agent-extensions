import { registerHooks } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
registerHooks({ load(url, context, next) { if (url.endsWith(".json")) return { shortCircuit: true, format: "module", source: `export default ${readFileSync(new URL(url), "utf8")}` }; return next(url, context); }, resolve(specifier, context, next) {
  if (specifier === "@earendil-works/pi-coding-agent") return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent('export const getAgentDir=()=>process.env.PI_WORKTREE_FIXTURE_AGENT_DIR;')}` };
  if (specifier.endsWith(".js") && specifier.startsWith(".")) { try { return next(specifier.replace(/\.js$/, ".ts"), context); } catch {} }
  if (specifier.endsWith(".json")) return next(specifier, { ...context, importAttributes: { type: "json" } });
  return next(specifier, context);
} });
const { saveOwnedWorktree, ownedWorktrees, worktreeGit: git, provisionWorktrees } = await import("./subagent-worktrees.ts");
const { reapOwnedWorktrees, WorktreeReapError } = await import("./worktree-reap.ts");
const { ownedWorktreeReapHost, ownedWorktreeCompletionHost } = await import("./worktree-completion-host.ts");
const { markWorktreeComplete, cleanupCompletedWorktree } = await import("./worktree-completion.ts");
const realReaddir = fs.readdir.bind(fs), pids = new Set([String(process.pid)]);
fs.readdir = async (path, ...args) => path === "/proc" ? [...pids] : realReaddir(path, ...args);
const actor = "reap-fixture-owner", childId = x => `subagent-child-${x.repeat(24)}`, taskId = x => `subagent-task-${x.repeat(24)}`;
async function fixture(action) {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-reap-fixture-")); process.env.PI_WORKTREE_FIXTURE_AGENT_DIR = join(root, "agent");
  try {
    const records = [];
    for (const [n, ownerSessionId] of [["a", "parent-owner"], ["b", "nested-owner"], ["c", "leaf-owner"], ["d", "foreign-owner"], ["e", "sibling-owner"]]) {
      const repo = join(root, `repo-${n}`), path = join(root, `checkout-${n}`); await fs.mkdir(repo);
      await git(["init", "-b", "main"], repo); await git(["config", "user.email", "fixture@example.invalid"], repo); await git(["config", "user.name", "Fixture"], repo);
      await fs.writeFile(join(repo, "tracked"), "fixture\n"); await git(["add", "."], repo); await git(["commit", "-m", "fixture"], repo); await git(["worktree", "add", "-b", `pi/reap-${n}`, path], repo);
      const commonDir = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], repo)).trim();
      const admin = (await git(["rev-parse", "--path-format=absolute", "--git-dir"], path)).trim(), stat = await fs.stat(admin);
      const record = { version: 1, ownerSessionId, taskId: taskId(n), childId: childId(n), title: n, repo, commonDir, path, cwd: path, branch: `pi/reap-${n}`, baseCommit: (await git(["rev-parse", "HEAD"], path)).trim(), includedChanges: false, createdAt: new Date().toISOString(), released: true, state: "ready", physicalIdentity: { dev: String(stat.dev), ino: String(stat.ino), birthtimeMs: String(stat.birthtimeMs) } };
      records.push(record); await saveOwnedWorktree(record);
      if (n <= "c") { await fs.writeFile(join(path, "worker-output"), `unmerged ${n}\n`); await git(["add", "worker-output"], path); await git(["commit", "-m", `unmerged ${n}`], path); record.unmergedOid = (await git(["rev-parse", "HEAD"], path)).trim(); }
      if (n === "a") { record.released = false; await saveOwnedWorktree(record); }
    }
    await action(root, records);
  } finally { delete process.env.PI_WORKTREE_FIXTURE_AGENT_DIR; await fs.rm(root, { recursive: true, force: true }); }
}
const req = (records, extra = {}) => ({ actorSessionId: actor, root: { ownerSessionId: records[0].ownerSessionId, taskId: records[0].taskId, childId: records[0].childId },
  descendants: records.slice(1, 3).map((record, index) => ({ ownerSessionId: record.ownerSessionId, taskId: record.taskId, childId: record.childId, reaped: true, attempt: index + 1 })),
  ownedSessionIds: ["nested-owner", "leaf-owner"], context: { cwd: process.cwd(), isIdle: () => true, hasPendingMessages: () => false, safety: async () => ({ active: false, retained: false }) }, ...extra });
test("authenticated idle coordinator can reap its own current root checkout", async () => fixture(async (_root, records) => {
  const originalCwd = process.cwd();
  try {
    process.chdir(records[0].path);
    const request = req(records);
    request.context.cwd = records[0].path;
    const report = await reapOwnedWorktrees(request);
    assert.equal(report.removed.length, 3);
    assert.ok((await ownedWorktrees(records[0].ownerSessionId)).find(row => row.taskId === records[0].taskId).reap.phase === "cleaned");
  } finally { process.chdir(originalCwd); }
}));
test("busy coordinator remains an activity blocker for its root checkout", async () => fixture(async (_root, records) => {
  const originalCwd = process.cwd();
  try {
    process.chdir(records[0].path);
    const request = req(records);
    request.context.cwd = records[0].path;
    request.context.isIdle = () => false;
    await assert.rejects(reapOwnedWorktrees(request), /active agent, process, or user/);
    assert.ok(await fs.stat(records[0].path));
  } finally { process.chdir(originalCwd); }
}));
test("reaps authenticated root and nested owner records without deleting branches", async () => fixture(async (_root, records) => {
  const report = await reapOwnedWorktrees(req(records)); assert.equal(report.removed.length, 3);
  assert.equal(report.scope, "registered-harness-worktrees-only"); assert.match(report.limitation, /unregistered worktrees are not inventoried or removed/);
  for (const row of records.slice(0, 3)) {
    await assert.rejects(fs.stat(row.path), { code: "ENOENT" });
    assert.equal((await git(["rev-parse", row.branch], row.repo)).trim(), row.unmergedOid, "worker commit remains on its branch without merge");
    assert.equal((await git(["rev-parse", "main"], row.repo)).trim(), row.baseCommit, "source branch remains unchanged");
  }
  for (const row of records.slice(3)) { assert.ok(await fs.stat(row.path)); assert.equal((await ownedWorktrees(row.ownerSessionId)).find(item => item.taskId === row.taskId).reap, undefined); }
  assert.equal((await ownedWorktrees()).filter(row => records.slice(0, 3).some(target => row.taskId === target.taskId)).every(row => row.reap.phase === "cleaned"), true);
}));
test("newer root registry child is refused and force only audits requested/current identity", async () => fixture(async (_root, records) => {
  const request = req(records), oldRoot = request.root, newer = { ...records[0], childId: childId("f"), released: true };
  await saveOwnedWorktree(newer);
  await assert.rejects(reapOwnedWorktrees(request), error => {
    assert.ok(error instanceof WorktreeReapError, `${error?.constructor?.name}: ${error?.message}`); const blocked = error.report.blocked.find(item => item.taskId === records[0].taskId);
    assert.equal(blocked.childId, newer.childId); assert.deepEqual(blocked.requestedRoot, oldRoot); assert.ok(error.report.remaining.includes(records[0].path)); return true;
  });
  assert.ok(await fs.stat(records[0].path));
  const forced = await reapOwnedWorktrees({ ...request, force: true, reason: "inspect changed root" });
  assert.equal(forced.audited, true); assert.ok(await fs.stat(records[0].path));
  const audit = (await ownedWorktrees(records[0].ownerSessionId)).find(row => row.taskId === records[0].taskId).reapAudits.at(-1);
  assert.equal(audit.recordedIdentity.childId, newer.childId); assert.equal(audit.requestedRoot.childId, oldRoot.childId); assert.equal(audit.provenance, "uncertain");
}));
test("dirty, active/unreleased, and absent-attribution records block safely", async () => fixture(async (_root, records) => {
  await fs.writeFile(join(records[1].path, "untracked"), "keep");
  const broken = req(records); broken.descendants[0].reaped = false;
  await assert.rejects(reapOwnedWorktrees(broken), error => {
    assert.ok(error instanceof WorktreeReapError); assert.match(error.message, /not verified reaped and released/);
    assert.deepEqual(error.report.blocked[0], { ownerSessionId: records[1].ownerSessionId, taskId: records[1].taskId, childId: records[1].childId, path: records[1].path,
      physicalIdentity: records[1].physicalIdentity, reason: "Descendant is not verified reaped and released" });
    assert.equal(error.report.remainingWorktrees.length, 3); return true;
  });
  assert.ok(await fs.stat(records[1].path));
  const missing = req(records); missing.descendants = [];
  await assert.rejects(reapOwnedWorktrees(missing), /missing exact authenticated ancestry/);
  assert.ok(await fs.stat(records[0].path));
}));
test("force mode durably audits actual leftover paths and never removes", async () => fixture(async (_root, records) => {
  await fs.writeFile(join(records[1].path, "untracked"), "keep");
  const report = await reapOwnedWorktrees(req(records, { force: true, reason: "operator requested evidence" }));
  assert.equal(report.audited, true); assert.ok(report.remaining.includes(records[0].path)); assert.ok(await fs.stat(records[0].path)); assert.ok(await fs.stat(records[1].path));
  const audit = (await ownedWorktrees()).find(row => row.taskId === records[1].taskId).reapAudits.at(-1);
  assert.equal(audit.reason, "operator requested evidence"); assert.equal(audit.path, records[1].path); assert.equal(audit.actorSessionId, actor); assert.deepEqual(audit.root, req(records).root);
}));
test("audit record size cap fails closed with an actionable error", async () => fixture(async (_root, records) => {
  const audit = { at: new Date().toISOString(), actorSessionId: actor, recordedIdentity: { ownerSessionId: records[1].ownerSessionId, taskId: records[1].taskId, childId: records[1].childId },
    reason: "x".repeat(1000), path: records[1].path, recordedPhysicalIdentity: records[1].physicalIdentity, provenance: "verified" };
  await assert.rejects(saveOwnedWorktree({ ...records[1], reapAudits: Array(20).fill(audit) }), /16 KiB durable inventory limit.*operator archival\/review/);
}));
test("unreasoned force mode is rejected", async () => fixture(async (_root, records) => {
  await assert.rejects(reapOwnedWorktrees(req(records, { force: true })), /requires a reason/);
  await assert.rejects(reapOwnedWorktrees(req(records, { force: true, reason: "x".repeat(1001) })), /1000 bytes/);
}));
test("force audit appends coordinator identity and records uncertain provenance", async () => fixture(async (_root, records) => {
  const request = req(records, { force: true, reason: "auditable" });
  await reapOwnedWorktrees(request);
  const auditCount = (await ownedWorktrees()).find(item => item.taskId === records[1].taskId).reapAudits.length;
  await reapOwnedWorktrees(request);
  assert.equal((await ownedWorktrees()).find(item => item.taskId === records[1].taskId).reapAudits.length, auditCount, "same durable audit identity is idempotent across retries");
  const second = { ...request, actorSessionId: "second-coordinator" };
  await reapOwnedWorktrees(second);
  let row = (await ownedWorktrees()).find(item => item.taskId === records[1].taskId);
  assert.deepEqual(row.reapAudits.map(audit => audit.actorSessionId), [actor, "second-coordinator"]);
  const { physicalIdentity: _missing, ...withoutIdentity } = records[2]; await saveOwnedWorktree(withoutIdentity);
  await reapOwnedWorktrees(request);
  row = (await ownedWorktrees()).find(item => item.taskId === records[2].taskId);
  assert.equal(row.reapAudits.at(-1).provenance, "uncertain"); assert.match(row.reapAudits.at(-1).uncertainty, /physical identity/i);
  assert.ok(await fs.stat(records[2].path));
}));
test("unreadable unrelated process does not block when managed controllers verify no user", async () => fixture(async (_root, records) => {
  const stat = fs.stat.bind(fs), readlink = fs.readlink.bind(fs), pid = "424242"; let unreadableReads = 0;
  pids.add(pid);
  fs.stat = async (path, ...args) => path === `/proc/${pid}` ? { uid: process.getuid() } : stat(path, ...args);
  fs.readlink = async (path, ...args) => {
    if (path === `/proc/${pid}/cwd`) { unreadableReads++; throw Object.assign(new Error("Permission denied"), { code: "EACCES" }); }
    return readlink(path, ...args);
  };
  try {
    const request = req(records);
    request.context.managedWorktreeActivity = async () => false;
    const result = await reapOwnedWorktrees(request);
    assert.equal(result.removed.length, 3);
    assert.equal(unreadableReads, 0, "coordinator cleanup must not inspect unrelated host processes");
  } finally { fs.stat = stat; fs.readlink = readlink; pids.delete(pid); }
}));
test("tracked active and unavailable managed activity continue to block coordinator reap", async () => fixture(async (_root, records) => {
  const active = req(records);
  active.context.managedWorktreeActivity = async path => path === records[1].path;
  await assert.rejects(reapOwnedWorktrees(active), /active agent, process, or user/);
  assert.ok(await fs.stat(records[1].path));
  const unknown = req(records);
  unknown.context.managedWorktreeActivity = async () => { throw new Error("Managed worker activity inventory unavailable"); };
  await assert.rejects(reapOwnedWorktrees(unknown), /Managed worker activity inventory unavailable/);
  assert.ok(await fs.stat(records[0].path));
}));
test("retention, active OS users, and unowned foreign/sibling owners remain untouched", async () => fixture(async (_root, records) => {
  await saveOwnedWorktree({ ...records[1], retain: true });
  await assert.rejects(reapOwnedWorktrees(req(records)), /retained/);
  for (const foreign of records.slice(3)) { assert.ok(await fs.stat(foreign.path)); assert.equal((await ownedWorktrees(foreign.ownerSessionId)).find(row => row.taskId === foreign.taskId).reap, undefined); }
  await saveOwnedWorktree({ ...records[1], retain: false });
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: records[1].path, stdio: "ignore" });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); }); pids.add(String(child.pid));
  try { await assert.rejects(reapOwnedWorktrees(req(records)), /active/); assert.ok(await fs.stat(records[1].path)); }
  finally { pids.delete(String(child.pid)); child.kill(); await new Promise(resolve => child.once("close", resolve)); }
}));
test("existing guarded completion removal is recognized without branch or marker mutation", async () => fixture(async (_root, records) => {
  const row = { ...records[0], released: true }; await saveOwnedWorktree(row);
  const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => row.ownerSessionId }, isIdle: () => true, hasPendingMessages: () => false };
  const completionHost = ownedWorktreeCompletionHost(ctx, async () => ({ active: false, retained: false }));
  await markWorktreeComplete(completionHost, row.taskId, "fixture completion reviewed");
  await cleanupCompletedWorktree(completionHost, row.taskId);
  assert.equal((await ownedWorktrees(row.ownerSessionId)).find(item => item.taskId === row.taskId).completion.phase, "cleaned");
  assert.equal((await git(["branch", "--list", row.branch], row.repo)).trim(), "");
  const report = await reapOwnedWorktrees(req(records)); assert.equal(report.removed.length, 3);
  const after = (await ownedWorktrees(row.ownerSessionId)).find(item => item.taskId === row.taskId);
  assert.equal(after.completion.phase, "cleaned"); assert.equal(after.reap.phase, "cleaned");
}));
test("marked completion without durable removal evidence cannot authorize missing-path cleanup", async () => fixture(async (_root, records) => {
  const row = { ...records[0], released: true }; await saveOwnedWorktree(row);
  const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => row.ownerSessionId }, isIdle: () => true, hasPendingMessages: () => false };
  const completionHost = ownedWorktreeCompletionHost(ctx, async () => ({ active: false, retained: false }));
  await markWorktreeComplete(completionHost, row.taskId, "fixture completion reviewed");
  await git(["worktree", "remove", row.path], row.repo);
  await assert.rejects(reapOwnedWorktrees(req(records)), /missing before reap intent/);
  const after = (await ownedWorktrees(row.ownerSessionId)).find(item => item.taskId === row.taskId);
  assert.equal(after.completion.phase, "marked"); assert.equal(after.reap, undefined);
}));
test("cleaned phase refuses a reused worktree path", async () => fixture(async (_root, records) => {
  const request = req(records); await reapOwnedWorktrees(request);
  await assert.rejects(provisionWorktrees([{ taskId: records[1].taskId, childId: records[1].childId, spec: { task: "resume", cwd: records[1].cwd, worktree: {} } }], records[1].ownerSessionId, undefined, () => true, true), /Worktree removal is recorded/);
  await fs.mkdir(records[1].path);
  await assert.rejects(reapOwnedWorktrees(request), /reused|identity|git/i);
  assert.ok(await fs.stat(records[1].path));
}));
test("normal cleanup preserves the durable force audit", async () => fixture(async (_root, records) => {
  const request = req(records); await reapOwnedWorktrees({ ...request, force: true, reason: "review leftovers" });
  await reapOwnedWorktrees(request);
  const row = (await ownedWorktrees()).find(item => item.taskId === records[1].taskId);
  assert.equal(row.reap.phase, "cleaned"); assert.equal(row.reapAudits.at(-1).reason, "review leftovers");
}));
test("new attributable inventory during cleanup is retained and requires reconciliation", async () => fixture(async (root, records) => {
  const request = req(records);
  const ctx = { ...request.context, sessionManager: { getSessionId: () => actor } };
  const host = ownedWorktreeReapHost(ctx, request.context.safety, undefined, undefined, request.root, request.descendants, request.ownedSessionIds);
  const remove = host.removeForReap, path = join(root, "late-tree");
  host.removeForReap = async (...args) => {
    await remove(...args);
    if (args[0] !== request.root.taskId) return;
    await git(["worktree", "add", "-b", "pi/late-tree", path], records[1].repo);
    const stat = await fs.stat((await git(["rev-parse", "--path-format=absolute", "--git-dir"], path)).trim());
    await saveOwnedWorktree({ ...records[1], taskId: taskId("f"), childId: childId("f"), path, cwd: path,
      branch: "pi/late-tree", physicalIdentity: { dev: String(stat.dev), ino: String(stat.ino), birthtimeMs: String(stat.birthtimeMs) } });
  };
  await assert.rejects(reapOwnedWorktrees(host, request), /inventory changed during reap/);
  assert.ok(await fs.stat(path));
  assert.equal((await ownedWorktrees()).find(row => row.taskId === taskId("f")).reap, undefined);
}));

test("partial cleanup leaves dirty later child and root for a repaired retry", async () => fixture(async (_root, records) => {
  await fs.writeFile(join(records[2].path, "dirty"), "keep");
  await assert.rejects(reapOwnedWorktrees(req(records)), /remaining files/);
  assert.equal((await ownedWorktrees()).find(row => row.taskId === records[1].taskId).reap.phase, "cleaned");
  assert.ok(await fs.stat(records[2].path)); assert.ok(await fs.stat(records[0].path));
  await fs.rm(join(records[2].path, "dirty"));
  const report = await reapOwnedWorktrees(req(records)); assert.equal(report.removed.length, 3);
  assert.ok((await ownedWorktrees()).find(row => row.taskId === records[0].taskId).reap.phase === "cleaned");
}));
test("recovery handles physical removal before the durable phase save", async () => fixture(async (_root, records) => {
  const request = req(records), safety = request.context.safety;
  const ctx = { cwd: request.context.cwd, isIdle: request.context.isIdle, hasPendingMessages: request.context.hasPendingMessages,
    sessionManager: { getSessionId: () => actor } };
  const host = ownedWorktreeReapHost(ctx, safety, undefined, undefined, request.root, request.descendants, request.ownedSessionIds);
  const remove = host.removeForReap; let interrupt = true;
  host.removeForReap = async (...args) => { await remove(...args); if (interrupt) { interrupt = false; throw new Error("simulated post-remove interruption"); } };
  await assert.rejects(reapOwnedWorktrees(host, request), /simulated post-remove interruption/);
  assert.equal((await ownedWorktrees()).find(row => row.taskId === records[1].taskId).reap.phase, "intent");
  const report = await reapOwnedWorktrees(request); assert.equal(report.removed.length, 3);
  assert.ok((await git(["branch", "--list", records[1].branch], records[1].repo)).trim());
}));
