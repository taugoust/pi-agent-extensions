import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TuiNativeManager } from "./tui-native.ts";
import { TuiWorkerStore } from "./tui-worker-store.ts";

function child(root: string, id: string, cleanupWorktreesOnReap: boolean, attempt = 1) {
  return { childId: `subagent-child-${id.repeat(24)}`, taskId: `subagent-task-${id.repeat(24)}`, attempt,
    directory: join(root, id), spec: { task: id, cwd: root, ...(cleanupWorktreesOnReap ? { cleanupWorktreesOnReap: true } : {}) },
    state: "completed", reaped: false, started: true };
}

test("manager attributes before-remove cleanup only to the opted-in worker and retains it on failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "worktree-reap-manager-"));
  const manager: any = new TuiNativeManager(root, () => "native", () => false, 16);
  const owner = "parent", opted = child(root, "a", true), ordinary = child(root, "b", false);
  const group: any = { id: `subagent-job-${"c".repeat(24)}`, owner, children: [opted, ordinary] };
  const manifests = new Map([opted, ordinary].map(c => [c.childId, {
    ownerSessionId: owner, taskId: c.taskId, childId: c.childId, attempt: c.attempt,
    ...(c.spec.cleanupWorktreesOnReap ? { cleanupWorktreesOnReap: true } : {}),
  }]));
  const callbacks: any[] = [], failures = new Set<string>();
  manager.manifest = (c: any) => manifests.get(c.childId);
  manager.reconcileWorktrees = async (g: any, c: any, options: any) => {
    callbacks.push({ group: g.id, child: c.childId, options });
    if (failures.has(c.childId)) throw new Error("registry cleanup blocked");
  };
  manager.tmux.reap = async (manifest: any, _timeout: unknown, options: any) => {
    if (manifest.cleanupWorktreesOnReap === true) {
      assert.equal(typeof options.beforeRemove, "function");
      await options.beforeRemove();
    } else assert.equal(options.beforeRemove, undefined, "non-opted worker has no policy callback");
  };
  manager.save = () => {};
  manager.owner = owner;
  try {
    await manager.reapChild(group, opted, { force: true, reason: "test force" });
    await manager.reapChild(group, ordinary);
    assert.deepEqual(callbacks, [{ group: group.id, child: opted.childId, options: { force: true, reason: "test force" } }]);
    assert.equal(opted.reaped, true);
    assert.equal(ordinary.reaped, true);
    assert.equal(Object.hasOwn(manifests.get(ordinary.childId)!, "cleanupWorktreesOnReap"), false, "ordinary worker gets no injected policy field");

    const blocked = child(root, "d", true);
    manifests.set(blocked.childId, { ownerSessionId: owner, taskId: blocked.taskId, childId: blocked.childId, attempt: blocked.attempt, cleanupWorktreesOnReap: true });
    failures.add(blocked.childId);
    await assert.rejects(manager.reapChild(group, blocked, { force: true, reason: "still required" }), /registry cleanup blocked/);
    assert.equal(blocked.reaped, false, "failed cleanup must not mark the worker reaped");
  } finally {
    await manager.shutdown(false);
    await rm(root, { recursive: true, force: true });
  }
});

test("retained manifest/spec policy disagreement cannot silently opt out of cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "worktree-reap-policy-mismatch-"));
  const manager: any = new TuiNativeManager(root, () => "native", () => false, 16);
  const c = child(root, "a", false), store = new TuiWorkerStore(c.directory, true);
  store.writeManifest({ protocol: 1, ownerSessionId: "parent", taskId: c.taskId, childId: c.childId,
    groupId: `subagent-job-${"c".repeat(24)}`, attempt: 1, runtimeId: "fixture", workerEpoch: "a".repeat(32),
    controlToken: "a".repeat(64), controlSocket: join(c.directory, "control.sock"), sessionFile: join(c.directory, "session.jsonl"),
    cleanupWorktreesOnReap: true, presentation: "background", placement: { socketPath: "/tmp/fixture", serverEpoch: "1:2",
      sessionId: "$1", windowId: "@1", paneId: "%1", ownershipNonce: "a".repeat(64) } });
  try { assert.throws(() => manager.manifest(c), /trusted reap policy mismatch/); }
  finally { await manager.shutdown(false); await rm(root, { recursive: true, force: true }); }
});

test("managed activity observes known external workers sharing a coordinator checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "worktree-reap-managed-activity-"));
  let manager: any = new TuiNativeManager(root, () => "native", () => false, 16);
  const initialManager = manager;
  const owner = "current-owner", externalOwner = "external-owner", c = child(root, "a", true), external = child(root, "b", true);
  const checkout = join(root, "coordinator-checkout"), alias = join(root, "checkout-alias"), retarget = join(root, "retargeted-checkout");
  const unrelated = join(root, "unrelated-checkout"), loop = join(root, "checkout-loop");
  await mkdir(checkout); await mkdir(retarget); await mkdir(unrelated); await symlink(checkout, alias); await symlink(loop, loop);
  c.directory = join(root, "workers", "1".repeat(24)); c.operatorCapability = "1".repeat(64);
  external.directory = join(root, "workers", "2".repeat(24)); external.operatorCapability = "2".repeat(64);
  c.spec.cwd = checkout; external.spec.cwd = alias; external.spec.worktreeInfo = { path: checkout, branch: "pi/worker", baseCommit: "a".repeat(40), includedChanges: false };
  external.activityCwd = checkout; external.state = "running";
  const group: any = { version: 1, id: `subagent-job-${"c".repeat(24)}`, owner, children: [c] };
  const externalGroup: any = { version: 1, id: `subagent-job-${"d".repeat(24)}`, owner: externalOwner, children: [external] };
  manager.groups.set(group.id, group); manager.groups.set(externalGroup.id, externalGroup);
  manager.save(group); manager.save(externalGroup);
  manager = new TuiNativeManager(root, () => "native", () => false, 16);
  manager.owner = owner; manager.reapReserved = true;
  const tracked: any = manager.groups.get(externalGroup.id).children[0];
  let legacySession = false;
  manager.manifest = (observed: any) => {
    const found = [...manager.groups.values()].find((candidate: any) => candidate.children.includes(observed));
    return observed.activityCwd || legacySession ? { ownerSessionId: found.owner, groupId: found.id, taskId: observed.taskId, childId: observed.childId,
      attempt: observed.attempt, activityCwd: observed.activityCwd, sessionFile: join(observed.directory, "session.jsonl") } : undefined;
  };
  manager.observe = async (_g: any, observed: any) => { observed.observationError = undefined; };
  const justReaped = { ownerSessionId: owner, taskId: c.taskId, childId: c.childId, attempt: c.attempt };
  try {
    assert.equal(await manager.worktreeReapActivity(owner, checkout, justReaped), true, "launch-time identity detects a stable managed symlink alias");
    await unlink(alias); await symlink(retarget, alias);
    assert.equal(await manager.worktreeReapActivity(owner, checkout, justReaped), true, "retargeting the lexical alias cannot hide the launch-time checkout");
    assert.equal(await manager.worktreeReapActivity(owner, retarget, justReaped), false, "retargeting does not move the authenticated worker identity");
    tracked.activityCwd = join(checkout, "missing-checkout");
    await assert.rejects(manager.worktreeReapActivity(owner, checkout, justReaped), /Managed worker physical checkout identity is unavailable/);
    tracked.activityCwd = undefined;
    await assert.rejects(manager.worktreeReapActivity(owner, checkout, justReaped), /launch-time checkout identity unavailable/);
    legacySession = true;
    await mkdir(tracked.directory, { recursive: true, mode: 0o700 });
    const sessionFile = join(tracked.directory, "session.jsonl");
    const header = (cwd: string) => JSON.stringify({ type: "session", id: "legacy-worker-session", cwd }) + "\n";
    await writeFile(sessionFile, header(checkout), { mode: 0o600 });
    tracked.spec.cwd = checkout;
    assert.equal(await manager.worktreeReapActivity(owner, checkout, justReaped), true, "legacy physical session cwd still detects relevant active workers");
    tracked.resumeSessionFile = sessionFile;
    await assert.rejects(manager.worktreeReapActivity(owner, checkout, justReaped), /launch-time checkout identity unavailable/, "resumed legacy header cannot attest a new launch cwd");
    delete tracked.resumeSessionFile;
    tracked.spec.cwd = alias;
    await assert.rejects(manager.worktreeReapActivity(owner, checkout, justReaped), /launch-time checkout identity unavailable/, "lexical symlink is not substituted for physical session identity");
    tracked.spec.cwd = join(root, "removed-legacy-checkout");
    await writeFile(sessionFile, header(tracked.spec.cwd));
    assert.equal(await manager.worktreeReapActivity(owner, checkout, justReaped), false, "unrelated removed legacy checkout does not block cleanup");
    await writeFile(sessionFile, "invalid session header\n");
    await assert.rejects(manager.worktreeReapActivity(owner, checkout, justReaped), /launch-time checkout identity unavailable/);
    legacySession = false;
    tracked.activityCwd = unrelated; tracked.spec.cwd = unrelated;
    assert.equal(await manager.worktreeReapActivity(owner, checkout, justReaped), false, "an unrelated active managed checkout does not block");
    tracked.reaped = true;
    tracked.state = "completed";
    tracked.spec.cwd = join(root, "removed-worktree");
    assert.equal(await manager.worktreeReapActivity(owner, checkout, justReaped), false, "a fully reaped removed-worktree record does not block");
    tracked.reaped = false;
    tracked.activityCwd = checkout;
    tracked.spec.cwd = alias;
    manager.observe = async (_g: any, observed: any) => { observed.observationError = "controller unavailable"; };
    await assert.rejects(manager.worktreeReapActivity(owner, checkout, justReaped), /Managed worker activity is unavailable/);
  } finally {
    manager.reapReserved = false;
    await manager.shutdown(false);
    await initialManager.shutdown(false);
    await rm(root, { recursive: true, force: true });
  }
});

test("reserved manager target projection is exact and emits no profile policy fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "worktree-reap-targets-"));
  const manager: any = new TuiNativeManager(root, () => "native", () => false, 16);
  const owner = "parent";
  const current = child(root, "e", true, 2);
  const stale = child(root, "e", false, 1);
  const group: any = { id: `subagent-job-${"f".repeat(24)}`, owner, children: [stale, current] };
  manager.owner = owner;
  manager.groups.set(group.id, group);
  manager.descendantGroups = () => [];
  try {
    assert.throws(() => manager.worktreeReapTargets(owner), /reservation/);
    manager.reapReserved = true;
    const targets = manager.worktreeReapTargets(owner);
    assert.deepEqual(targets, [{ ownerSessionId: owner, taskId: current.taskId, childId: current.childId, reaped: false, attempt: 2 }]);
    assert.deepEqual(Object.keys(targets[0]).sort(), ["attempt", "childId", "ownerSessionId", "reaped", "taskId"]);
    current.reaped = true;
    assert.equal(manager.worktreeReapTargets(owner)[0].reaped, true);
    current.state = "running";
    assert.equal(manager.worktreeReapTargets(owner)[0].reaped, false, "active child is never reported reaped");
  } finally {
    manager.reapReserved = false;
    await manager.shutdown(false);
    await rm(root, { recursive: true, force: true });
  }
});
