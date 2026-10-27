import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeTaskStore, createTaskId } from "./resume.ts";

test("stop proof is task/attempt scoped, process fenced, and independent of inventory pagination", async () => {
  const root = await mkdtemp(join(tmpdir(), "goal-stop-"));
  try {
    const store = new NativeTaskStore(root), id = createTaskId();
    const child = "subagent-child-" + "a".repeat(24);
    await store.create("s", id, { task: "isolated stop test", cwd: root, model: "gpt-6.1-sol" }, child);
    await assert.rejects(store.verifyStopped("s", id, child, 1), /still running/);
    await store.finish("s", id, child);
    await store.verifyStopped("s", id, child, 1);
    await assert.rejects(store.verifyStopped("s", id, child, 2), /ownership changed/);
    await assert.rejects(store.verifyStopped("foreign-session", id, child, 1), /another parent session/);
    await assert.rejects(store.bindChild("s", id, child, process.pid), /ownership changed/);
    const successor = "subagent-child-" + "b".repeat(24);
    await store.beginResume("s", id, successor);
    await store.bindChild("s", id, successor, process.pid);
    await store.finish("s", id, successor);
    await assert.rejects(store.verifyStopped("s", id, successor, 2), /child stop cannot be verified/);
    const unbound = createTaskId();
    await store.create("s", unbound, { task: "spawn-to-bind crash fixture", cwd: root }, child);
    const statePath = join(root, unbound, "state.json");
    const crashed = JSON.parse(await readFile(statePath, "utf8"));
    crashed.ownerPid = 2147483647; crashed.ownerToken = "dead-owner";
    await writeFile(statePath, JSON.stringify(crashed));
    await assert.rejects(store.verifyStopped("s", unbound, child, 1), /cleanup grace/);
    const recovery = JSON.parse(await readFile(statePath, "utf8"));
    assert(recovery.recoveryAfter > Date.now());
    recovery.recoveryAfter = Date.now() - 1; // deterministic elapsed-grace simulation, no real process
    await writeFile(statePath, JSON.stringify(recovery));
    await store.verifyStopped("s", unbound, child, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
