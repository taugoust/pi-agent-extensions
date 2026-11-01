import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
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
  const manager: any = new TuiNativeManager(root, () => "native", () => false, 16);
  const owner = "current-owner", externalOwner = "external-owner", c = child(root, "g", true), external = child(root, "i", true);
  c.spec.cwd = external.spec.cwd = join(root, "coordinator-checkout");
  const group: any = { id: `subagent-job-${"h".repeat(24)}`, owner, children: [c] };
  const externalGroup: any = { id: `subagent-job-${"j".repeat(24)}`, owner: externalOwner, children: [external] };
  manager.owner = owner; manager.reapReserved = true; manager.groups.set(group.id, group); manager.groups.set(externalGroup.id, externalGroup);
  manager.observe = async (_g: any, observed: any) => { observed.observationError = undefined; };
  const justReaped = { ownerSessionId: owner, taskId: c.taskId, childId: c.childId, attempt: c.attempt };
  try {
    assert.equal(await manager.worktreeReapActivity(owner, c.spec.cwd, justReaped), true, "the exactly reaped coordinator is excluded while an external managed worker remains");
    external.reaped = true;
    assert.equal(await manager.worktreeReapActivity(owner, c.spec.cwd, justReaped), false, "verified reaping releases the external managed activity");
    external.reaped = false;
    manager.observe = async (_g: any, observed: any) => { observed.observationError = "controller unavailable"; };
    await assert.rejects(manager.worktreeReapActivity(owner, c.spec.cwd, justReaped), /Managed worker activity is unavailable/);
  } finally {
    manager.reapReserved = false;
    await manager.shutdown(false);
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
