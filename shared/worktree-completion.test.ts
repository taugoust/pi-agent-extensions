import test from "node:test";
import assert from "node:assert/strict";
import { markWorktreeComplete, cleanupCompletedWorktree, type CompletionHost, type CompletionInspection, type WorktreeCompletion } from "./worktree-completion.ts";
function fixture() {
  let marker: WorktreeCompletion | undefined;
  let removed = 0, deleted = 0;
  const state: CompletionInspection = { owned: true, released: true, retained: false, active: false, remainingFiles: false, identityChanged: false, worktreeExists: true, branchOid: "a".repeat(40) };
  const host: CompletionHost = {
    exclusive: async (_o, _t, action) => action(), authorize: async () => ({ ownerSessionId: "owner", actorSessionId: "coordinator" }),
    load: async () => marker && structuredClone(marker), save: async value => { marker = structuredClone(value); },
    inspect: async () => ({ ...state }),
    removeWorktree: async () => { removed++; state.worktreeExists = false; },
    deleteBranch: async (_o, _t, oid) => { assert.equal(state.branchOid, oid); deleted++; state.branchOid = undefined; },
  };
  return { host, state, counts: () => ({ removed, deleted }), marker: () => marker };
}
test("explicit completion is required and completion alone never deletes", async () => {
  const f = fixture();
  await assert.rejects(cleanupCompletedWorktree(f.host, "task"), /Explicit completion/);
  const first = await markWorktreeComplete(f.host, "task", "Reviewed outcome");
  f.state.branchOid = "b".repeat(40);
  assert.deepEqual(await markWorktreeComplete(f.host, "task", "again"), first);
  assert.deepEqual(f.counts(), { removed: 0, deleted: 0 });
  assert.match((await cleanupCompletedWorktree(f.host, "task")).blockedReason!, /Branch advanced/);
});
test("cleanup is ordered, durable and idempotent", async () => {
  const f = fixture(); await markWorktreeComplete(f.host, "task", "Reviewed");
  const remove = f.host.removeWorktree;
  f.host.removeWorktree = async (...args) => { assert.equal(f.marker()?.phase, "removal-pending"); await remove(...args); };
  assert.equal((await cleanupCompletedWorktree(f.host, "task")).phase, "cleaned");
  await cleanupCompletedWorktree(f.host, "task");
  assert.deepEqual(f.counts(), { removed: 1, deleted: 1 });
});
for (const key of ["retained", "active", "remainingFiles", "identityChanged"] as const) {
  test(`${key} blocks cleanup without losing completion`, async () => {
    const f = fixture(); await markWorktreeComplete(f.host, "task", "Reviewed"); f.state[key] = true;
    const result = await cleanupCompletedWorktree(f.host, "task");
    assert.equal(result.phase, "marked"); assert.ok(result.blockedReason);
    assert.deepEqual(f.counts(), { removed: 0, deleted: 0 });
  });
}
test("activity arising during durable intent write blocks removal", async () => {
  const f = fixture(); await markWorktreeComplete(f.host, "task", "Reviewed");
  const save = f.host.save; f.host.save = async m => { await save(m); if (m.phase === "removal-pending") f.state.active = true; };
  assert.match((await cleanupCompletedWorktree(f.host, "task")).blockedReason!, /using/);
  assert.equal(f.counts().removed, 0);
});
test("failure after removal retains recoverable metadata and retries branch deletion", async () => {
  const f = fixture(); await markWorktreeComplete(f.host, "task", "Reviewed");
  const save = f.host.save; let fail = true;
  f.host.save = async m => { if (m.phase === "worktree-removed" && fail) { fail = false; throw new Error("disk failure"); } await save(m); };
  assert.match((await cleanupCompletedWorktree(f.host, "task")).blockedReason!, /disk failure/);
  assert.equal((await cleanupCompletedWorktree(f.host, "task")).phase, "cleaned");
  assert.deepEqual(f.counts(), { removed: 1, deleted: 1 });
});
test("path reuse after removal blocks deletion", async () => {
  const f = fixture(); await markWorktreeComplete(f.host, "task", "Reviewed");
  f.host.removeWorktree = async () => { f.state.worktreeExists = true; };
  assert.match((await cleanupCompletedWorktree(f.host, "task")).blockedReason!, /reused/);
  assert.equal(f.counts().deleted, 0);
});
