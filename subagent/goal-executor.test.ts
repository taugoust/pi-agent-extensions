import assert from "node:assert/strict";
import { test } from "node:test";
import { createDelegatedGoalExecutor, type GoalChildHandle } from "./goal-executor.ts";
import type { DelegatedGoalEntry } from "../workflows/delegated-goals.ts";
import { createGoalQuestions } from "../workflows/goal-questions.ts";
const entry = (id: string): DelegatedGoalEntry => ({ id, revision: 1, text: id, status: "paused", tasks: [], child: null, tokenBudget: null, tokensUsed: 0, automaticTurns: 0, noProgressTurns: 0, summary: null, waiting: null });
for (const stoppedStatus of ["blocked", "usage_limited", "budget_limited", "complete"] as const) test(`automatic ${stoppedStatus} stop captures actual question cancellation before teardown`, async () => {
  const questions = createGoalQuestions("e", "epoch", [], () => {});
  const pending = questions.request({ kind: "questionnaire", questions: [{ id: "q", prompt: "Choose", options: [{ value: "a", label: "A" }], allowOther: false }] });
  const rejected = assert.rejects(pending, /cancelled/);
  let status: "active" | typeof stoppedStatus = "active", stopped = false;
  const snapshot = () => ({ goalId: "g", activationId: "activation", status, executionStopped: status !== "active", waiting: null, story: { version: 1 as const, timeline: [], activity: [], questions: questions.snapshot() } });
  const executor = createDelegatedGoalExecutor({ sessionId: "s", runtimeId: "r", async launch() {
    return { identity: { sessionId: "s", runtimeId: "r", taskId: "task", childId: "child", jobId: "job", attempt: 1, workerEpoch: "epoch" }, model: "actual", start: async () => snapshot(), resume: async () => snapshot(), pause: async () => snapshot(), observe: async () => snapshot(), settle: async (goalId, activationId) => { assert.equal(goalId, "g"); assert.equal(activationId, "activation"); questions.cancelPending(); return snapshot(); }, stop: async () => { assert.equal(questions.snapshot()[0].status, "cancelled"); stopped = true; } };
  } });
  const e = entry("e"); e.child = await executor.start(e); status = stoppedStatus;
  const observed = await executor.observe(e); await rejected;
  assert.equal(stopped, true); assert.equal(observed?.story?.questions?.[0].status, "cancelled"); assert.equal(observed?.status, stoppedStatus); questions.dispose();
});

test('normal managed Goal recovers an active task across parent reload and resumes its idle worker without duplication',async()=>{
 let launches=0,activation=0,status:'active'|'paused'='paused';
 const snapshot=()=>({goalId:'logical-goal',activationId:`activation-${activation}`,status,executionStopped:status!=='active',waiting:null});
 const handle:GoalChildHandle={managed:true,model:'owning-provider/model',identity:{sessionId:'owner',runtimeId:'worker-runtime',taskId:'task',childId:'child',jobId:'normal-group',attempt:1,workerEpoch:'worker-epoch'},
  async start(){status='active';activation++;return snapshot();},async resume(){status='active';activation++;return snapshot();},async pause(){status='paused';return snapshot();},async observe(){return snapshot();},async stop(){assert.equal(status,'paused');}};
 const make=(runtimeId:string)=>createDelegatedGoalExecutor({sessionId:'owner',runtimeId,async launch(){launches++;return handle;},async recover(){return handle;},async verifyStopped(){assert.equal(status,'paused');}});
 const e=entry('catalog-goal');const first=make('parent-one');e.child=await first.start(e);const oldChild=structuredClone(e.child);
 const restored=make('parent-two');assert.equal((await restored.observe(e))?.status,'active');assert.equal(launches,1,'Reload is observation/rebind, not another launch');
 await restored.pause(e);const resumed=await restored.resume(e);assert.deepEqual(resumed,oldChild);assert.equal(activation,2);assert.equal((await restored.observe({...e,child:resumed}))?.status,'active');
});

test("abrupt child exit replaces cached guard keys with fresh authenticated retained metadata", async () => {
  const e = entry("guarded"); let reads = 0, stops = 0, marker = "forge-approval:first";
  const handle: GoalChildHandle = {
    model: "test/model",
    identity: { sessionId: "s", runtimeId: "r", taskId: "task", childId: "child", jobId: "job", attempt: 1, workerEpoch: "epoch" },
    async start() { return { goalId: e.id, activationId: "activation", status: "active", executionStopped: false, waiting: null, completionGuardKeys: [] }; },
    async resume() { throw Error("unused"); }, async pause() { throw Error("unused"); },
    async observe() { throw Error("worker exited abruptly"); },
    async stop() { stops++; },
  };
  const executor = createDelegatedGoalExecutor({ sessionId: "s", runtimeId: "r",
    async launch() { return handle; }, async verifyStopped() {},
    async retainedCompletion() { reads++; return { goalId: e.id, activationId: "activation", status: "paused", executionStopped: true, waiting: null, completionGuardKeys: [marker] }; },
  });
  e.child = await executor.start(e);
  const first = await executor.observe(e);
  assert.deepEqual(first?.completionGuardKeys, ["forge-approval:first"]);
  assert.equal(stops, 1); assert.equal(reads, 1);
  marker = "forge-approval:changed";
  const second = await executor.observe(e);
  assert.deepEqual(second?.completionGuardKeys, ["forge-approval:changed"], "stopped observations re-read retained metadata instead of trusting b.last");
  assert.equal(reads, 2);
});

test("two child bindings retain tasks across attempts; pause awaits halt and rejects stale attempts", async () => {
  let halted = 0, validPause = false;
  const contractIds = new Map<string, string>();
  const handles: GoalChildHandle[] = [];
  const executor = createDelegatedGoalExecutor({ sessionId: "s", runtimeId: "r", async launch(e, previous) {
    const attempt = (previous?.attempt ?? 0) + 1;
    let running = false;
    const handle: GoalChildHandle = {
      // The executor fences child identity, not a hardcoded default model.
      // Explicit/retained role choices must survive the same exact-child lane.
      model: e.id === "a" ? "owning-provider/gpt-6-astra:low" : "owning-provider/gpt-6.1-sol:high",
      identity: { sessionId: "s", runtimeId: "r", taskId: previous?.taskId ?? `task-${e.id}`, childId: `child-${e.id}-${attempt}`, jobId: `job-${e.id}-${attempt}`, attempt, workerEpoch: `epoch-${e.id}-${attempt}` },
      async start() { running = true; contractIds.set(e.id, e.id); return { goalId: e.id, activationId: e.id, status: "active", waiting: null, executionStopped: false }; },
      async resume() { running = true; const goalId = `${e.id}-contract-${attempt}`; contractIds.set(e.id, goalId); return { goalId: e.id, activationId: goalId, status: "active", waiting: null, executionStopped: false }; },
      async pause() { if (validPause) running = false; return { goalId: e.id, activationId: contractIds.get(e.id)!, status: "paused", waiting: null, executionStopped: validPause }; },
      async observe() { return { goalId: e.id, activationId: contractIds.get(e.id)!, status: running ? "active" : "paused", waiting: null, executionStopped: !running }; },
      async stop() { await Promise.resolve(); halted++; },
    }; handles.push(handle); return handle;
  } });
  const a = entry("a"), b = entry("b");
  a.child = await executor.start(a); b.child = await executor.start(b);
  assert.notEqual(a.child.taskId, b.child.taskId);
  assert.equal(a.child.model, "owning-provider/gpt-6-astra:low");
  assert.equal(b.child.model, "owning-provider/gpt-6.1-sol:high");
  await assert.rejects(executor.update(a), /execution is not stopped/);
  await assert.rejects(executor.pause(a), /did not verify stopped execution/);
  assert.equal(halted, 0);
  validPause = true;
  const paused = await executor.pause(a); assert.equal(halted, 1);
  assert.equal(paused?.status, "paused");
  a.text = "Updated while paused";
  const launchedBeforeEdit = handles.length;
  await executor.update(a);
  assert.equal(handles.length, launchedBeforeEdit, "paused metadata edits cannot launch a worker");
  const stale = structuredClone(a);
  a.child = await executor.resume(a);
  assert.equal(a.child.taskId, stale.child!.taskId);
  assert.equal(a.child.attempt, 2);
  assert.equal((await executor.observe(a))?.goalId, "a", "Resume retains goal identity");
  assert.equal((await executor.observe(a))?.activationId, "a-contract-2", "Resume rotates only the activation token");
  contractIds.set("a", "a");
  await assert.rejects(executor.observe(a), /Invalid dedicated child goal observation/, "ordinary observation must still reject the old pre-resume contract");
  contractIds.set("a", "a-contract-2");
  await assert.rejects(executor.observe(stale), /Stale dedicated goal child binding/);
  assert.equal((await executor.observe(b)).goalId, "b");
  handles[2].identity.workerEpoch = "replaced";
  await assert.rejects(executor.pause(a), /Stale dedicated goal child binding/);
});
