import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { JobStore } from './store.js';
import { BackgroundJobManager } from './manager.js';
import { OUTPUT_RETENTION_MS } from './retention.js';

const root = await mkdtemp(join(tmpdir(), 'job-retention-races-'));
const store = new JobStore(root);
await store.initialize();
const secondStore = new JobStore(root);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
let sequence = 0;
const terminal = { schemaVersion: 1, status: 'completed', exitCode: 0, finishedAt: new Date().toISOString() };
async function fixture(completed = true) {
  const id = `job-${(++sequence).toString(16).padStart(24, '0')}`;
  await store.create({schemaVersion:1,id,sessionId:'owner',command:':',cwd:root,shell:'/bin/sh',createdAt:new Date().toISOString(),ownerPid:process.pid}, ':', Buffer.alloc(0));
  await store.writeLaunch(id, {schemaVersion:1,windowId:'@1',paneId:'%1',panePid:process.pid,paneStartToken:'fixture',launchedAt:new Date().toISOString()});
  if (completed) await store.publishResult(id, terminal);
  return id;
}
let child;
try {
  // A real second process owns the lock. Live owners cannot be stolen; SIGKILL
  // must not wedge output retrieval or expiry after a Pi restart.
  const script = join(root, 'lock-child.mjs');
  await writeFile(script, `import { JobStore } from ${JSON.stringify(new URL('./store.js', import.meta.url).href)};
    await new JobStore(process.argv[2]).withRetentionLock(async () => {
      setInterval(() => {}, 1000); process.send('locked'); await new Promise(() => {});
    });`);
  child = fork(script, [root], {stdio:['ignore','inherit','inherit','ipc']});
  const [message] = await once(child, 'message');
  assert.equal(message, 'locked');
  let entered = false;
  const contender = secondStore.withRetentionLock(async () => { entered = true; });
  await pause(75);
  assert.equal(entered, false, 'live cross-process owner was bypassed');
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited; child = undefined;
  await contender;
  assert.equal(entered, true, 'dead owner blocked restart');

  // Concurrent dead-owner cleaners cannot remove a successor's lock. Model PID
  // reuse with an impossible start token and exercise eight competing stores.
  const lock = join(root, '.retention-lock');
  await mkdir(lock);
  await writeFile(join(lock, `owner-${process.pid}-${'a'.repeat(32)}`), 'stale-start-token');
  let active = 0, acquisitions = 0;
  await Promise.all(Array.from({length:8}, () => new JobStore(root).withRetentionLock(async () => {
    assert.equal(++active, 1, 'concurrent cleanup stole a live successor lock');
    await pause(5); active--; acquisitions++;
  })));
  assert.equal(acquisitions, 8);
  assert.equal((await readdir(root)).some(name => name.startsWith('.retention-lock')), false);

  // Retrieval owns the lock from snapshot through timestamp publication. The
  // sweeper sees an expired hint but must recheck after the fresh output read.
  const id = await fixture();
  await store.markRetrieved(id, Date.now() - OUTPUT_RETENTION_MS - 1000);
  const captureEntered = gate(), releaseCapture = gate();
  let reaped = 0;
  const backend = {async capture() { captureEntered.resolve(); await releaseCapture.promise; return 'final output'; }, async reap() { reaped++; }};
  const manager = new BackgroundJobManager(store, backend);
  const other = new BackgroundJobManager(secondStore, backend);
  const output = manager.output(id);
  await captureEntered.promise;
  const sweep = other.reapExpired(id, Date.now(), OUTPUT_RETENTION_MS);
  await pause(50);
  assert.equal(reaped, 0, 'expiry crossed the output critical section');
  releaseCapture.resolve();
  assert.equal((await output).text, 'final output');
  await sweep;
  assert.equal(reaped, 0, 'expiry used its stale timestamp hint');
  assert.ok(await store.readRetrieved(id) > Date.now() - 5000);

  // In the opposite ordering an already reaped job cannot be resurrected by a
  // timestamp write from an output read that began before expiry finished.
  await store.markRetrieved(id, Date.now() - OUTPUT_RETENTION_MS - 1000);
  const reapEntered = gate(), releaseReap = gate();
  backend.reap = async () => { reapEntered.resolve(); await releaseReap.promise; reaped++; };
  const deleting = other.reapExpired(id, Date.now(), OUTPUT_RETENTION_MS);
  await reapEntered.promise;
  const lateOutput = manager.output(id);
  const rejected = assert.rejects(lateOutput, /ENOENT/);
  releaseReap.resolve(); await deleting; await rejected;
  assert.equal(await store.exists(store.jobDir(id)), false, 'late reader recreated deleted metadata');

  const unreadableId = await fixture();
  const unreadable = new BackgroundJobManager(store, {async capture() { throw new Error('capture unavailable'); }});
  await assert.rejects(unreadable.output(unreadableId), /capture unavailable/);
  assert.equal(await store.readRetrieved(unreadableId), undefined, 'failed reads must not start retention');
  await store.remove(unreadableId);

  // Completion during a running pane snapshot must not count as inspection of
  // final output, even when a later tool get() observes the terminal result.
  const runningId = await fixture(false);
  const running = new BackgroundJobManager(store, {
    async paneState() { return {exists:true,dead:false}; },
    async capture() { await store.publishResult(runningId, terminal); return 'running snapshot'; },
  });
  assert.equal((await running.output(runningId)).text, 'running snapshot');
  assert.ok((await running.get(runningId)).result);
  assert.equal(await store.readRetrieved(runningId), undefined);
  await running.output(runningId);
  assert.ok(await store.readRetrieved(runningId));
  await store.remove(runningId);

  // Global expiry from a different session/store must wait for worker-session
  // preservation. No data can disappear between inventory and durable copy.
  const sessionId = await fixture();
  await writeFile(store.path(sessionId, 'output.log'), 'preserve me');
  await store.markRetrieved(sessionId, Date.now() - OUTPUT_RETENTION_MS - 1000);
  const preserveEntered = gate(), releasePreserve = gate();
  let preserved = false, deleted = false;
  const sessionBackend = {async reap() { assert.equal(preserved, true); deleted = true; }};
  const owner = new BackgroundJobManager(store, sessionBackend);
  const foreign = new BackgroundJobManager(secondStore, sessionBackend);
  const cleanup = owner.reapSession('owner', async payload => {
    assert.equal(payload.jobs.length, 1);
    assert.equal(payload.jobs[0].output, 'preserve me');
    preserveEntered.resolve(); await releasePreserve.promise; preserved = true;
  });
  await preserveEntered.promise;
  const expiry = foreign.reapExpired(sessionId, Date.now(), OUTPUT_RETENTION_MS).catch(error => {
    assert.equal(error.code, 'ENOENT'); // session cleanup won the race
  });
  await pause(50);
  assert.equal(deleted, false, 'expiry deleted a session awaiting preservation');
  releasePreserve.resolve(); await cleanup; await expiry;
  assert.equal(deleted, true);
  assert.equal(await store.exists(store.jobDir(sessionId)), false);
  console.log('background-job retention races passed: cross-process/dead-owner locks, reset-vs-expiry, no resurrection, snapshot completion, session preservation');
} finally {
  if (child) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  await rm(root, {recursive:true,force:true});
}
