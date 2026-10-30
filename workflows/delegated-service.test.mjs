import { registerHooks } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Real service and registry; narrow dependency seams isolate filesystem inventories,
// legacy goal commands and SDK types. No Pi process, provider or child is launched.
const seams = {
  "./worktree/repositories.js": "export async function workspaceRepositories(){return {roots:[],active:null,container:true}}",
  "../shared/subagent-worktrees.ts": "export function recordedWorktreeOwner(){}; export async function ownedWorktrees(){return []}; export async function worktreeGit(){return {stdout:''}}",
  "../shared/harness-readonly.ts": "export function harnessReadOnlyRegistry(){return {}}",
  "../shared/goal-progress.ts": "export function readGoalTasks(){return []};export function addGoalTask(){throw Error('legacy mutation forbidden')}",
  "./goal/history.js": "export function readGoalHistory(){return []}",
  "./worktree/command.js": "export function addFlow(){};export function removeFlow(){};export function pruneFlow(){}",
  "./worktree/git.js": "export function currentWorktreePath(){};export async function listWorktrees(){return []};export function runGit(){};export const pathsEqual=(a,b)=>a===b;export const pathIdentity=x=>x;export const stripTerminalControls=x=>x",
  "./goal/runtime.js": "export function createGoal(){throw Error('parent execution forbidden')};export function transitionGoal(){throw Error('parent execution forbidden')}",
  "./goal/accounting.js": "export function currentTokenTotal(){return 0}",
};
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith("/workflows/delegated-child.ts") && specifier === "../shared/goal-progress.ts") return { url: `data:text/javascript,${encodeURIComponent("export function readGoalTasks(ctx,goal){return goal.testTasks??[]};export function writeProgress(pi,ctx,tasks,id){pi.appendEntry('progress-fixture',{tasks,id})}")}`, shortCircuit: true };
  if (context.parentURL?.endsWith("/workflows/service.ts") && seams[specifier]) return { url: `data:text/javascript,${encodeURIComponent(seams[specifier])}`, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { createWorkflowService } = await import("./service.ts");

test("actual service permits busy parent metadata create and fences independent confirmed child actions", async () => {
  const root = mkdtempSync(join(tmpdir(), "delegated-service-"));
  const previous = process.env.PI_DELEGATED_GOALS_STATE_ROOT;
  process.env.PI_DELEGATED_GOALS_STATE_ROOT = root;
  let service;
  try {
    const calls = [], sessionId = randomUUID();
    const runtime = { activeGoal: { id: "legacy", text: "legacy untouched", status: "active", tokensUsed: 0 },
      snapshotSettingsApplicationState: () => ({}), settings: { continuationLimits: { automaticTurns: null, noProgressTurns: null } } };
    const originalGoal = structuredClone(runtime.activeGoal);
    const ctx = { cwd: root, isIdle: () => false, hasPendingMessages: () => true,
      sessionManager: { getSessionId: () => sessionId, getLeafId: () => "leaf", getBranch: () => [], getEntries: () => [] },
      ui: { setStatus() {} }, model: null };
    const pi = { appendEntry() { throw Error("Parent session mutation forbidden"); }, exec: async () => ({ code: 0, stdout: "", stderr: "" }) };
    globalThis.__paeDelegatedGoalExecutorV1 = { protocol: 1, sessionId,
      executionAvailable: () => true,
      async reviewRoot() { return root; },
      executionUnavailableReason: () => "Required child lifecycle tools denied by effective allowlist",
      async start(entry) { calls.push(`start:${entry.id}`); return { taskId: `task:${entry.id}`, childId: `child:${entry.id}:1`, jobId: `job:${entry.id}:1`, attempt: 1 }; },
      async pause(entry) { calls.push(`pause:${entry.id}`); },
      async resume(entry) { calls.push(`resume:${entry.id}`); return { ...entry.child, childId: `child:${entry.id}:2`, jobId: `job:${entry.id}:2`, attempt: 2 }; },
    };
    service = createWorkflowService(pi, ctx, runtime, {}, { get: () => ({}) }, () => true);
    const identity = { sessionId, serviceEpoch: service.serviceEpoch };
    const request = data => service.handle({ ...identity, requestId: randomUUID(), operation: "start", ...data });
    const snap = () => service.handle({ ...identity, operation: "snapshot" });
    let snapshot = await request({ action: "goals.create", expectedGoalId: null, expectedRegistryRevision: 0, objective: "first" });
    snapshot = await request({ action: "goals.create", expectedGoalId: null, expectedRegistryRevision: 1, objective: "second" });
    assert.equal(snapshot.delegatedGoals.entries.length, 2); assert.deepEqual(calls, []);
    assert.deepEqual(runtime.activeGoal, originalGoal); assert.equal(snapshot.idle, false);
    assert.deepEqual(snapshot.limits, { automaticTurns: null, noProgressTurns: null });
    let first = snapshot.delegatedGoals.entries[0];
    const second = snapshot.delegatedGoals.entries[1];
    snapshot = await request({ action: "goals.add_task", expectedGoalId: second.id, expectedEntryRevision: second.revision, text: "  keep exact task  " });
    const afterAdd = structuredClone(snapshot.delegatedGoals);
    const duplicate = { ...identity, requestId: randomUUID(), operation: "start", action: "goals.add_task", expectedGoalId: second.id, expectedEntryRevision: snapshot.delegatedGoals.entries[1].revision, text: "keep exact task" };
    await assert.rejects(service.handle(duplicate), /distinct descriptions/);
    await assert.rejects(service.handle(duplicate), /distinct descriptions/); // replay must retain rejection, never snapshot-as-success
    const staleEdit = { ...identity, requestId: randomUUID(), operation: "start", action: "goals.edit", expectedGoalId: first.id, expectedEntryRevision: first.revision + 99, objective: "must not apply" };
    await assert.rejects(service.handle(staleEdit), /revision/);
    await assert.rejects(service.handle(staleEdit), /revision/);
    snapshot = await snap(); assert.deepEqual(snapshot.delegatedGoals, afterAdd);
    snapshot = await request({action:"goals.add_task",expectedGoalId:second.id,expectedEntryRevision:snapshot.delegatedGoals.entries[1].revision,text:"Second planned task"});
    const plannedTasks=snapshot.delegatedGoals.entries[1].tasks;
    snapshot = await request({action:"goals.dependencies",expectedGoalId:second.id,expectedEntryRevision:snapshot.delegatedGoals.entries[1].revision,taskId:plannedTasks[1].id,waitsFor:[plannedTasks[0].id]});
    assert.equal(snapshot.capabilities.goalPlanning,true);assert.deepEqual(snapshot.delegatedGoals.entries[1].planning.dependencies,[{taskId:plannedTasks[1].id,waitsFor:[plannedTasks[0].id]}]);
    snapshot = await request({action:"goals.blocker.add",expectedGoalId:second.id,expectedEntryRevision:snapshot.delegatedGoals.entries[1].revision,blockerReason:"External service",blockerEvidence:"Recorded service failure"});
    const recorded=snapshot.delegatedGoals.entries[1].planning.blockers[0];
    snapshot = await request({action:"goals.blocker.clear",expectedGoalId:second.id,expectedEntryRevision:snapshot.delegatedGoals.entries[1].revision,blockerId:recorded.id});
    assert.equal(snapshot.delegatedGoals.entries[1].planning.blockers[0].evidence,"Recorded service failure");assert.ok(snapshot.delegatedGoals.entries[1].planning.blockers[0].clearedAt);assert.equal(snapshot.delegatedGoals.entries[1].status,"paused");assert.deepEqual(snapshot.delegatedGoals.entries[1].tasks,plannedTasks);
    assert.equal(snapshot.operationId, null); assert.equal(snapshot.notice, null); assert.deepEqual(calls, []);
    assert.ok(!readdirSync(root).some(name => name.endsWith(".intent")));
    globalThis.__paeDelegatedGoalExecutorV1.executionAvailable = () => false;
    snapshot = await snap();
    assert.equal(snapshot.capabilities.delegatedGoalExecution, false);
    assert.match(snapshot.notice, /tools denied/);
    snapshot = await request({ action: "goals.start", expectedGoalId: first.id, expectedEntryRevision: first.revision });
    assert.equal(snapshot.dialog, null); assert.deepEqual(calls, []);
    globalThis.__paeDelegatedGoalExecutorV1.executionAvailable = () => true;
    snapshot = await request({ action: "goals.start", expectedGoalId: first.id, expectedEntryRevision: first.revision });
    assert.equal(snapshot.dialog.kind, "confirm");
    assert.match(snapshot.dialog.message, /gpt-6\.1-sol/); assert.match(snapshot.dialog.message, /Workspace:/);
    assert.match(snapshot.dialog.message, /Dedicated automatic limit: unlimited/); assert.match(snapshot.dialog.message, /Dedicated no-progress limit: unlimited/);
    assert.deepEqual(calls, []);
    await service.handle({ ...identity, requestId: randomUUID(), operation: "send", operationId: snapshot.operationId, dialogId: snapshot.dialog.id, value: true });
    // Microtask-only deterministic drain: no polling timers or model calls.
    for (let i = 0; i < 20 && (await snap()).operationId; i++) await Promise.resolve();
    snapshot = await snap(); first = snapshot.delegatedGoals.entries[0];
    assert.equal(first.status, "active"); assert.equal(calls.length, 1);
    assert.equal(snapshot.delegatedGoals.entries[1].status, "paused");
    writeFileSync(join(root,"spec.md"),"Explicit registered source");
    snapshot = await request({ action: "goals.reference", expectedGoalId: first.id, expectedEntryRevision: first.revision, reviewTitle: "Spec", reviewTarget: "spec.md", reviewRole: "source" });
    first = snapshot.delegatedGoals.entries[0];
    const previewRequest = { ...identity, operation: "review", expectedGoalId: first.id, expectedEntryRevision: first.revision, referenceId: first.review[0].id };
    assert.deepEqual((await service.handle(previewRequest)).preview,{kind:"text",text:"Explicit registered source"});
    await assert.rejects(service.handle({...previewRequest,path:"/etc/passwd"}),/fields/);
    await assert.rejects(service.handle({...previewRequest,expectedEntryRevision:first.revision-1}),/changed/);
    await assert.rejects(service.handle({...previewRequest,referenceId:randomUUID()}),/unavailable/);
    writeFileSync(join(root,"spec.md"),"Changed source");await assert.rejects(service.handle(previewRequest),/changed/);
    assert.equal(calls.length,1,"review must not launch, resume, prompt or pause execution");
    await assert.rejects(service.handle({ ...identity, serviceEpoch: randomUUID(), operation: "snapshot" }), /Stale/);
    await assert.rejects(request({ action: "goals.pause", expectedGoalId: first.id, expectedEntryRevision: 0 }), /revision/);
    await assert.rejects(request({ action: "goal.start", expectedGoalId: "legacy", objective: "forbidden" }), /busy|read-only/);
    assert.deepEqual(runtime.activeGoal, originalGoal);
    await request({ action: "goals.pause", expectedGoalId: first.id, expectedEntryRevision: first.revision });
    for (let i = 0; i < 20 && (await snap()).operationId; i++) await Promise.resolve();
    snapshot = await snap(); const paused = snapshot.delegatedGoals.entries[0];
    assert.equal(paused.status, "paused");
    const unverifiableClear = { ...identity, requestId: randomUUID(), operation: "start", action: "goals.clear", expectedGoalId: paused.id, expectedEntryRevision: paused.revision };
    await assert.rejects(service.handle(unverifiableClear), /stop verification is unavailable/);
    await assert.rejects(service.handle(unverifiableClear), /stop verification is unavailable/);
    assert.equal((await snap()).delegatedGoals.entries[0].status, "paused");
    const clearSecond = snapshot.delegatedGoals.entries[1];
    snapshot = await request({ action: "goals.clear", expectedGoalId: clearSecond.id, expectedEntryRevision: clearSecond.revision });
    assert.equal(snapshot.delegatedGoals.entries[1].status, "cleared"); assert.equal(snapshot.operationId, null);
    assert.ok(!readdirSync(root).some(name => name.endsWith(".intent")));
    service.dispose(); service = createWorkflowService(pi, ctx, runtime, {}, { get: () => ({}) }, () => true);
    const restored = await service.handle({ operation: "snapshot", sessionId, serviceEpoch: service.serviceEpoch });
    assert.equal(restored.delegatedGoals.entries.length, 2); assert.equal(restored.delegatedGoals.entries[0].child.taskId, first.child.taskId);
  } finally {
    service?.dispose(); delete globalThis.__paeDelegatedGoalExecutorV1;
    if (previous === undefined) delete process.env.PI_DELEGATED_GOALS_STATE_ROOT; else process.env.PI_DELEGATED_GOALS_STATE_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("assigned limits API is available while busy and fences identity, revision, extra fields and replays", async () => {
  const root = mkdtempSync(join(tmpdir(), "assigned-limit-service-")), previous = process.env.PI_DELEGATED_GOALS_STATE_ROOT;
  process.env.PI_DELEGATED_GOALS_STATE_ROOT = root;
  let service;
  try {
    const sessionId = randomUUID(), calls = [];
    const runtime = { activeGoal: { id: "assigned", activationId: "assigned-activation", revision: 7, text: "Keep objective", status: "active", tokensUsed: 50 }, policyRevision: 4,
      continuationLimits: { automaticTurns: 8, noProgressTurns: 3 }, settings: { continuationLimits: { automaticTurns: null, noProgressTurns: null } },
      snapshotSettingsApplicationState: () => ({}),
      updateGoalLimits(ctx, id, revision, budget, limits) {
        if (id !== this.activeGoal.id || revision !== this.policyRevision) throw Error("Goal identity or policy revision changed");
        calls.push({ id, revision, budget, limits }); this.policyRevision++;
      } };
    const ctx = { cwd: root, isIdle: () => false, hasPendingMessages: () => true, ui: { setStatus() {} }, model: null,
      sessionManager: { getSessionId: () => sessionId, getBranch: () => [], getEntries: () => [], getLeafId: () => "leaf" } };
    service = createWorkflowService({ appendEntry() { throw Error("No direct session mutation"); }, exec: async () => ({ code: 0, stdout: "" }) }, ctx, runtime, {}, { get: () => ({}) }, () => true);
    const request = { operation: "start", sessionId, serviceEpoch: service.serviceEpoch, requestId: randomUUID(), action: "goal.limits",
      expectedGoalId: "assigned", expectedActivationId: "assigned-activation", expectedPolicyRevision: 4, tokenBudget: null, continuationLimits: { automaticTurns: 5, noProgressTurns: null } };
    await assert.rejects(service.handle({ ...request, serviceEpoch: randomUUID() }), /Stale/);
    await assert.rejects(service.handle({ ...request, objective: "not allowed" }), /Invalid/);
    await assert.rejects(service.handle({ ...request, expectedActivationId: "stale" }), /activation changed/);
    await assert.rejects(service.handle({ ...request, expectedPolicyRevision: 3 }), /revision changed/);
    const snapshot = await service.handle(request);
    assert.equal(snapshot.capabilities.goalLimitEditing, true); assert.equal(snapshot.goal.policyRevision, 5);
    assert.deepEqual(snapshot.goal.effectiveLimits, runtime.continuationLimits);
    assert.equal(calls.length, 1); assert.equal(calls[0].budget, null);
    await service.handle(request); assert.equal(calls.length, 1);
    await assert.rejects(service.handle({ ...request, requestId: randomUUID() }), /revision changed/);
    await assert.rejects(service.handle({ ...request, tokenBudget: 100 }), /Request ID conflict/);
  } finally {
    service?.dispose();
    if (previous === undefined) delete process.env.PI_DELEGATED_GOALS_STATE_ROOT; else process.env.PI_DELEGATED_GOALS_STATE_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
