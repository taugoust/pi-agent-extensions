import assert from "node:assert/strict";
import { test } from "node:test";
import { DelegatedGoalRegistry, type DelegatedGoalEntry, type DelegatedGoalExecutor } from "./delegated-goals.ts";
import { delegatedGoalStore } from "./delegated-goal-store.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixture(initial?: any) {
  const calls: string[] = [];
  const executor: DelegatedGoalExecutor = {
    async start(e) { calls.push("start"); return { taskId: `task:${e.id}`, childId: "child-1", jobId: "job-1", attempt: 1 }; },
    async resume(e) { calls.push("resume"); return { taskId: e.child!.taskId, childId: "child-2", jobId: "job-2", attempt: e.child!.attempt + 1 }; },
    async pause() { calls.push("pause"); },
  };
  let counter = 0;
  let registry = new DelegatedGoalRegistry("session", executor, () => {}, initial);
  const create = (objective: string) => registry.mutate("session", { action: "goals.create", requestId: `r${++counter}`, expectedGoalId: null, objective });
  const mutate = (entry: DelegatedGoalEntry, extra: object, requestId = `r${++counter}`) => registry.mutate("session", { action: "goals.tasks", requestId, expectedGoalId: entry.id, expectedEntryRevision: entry.revision, ...extra });
  const act = (entry: DelegatedGoalEntry, action: "goals.start" | "goals.pause" | "goals.resume") => registry.mutate("session", { action, requestId: `r${++counter}`, expectedGoalId: entry.id, expectedEntryRevision: entry.revision });
  const seedTasks = (id: string, tasks: ReturnType<typeof task>[]) => { const state = registry.snapshot(); state.entries.find(e => e.id === id)!.tasks = structuredClone(tasks); registry = new DelegatedGoalRegistry("session", executor, () => {}, state); };
  return { get registry() { return registry; }, executor, calls, create, mutate, act, seedTasks };
}

const task = (id: string, text: string, status: "pending" | "in_progress" | "completed" | "blocked" = "pending") => ({ id, text, status });

test("checklist inserts first prerequisite, edits and reorders without changing retained task identity or status", async () => {
  const f = fixture(); await f.create("Deliver verified change");
  const entry = f.registry.snapshot().entries[0];
  f.seedTasks(entry.id, [task("implementation", "Implement change", "completed"), task("mr", "Open a merge request", "in_progress"), task("confirmation", "Obtain explicit user merge confirmation", "blocked")]);
  const beforePolicy = entry.policyRevision, beforeRevision = entry.revision, ids = ["implementation", "mr", "confirmation"];
  const result = await f.mutate(entry, { taskEdits: [{ text: "Inspect prerequisites", before_task_id: "implementation" }] });
  const updated = result.entries[0];
  assert.deepEqual(updated.tasks.map(t => t.text), ["Inspect prerequisites", "Implement change", "Open a merge request", "Obtain explicit user merge confirmation"]);
  assert.deepEqual(updated.tasks.slice(1).map(t => [t.id, t.status]), [["implementation", "completed"], ["mr", "in_progress"], ["confirmation", "blocked"]]);
  assert.notEqual(updated.tasks[0].id, "implementation"); assert.deepEqual(updated.tasks.slice(1).map(t => t.id), ids);
  assert.equal(updated.policyRevision, beforePolicy); assert.equal(updated.revision, beforeRevision + 1);
  assert.ok(updated.story?.timeline.some(event => event.kind === "edited"));
  const reordered = await f.mutate(updated, { taskEdits: [{ id: "confirmation", before_task_id: "implementation" }, { id: "mr", text: "Open the merge request" }] });
  assert.deepEqual(reordered.entries[0].tasks.map(t => t.id), [updated.tasks[0].id, "confirmation", "implementation", "mr"]);
  assert.equal(reordered.entries[0].tasks[1].status, "blocked"); assert.equal(reordered.entries[0].tasks[3].status, "in_progress");
  assert.deepEqual(f.calls, []);
});

test("explicit removal, append-to-end and atomic validation preserve task records", async () => {
  const f = fixture(); await f.create("Checklist");
  let e = f.registry.snapshot().entries[0]; f.seedTasks(e.id, [task("a", "Alpha", "completed"), task("b", "Beta"), task("c", "Gamma", "blocked")]); e = f.registry.snapshot().entries[0];
  const added = await f.mutate(e, { taskEdits: [{ text: "Delta" }, { id: "a", text: "Renamed alpha", before_task_id: null }], removeTaskIds: ["b"] });
  assert.deepEqual(added.entries[0].tasks.map(t => t.text), ["Gamma", "Delta", "Renamed alpha"]);
  assert.equal(added.entries[0].tasks[0].id, "c"); assert.equal(added.entries[0].tasks[0].status, "blocked");
  assert.equal(added.entries[0].tasks[2].id, "a"); assert.equal(added.entries[0].tasks[2].status, "completed");
  e = added.entries[0]; const before = f.registry.snapshot();
  const invalid = [
    { taskEdits: [], removeTaskIds: [] },
    { taskEdits: [{ id: "foreign", text: "X" }] },
    { taskEdits: [{ text: "X", before_task_id: "foreign" }] },
    { taskEdits: [{ text: "X", before_task_id: "b" }] },
    { taskEdits: [{ id: "a", before_task_id: "a" }] },
    { taskEdits: [{ id: "a", text: "X" }, { id: "a", text: "Y" }] },
    { taskEdits: [{ id: "a", text: "X" }], removeTaskIds: ["a"] },
    { removeTaskIds: ["foreign"] }, { removeTaskIds: ["c", "c"] },
    { taskEdits: [{ text: "Gamma" }] },
    { taskEdits: [{ text: "   " }] }, { taskEdits: [{ text: "X", extra: true }] },
    { taskEdits: [{ id: "a", text: "X", before_task_id: 3 }] },
    { taskEdits: [{ id: "   ", text: "X" }] }, { taskEdits: [{ text: "X", before_task_id: "  " }] },
    { removeTaskIds: ["  "] },
    { taskEdits: Array.from({ length: 51 }, (_, i) => ({ text: `New ${i}` })) },
    { removeTaskIds: Array.from({ length: 51 }, (_, i) => `task-${i}`) },
  ];
  for (const [index, body] of invalid.entries()) {
    await assert.rejects(f.mutate(e, body, `invalid-${index}`));
    assert.deepEqual(f.registry.snapshot(), before);
  }
  await assert.rejects(f.registry.mutate("other", { action: "goals.tasks", requestId: "foreign-session", expectedGoalId: e.id, expectedEntryRevision: e.revision, taskEdits: [{ text: "No" }] }), /session/);
  await assert.rejects(f.mutate({ ...e, revision: e.revision - 1 }, { taskEdits: [{ text: "stale" }] }), /revision/);
});

test("idempotent retry/conflict, pending and lifecycle fences, and persisted paused edits retain IDs on resume", async () => {
  const root = mkdtempSync(join(tmpdir(), "saved-goal-tasks-"));
  try {
    const store = delegatedGoalStore("session", root), f = fixture(); await f.create("Linked checklist");
    let e = f.registry.snapshot().entries[0]; f.seedTasks(e.id, [task("keep", "Keep identity")]); e = f.registry.snapshot().entries[0];
    await f.act(e, "goals.start"); await f.act(f.registry.snapshot().entries[0], "goals.pause");
    e = f.registry.snapshot().entries[0];
    const request = { action: "goals.tasks" as const, requestId: "same-request", expectedGoalId: e.id, expectedEntryRevision: e.revision, taskEdits: [{ text: "Prerequisite", before_task_id: "keep" }] };
    const [first, retry] = await Promise.all([f.registry.mutate("session", request), f.registry.mutate("session", request)]);
    assert.deepEqual(first, retry);
    await assert.rejects(f.registry.mutate("session", { ...request, taskEdits: [{ text: "Different" }] }), /conflict/);
    store.save(first);
    const restored = new DelegatedGoalRegistry("session", f.executor, s => store.save(s), store.load());
    const reloadedEntry = restored.snapshot().entries[0], ids = reloadedEntry.tasks.map(t => t.id), childTaskId = reloadedEntry.child!.taskId;
    assert.deepEqual(ids, first.entries[0].tasks.map(t => t.id));
    assert.equal(reloadedEntry.tokensUsed, e.tokensUsed); assert.equal(reloadedEntry.summary, e.summary); assert.equal(reloadedEntry.waiting, e.waiting);
    assert.deepEqual(reloadedEntry.child, e.child);
    await assert.rejects(restored.mutate("session", request), /revision/); // receipts are in-memory; persisted revision safely fences replay
    await restored.mutate("session", { action: "goals.resume", requestId: "resume-edited", expectedGoalId: reloadedEntry.id, expectedEntryRevision: reloadedEntry.revision });
    const resumed = restored.snapshot().entries[0]; assert.equal(resumed.status, "active"); assert.equal(resumed.child!.taskId, childTaskId); assert.deepEqual(resumed.tasks.map(t => t.id), ids);
    const active = resumed;
    await assert.rejects(restored.mutate("session", { action: "goals.tasks", requestId: "active-edit", expectedGoalId: active.id, expectedEntryRevision: active.revision, taskEdits: [{ text: "blocked" }] }), /Pause goal/);
    const terminalState = restored.snapshot(); terminalState.entries[0].status = "complete"; terminalState.entries[0].revision++;
    const terminal = new DelegatedGoalRegistry("session", f.executor, () => {}, terminalState);
    await assert.rejects(terminal.mutate("session", { action: "goals.tasks", requestId: "terminal-edit", expectedGoalId: terminalState.entries[0].id, expectedEntryRevision: terminalState.entries[0].revision, taskEdits: [{ text: "blocked" }] }), /terminal/);
    const fenced = new DelegatedGoalRegistry("session", f.executor, () => {}, first, { initial: { requestId: "uncertain", action: "goals.resume", entryId: first.entries[0].id, expectedEntryRevision: first.entries[0].revision }, save() {} });
    await assert.rejects(fenced.mutate("session", { action: "goals.tasks", requestId: "pending-edit", expectedGoalId: first.entries[0].id, expectedEntryRevision: first.entries[0].revision, taskEdits: [{ text: "blocked" }] }), /reconciliation/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("canonical grapheme limits permit Unicode task edits and moves while rejecting overlong text atomically", async () => {
  const f = fixture(); await f.create("Unicode checklist"); let e = f.registry.snapshot().entries[0];
  const emoji = "😀".repeat(503), combining = "e\u0301".repeat(503);
  const result = await f.mutate(e, { taskEdits: [{ text: emoji }, { text: combining }] }); e = result.entries[0];
  assert.deepEqual(e.tasks.map(task => task.text), [emoji, combining]);
  const moved = await f.mutate(e, { taskEdits: [{ id: e.tasks[1].id, before_task_id: e.tasks[0].id }] });
  assert.deepEqual(moved.entries[0].tasks, [e.tasks[1], e.tasks[0]]);
  const before = f.registry.snapshot();
  for (const text of ["😀".repeat(504), "e\u0301".repeat(504)]) {
    await assert.rejects(f.mutate(moved.entries[0], { taskEdits: [{ text }] }), /503/);
    assert.deepEqual(f.registry.snapshot(), before);
  }
  const restored = new DelegatedGoalRegistry("session", f.executor, () => {}, before);
  assert.deepEqual(restored.snapshot(), before); assert.deepEqual(f.calls, []);
});

test("legacy add_task and initial checklist adapters share canonical Unicode validation", async () => {
  const f = fixture(); await f.create("Append Unicode tasks"); const e = f.registry.snapshot().entries[0], emoji = "😀".repeat(503);
  const request = { action: "goals.add_task" as const, requestId: "append-unicode", expectedGoalId: e.id, expectedEntryRevision: e.revision, text: emoji };
  const result = await f.registry.mutate("session", request);
  assert.equal(result.entries[0].tasks[0].text, emoji); assert.equal(result.entries[0].tasks[0].status, "pending");
  const before = f.registry.snapshot();
  await assert.rejects(f.registry.mutate("session", { ...request, requestId: "append-too-long", expectedEntryRevision: result.entries[0].revision, text: "😀".repeat(504) }), /503/);
  assert.deepEqual(f.registry.snapshot(), before);
  const created = await f.registry.mutate("session", { action: "goals.create", requestId: "initial-unicode", expectedGoalId: null, objective: "Unicode initial adapter", initialTasks: ["e\u0301".repeat(503)] });
  assert.equal(created.entries[1].tasks[0].text, "e\u0301".repeat(503)); assert.deepEqual(f.calls, []);
});

test("persistence failure leaves checklist unchanged and edits do not affect unrelated goals", async () => {
  const f = fixture(); await f.create("Target"); await f.create("Unrelated");
  let state = f.registry.snapshot(); const target = state.entries[0];
  state.entries[0].tasks = [task("original", "Original")];
  const unrelated = structuredClone(state.entries[1]);
  const persistFailure = new DelegatedGoalRegistry("session", f.executor, () => { throw new Error("disk failure"); }, state);
  const before = persistFailure.snapshot(), entry = before.entries[0];
  await assert.rejects(persistFailure.mutate("session", { action: "goals.tasks", requestId: "persist-failure", expectedGoalId: entry.id, expectedEntryRevision: entry.revision, taskEdits: [{ text: "New", before_task_id: "original" }] }), /disk failure/);
  assert.deepEqual(persistFailure.snapshot(), before);
  const successful = new DelegatedGoalRegistry("session", f.executor, () => {}, state);
  const changed = await successful.mutate("session", { action: "goals.tasks", requestId: "unrelated-preserved", expectedGoalId: target.id, expectedEntryRevision: target.revision, taskEdits: [{ text: "New", before_task_id: "original" }] });
  assert.deepEqual(changed.entries[1], unrelated);
  assert.equal(changed.entries[0].status, target.status); assert.equal(changed.entries[0].child, target.child);
  assert.equal(changed.entries[0].tokensUsed, target.tokensUsed); assert.equal(changed.entries[0].summary, target.summary); assert.equal(changed.entries[0].waiting, target.waiting);
});
