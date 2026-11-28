import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { JobStore } from "./store.js";
import { BackgroundJobManager } from "./manager.js";
import { OUTPUT_RETENTION_MS } from "./retention.js";

const root = await mkdtemp(join(tmpdir(), "job-retention-races-"));
const store = new JobStore(root);
await store.initialize();
const secondStore = new JobStore(root);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gate = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
let sequence = 0;
const terminal = {
  schemaVersion: 1,
  status: "completed",
  exitCode: 0,
  finishedAt: new Date().toISOString(),
};
async function fixture(completed = true) {
  const id = `job-${(++sequence).toString(16).padStart(24, "0")}`;
  await store.create(
    {
      schemaVersion: 1,
      id,
      sessionId: "owner",
      command: ":",
      cwd: root,
      shell: "/bin/sh",
      createdAt: new Date().toISOString(),
      ownerPid: process.pid,
    },
    ":",
    Buffer.alloc(0),
  );
  await store.writeLaunch(id, {
    schemaVersion: 1,
    windowId: "@1",
    paneId: "%1",
    panePid: process.pid,
    paneStartToken: "fixture",
    launchedAt: new Date().toISOString(),
  });
  if (completed) await store.publishResult(id, terminal);
  return id;
}
let child;
try {
  // A real second process owns the lock. Live owners cannot be stolen; SIGKILL
  // must not wedge output retrieval or expiry after a Pi restart.
  const script = join(root, "lock-child.mjs");
  await writeFile(
    script,
    `import { JobStore } from ${JSON.stringify(new URL("./store.js", import.meta.url).href)};
    await new JobStore(process.argv[2]).withRetentionLock(async () => {
      setInterval(() => {}, 1000); process.send('locked'); await new Promise(() => {});
    });`,
  );
  child = fork(script, [root], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const [message] = await once(child, "message");
  assert.equal(message, "locked");
  let entered = false;
  const contender = secondStore.withRetentionLock(async () => {
    entered = true;
  });
  await pause(75);
  assert.equal(entered, false, "live cross-process owner was bypassed");
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  child = undefined;
  await contender;
  assert.equal(entered, true, "dead owner blocked restart");

  // Concurrent dead-owner cleaners cannot remove a successor's lock. Model PID
  // reuse with an impossible start token and exercise eight competing stores.
  const lock = join(root, ".retention-lock");
  await mkdir(lock);
  await writeFile(join(lock, `owner-${process.pid}-${"a".repeat(32)}`), "stale-start-token");
  let active = 0,
    acquisitions = 0;
  await Promise.all(
    Array.from({ length: 8 }, () =>
      new JobStore(root).withRetentionLock(async () => {
        assert.equal(++active, 1, "concurrent cleanup stole a live successor lock");
        await pause(5);
        active--;
        acquisitions++;
      }),
    ),
  );
  assert.equal(acquisitions, 8);
  assert.equal(
    (await readdir(root)).some((name) => name.startsWith(".retention-lock")),
    false,
  );

  // Retrieval owns the lock from snapshot through timestamp publication. The
  // sweeper sees an expired hint but must recheck after the fresh output read.
  const id = await fixture();
  await store.markRetrieved(id, Date.now() - OUTPUT_RETENTION_MS - 1000);
  const captureEntered = gate(),
    releaseCapture = gate();
  let reaped = 0;
  const backend = {
    async capture() {
      captureEntered.resolve();
      await releaseCapture.promise;
      return "final output";
    },
    async reap() {
      reaped++;
    },
  };
  const manager = new BackgroundJobManager(store, backend);
  const other = new BackgroundJobManager(secondStore, backend);
  const output = manager.output(id);
  await captureEntered.promise;
  const sweep = other.reapExpired(id, Date.now(), OUTPUT_RETENTION_MS);
  await pause(50);
  assert.equal(reaped, 0, "expiry crossed the output critical section");
  releaseCapture.resolve();
  assert.equal((await output).text, "final output");
  await sweep;
  assert.equal(reaped, 0, "expiry used its stale timestamp hint");
  assert.ok((await store.readRetrieved(id)) > Date.now() - 5000);

  // In the opposite ordering an already reaped job cannot be resurrected by a
  // timestamp write from an output read that began before expiry finished.
  await store.markRetrieved(id, Date.now() - OUTPUT_RETENTION_MS - 1000);
  const reapEntered = gate(),
    releaseReap = gate();
  backend.reap = async () => {
    reapEntered.resolve();
    await releaseReap.promise;
    reaped++;
  };
  const deleting = other.reapExpired(id, Date.now(), OUTPUT_RETENTION_MS);
  await reapEntered.promise;
  const lateOutput = manager.output(id);
  const rejected = assert.rejects(lateOutput, /ENOENT/);
  releaseReap.resolve();
  await deleting;
  await rejected;
  assert.equal(
    await store.exists(store.jobDir(id)),
    false,
    "late reader recreated deleted metadata",
  );

  const transientRemovalId = await fixture();
  const originalRemoveOnce = store.removeOnce;
  let lateFileCreated = false;
  store.removeOnce = async function (path) {
    if (!lateFileCreated) {
      lateFileCreated = true;
      await writeFile(join(path, "late-output"), "late", { mode: 0o600 });
      const error = new Error("directory changed during removal");
      error.code = "ENOTEMPTY";
      throw error;
    }
    return await originalRemoveOnce.call(this, path);
  };
  await store.remove(transientRemovalId);
  store.removeOnce = originalRemoveOnce;
  assert.equal(lateFileCreated, true, "late output entry was not exercised");
  assert.equal(await store.exists(store.jobDir(transientRemovalId)), false);
  assert.equal(
    await store.exists(join(store.jobsRoot, `.${transientRemovalId}.removal.json`)),
    false,
  );

  const busyRemovalId = await fixture();
  let busyOnce = true;
  store.removeOnce = async function (path) {
    if (busyOnce) {
      busyOnce = false;
      const error = new Error("NFS open-file busy");
      error.code = "EBUSY";
      throw error;
    }
    return await originalRemoveOnce.call(this, path);
  };
  await store.remove(busyRemovalId);
  store.removeOnce = originalRemoveOnce;
  assert.equal(busyOnce, false, "busy-file retry was not exercised");

  const readerRemovalId = await fixture();
  const activeReaderEntered = gate(),
    releaseActiveReader = gate();
  const reader = store.withReader(readerRemovalId, async () => {
    activeReaderEntered.resolve();
    await releaseActiveReader.promise;
  });
  await activeReaderEntered.promise;
  let removeFinished = false;
  const readerRemoval = store.remove(readerRemovalId).then(() => {
    removeFinished = true;
  });
  await pause(25);
  assert.equal(removeFinished, false, "removal passed an active local reader");
  releaseActiveReader.resolve();
  await Promise.all([reader, readerRemoval]);
  assert.equal(removeFinished, true);

  const queuedRemovalId = await fixture();
  const removeEntered = gate(),
    failRemove = gate(),
    readerEntered = gate(),
    releaseReader = gate();
  let failFirstRemoval = true;
  let readerHasEntered = false;
  store.removeOnce = async function (path) {
    if (!failFirstRemoval) return await originalRemoveOnce.call(this, path);
    failFirstRemoval = false;
    removeEntered.resolve();
    await failRemove.promise;
    const error = new Error("first removal failed");
    error.code = "EACCES";
    throw error;
  };
  const firstRemoval = store.remove(queuedRemovalId).catch((error) => error);
  await removeEntered.promise;
  const queuedReader = store.withReader(queuedRemovalId, async () => {
    readerHasEntered = true;
    readerEntered.resolve();
    await releaseReader.promise;
  });
  await pause(10);
  assert.equal(readerHasEntered, false, "queued reader entered before removal released it");
  let secondRemovalFinished = false;
  const secondRemoval = store.remove(queuedRemovalId).then(() => {
    secondRemovalFinished = true;
  });
  failRemove.resolve();
  await readerEntered.promise;
  await pause(10);
  assert.equal(secondRemovalFinished, false, "second removal passed a queued reader");
  releaseReader.resolve();
  assert.equal((await firstRemoval).code, "EACCES");
  await Promise.all([queuedReader, secondRemoval]);
  store.removeOnce = originalRemoveOnce;

  const retryRemovalId = await fixture();
  store.removeOnce = async function () {
    const error = new Error("permission denied during cleanup");
    error.code = "EACCES";
    throw error;
  };
  await assert.rejects(store.remove(retryRemovalId), { code: "EACCES" });
  const retryManager = new BackgroundJobManager(store, { async reap() {} });
  const preservedRecord = await retryManager.get(retryRemovalId);
  assert.equal(preservedRecord.metadata.id, retryRemovalId);
  await assert.rejects(
    retryManager.get(retryRemovalId, false, () => {
      throw new Error("foreign owner");
    }),
    /foreign owner/,
  );
  assert.equal(preservedRecord.result.status, "completed");
  store.removeOnce = originalRemoveOnce;
  await retryManager.reap(retryRemovalId);
  assert.equal(await store.readRemovalIntent(retryRemovalId), undefined);
  assert.equal(await store.exists(store.jobDir(retryRemovalId)), false);

  const verifiedRemovalId = await fixture();
  let verifiedPaneReaps = 0;
  const verifiedBackend = {
    async reap() {
      if (++verifiedPaneReaps > 1) throw new Error("pane identity changed after removal began");
    },
  };
  const verifiedManager = new BackgroundJobManager(store, verifiedBackend);
  store.removeOnce = async function () {
    const error = new Error("NFS busy file held open");
    error.code = "EBUSY";
    throw error;
  };
  await verifiedManager.reap(verifiedRemovalId);
  store.removeOnce = originalRemoveOnce;
  await verifiedManager.reap(verifiedRemovalId);
  assert.equal(verifiedPaneReaps, 1, "retry repeated pane mutation from removal intent");

  const restartReceiptId = await fixture();
  let restartPaneReaps = 0;
  const restartBackend = {
    async reap() {
      if (++restartPaneReaps > 1) throw new Error("restart repeated pane mutation");
    },
  };
  const restartManager = new BackgroundJobManager(store, restartBackend);
  store.removeOnce = async function () {
    const error = new Error("NFS busy file held open");
    error.code = "EBUSY";
    throw error;
  };
  await restartManager.reap(restartReceiptId);
  store.removeOnce = originalRemoveOnce;
  const restartedStore = new JobStore(root);
  await restartedStore.initialize();
  const receipt = await restartedStore.readRemovalIntent(restartReceiptId);
  assert.ok(receipt?.cleanedAt, "startup did not retain a cleanup receipt");
  const receiptInfo = await stat(join(store.jobsRoot, `.${restartReceiptId}.removal.json`));
  assert.equal(receiptInfo.mode & 0o777, 0o600, "receipt is not a private file");
  assert.equal(receiptInfo.uid, (await stat(store.jobsRoot)).uid);
  const restartedManager = new BackgroundJobManager(restartedStore, restartBackend);
  await restartedManager.reap(restartReceiptId);
  assert.equal(restartPaneReaps, 1, "startup retry repeated pane mutation");
  assert.equal(await restartedStore.readRemovalIntent(restartReceiptId), undefined);

  const concurrentSweepId = await fixture();
  const concurrentIntentPath = join(store.jobsRoot, `.${concurrentSweepId}.removal.json`);
  const concurrentIntent = {
    metadata: await store.readMetadata(concurrentSweepId),
    launch: await store.readLaunch(concurrentSweepId),
    result: await store.readResult(concurrentSweepId),
    reapVerified: true,
  };
  await writeFile(concurrentIntentPath, `${JSON.stringify(concurrentIntent)}\n`, { mode: 0o600 });
  const concurrentTombstone = `${store.jobDir(concurrentSweepId)}.removing-99999-${"a".repeat(16)}`;
  const sourceObserved = gate(),
    continueSweep = gate();
  const originalExists = restartedStore.exists;
  let blockedAtSource = false;
  restartedStore.exists = async function (path) {
    if (!blockedAtSource && path === this.jobDir(concurrentSweepId)) {
      blockedAtSource = true;
      sourceObserved.resolve();
      await continueSweep.promise;
    }
    return await originalExists.call(this, path);
  };
  const concurrentInitialize = restartedStore.initialize();
  await sourceObserved.promise;
  await rename(store.jobDir(concurrentSweepId), concurrentTombstone);
  continueSweep.resolve();
  await concurrentInitialize;
  restartedStore.exists = originalExists;
  assert.equal(await store.exists(concurrentTombstone), false, "sweep missed a concurrent rename");
  assert.ok((await restartedStore.readRemovalIntent(concurrentSweepId))?.cleanedAt);
  await restartedStore.remove(concurrentSweepId);

  const staleReceiptId = await fixture();
  const staleManager = new BackgroundJobManager(store, { async reap() {} });
  store.removeOnce = async function () {
    const error = new Error("NFS busy file held open");
    error.code = "EBUSY";
    throw error;
  };
  await staleManager.reap(staleReceiptId);
  store.removeOnce = originalRemoveOnce;
  await restartedStore.initialize();
  const staleReceiptPath = join(store.jobsRoot, `.${staleReceiptId}.removal.json`);
  const staleReceipt = JSON.parse(await readFile(staleReceiptPath, "utf8"));
  staleReceipt.cleanedAt = Date.now() - 24 * 60 * 60 * 1000 - 1;
  await writeFile(staleReceiptPath, `${JSON.stringify(staleReceipt)}\n`, { mode: 0o600 });
  await restartedStore.initialize();
  assert.equal(await restartedStore.readRemovalIntent(staleReceiptId), undefined);
  await assert.rejects(staleManager.get(staleReceiptId), /ENOENT/);

  const deferredRemovalId = await fixture();
  let upgradedPaneReaps = 0;
  const upgradeManager = new BackgroundJobManager(store, {
    async reap() {
      if (++upgradedPaneReaps > 1) throw new Error("unverified intent retried pane mutation");
    },
  });
  store.removeOnce = async function () {
    const error = new Error("persistent NFS busy file");
    error.code = "EBUSY";
    throw error;
  };
  await store.remove(deferredRemovalId);
  await upgradeManager.reap(deferredRemovalId);
  assert.equal(upgradedPaneReaps, 1);
  assert.equal((await store.readRemovalIntent(deferredRemovalId)).reapVerified, true);
  store.removeOnce = originalRemoveOnce;
  await upgradeManager.reap(deferredRemovalId);
  assert.equal(upgradedPaneReaps, 1, "retry repeated pane mutation after intent upgrade");
  assert.equal(await store.readRemovalIntent(deferredRemovalId), undefined);

  const pendingRemovalId = await fixture();
  const legacyRemovalId = await fixture();
  const legacyRemoval = join(store.jobsRoot, `${legacyRemovalId}.removing-99999`);
  await mkdir(legacyRemoval);
  const unrelatedId = await fixture();
  store.removeOnce = async function () {
    const error = new Error("cleanup temporarily lacks permission");
    error.code = "EACCES";
    throw error;
  };
  await assert.rejects(store.remove(pendingRemovalId), { code: "EACCES" });
  await store.initialize();
  assert.ok(await store.exists(legacyRemoval), "permission failure dropped legacy tombstone");
  assert.ok(await store.readRemovalIntent(pendingRemovalId));
  assert.equal((await store.readMetadata(unrelatedId)).id, unrelatedId);
  store.removeOnce = originalRemoveOnce;
  await store.initialize();
  assert.equal(await store.exists(legacyRemoval), false, "legacy tombstone was not retried");
  assert.equal(await store.readRemovalIntent(pendingRemovalId), undefined);
  await store.remove(legacyRemovalId);
  await store.remove(unrelatedId);

  await assert.rejects(store.readRemovalIntent("not-a-job-id"), /Invalid background job ID/);
  const corruptIntentId = await fixture();
  const corruptIntent = join(store.jobsRoot, `.${corruptIntentId}.removal.json`);
  await writeFile(corruptIntent, "{}\n", { mode: 0o600 });
  await store.initialize();
  assert.ok(await store.exists(corruptIntent));
  await assert.rejects(store.readRemovalIntent(corruptIntentId), /missing field/);
  await rm(corruptIntent, { force: true });
  await store.remove(corruptIntentId);

  const unreadableId = await fixture();
  const unreadable = new BackgroundJobManager(store, {
    async capture() {
      throw new Error("capture unavailable");
    },
  });
  await assert.rejects(unreadable.output(unreadableId), /capture unavailable/);
  assert.equal(
    await store.readRetrieved(unreadableId),
    undefined,
    "failed reads must not start retention",
  );
  await store.remove(unreadableId);

  // Completion during a running pane snapshot must not count as inspection of
  // final output, even when a later tool get() observes the terminal result.
  const runningId = await fixture(false);
  const running = new BackgroundJobManager(store, {
    async paneState() {
      return { exists: true, dead: false };
    },
    async capture() {
      await store.publishResult(runningId, terminal);
      return "running snapshot";
    },
  });
  assert.equal((await running.output(runningId)).text, "running snapshot");
  assert.ok((await running.get(runningId)).result);
  assert.equal(await store.readRetrieved(runningId), undefined);
  await running.output(runningId);
  assert.ok(await store.readRetrieved(runningId));
  await store.remove(runningId);

  // Global expiry from a different session/store must wait for worker-session
  // preservation. No data can disappear between inventory and durable copy.
  const sessionId = await fixture();
  await writeFile(store.path(sessionId, "output.log"), "preserve me", { mode: 0o600 });
  await store.markRetrieved(sessionId, Date.now() - OUTPUT_RETENTION_MS - 1000);
  const preserveEntered = gate(),
    releasePreserve = gate();
  let preserved = false,
    deleted = false;
  const sessionBackend = {
    async reap() {
      assert.equal(preserved, true);
      deleted = true;
    },
  };
  const owner = new BackgroundJobManager(store, sessionBackend);
  const foreign = new BackgroundJobManager(secondStore, sessionBackend);
  const cleanup = owner.reapSession("owner", async (payload) => {
    assert.equal(payload.jobs.length, 1);
    assert.equal(payload.jobs[0].output, "preserve me");
    preserveEntered.resolve();
    await releasePreserve.promise;
    preserved = true;
  });
  await preserveEntered.promise;
  const expiry = foreign.reapExpired(sessionId, Date.now(), OUTPUT_RETENTION_MS).catch((error) => {
    assert.equal(error.code, "ENOENT"); // session cleanup won the race
  });
  await pause(50);
  assert.equal(deleted, false, "expiry deleted a session awaiting preservation");
  releasePreserve.resolve();
  await cleanup;
  await expiry;
  assert.equal(deleted, true);
  assert.equal(await store.exists(store.jobDir(sessionId)), false);
  // A reap sent alongside cancel waits for the cancel to land instead of failing.
  const reapBackend = {
    async paneState() {
      return { exists: true, dead: false };
    },
    async reap() {},
  };
  const reaper = new BackgroundJobManager(store, reapBackend);
  const stillRunning = await fixture(false);
  await assert.rejects(reaper.reap(stillRunning), /still running; cancel it before reaping/);
  await writeFile(join(store.jobDir(stillRunning), "cancel-requested"), "", { mode: 0o600 });
  const reaping = reaper.reap(stillRunning);
  await pause(150);
  await store.publishResult(stillRunning, { ...terminal, status: "cancelled" });
  await reaping;
  assert.equal(
    await store.exists(store.jobDir(stillRunning)),
    false,
    "reap after cancel left the job",
  );
  console.log(
    "background-job retention races passed: cross-process/dead-owner locks, reset-vs-expiry, no resurrection, snapshot completion, session preservation, reap waits for cancel",
  );
} finally {
  if (child) {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
  await rm(root, { recursive: true, force: true });
}
