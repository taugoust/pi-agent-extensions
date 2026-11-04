import { registerHooks } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
registerHooks({ load(url, context, next) { if (url.endsWith(".json")) return { shortCircuit: true, format: "module", source: `export default ${readFileSync(new URL(url), "utf8")}` }; return next(url, context); }, resolve(specifier, context, next) {
  if (specifier === "@earendil-works/pi-coding-agent") return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent('export const getAgentDir=()=>process.env.PI_WORKTREE_FIXTURE_AGENT_DIR;')}` };
  if (specifier.endsWith(".js") && specifier.startsWith(".")) { try { return next(specifier.replace(/\.js$/, ".ts"), context); } catch {} }
  return next(specifier, context);
} });
const { provisionWorktrees, ownedWorktrees, releaseWorktree, worktreeGit: git, saveOwnedWorktree, worktreeOption, descriptiveWorktreeBranch } = await import("./subagent-worktrees.ts");
const { reapOwnedWorktrees } = await import("./worktree-reap.ts");
const { applyAutomaticWorktreePolicy, installWorkerWorktreeContext, workerWorktreeContext } = await import("./worker-worktree-context.ts");
const { discoverAgentProfiles, resolveAgentProfileLaunch } = await import("../subagent/profiles.ts");
const id = (prefix, n) => `${prefix}-${n.toString(16).padStart(24, "0")}`;
const makeChild = (n, cwd, worktree = true) => ({ taskId: id("subagent-task", n), childId: id("subagent-child", n), spec: { task: "Bounded fixture", cwd, worktree } });
const idle = async () => false, current = () => true;
const identity = row => ({ ownerSessionId: row.ownerSessionId, taskId: row.taskId, childId: row.childId });
async function fixture(action) {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-auto-worktree-")), agent = join(root, "agent"), repo = join(root, "source");
  process.env.PI_WORKTREE_FIXTURE_AGENT_DIR = agent;
  await fs.mkdir(agent); await fs.mkdir(repo);
  await fs.writeFile(join(agent, "pi-worktree.json"), JSON.stringify({ worktreeRoot: join(root, "trees") }));
  await git(["init", "-b", "main"], repo); await git(["config", "user.email", "fixture@example.invalid"], repo); await git(["config", "user.name", "Fixture"], repo);
  await fs.mkdir(join(repo, "sub")); await fs.writeFile(join(repo, "sub", "tracked"), "original\n");
  await git(["add", "."], repo); await git(["commit", "-m", "fixture"], repo);
  try { await action({ root, repo, agent }); }
  finally { delete process.env.PI_WORKTREE_FIXTURE_AGENT_DIR; await fs.rm(root, { recursive: true, force: true }); }
}
const provision = (children, owner = "owner", resume = false, supervisor, previous, activity = idle) => provisionWorktrees(children, owner, undefined, current, resume, supervisor, previous, activity);
const request = (record, extra = {}) => ({ actorSessionId: "owner", cleanupBorrowedRoot: true, root: identity(record), descendants: [], ownedSessionIds: [], context: { cwd: process.cwd(), isIdle: current, hasPendingMessages: () => false, managedWorktreeActivity: idle }, ...extra });

test("trusted spawning-parent profile policy is independent of child selection, names, environment and Goals", async () => fixture(async ({ root, agent }) => {
  const profiles = await discoverAgentProfiles({ cwd: root, agentDir: agent, projectTrusted: false });
  const coordinator = resolveAgentProfileLaunch({ agent: "coordinator" }, profiles, { defaultModel: "fixture" });
  assert.equal(coordinator.automaticWorktrees, true);
  for (const name of ["scout", "worker", "reviewer", "oracle"]) assert.equal(resolveAgentProfileLaunch({ agent: name }, profiles, { defaultModel: "fixture" }).automaticWorktrees, false);
  process.env.PI_AUTOMATIC_WORKTREES = "true";
  try { assert.equal(applyAutomaticWorktreePolicy({ agent: "coordinator", task: "plain" }, "ordinary").worktree, undefined); }
  finally { delete process.env.PI_AUTOMATIC_WORKTREES; }
  assert.throws(() => resolveAgentProfileLaunch({ automaticWorktrees: true }, [], { defaultModel: "fixture" }), /trusted profile/);
  const clear = installWorkerWorktreeContext("coordinator-session", { ...coordinator, ownerSessionId: "parent", taskId: id("subagent-task", 1), childId: id("subagent-child", 1) });
  try {
    assert.equal(applyAutomaticWorktreePolicy({ agent: "worker", task: "non-goal" }, "coordinator-session").worktree, true);
    assert.equal(applyAutomaticWorktreePolicy({ agent: "worker", task: "opt-out", worktree: false }, "coordinator-session").worktree, false);
    const items = applyAutomaticWorktreePolicy({ tasks: [{ task: "default" }, { task: "off", worktree: false }, { task: "new", worktree: {} }] }, "coordinator-session").tasks;
    assert.deepEqual(items.map(x => x.worktree), [true, false, {}]);
    assert.equal(applyAutomaticWorktreePolicy({ chain: [{ task: "default" }] }, "coordinator-session").chain[0].worktree, true);
    assert.equal(workerWorktreeContext("different-session"), undefined);
    assert.equal(applyAutomaticWorktreePolicy({ operation: "resume" }, "coordinator-session").worktree, undefined);
  } finally { clear(); }
  assert.equal(workerWorktreeContext("coordinator-session"), undefined);
  assert.equal(worktreeOption(false), false); assert.equal(worktreeOption(true), true); assert.throws(() => worktreeOption({ enabled: true }), /Invalid/);
}));

test("descriptive branch suggestions prefer displayName, support legacy names and task intent", () => {
  assert.equal(descriptiveWorktreeBranch({ task: "Review bounded implementation", displayName: "Saved Goal Checklist", name: "legacy-name" }), "saved-goal-checklist");
  assert.equal(descriptiveWorktreeBranch({ task: "Review bounded implementation", name: "legacy-name" }), "legacy-name");
  assert.equal(descriptiveWorktreeBranch({ task: "Upgrade Paseo to 0.15.0", name: "worker" }), "upgrade/paseo-0.15.0");
  assert.equal(descriptiveWorktreeBranch({ task: "Implement saved goal checklist", name: "worker" }), "feat/saved-goal-checklist");
  assert.equal(descriptiveWorktreeBranch({ task: "Fix worktree cleanup", displayName: "Worker" }), "fix/worktree-cleanup");
  assert.equal(descriptiveWorktreeBranch({ task: "Anything", displayName: "Review", name: "ignored" }, "fix/exact-name"), "fix/exact-name");
});

test("invalid explicit branch names fail before registry mutation; collisions get readable suffixes", async () => fixture(async ({ repo }) => {
  await assert.rejects(provision([makeChild(1, repo, { branch: "../foreign" })]), /invalid|branch/i);
  assert.equal((await ownedWorktrees()).length, 0);
  await git(["branch", "feat/saved-goal-checklist"], repo);
  const child = makeChild(2, repo, { branch: "feat/saved-goal-checklist" });
  child.spec.displayName = "Saved Goal Checklist";
  await provision([child]);
  assert.equal(child.spec.worktreeInfo.branch, "feat/saved-goal-checklist-2");
  assert.equal((await git(["rev-parse", "feat/saved-goal-checklist"], repo)).trim(), (await git(["rev-parse", "HEAD"], repo)).trim(), "foreign existing branch remains untouched");
}));

test("automatic repository provisioning preserves relative cwd and primary checkout; false permits non-Git", async () => fixture(async ({ repo, root }) => {
  const child = makeChild(1, join(repo, "sub")); await provision([child]);
  assert.notEqual(child.spec.cwd, join(repo, "sub")); assert.equal(child.spec.cwd, join(child.spec.worktreeInfo.path, "sub"));
  assert.equal((await git(["branch", "--show-current"], repo)).trim(), "main"); assert.equal(await git(["status", "--porcelain"], repo), "");
  assert.equal((await ownedWorktrees("owner")).length, 1);
  await provision([makeChild(2, root, false)]); const ordinary = makeChild(3, root); delete ordinary.spec.worktree; await provision([ordinary]);
  await assert.rejects(provision([makeChild(4, root)]), /requires a Git repository cwd.*worktree:false/);
}));

test("new dirty sources never imply include/exclude; explicit objects retain new-tree snapshot semantics", async () => fixture(async ({ repo }) => {
  await fs.writeFile(join(repo, "partial"), "do not guess\n");
  await assert.rejects(provision([makeChild(1, repo)]), /Set worktree.changes/);
  assert.equal((await ownedWorktrees()).length, 0);
  const included = makeChild(2, repo, { changes: "include" }); await provision([included]);
  assert.equal(await fs.readFile(join(included.spec.cwd, "partial"), "utf8"), "do not guess\n");
  const excluded = makeChild(3, repo, { changes: "exclude" }); await provision([excluded]);
  await assert.rejects(fs.stat(join(excluded.spec.cwd, "partial")), { code: "ENOENT" });
  assert.equal(await fs.readFile(join(repo, "partial"), "utf8"), "do not guess\n");
}));

test("replacement and resumed borrowers preserve dirty staged/untracked partial work in place across reload", async () => fixture(async ({ repo }) => {
  const creator = makeChild(1, repo); await provision([creator]); const path = creator.spec.worktreeInfo.path;
  await fs.writeFile(join(path, "sub", "tracked"), "staged partial\n"); await git(["add", "sub/tracked"], path);
  await fs.writeFile(join(path, "untracked"), "retained\n");
  await assert.rejects(provision([makeChild(2, path)]), /creator is still attached/);
  await releaseWorktree("owner", creator.taskId, creator.childId);
  const replacement = makeChild(2, path); await provision([replacement]);
  assert.equal(replacement.spec.cwd, path); assert.equal(replacement.spec.worktreeInfo.borrowed, true);
  assert.equal((await ownedWorktrees()).length, 1, "no copying to another tree or ownership transfer");
  await assert.rejects(provision([makeChild(3, path)]), /conflicting active borrower/);
  await releaseWorktree("owner", replacement.taskId, replacement.childId);
  const resumed = { ...replacement, childId: id("subagent-child", 9), spec: structuredClone(replacement.spec) };
  await provision([resumed], "owner", true, undefined, replacement.childId);
  await releaseWorktree("owner", replacement.taskId, replacement.childId);
  assert.equal((await ownedWorktrees())[0].borrowers[0].released, false, "stale attempt cannot release replacement");
  assert.equal(await fs.readFile(join(path, "untracked"), "utf8"), "retained\n"); assert.match(await git(["diff", "--cached"], path), /staged partial/);
  await releaseWorktree("owner", resumed.taskId, resumed.childId);
  await assert.rejects(provision([{ ...resumed, childId: id("subagent-child", 10) }], "owner", true, undefined, replacement.childId), /replacement identity/);
}));

test("nested authenticated supervisors lend their root exclusively without foreign takeover", async () => fixture(async ({ repo }) => {
  const creator = makeChild(1, repo); await provision([creator], "outer"); const record = (await ownedWorktrees())[0];
  const supervisor = { sessionId: "coordinator", automaticWorktrees: true, self: identity(record), worktree: identity(record) };
  const worker = makeChild(2, record.path); await provision([worker], "coordinator", false, supervisor);
  const nestedSupervisor = { sessionId: "nested", automaticWorktrees: false, self: { ownerSessionId: "coordinator", taskId: worker.taskId, childId: worker.childId }, worktree: identity(record) };
  const leaf = makeChild(3, record.path); await provision([leaf], "nested", false, nestedSupervisor);
  await assert.rejects(provision([makeChild(4, record.path)], "coordinator", false, supervisor), /conflicting active borrower/);
  await assert.rejects(provision([makeChild(5, record.path)], "foreign"), /foreign ownership/);
  assert.equal((await ownedWorktrees())[0].ownerSessionId, "outer");
  await releaseWorktree("nested", leaf.taskId, leaf.childId); await releaseWorktree("coordinator", worker.taskId, worker.childId);
  await provision([makeChild(6, record.path)], "coordinator", false, supervisor);
}));

test("borrowed coordinator cleans owned descendants before durable detach and retains parent root across retry", async () => fixture(async ({ repo, root }) => {
  const creator = makeChild(1, repo); await provision([creator], "ancestor"); const parent = (await ownedWorktrees())[0];
  const supervisor = { sessionId: "parent-session", automaticWorktrees: true, self: identity(parent), worktree: identity(parent) };
  const coordinator = makeChild(2, parent.path); await provision([coordinator], "parent-session", false, supervisor);
  const coordinatorId = { ownerSessionId: "parent-session", taskId: coordinator.taskId, childId: coordinator.childId };
  const nested = makeChild(3, repo, {}); await provision([nested], "coordinator-session");
  const secondRepo = join(root, "second-repository"); await git(["clone", "--local", repo, secondRepo], root);
  const other = makeChild(4, secondRepo, {}); await provision([other], "nested-session");
  const owned = (await ownedWorktrees()).filter(row => row.ownerSessionId !== "ancestor");
  for (const child of [nested, other]) await releaseWorktree(child === nested ? "coordinator-session" : "nested-session", child.taskId, child.childId);
  await fs.writeFile(join(nested.spec.cwd, "partial"), "preserve child evidence\n");
  const req = request(parent, { cleanupBorrowedRoot: false, root: coordinatorId, ownedSessionIds: ["coordinator-session", "nested-session"],
    descendants: owned.map(row => ({ ...identity(row), reaped: true })) });
  await assert.rejects(reapOwnedWorktrees(req), /remaining files/);
  assert.equal((await ownedWorktrees("ancestor"))[0].borrowers[0].released, false, "owned cleanup failure must not prematurely release supervision link");
  assert.ok(await fs.stat(parent.path)); await fs.unlink(join(nested.spec.cwd, "partial"));
  const report = await reapOwnedWorktrees(req); assert.equal(report.removed.length, 2); assert.deepEqual(report.retainedParentWorktrees.map(row => row.path), [parent.path]);
  assert.equal((await ownedWorktrees("ancestor"))[0].released, false, "ancestor creator remains attached");
  await releaseWorktree("parent-session", coordinator.taskId, coordinator.childId);
  await releaseWorktree("parent-session", coordinator.taskId, coordinator.childId);
  assert.equal((await ownedWorktrees("ancestor"))[0].borrowers[0].released, true, "detach is durable/idempotent");
  assert.equal((await reapOwnedWorktrees(req)).removed.length, 2, "reload/retry retains exact attribution");
  const originalOwner = await reapOwnedWorktrees(request(parent)); assert.deepEqual(originalOwner.removed, [parent.path]);
}));

test("managed activity, branch/physical identity and failed preparation remain fail-closed", async () => fixture(async ({ repo, root }) => {
  const creator = makeChild(1, repo); await provision([creator]); await releaseWorktree("owner", creator.taskId, creator.childId);
  const record = (await ownedWorktrees())[0];
  await assert.rejects(provision([makeChild(2, record.path)], "owner", false, undefined, undefined, async () => true), /conflicting managed worker/);
  await assert.rejects(provision([makeChild(2, record.path)], "owner", false, undefined, undefined, async () => { throw new Error("inventory unavailable"); }), /inventory unavailable/);
  const borrowed = makeChild(3, record.path);
  await assert.rejects(provision([borrowed, makeChild(4, root)]), /Git repository cwd/);
  assert.equal((await ownedWorktrees())[0].borrowers.find(x => x.taskId === borrowed.taskId).released, true, "preflight partial failure releases exact borrower durably");
  await git(["switch", "-c", "changed-identity"], record.path);
  await assert.rejects(provision([makeChild(5, record.path)]), /branch\/path identity changed/);
  await git(["switch", record.branch], record.path);
  await saveOwnedWorktree({ ...record, physicalIdentity: { ...record.physicalIdentity, ino: "0" } });
  await assert.rejects(provision([makeChild(6, record.path)]), /physical identity changed/);
}));

test("cleanup protects borrowed/shared worktrees; force audits leftovers; released clean borrower can clean with retry", async () => fixture(async ({ repo }) => {
  const creator = makeChild(1, repo); await provision([creator]); const record = (await ownedWorktrees())[0];
  const supervisor = { sessionId: "supervisor", automaticWorktrees: true, self: identity(record), worktree: identity(record) };
  const borrower = makeChild(2, record.path); await provision([borrower], "supervisor", false, supervisor);
  await assert.rejects(reapOwnedWorktrees(request(record)), /active agent/);
  const borrowedRoot = { ownerSessionId: "supervisor", taskId: borrower.taskId, childId: borrower.childId };
  await assert.rejects(reapOwnedWorktrees(request(record, { root: borrowedRoot })), /creator\/supervisor remains attached/);
  const forced = await reapOwnedWorktrees(request(record, { root: borrowedRoot, force: true, reason: "Preserve shared investigation" }));
  assert.deepEqual(forced.remaining, [record.path]); assert.equal((await ownedWorktrees())[0].reapAudits[0].requestedRoot.childId, borrower.childId);
  await releaseWorktree("owner", creator.taskId, creator.childId);
  await fs.writeFile(join(record.path, "dirty"), "keep\n");
  await assert.rejects(reapOwnedWorktrees(request(record, { root: borrowedRoot })), /remaining files/);
  await fs.unlink(join(record.path, "dirty"));
  assert.deepEqual((await reapOwnedWorktrees(request(record, { root: borrowedRoot }))).removed, [record.path]);
  assert.equal((await git(["rev-parse", record.branch], repo)).trim(), record.baseCommit, "branch retained");
  assert.deepEqual((await reapOwnedWorktrees(request(record, { root: borrowedRoot }))).removed, [record.path], "durable retry");
}));
