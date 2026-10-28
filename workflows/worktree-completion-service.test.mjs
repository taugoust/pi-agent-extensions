import { registerHooks } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const calls = [];
globalThis.__worktreeCompletionFixtureCalls = calls;
const seams = {
  "./worktree/completion.ts": "export async function completionFlow(ctx,action,task,reason,guard){guard();globalThis.__worktreeCompletionFixtureCalls.push({owner:ctx.sessionManager.getSessionId(),action,task,reason})}",
  "./worktree/repositories.js": "export async function workspaceRepositories(){return {roots:[],active:null,container:true}}",
  "../shared/subagent-worktrees.ts": "export async function ownedWorktrees(){return []};export async function worktreeGit(){return ''};export function recordedWorktreeOwner(){return undefined}",
  "../shared/harness-readonly.ts": "export function harnessReadOnlyRegistry(){return {}}",
  "../shared/goal-progress.ts": "export function readGoalTasks(){return []};export function addGoalTask(){}",
  "./goal/history.js": "export function readGoalHistory(){return []}",
  "./worktree/command.js": "export function addFlow(){};export function removeFlow(){};export function pruneFlow(){}",
  "./worktree/git.js": "export function currentWorktreePath(){};export async function listWorktrees(){return []};export function runGit(){};export const pathsEqual=(a,b)=>a===b;export const pathIdentity=x=>x;export const stripTerminalControls=x=>x",
  "./goal/runtime.js": "export function createGoal(){throw Error('Goal forbidden')};export function transitionGoal(){throw Error('Goal forbidden')}",
  "./goal/accounting.js": "export function currentTokenTotal(){return 0}",
};
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith("/workflows/service.ts") && seams[specifier]) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(seams[specifier])}` };
  return next(specifier, context);
} });
const { createWorkflowService } = await import("./service.ts");
test("owner-session service exposes task completion and cleanup, rejects forged owner/path/profile fields", async () => {
  const root = mkdtempSync(join(tmpdir(), "completion-service-fixture-"));
  process.env.PI_DELEGATED_GOALS_STATE_ROOT = root;
  const owner = randomUUID(), task = "subagent-task-" + "a".repeat(24);
  const ctx = { cwd: root, isIdle: () => true, hasPendingMessages: () => false, ui: { setStatus() {} }, sessionManager: { getSessionId: () => owner, getLeafId: () => "leaf", getBranch: () => [], getEntries: () => [] } };
  const runtime = { activeGoal: null, snapshotSettingsApplicationState: () => ({}), settings: { continuationLimits: { automaticTurns: null, noProgressTurns: null } } };
  const service = createWorkflowService({}, ctx, runtime, {}, { get: () => ({}) }, () => false);
  const request = data => service.handle({ sessionId: owner, serviceEpoch: service.serviceEpoch, requestId: randomUUID(), operation: "start", ...data });
  try {
    const snapshot = await service.handle({ sessionId: owner, serviceEpoch: service.serviceEpoch, operation: "snapshot" });
    assert.equal(snapshot.capabilities.ownedWorktreeCompletion, true);
    assert.deepEqual(snapshot.worktreeCompletions, []);
    assert.equal(snapshot.worktreeCompletionError, null);
    for (const extra of [{ ownerSessionId: "forged" }, { profile: "coordinator" }, { path: root }]) await assert.rejects(request({ action: "worktree.complete", taskId: task, reason: "Reviewed", ...extra }), /Unknown|task ID/);
    await assert.rejects(request({ action: "worktree.complete", taskId: task }), /rationale/);
    await request({ action: "worktree.complete", taskId: task, reason: "Reviewed" });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls[0], { owner, action: "complete", task, reason: "Reviewed" });
    await request({ action: "worktree.cleanup", taskId: task });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(calls[1], { owner, action: "cleanup", task, reason: undefined });
    await assert.rejects(service.handle({ sessionId: "foreign", serviceEpoch: service.serviceEpoch, operation: "snapshot" }), /Stale workflow identity/);
    assert.equal(runtime.activeGoal, null);
  } finally { service.dispose(); delete process.env.PI_DELEGATED_GOALS_STATE_ROOT; delete globalThis.__worktreeCompletionFixtureCalls; rmSync(root, { recursive: true, force: true }); }
});
