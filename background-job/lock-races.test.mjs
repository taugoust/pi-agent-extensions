import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { constants as osConstants, hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
const { processStartToken } = await import("./tmux.js").catch(() => import("./tmux.ts"));
const { JobStore } = await import("./store.js").catch(() => import("./store.ts"));
const nativeFs = createRequire(import.meta.url)("node:fs/promises");
const nativeReadFile = nativeFs.readFile;
nativeFs.readFile = async (path, ...args) =>
  path === "/etc/machine-id" ? "test-machine-id\n" : await nativeReadFile(path, ...args);
syncBuiltinESMExports();

const roots = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gate = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), "background-lock-races-"));
  roots.push(root);
  return root;
}

async function writeOwner(lock, owner) {
  const name = `owner-${owner.token}`;
  await writeFile(join(lock, name), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  return name;
}

async function localOwner(pid, startToken, token, bootOverride, hostOverride) {
  const [machineId, bootId, pidNamespace] = await Promise.all([
    readFile("/etc/machine-id", "utf8"),
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readFile("/proc/self/ns/pid", "utf8").catch(async () => {
      const { readlink } = await import("node:fs/promises");
      return await readlink("/proc/self/ns/pid");
    }),
  ]);
  return {
    hostname: hostOverride ?? hostname(),
    machineId: machineId.trim(),
    bootId: bootOverride ?? bootId.trim(),
    pidNamespace,
    pid,
    startToken,
    token,
    createdAt: Date.now(),
  };
}

try {
  {
    const root = await makeRoot();
    const store = new JobStore(root);
    const entered = gate();
    const resume = gate();
    const active = store.withLock(async (assertOwned) => {
      entered.resolve();
      await resume.promise;
      await assertOwned();
      await store.create(
        {
          schemaVersion: 1,
          id: `job-${"1".repeat(24)}`,
          command: ":",
          cwd: root,
          shell: "/bin/sh",
          createdAt: new Date().toISOString(),
          ownerPid: process.pid,
        },
        ":",
        Buffer.alloc(0),
      );
    });
    await entered.promise;
    const lock = join(root, ".lock");
    await rm(lock, { recursive: true });
    await mkdir(lock);
    await writeFile(join(lock, "successor"), "retain", { mode: 0o600 });
    resume.resolve();
    await assert.rejects(active, /state lock ownership lost/);
    assert.equal(await readFile(join(lock, "successor"), "utf8"), "retain");
    assert.equal(await store.exists(store.jobDir(`job-${"1".repeat(24)}`)), false);
  }

  {
    const root = await makeRoot();
    const store = new JobStore(root);
    const entered = gate();
    const resume = gate();
    const owner = store.withLock(async (assertOwned) => {
      entered.resolve();
      await resume.promise;
      await assertOwned();
    });
    await entered.promise;
    const old = new Date(Date.now() - 60_000);
    await utimes(join(root, ".lock"), old, old);
    await assert.rejects(
      new JobStore(root).withLock(async () => {}),
      /Timed out acquiring the background-job state lock/,
    );
    resume.resolve();
    await owner;
  }

  {
    const root = await makeRoot();
    const lock = join(root, ".lock");
    await mkdir(lock);
    const dead = await localOwner(2_147_483_647, "linux-proc:0", "d".repeat(32));
    const staleName = await writeOwner(lock, dead);
    const stalePath = join(lock, staleName);
    const originalReadFile = nativeFs.readFile;
    const observed = gate();
    const proceed = gate();
    let observations = 0;
    nativeFs.readFile = async (...args) => {
      const result = await originalReadFile(...args);
      if (args[0] === stalePath && observations < 2) {
        observations++;
        if (observations === 2) observed.resolve();
        await proceed.promise;
      }
      return result;
    };
    syncBuiltinESMExports();
    const contenders = [
      new JobStore(root).withLock(async () => {}),
      new JobStore(root).withLock(async () => {}),
    ];
    await observed.promise;
    await rm(stalePath);
    await import("node:fs/promises").then(({ rmdir }) => rmdir(lock));
    await mkdir(lock);
    const successor = await localOwner(
      process.pid,
      await processStartToken(process.pid),
      "e".repeat(32),
    );
    const successorName = await writeOwner(lock, successor);
    proceed.resolve();
    nativeFs.readFile = originalReadFile;
    syncBuiltinESMExports();
    await Promise.all(
      contenders.map((contender) =>
        assert.rejects(contender, /Timed out acquiring the background-job state lock/),
      ),
    );
    assert.deepEqual(await readdir(lock), [successorName]);
  }

  {
    const root = await makeRoot();
    const store = new JobStore(root);
    await store.initialize();
    const lock = join(root, ".lock");
    await mkdir(lock);
    const dead = await localOwner(2_147_483_647, "linux-proc:0", "6".repeat(32));
    const ownerName = await writeOwner(lock, dead);
    const reader = await open(join(lock, ownerName), "r");
    try {
      let acquired = false;
      await store.withLock(async () => {
        acquired = true;
      });
      assert.equal(acquired, true, "open reader delayed the next owner until empty-lock grace");
      assert.equal(JSON.parse(await reader.readFile("utf8")).token, dead.token);
    } finally {
      await reader.close();
    }
    const retired = join(root, `.lock-retired-${"5".repeat(32)}`);
    await writeFile(retired, "leftover retired owner", { mode: 0o600 });
    await store.withLock(async () => {
      assert.equal(await store.exists(retired), false, "retired owner was not swept");
    });
    assert.equal(
      (await readdir(root)).some((name) => /^\.lock-retired-[a-f0-9]{32}$/.test(name)),
      false,
    );
  }

  {
    const root = await makeRoot();
    const lock = join(root, ".lock");
    await mkdir(lock);
    const interruptedOwner = await localOwner(
      process.pid,
      await processStartToken(process.pid),
      "7".repeat(32),
    );
    const interruptedName = await writeOwner(lock, interruptedOwner);
    await rm(join(lock, interruptedName));
    const aged = new Date(Date.now() - 31_000);
    await utimes(lock, aged, aged);
    let acquired = false;
    await new JobStore(root).withLock(async () => {
      acquired = true;
    });
    assert.equal(acquired, true, "aged empty release window was not recovered");
  }

  {
    const root = await makeRoot();
    const lock = join(root, ".lock");
    await mkdir(lock);
    const aged = new Date(Date.now() - 31_000);
    await utimes(lock, aged, aged);
    const originalReaddir = nativeFs.readdir;
    let staleOnce = true;
    nativeFs.readdir = async (path, ...args) => {
      if (path === lock && staleOnce) {
        staleOnce = false;
        const error = new Error("simulated NFS stale handle");
        error.errno = -osConstants.errno.ESTALE;
        error.code = `Unknown system error -${osConstants.errno.ESTALE}`;
        throw error;
      }
      return await originalReaddir(path, ...args);
    };
    syncBuiltinESMExports();
    try {
      let acquired = false;
      await new JobStore(root).withLock(async () => {
        acquired = true;
      });
      assert.equal(staleOnce, false);
      assert.equal(acquired, true, "ESTALE acquisition observation was not retried");
    } finally {
      nativeFs.readdir = originalReaddir;
      syncBuiltinESMExports();
    }
  }

  {
    const root = await makeRoot();
    const lock = join(root, ".lock");
    await mkdir(lock);
    await assert.rejects(
      new JobStore(root).withLock(async () => {}),
      /Timed out acquiring the background-job state lock/,
    );
    assert.deepEqual(await readdir(lock), [], "young empty lock was replaced");
  }

  {
    for (const reclaim of [false, true]) {
      const root = await makeRoot();
      const lock = join(root, ".lock");
      if (reclaim) {
        await mkdir(lock);
        await writeOwner(lock, await localOwner(2_147_483_647, "linux-proc:0", "8".repeat(32)));
      }
      const originalRmdir = nativeFs.rmdir;
      let busyOnce = true;
      nativeFs.rmdir = async (path, ...args) => {
        if (path === lock && busyOnce) {
          busyOnce = false;
          const error = new Error("simulated transient NFS sillyrename");
          error.code = "ENOTEMPTY";
          throw error;
        }
        return await originalRmdir(path, ...args);
      };
      syncBuiltinESMExports();
      try {
        await new JobStore(root).withLock(async () => {});
        assert.equal(busyOnce, false);
        assert.equal(await new JobStore(root).exists(lock), false);
      } finally {
        nativeFs.rmdir = originalRmdir;
        syncBuiltinESMExports();
      }
    }
  }

  {
    const root = await makeRoot();
    const lock = join(root, ".lock");
    await mkdir(lock);
    const dead = await localOwner(2_147_483_647, "linux-proc:0", "a".repeat(32));
    await writeOwner(lock, dead);
    let active = 0;
    let maximum = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        new JobStore(root).withLock(async (assertOwned) => {
          await assertOwned();
          active++;
          maximum = Math.max(maximum, active);
          await pause(10);
          active--;
        }),
      ),
    );
    assert.equal(maximum, 1, "concurrent dead-owner reclaimers overlapped");
  }

  {
    const root = await makeRoot();
    const lock = join(root, ".lock");
    await mkdir(lock);
    const priorBoot = await localOwner(
      process.pid,
      await processStartToken(process.pid),
      "f".repeat(32),
      "previous-boot",
      "old-hostname",
    );
    await writeOwner(lock, priorBoot);
    let acquired = false;
    await new JobStore(root).withLock(async () => {
      acquired = true;
    });
    assert.equal(acquired, true, "same-machine prior-boot lock was not reclaimed");
  }

  {
    const root = await makeRoot();
    const lock = join(root, ".lock");
    await mkdir(lock);
    const unknownBoot = await localOwner(2_147_483_647, "linux-proc:0", "9".repeat(32), "");
    await writeOwner(lock, unknownBoot);
    await assert.rejects(
      new JobStore(root).withLock(async () => {}),
      /Timed out acquiring the background-job state lock/,
    );
    assert.deepEqual(await readdir(lock), [`owner-${unknownBoot.token}`]);
  }

  {
    const root = await makeRoot();
    const lock = join(root, ".lock");
    await mkdir(lock);
    const legacy = await localOwner(2_147_483_647, "linux-proc:0", "b".repeat(32));
    const legacyToken = `${process.pid}-${Date.now()}-legacy`;
    await writeFile(join(lock, "owner"), legacyToken, { mode: 0o600 });
    const remote = await makeRoot();
    const remoteLock = join(remote, ".lock");
    await mkdir(remoteLock);
    const unknown = {
      ...legacy,
      hostname: "other-host",
      machineId: "other-machine",
      token: "c".repeat(32),
    };
    await writeOwner(remoteLock, unknown);
    const [legacyError, remoteError] = await Promise.all([
      new JobStore(root)
        .withLock(async () => {})
        .then(
          () => undefined,
          (error) => error,
        ),
      new JobStore(remote)
        .withLock(async () => {})
        .then(
          () => undefined,
          (error) => error,
        ),
    ]);
    assert.match(legacyError.message, new RegExp(`${lock.replaceAll("/", "\\/")}.*legacy`));
    assert.match(legacyError.message, new RegExp(`pid=${process.pid} age=[0-9]+ms`));
    assert.ok(
      legacyError.message.includes(`legacy token=${JSON.stringify(legacyToken)} host=unknown`),
    );
    assert.match(
      legacyError.message,
      /verify the old owner is not running before manually clearing/,
    );
    assert.match(remoteError.message, new RegExp(`${remoteLock.replaceAll("/", "\\/")}`));
    assert.match(remoteError.message, /host=other-host pid=2147483647 age=[0-9]+ms/);
    assert.deepEqual(await readdir(lock), ["owner"]);
    assert.deepEqual(await readdir(remoteLock), [`owner-${unknown.token}`]);
  }

  console.log(
    "background-job lock races passed: resumed owner, live stale owner, dead owner, " +
      "parallel reclaimers, remote/legacy owners",
  );
} finally {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}
