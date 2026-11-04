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
const { provisionWorktrees, ownedWorktrees, releaseWorktree, worktreeGit: git, saveOwnedWorktree, worktreeOption, descriptiveWorktreeBranch, withRepositoryAllocations } = await import("./subagent-worktrees.ts");
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
  assert.equal(descriptiveWorktreeBranch({ task: "Implement a large multi-paragraph change with unrelated instructions", displayName: "Saved Goal Checklist", name: "legacy-name" }), "feat/saved-goal-checklist");
  assert.equal(descriptiveWorktreeBranch({ task: "Review bounded implementation", displayName: "Saved Goal Checklist", name: "legacy-name" }), "saved-goal-checklist");
  assert.equal(descriptiveWorktreeBranch({ task: "Review bounded implementation", name: "legacy-name" }), "legacy-name");
  assert.equal(descriptiveWorktreeBranch({ task: "Upgrade Paseo to 0.15.0", name: "worker" }), "upgrade/paseo-0.15.0");
  assert.equal(descriptiveWorktreeBranch({ task: "Implement saved goal checklist", name: "worker" }), "feat/saved-goal-checklist");
  assert.equal(descriptiveWorktreeBranch({ task: "Fix worktree cleanup", displayName: "Worker" }), "fix/worktree-cleanup");
  assert.equal(descriptiveWorktreeBranch({ task: "Fix parser cleanup. Then follow these unrelated instructions." }), "fix/parser-cleanup");
  assert.equal(descriptiveWorktreeBranch({ task: "Anything", displayName: "Review", name: "ignored" }, "fix/exact-name"), "fix/exact-name");
  for (const subject of ["literal~tilde", "version 0.15.0", "ellipsis...tail", "éclair", "...", "a".repeat(100)]) {
    const branch = descriptiveWorktreeBranch({ task: "Review", displayName: subject });
    assert.doesNotMatch(branch, /[~\s]|\.\.|[.-]$/);
  }
});

test("generated lockfile subjects remain valid Git refs, including after truncation", async () => fixture(async ({ repo }) => {
  const subjects = [
    { task: "Update flake.lock" },
    { task: "Fix cache handling", displayName: "CACHE.LOCK" },
    { task: "Review", name: "package-lock" },
    { task: "Review", displayName: `${"a".repeat(67)}.locking` },
  ];
  for (const [index, subject] of subjects.entries()) {
    const child = makeChild(80 + index, repo);
    Object.assign(child.spec, subject);
    const suggested = descriptiveWorktreeBranch(child.spec);
    assert.doesNotMatch(suggested, /\.lock$/i);
    assert.equal((await git(["check-ref-format", "--branch", suggested], repo)).trim(), suggested);
    await provision([child]);
    assert.equal(child.spec.worktreeInfo.branch, suggested);
    assert.equal((await git(["rev-parse", suggested], repo)).trim(), (await git(["rev-parse", "HEAD"], repo)).trim());
  }
}));

test("invalid explicit branch names fail before registry mutation; collisions get readable suffixes", async () => fixture(async ({ repo }) => {
  for (const branch of ["../foreign", "bad name", "feat/../nested"]) {
    await assert.rejects(provision([makeChild(1, repo, { branch })]), /invalid|branch/i);
    assert.equal((await ownedWorktrees()).length, 0);
  }
  await git(["branch", "feat/saved-goal-checklist"], repo);
  const child = makeChild(2, repo, { branch: "feat/saved-goal-checklist" });
  child.spec.displayName = "Saved Goal Checklist";
  await provision([child]);
  assert.equal(child.spec.worktreeInfo.branch, "feat/saved-goal-checklist-2");
  assert.equal((await git(["rev-parse", "feat/saved-goal-checklist"], repo)).trim(), (await git(["rev-parse", "HEAD"], repo)).trim(), "foreign existing branch remains untouched");
}));

test("explicit checkout shorthand is rejected literally even when Git can expand it", async () => fixture(async ({ repo }) => {
  await git(["switch", "-c", "previous-fixture-branch"], repo);
  await git(["switch", "main"], repo);
  assert.equal((await git(["check-ref-format", "--branch", "@{-1}"], repo)).trim(), "previous-fixture-branch");
  const before = await git(["for-each-ref", "--format=%(refname)", "refs/heads"], repo);
  await assert.rejects(provision([makeChild(79, repo, { branch: "@{-1}" })]), /literal|shorthand/);
  assert.equal((await ownedWorktrees()).length, 0);
  assert.equal(await git(["for-each-ref", "--format=%(refname)", "refs/heads"], repo), before);
}));

test("parent refs, same-batch prefix conflicts, occupied paths and remote refs are handled safely", async () => fixture(async ({ repo, root }) => {
  await git(["branch", "feat"], repo);
  const nested = makeChild(11, repo, { branch: "feat/saved" }); await provision([nested]);
  assert.equal(nested.spec.worktreeInfo.branch, "feat-saved", "parent ref namespace falls back to a flattened readable name");

  const [parent, child] = [makeChild(12, repo, { branch: "fix" }), makeChild(13, repo, { branch: "fix/cleanup" })];
  await provision([parent, child]);
  assert.notEqual(parent.spec.worktreeInfo.branch, child.spec.worktreeInfo.branch);
  assert.equal(parent.spec.worktreeInfo.branch, "fix");
  assert.equal(child.spec.worktreeInfo.branch, "fix-cleanup");

  await git(["update-ref", "refs/remotes/origin/docs/guide", "HEAD"], repo);
  const remote = makeChild(14, repo, { branch: "docs/guide" }); await provision([remote]);
  assert.equal(remote.spec.worktreeInfo.branch, "docs/guide", "remote-tracking refs do not occupy local branch names");

  const pathRoot = join(root, "trees", "source"); await fs.mkdir(pathRoot, { recursive: true });
  await fs.mkdir(join(pathRoot, "path-collision"));
  const occupiedPath = makeChild(15, repo, { branch: "path-collision" }); await provision([occupiedPath]);
  assert.equal(occupiedPath.spec.worktreeInfo.branch, "path-collision-2");
}));

test("same-basename repositories sharing an aliased physical worktree root allocate distinct paths and leave sources unchanged", async () => fixture(async ({ root, agent }) => {
  async function makeRepository(path) {
    await fs.mkdir(path, { recursive: true });
    await git(["init", "-b", "main"], path); await git(["config", "user.email", "fixture@example.invalid"], path); await git(["config", "user.name", "Fixture"], path);
    await fs.writeFile(join(path, "tracked"), "original\n"); await git(["add", "."], path); await git(["commit", "-m", "fixture"], path);
    return path;
  }
  const physicalRoot = join(root, "shared-worktrees"), rootAlias = join(root, "shared-worktrees-alias");
  await fs.mkdir(physicalRoot); await fs.symlink(physicalRoot, rootAlias);
  await fs.writeFile(join(agent, "pi-worktree.json"), JSON.stringify({ worktreeRoot: rootAlias }));
  const firstRepo = await makeRepository(join(root, "first", "repository"));
  const secondRepo = await makeRepository(join(root, "second", "repository"));
  const first = makeChild(31, firstRepo), second = makeChild(32, secondRepo);
  first.spec.displayName = second.spec.displayName = "Shared Parser Review";
  await Promise.all([provision([first]), provision([second])]);
  assert.notEqual(first.spec.worktreeInfo.path, second.spec.worktreeInfo.path);
  assert.notEqual(first.spec.worktreeInfo.branch, second.spec.worktreeInfo.branch);
  assert.ok(first.spec.worktreeInfo.path.startsWith(join(physicalRoot, "repository") + "/"));
  assert.ok(second.spec.worktreeInfo.path.startsWith(join(physicalRoot, "repository") + "/"));
  for (const repo of [firstRepo, secondRepo]) {
    assert.equal((await git(["branch", "--show-current"], repo)).trim(), "main");
    assert.equal(await git(["status", "--porcelain"], repo), "");
  }
}));

test("cancelled repository-queue waiters preserve FIFO for later waiters", { timeout: 1000 }, async () => fixture(async () => {
  const events = [];
  let enterFirst, leaveFirst;
  const firstEntered = new Promise(resolve => { enterFirst = resolve; });
  const firstGate = new Promise(resolve => { leaveFirst = resolve; });
  const key = "repository:abort-order-fixture";
  const first = withRepositoryAllocations([key], undefined, async () => { events.push("first-enter"); enterFirst(); await firstGate; events.push("first-exit"); });
  await firstEntered;
  const controller = new AbortController();
  const cancelled = withRepositoryAllocations([key], controller.signal, async () => { events.push("cancelled-action"); });
  const third = withRepositoryAllocations([key], undefined, async () => { events.push("third-action"); });
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  assert.deepEqual(events, ["first-enter"], "neither cancelled nor later waiter may pass the holder");
  leaveFirst(); await Promise.all([first, third]);
  assert.deepEqual(events, ["first-enter", "first-exit", "third-action"]);
}));

test("same-name launches racing in one repository select distinct branches without stale prompt injection", async () => fixture(async ({ repo }) => {
  const first = makeChild(21, repo), second = makeChild(22, repo);
  first.spec.displayName = second.spec.displayName = "Shared Parser Review";
  await Promise.all([provision([first]), provision([second])]);
  assert.notEqual(first.spec.worktreeInfo.branch, second.spec.worktreeInfo.branch);
  assert.equal(new Set((await ownedWorktrees("owner")).map(row => row.branch)).size, 2);
  for (const child of [first, second]) {
    assert.equal((child.spec.systemPrompt.match(/\[Isolated worktree\]/g) ?? []).length, 1);
    assert.ok(child.spec.systemPrompt.includes(`Work in ${child.spec.worktreeInfo.path} on branch ${child.spec.worktreeInfo.branch}.`));
  }
}));

test("worktree context injection preserves user-authored prompt text exactly", async () => fixture(async ({ repo }) => {
  const child = makeChild(23, repo);
  const userPrompt = "User note: do not merge or remove them automatically. [Isolated worktree] is my literal text.";
  child.spec.systemPrompt = userPrompt;
  await provision([child]);
  assert.ok(child.spec.systemPrompt.startsWith(userPrompt));
  assert.equal((child.spec.systemPrompt.match(/\[Isolated worktree\]/g) ?? []).length, 2, "one user phrase and one injected section");
}));

test("a Git add failure after partial mutation retains its original failed record without retry", async () => fixture(async ({ repo, root }) => {
  const executable = process.env.PATH.split(":").map(path => join(path, "git"));
  let realGit;
  for (const path of executable) { try { await fs.access(path, 1); realGit = path; break; } catch {} }
  assert.ok(realGit, "test host has a real Git executable");
  const bin = join(root, "failure-bin"), wrapper = join(bin, "git"); await fs.mkdir(bin);
  await fs.writeFile(wrapper, `#!/bin/sh\ncase "$*" in *"worktree add"*)\n  "${realGit}" "$@"\n  exit 124\n  ;;\nesac\nexec "${realGit}" "$@"\n`);
  await fs.chmod(wrapper, 0o700);
  const originalPath = process.env.PATH; process.env.PATH = `${bin}:${originalPath}`;
  const child = makeChild(24, repo); child.spec.displayName = "Partial Git Failure";
  try {
    await assert.rejects(provision([child]), /124|failed|worktree/i);
  } finally { process.env.PATH = originalPath; }
  const record = (await ownedWorktrees("owner")).find(row => row.taskId === child.taskId);
  assert.ok(record); assert.equal(record.state, "failed");
  assert.equal(record.branch, "partial-git-failure");
  assert.equal(record.path, join(root, "trees", "source", "partial-git-failure"));
  assert.equal((await git(["branch", "--show-current"], record.path)).trim(), record.branch);
  const worktrees = await git(["worktree", "list", "--porcelain"], repo);
  assert.ok(worktrees.includes(`worktree ${record.path}`));
  assert.ok(worktrees.includes(`branch refs/heads/${record.branch}`));
  assert.equal((await git(["for-each-ref", "--format=%(refname:strip=2)", "refs/heads"], repo)).split(/\r?\n/).filter(Boolean).filter(name => name.startsWith("partial-git-failure")).length, 1);
}));

test("automatic repository provisioning preserves relative cwd and primary checkout; false permits non-Git", async () => fixture(async ({ repo, root }) => {
  const child = makeChild(1, join(repo, "sub")); await provision([child]);
  assert.notEqual(child.spec.cwd, join(repo, "sub")); assert.equal(child.spec.cwd, join(child.spec.worktreeInfo.path, "sub"));
  assert.equal((await git(["branch", "--show-current"], repo)).trim(), "main"); assert.equal(await git(["status", "--porcelain"], repo), "");
  assert.equal((await ownedWorktrees("owner")).length, 1);
  await provision([makeChild(2, root, false)]); const ordinary = makeChild(3, root); delete ordinary.spec.worktree; await provision([ordinary]);
  await assert.rejects(provision([makeChild(4, root)]), /requires a Git repository cwd.*worktree:false/);
}));

test("canonical source cwd and symlinked worktree root stay canonical through allocation", async () => fixture(async ({ repo, root, agent }) => {
  const actualRoot = join(root, "canonical-trees"), rootAlias = join(root, "trees-alias"), sourceAlias = join(root, "source-alias");
  await fs.mkdir(actualRoot); await fs.symlink(actualRoot, rootAlias); await fs.symlink(repo, sourceAlias);
  await fs.writeFile(join(agent, "pi-worktree.json"), JSON.stringify({ worktreeRoot: rootAlias }));
  const child = makeChild(16, join(sourceAlias, "sub")); await provision([child]);
  const record = (await ownedWorktrees("owner"))[0];
  assert.equal(record.path, await fs.realpath(record.path));
  assert.ok(record.path.startsWith(actualRoot + "/"));
  assert.equal(child.spec.cwd, join(record.path, "sub"));
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

test("replacement and resumed borrowers preserve dirty work and legacy pi branches across reload", async () => fixture(async ({ repo }) => {
  const creator = makeChild(1, repo); await provision([creator]); const path = creator.spec.worktreeInfo.path;
  const legacyBranch = "pi/legacy-resume";
  await git(["branch", "-m", creator.spec.worktreeInfo.branch, legacyBranch], path);
  const registered = (await ownedWorktrees("owner"))[0];
  await saveOwnedWorktree({ ...registered, branch: legacyBranch });
  creator.spec.worktreeInfo.branch = legacyBranch;
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
  assert.equal((await ownedWorktrees())[0].borrowers?.some(x => x.taskId === borrowed.taskId) ?? false, false, "repository preflight rejects before acquiring any borrower attachment");
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
