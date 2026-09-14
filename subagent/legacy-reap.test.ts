import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundSubagentManager } from "./background.js";

async function fixture(t: any, overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "legacy-reap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = "subagent-job-" + "a".repeat(24);
  const directory = join(root, "jobs", id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const procStat = process.platform === "linux" ? await readFile(`/proc/${process.pid}/stat`, "utf8") : "";
  const token = procStat ? procStat.slice(procStat.lastIndexOf(")") + 2).split(" ")[19] : "fixture";
  const record = { schemaVersion: 2, id, sessionId: "owner", backend: "native", mode: "single",
    summary: "legacy", createdAt: now, updatedAt: now, ownerPid: process.pid,
    ownerStartToken: token, status: "completed", latest: "answer", ...overrides };
  const state = join(directory, "state.json");
  await writeFile(state, JSON.stringify(record), { mode: 0o600 });
  const manager = new BackgroundSubagentManager(root);
  await manager.initialize();
  return { root, id, directory, state, record, manager };
}

for (const status of ["completed", "failed", "cancelled"]) {
  test(`owned terminal ${status}: reports-only reap and no resurrection`, async t => {
    const f = await fixture(t, { status });
    const stale = new BackgroundSubagentManager(f.root);
    await stale.initialize();
    assert.equal((await f.manager.readResult(f.id)).text, "answer");
    await f.manager.markNotified(f.id);
    assert.equal((await f.manager.reapNative(f.id, "owner")).status, status);
    await assert.rejects(stat(f.directory), { code: "ENOENT" });
    assert.deepEqual(await f.manager.list("owner"), []);
    assert.deepEqual(await stale.list("owner"), []);
    await assert.rejects(stale.readResult(f.id), /Unknown/);
    await assert.rejects(f.manager.markNotified(f.id), /Unknown/);
    await assert.rejects(f.manager.reapNative(f.id, "owner"), /Unknown/);
    await assert.rejects(stat(f.directory), { code: "ENOENT" });
  });
}

test("foreign sessions and AgentSH rejected without deleting storage", async t => {
  const native = await fixture(t);
  await assert.rejects(native.manager.reapNative(native.id, "foreign"), /another Pi session/);
  await stat(native.state);
  const agentsh = await fixture(t, { backend: "agentsh" });
  await assert.rejects(agentsh.manager.reapNative(agentsh.id, "owner"), /AgentSH groups cannot/);
  await stat(agentsh.state);
});

test("running, cancelling, reload, and shutdown never let reap cancel work", async t => {
  const f = await fixture(t);
  let finish!: (value: any) => void;
  let signal!: AbortSignal;
  const running = await f.manager.start({ sessionId: "owner", backend: "native", mode: "single", summary: "active" }, s => {
    signal = s;
    return new Promise(resolve => { finish = resolve; });
  });
  await assert.rejects(f.manager.reapNative(running.id, "owner"), /active/);
  assert.equal(signal.aborted, false);
  f.manager.beginReloadAdoption("owner", 1000);
  await assert.rejects(f.manager.reapNative(running.id, "owner"), /active/);
  assert.equal(signal.aborted, false);
  f.manager.adoptReload("owner");
  const cancelling = f.manager.cancel(running.id);
  while (!signal.aborted) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.manager.reapNative(running.id, "owner"), /active/);
  f.manager.requestCancelSession("owner");
  finish({ text: "cancelled", failed: false });
  await cancelling;
  // wait reports terminal before its persistence/controller teardown completes.
  for (let i = 0; i < 100; i++) {
    try { await f.manager.reapNative(running.id, "owner"); return; }
    catch (error) { assert.match(String(error), /busy/); await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  assert.fail("terminal storage never settled");
});

test("concurrent result migration is busy, then reaps without late writes", async t => {
  const f = await fixture(t);
  const reading = f.manager.readResult(f.id);
  await assert.rejects(f.manager.reapNative(f.id, "owner"), /busy/);
  await reading;
  const results = await Promise.allSettled([f.manager.reapNative(f.id, "owner"), f.manager.reapNative(f.id, "owner")]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  await new Promise(resolve => setTimeout(resolve, 550));
  await assert.rejects(stat(f.directory), { code: "ENOENT" });
});

for (const patch of [{ status: "running" }, { sessionId: "foreign" }, { backend: "agentsh" }, { id: "subagent-job-" + "b".repeat(24) }]) {
  test(`disk revalidation rejects ${JSON.stringify(patch)}`, async t => {
    const f = await fixture(t);
    await writeFile(f.state, JSON.stringify({ ...f.record, ...patch }), { mode: 0o600 });
    await assert.rejects(f.manager.reapNative(f.id, "owner"), /changed|ownership/);
    assert.deepEqual(JSON.parse(await readFile(f.state, "utf8")), { ...f.record, ...patch });
  });
}

test("lost with living executor refuses cleanup; old native records are not auto-pruned", async t => {
  const f = await fixture(t, { status: "lost", createdAt: "2000-01-01T00:00:00Z", updatedAt: "2000-01-01T00:00:00Z" });
  await assert.rejects(f.manager.reapNative(f.id, "owner"), /may still be alive/);
  await stat(f.state);
});

test("reused PID is not the retained executor and is never signalled", { skip: process.platform !== "linux" }, async t => {
  const f = await fixture(t, { status: "lost", ownerStartToken: "0" });
  await f.manager.reapNative(f.id, "owner");
  await assert.rejects(stat(f.state), { code: "ENOENT" });
});

for (const ownerStartToken of [`${process.pid}:1234567890`, "unknown", "123ticks"]) {
  test(`unknown retained start token fails closed: ${ownerStartToken}`, { skip: process.platform !== "linux" }, async t => {
    const f = await fixture(t, { status: "lost", ownerStartToken });
    await assert.rejects(f.manager.reapNative(f.id, "owner"), /may still be alive/);
    await stat(f.state);
  });
}

test("other live executor is not reaped even with a terminal record", { skip: process.platform !== "linux" }, async t => {
  const stat = await readFile(`/proc/${process.ppid}/stat`, "utf8");
  const token = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  const f = await fixture(t, { ownerPid: process.ppid, ownerStartToken: token });
  await assert.rejects(f.manager.reapNative(f.id, "owner"), /may still be alive/);
});

test("dead executor lost record can be reaped", async t => {
  // Linux PID limit is far below this; do not target or signal a real process.
  const f = await fixture(t, { status: "lost", ownerPid: 2147483647 });
  await f.manager.reapNative(f.id, "owner");
  await assert.rejects(stat(f.state), { code: "ENOENT" });
});

test("native count retention does not bypass explicit cleanup", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 105; i++) {
    const id = `subagent-job-${i.toString(16).padStart(24, "0")}`;
    const directory = join(f.root, "jobs", id);
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, "state.json"), JSON.stringify({ ...f.record, id, sessionId: "foreign" }), { mode: 0o600 });
  }
  const reloaded = new BackgroundSubagentManager(f.root);
  assert.equal((await reloaded.list(undefined, 1000)).length, 106);
  await assert.rejects(reloaded.reapNative("subagent-job-" + "0".repeat(24), "owner"), /another Pi session/);
});

test("state symlink and directory replacement fail closed", async t => {
  const f = await fixture(t);
  const original = await readFile(f.state, "utf8");
  const unrelated = join(f.root, "original-state");
  await writeFile(unrelated, original, { mode: 0o600 });
  await rm(f.state);
  await symlink(unrelated, f.state);
  await assert.rejects(f.manager.reapNative(f.id, "owner"), /identity/);
  assert.equal(await readFile(unrelated, "utf8"), original);
  await rm(f.directory, { recursive: true });
  const other = join(f.root, "other-job");
  await mkdir(other, { mode: 0o700 });
  await writeFile(join(other, "state.json"), original, { mode: 0o600 });
  await symlink(other, f.directory);
  await assert.rejects(f.manager.reapNative(f.id, "owner"), /identity/);
  await stat(join(other, "state.json"));
});

test("symlink and unexpected file entries are not deleted", async t => {
  const f = await fixture(t);
  const unrelated = join(f.root, "unrelated");
  await writeFile(unrelated, "retain", { mode: 0o600 });
  await symlink(unrelated, join(f.directory, "result-1.md"));
  await assert.rejects(f.manager.reapNative(f.id, "owner"), /identity/);
  assert.equal(await readFile(unrelated, "utf8"), "retain");
  await stat(f.state);
  await rm(join(f.directory, "result-1.md"));
  await writeFile(join(f.directory, "unrelated"), "retain", { mode: 0o600 });
  await assert.rejects(f.manager.reapNative(f.id, "owner"), /Unexpected/);
  await stat(f.state);
});
