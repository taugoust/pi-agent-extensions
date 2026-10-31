import assert from "node:assert/strict";
import { test } from "node:test";
import { fork } from "node:child_process";
import { mkdtemp, mkdir, open, unlink, rm, lstat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskNameStore } from "./task-name-store.ts";

const identity = { ownerSessionId: "owner", taskId: "a", groupId: "group", childId: "a", attempt: 1, runtimeId: "a", workerEpoch: "a" };

for (const dropEvents of [false, true]) test(`real cross-process simultaneous claims and renames wait for live lock without losing aliases (notifications ${dropEvents ? "dropped" : "normal"})`, { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-name-contention-"));
  try {
    await mkdir(join(root, "task-names"), { mode: 0o700 });
    for (const operation of ["claim", "rename"]) {
      const lock = join(root, "task-names", ".write-lock");
      const fd = await open(lock, "wx", 0o600);
      const workers = ["a", "b", "c", "d"].map(id => {
        const child = fork(new URL("./task-name-contention.fixture.mjs", import.meta.url), [root, id, operation], { stdio: ["ignore", "inherit", "inherit", "ipc"], env: { ...process.env, PI_NAME_DROP_EVENTS: dropEvents ? "1" : "0" } });
        let ready!: () => void;
        const loaded = new Promise<void>(resolve => { ready = resolve; });
        let contended!: () => void;
        const barrier = new Promise<void>(resolve => { contended = resolve; });
        const messages: any[] = [];
        child.on("message", (message: any) => { messages.push(message); if (message.contended) contended(); if (message.ready) ready(); });
        const finished = new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
        return { child, loaded, barrier, finished, messages };
      });
      try {
        await Promise.all(workers.map(worker => worker.loaded));
        for (const worker of workers) worker.child.send({ begin: true });
        await Promise.all(workers.map(worker => worker.barrier));
        // All four actually attempted acquisition while a live owner held it.
        assert.equal((await lstat(lock)).ino, (await fd.stat()).ino);
      } finally { await fd.close(); await unlink(lock); }
      const exits = await Promise.all(workers.map(worker => worker.finished));
      assert.deepEqual(exits, [0, 0, 0, 0], JSON.stringify(workers.map(worker => worker.messages)));
      const records = workers.map(worker => worker.messages.find(message => message.result)?.result);
      assert.equal(new Set(records.map(record => record.alias)).size, 4);
      assert.ok(records.every(record => record.revision === (operation === "claim" ? 1 : 2)));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("orphan lock fails bounded and remains untouched; symlink lock is rejected", { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-name-orphan-"));
  try {
    await mkdir(join(root, "task-names"), { mode: 0o700 });
    const lock = join(root, "task-names", ".write-lock");
    const fd = await open(lock, "wx", 0o600);
    const inode = (await fd.stat()).ino;
    await fd.close();
    const store = new TaskNameStore(join(root, "workers", "a"), identity);
    await assert.rejects(store.claim("Safe Failure"), /contention timed out.*lock retained/);
    assert.equal((await lstat(lock)).ino, inode);
    await unlink(lock);
    await symlink(join(root, "victim"), lock);
    await assert.rejects(store.claim("Unsafe Lock"), /Unsafe canonical name lock/);
    assert.ok((await lstat(lock)).isSymbolicLink());
  } finally { await rm(root, { recursive: true, force: true }); }
});
