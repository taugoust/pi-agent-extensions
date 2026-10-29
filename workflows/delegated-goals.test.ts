import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DelegatedGoalRegistry, type DelegatedGoalEntry, type DelegatedGoalExecutor } from "./delegated-goals.ts";
import { delegatedGoalStore } from "./delegated-goal-store.ts";
import { resolveGoalLimits, DEDICATED_GOAL_LIMITS } from "../shared/delegated-goal-policy.ts";

function fixture() {
  const calls: string[] = [];
  let launches = 0;
  const executor: DelegatedGoalExecutor = {
    async start(e) { calls.push(`start:${e.id}`); launches++; return { taskId: `task:${e.id}`, childId: `child:${e.id}:1`, jobId: `job:${e.id}:1`, attempt: 1 }; },
    async resume(e) { calls.push(`resume:${e.id}`); return { taskId: e.child!.taskId, childId: `child:${e.id}:2`, jobId: `job:${e.id}:2`, attempt: 2 }; },
    async pause(e) { calls.push(`pause:${e.id}`); },
    async verifyStopped(e) { calls.push(`verified-stopped:${e.id}`); },
  };
  const saves: unknown[] = [];
  const registry = new DelegatedGoalRegistry("parent", executor, s => saves.push(s));
  let id = 0;
  const create = (objective: string) => registry.mutate("parent", { action: "goals.create", requestId: String(++id), expectedGoalId: null, objective });
  const act = (entry: DelegatedGoalEntry, action: any, extra = {}) => registry.mutate("parent", { action, requestId: String(++id), expectedGoalId: entry.id, expectedEntryRevision: entry.revision, ...extra });
  return { registry, executor, calls, saves, create, act, launches: () => launches };
}

test("per-goal limits persist independently, validate, and clear back to inherited defaults", async () => {
  const f = fixture();
  let state = await f.registry.mutate("parent", { action: "goals.create", requestId: "limits", expectedGoalId: null, objective: "bounded", continuationLimits: { automaticTurns: 9, noProgressTurns: null } });
  const defaults = { automaticTurns: 12, noProgressTurns: 4 };
  assert.deepEqual(resolveGoalLimits(state.entries[0].continuationLimits, defaults), { automaticTurns: 9, noProgressTurns: 4 });
  assert.deepEqual(resolveGoalLimits(undefined, DEDICATED_GOAL_LIMITS), { automaticTurns: null, noProgressTurns: null });
  const restored = new DelegatedGoalRegistry("parent", f.executor, () => {}, state);
  assert.deepEqual(restored.snapshot(), state);
  for (const invalid of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, "3"]) {
    await assert.rejects(f.act(state.entries[0], "goals.edit", { objective: "bounded", continuationLimits: { automaticTurns: invalid } }), /Invalid goal continuation/);
  }
  state = await f.act(state.entries[0], "goals.edit", { objective: "bounded", continuationLimits: { automaticTurns: null, noProgressTurns: null } });
  assert.deepEqual(resolveGoalLimits(state.entries[0].continuationLimits, defaults), defaults);
  assert.equal(f.launches(), 0);
});

test("exhausted explicit budget Resume refusal has no child side effect or pending intent", async () => {
  const f = fixture();
  await f.registry.mutate("parent", { action: "goals.create", requestId: "capped-budget", expectedGoalId: null, objective: "capped", tokenBudget: 10 });
  await f.act(f.registry.snapshot().entries[0], "goals.start");
  f.executor.observe = async () => ({ status: "budget_limited", tokensUsed: 10 });
  await f.registry.refresh();
  let entry = f.registry.snapshot().entries[0]; const before = f.registry.snapshot(), calls = f.calls.length;
  await assert.rejects(f.act(entry, "goals.resume"), /budget is still reached/);
  assert.deepEqual(f.registry.snapshot(), before); assert.equal(f.calls.length, calls); assert.equal(f.registry.blockedReason(), null);
  await f.act(entry, "goals.edit", { objective: entry.text, tokenBudget: null });
  entry = f.registry.snapshot().entries[0]; await f.act(entry, "goals.resume");
  assert.equal(f.registry.snapshot().entries[0].status, "active");
});

test("normalized duplicate task rejection leaves metadata, revision, journal and execution unchanged", async () => {
  const f = fixture(); await f.create("unique tasks");
  await f.act(f.registry.snapshot().entries[0], "goals.add_task", { text: "  Check exact text  " });
  const before = f.registry.snapshot(), saves = f.saves.length;
  await assert.rejects(f.act(before.entries[0], "goals.add_task", { text: "Check exact text" }), /distinct descriptions/);
  assert.deepEqual(f.registry.snapshot(), before); assert.equal(f.saves.length, saves); assert.equal(f.launches(), 0); assert.equal(f.registry.blockedReason(), null);
  await f.act(before.entries[0], "goals.add_task", { text: "check exact text" }); // no invented case folding
  const malformed = f.registry.snapshot();
  malformed.entries[0].tasks[1].text = "  Check exact text ";
  assert.throws(() => new DelegatedGoalRegistry("parent", f.executor, () => { throw Error("must not save"); }, malformed), /distinct descriptions/);
  await f.act(f.registry.snapshot().entries[0], "goals.start");
  const active = f.registry.snapshot(), activeSaves = f.saves.length;
  f.executor.observe = async () => ({ tasks: [{ id: "a", text: "same", status: "pending" }, { id: "b", text: " same ", status: "pending" }] });
  await assert.rejects(f.registry.refresh(), /distinct descriptions/);
  assert.deepEqual(f.registry.snapshot(), active); assert.equal(f.saves.length, activeSaves); assert.equal(f.registry.blockedReason(), null);
});

test("pause racing exact owned completion preserves terminal evidence without uncertainty trap", async () => {
  const f = fixture(); await f.create("complete concurrently");
  await f.act(f.registry.snapshot().entries[0], "goals.add_task", { text: "verify outcome" });
  await f.act(f.registry.snapshot().entries[0], "goals.start");
  const active = f.registry.snapshot().entries[0];
  f.executor.pause = async () => ({ status: "complete", summary: "exact completion evidence", tokensUsed: 51, tasks: active.tasks.map(task => ({ ...task, status: "completed" })) });
  let observations = 0;
  f.executor.observe = async () => {
    if (observations++ === 0) return { status: "active" }; // lifecycle preflight
    throw Error("terminal process already stopped; direct terminal receipt must suffice");
  };
  await f.act(active, "goals.pause");
  const completed = f.registry.snapshot().entries[0];
  assert.equal(completed.status, "complete"); assert.equal(completed.summary, "exact completion evidence");
  assert.equal(completed.tasks[0].status, "completed"); assert.equal(completed.tokensUsed, 51); assert.equal(f.registry.blockedReason(), null);
  await f.create("independent subsequent entry"); assert.equal(f.registry.snapshot().entries.length, 2);
});

test("two paused entries create no execution and leave arbitrary busy parent runtime untouched", async () => {
  const f = fixture();
  const parent = { activeGoal: { id: "legacy", status: "active" }, idle: false, messages: ["still chatting"] };
  const before = structuredClone(parent);
  await f.create("first"); await f.create("second");
  const state = f.registry.snapshot();
  assert.equal(state.entries.length, 2);
  assert.notEqual(state.entries[0].id, state.entries[1].id);
  assert.ok(state.entries.every(e => e.status === "paused" && e.child === null));
  assert.equal(f.launches(), 0); assert.deepEqual(f.calls, []); assert.deepEqual(parent, before);
});

test("independent child start, verified pause before clear, retained immutable task on resume", async () => {
  const f = fixture(); await f.create("one"); await f.create("two");
  let [one, two] = f.registry.snapshot().entries;
  await f.act(one, "goals.start"); await f.act(two, "goals.start");
  [one, two] = f.registry.snapshot().entries;
  assert.notEqual(one.child!.taskId, two.child!.taskId);
  await assert.rejects(f.act(one, "goals.clear"), /Pause child/);
  await f.act(one, "goals.pause"); one = f.registry.snapshot().entries[0];
  const taskId = one.child!.taskId;
  await f.act(one, "goals.resume"); one = f.registry.snapshot().entries[0];
  assert.equal(one.child!.taskId, taskId); assert.equal(one.child!.attempt, 2);
  assert.deepEqual(f.registry.snapshot().entries[1], two);
  await f.act(one, "goals.pause"); one = f.registry.snapshot().entries[0];
  await f.act(one, "goals.clear");
  assert.equal(f.registry.snapshot().entries[0].status, "cleared");
  assert.equal(f.registry.snapshot().entries[0].child!.taskId, taskId);
});

test("session, stale revision, idempotency, and in-flight serialization guards", async () => {
  const f = fixture(); await f.create("one");
  const entry = f.registry.snapshot().entries[0];
  const request = { action: "goals.start" as const, requestId: "start", expectedGoalId: entry.id, expectedEntryRevision: entry.revision };
  const [a, b] = await Promise.all([f.registry.mutate("parent", request), f.registry.mutate("parent", request)]);
  assert.deepEqual(a, b); assert.equal(f.launches(), 1);
  await assert.rejects(f.registry.mutate("foreign", request), /session/);
  await assert.rejects(f.registry.mutate("parent", { ...request, action: "goals.pause" }), /conflict/);
  await assert.rejects(f.act(entry, "goals.pause"), /revision/);
  await assert.rejects(f.registry.mutate("parent", { action: "goals.create", requestId: "bad-create", expectedGoalId: null, expectedRegistryRevision: 0, objective: "bad" }), /Registry changed/);
  let finish!: () => void;
  f.executor.pause = async () => await new Promise<void>(resolve => { finish = resolve; });
  const active = f.registry.snapshot().entries[0];
  const pause = f.act(active, "goals.pause");
  await Promise.resolve(); await Promise.resolve();
  const stale = f.act(active, "goals.clear");
  finish(); await pause;
  await assert.rejects(stale, /revision/);
  assert.equal(f.registry.snapshot().entries[0].status, "paused");
});

test("metadata round-trip is session-bound, retains cleared history and never emits session messages", async () => {
  const root = mkdtempSync(join(tmpdir(), "delegated-test-"));
  try {
    const store = delegatedGoalStore("session", root);
    const f = fixture(); await f.create("kept");
    store.save(f.registry.snapshot());
    assert.deepEqual(store.load(), f.registry.snapshot());
    assert.deepEqual(delegatedGoalStore("other", root).load(), { version: 1, revision: 0, entries: [] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("explicit delegated edit null removes budget; omission preserves; create null rejects", async () => {
  const f = fixture();
  await f.registry.mutate("parent", { action: "goals.create", requestId: "capped", expectedGoalId: null, objective: "cap", tokenBudget: 50 });
  let entry = f.registry.snapshot().entries[0];
  await f.act(entry, "goals.edit", { objective: "renamed" });
  entry = f.registry.snapshot().entries[0]; assert.equal(entry.tokenBudget, 50);
  await f.act(entry, "goals.edit", { objective: "unlimited", tokenBudget: null });
  assert.equal(f.registry.snapshot().entries[0].tokenBudget, null);
  await assert.rejects(f.registry.mutate("parent", { action: "goals.create", requestId: "invalid-null", expectedGoalId: null, objective: "no", tokenBudget: null }), /budget/);
});

test("child observation synchronizes only owned goal fields and retains completed history", async () => {
  const f = fixture(); await f.create("observed"); await f.create("independent");
  await f.act(f.registry.snapshot().entries[0], "goals.start");
  const other = f.registry.snapshot().entries[1];
  f.executor.observe = async () => ({ status: "complete", tokensUsed: 123, summary: "verified done", waiting: null });
  await f.registry.refresh();
  const state = f.registry.snapshot();
  assert.equal(state.entries[0].status, "complete"); assert.equal(state.entries[0].summary, "verified done");
  assert.deepEqual(state.entries[1], other);
  const launches = f.launches();
  const reconciled = await f.act(state.entries[0], "goals.resume");
  assert.equal(reconciled.entries[0].status, "complete");
  assert.equal(f.launches(), launches, "terminal reconciliation must never launch again");
  assert.equal(state.entries.length, 2);
});

test("durable pre-effect fence prevents duplicate start after persistence failure and reload", async () => {
  const root = mkdtempSync(join(tmpdir(), "delegated-intent-"));
  try {
    const store = delegatedGoalStore("parent", root), f = fixture();
    let failPersistence = false;
    const make = () => new DelegatedGoalRegistry("parent", f.executor, state => {
      if (failPersistence) throw Error("disk failure after child start");
      store.save(state);
    }, store.load(), { initial: store.loadIntent(), save: intent => store.saveIntent(intent) });
    const registry = make();
    await registry.mutate("parent", { action: "goals.create", requestId: "create", expectedGoalId: null, objective: "safe" });
    const entry = registry.snapshot().entries[0];
    failPersistence = true;
    await assert.rejects(registry.mutate("parent", { action: "goals.start", requestId: "start-once", expectedGoalId: entry.id, expectedEntryRevision: entry.revision }), /disk failure/);
    assert.equal(f.launches(), 1); assert.equal(store.loadIntent()!.entryId, entry.id);
    await assert.rejects(registry.mutate("parent", { action: "goals.start", requestId: "new-id", expectedGoalId: entry.id, expectedEntryRevision: entry.revision }), /reconciliation/);
    failPersistence = false;
    await registry.mutate("parent", { action: "goals.create", requestId: "unrelated", expectedGoalId: null, objective: "independent paused metadata" });
    assert.equal(registry.snapshot().entries.length, 2);
    assert.equal(store.loadIntent()!.entryId, entry.id);
    const reloaded = make();
    await assert.rejects(reloaded.mutate("parent", { action: "goals.start", requestId: "reload-id", expectedGoalId: entry.id, expectedEntryRevision: entry.revision }), /reconciliation/);
    assert.equal(f.launches(), 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("deterministic execution preflight refusal never poisons pending journal", async () => {
  const f = fixture(); await f.create("preflight");
  const entry = f.registry.snapshot().entries[0];
  f.executor.executionAvailable = () => false;
  await assert.rejects(f.act(entry, "goals.start"), /preflight refused/);
  assert.equal(f.registry.blockedReason(), null); assert.equal(f.launches(), 0);
  f.executor.executionAvailable = () => true;
  await f.act(entry, "goals.start"); assert.equal(f.launches(), 1);
});

test("clear rejects cached paused metadata unless exact child stop is verified", async () => {
  const f = fixture(); await f.create("owned"); await f.act(f.registry.snapshot().entries[0], "goals.start");
  let entry = f.registry.snapshot().entries[0]; await f.act(entry, "goals.pause"); entry = f.registry.snapshot().entries[0];
  f.executor.verifyStopped = async () => { throw Error("child still running"); };
  await assert.rejects(f.act(entry, "goals.clear"), /still running/);
  assert.equal(f.registry.snapshot().entries[0].status, "paused");
});

test("pause and resume persistence failures retain uncertain-delivery fence", async () => {
  for (const action of ["goals.pause", "goals.resume"] as const) {
    const f = fixture(); let fail = false; let pending: any = null;
    const registry = new DelegatedGoalRegistry("parent", f.executor, () => { if (fail) throw Error("persist failed"); }, undefined, { save: value => { pending = value; } });
    let id = 0;
    const mutate = (action: any, entry?: DelegatedGoalEntry, fields = {}) => registry.mutate("parent", { action, requestId: `effect-${++id}`, expectedGoalId: entry?.id ?? null, ...(entry ? { expectedEntryRevision: entry.revision } : {}), ...fields });
    await mutate("goals.create", undefined, { objective: "effect test" });
    await mutate("goals.start", registry.snapshot().entries[0]);
    if (action !== "goals.pause") await mutate("goals.pause", registry.snapshot().entries[0]);
    const entry = registry.snapshot().entries[0]; fail = true;
    await assert.rejects(mutate(action, entry), /persist failed/);
    assert.equal(pending.action, action); assert.deepEqual(registry.snapshot().entries[0], entry);
    const effects = f.calls.length;
    await assert.rejects(mutate(action, entry), /reconciliation/);
    assert.equal(f.calls.length, effects);
  }
});

test("linked paused edits are metadata-only and stale paused observations cannot erase them", async () => {
  const f = fixture(); await f.create("original");
  await f.act(f.registry.snapshot().entries[0], "goals.start");
  await f.act(f.registry.snapshot().entries[0], "goals.pause");
  const effects = f.calls.length;
  let entry = f.registry.snapshot().entries[0];
  const taskId = entry.child!.taskId;
  await f.act(entry, "goals.edit", { objective: "revised", tokenBudget: 77 });
  entry = f.registry.snapshot().entries[0];
  await f.act(entry, "goals.add_task", { text: "new task for next explicit resume" });
  f.executor.observe = async () => ({ tasks: [], status: "paused" });
  await f.registry.refresh(); entry = f.registry.snapshot().entries[0];
  assert.equal(entry.text, "revised"); assert.equal(entry.tokenBudget, 77); assert.equal(entry.tasks.length, 1);
  assert.equal(entry.child!.taskId, taskId); assert.equal(f.calls.length, effects); assert.equal(f.registry.blockedReason(), null);
  let resumed: DelegatedGoalEntry | undefined;
  f.executor.resume = async e => { resumed = structuredClone(e); return { ...e.child!, childId: "next-child", jobId: "next-job", attempt: e.child!.attempt + 1 }; };
  await f.act(entry, "goals.resume");
  assert.equal(resumed!.text, "revised"); assert.equal(resumed!.tasks.length, 1); assert.equal(resumed!.tokenBudget, 77);
});
