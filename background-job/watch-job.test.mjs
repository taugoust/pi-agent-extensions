// Watches on a native job's own output while the job is still running.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JobStore } from './store.js';
import { WatchManager } from './watch.js';
import { scanWatch } from './watch-runner.mjs';

const runner = new URL('./runner.mjs', import.meta.url).pathname;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'watch-job-'));
const store = new JobStore(path.join(root, 'state'));
const records = new Map();
const service = {
  store,
  async get(id) { if (!records.has(id)) throw new Error('missing'); return records.get(id); },
  async start(p) {
    const r = { metadata: { id: 'job-ffffffffffffffffffffffff', sessionId: p.sessionId }, status: 'running' };
    records.set(r.metadata.id, r);
    return r;
  },
};
const watches = new WatchManager(service, 'owner');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startJob(id, command, logBound = '65536') {
  const dir = store.jobDir(id);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.readFile(`/proc/${process.pid}/stat`, 'utf8');
  const token = `linux-proc:${stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]}`;
  await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify({ ownerPid: process.pid, ownerToken: token }));
  await fs.writeFile(path.join(dir, 'command'), command);
  await fs.writeFile(path.join(dir, 'environment'), `PATH=${process.env.PATH}\0`);
  records.set(id, { metadata: { id, sessionId: 'owner' }, status: 'running' });
  const child = spawn(process.execPath, [runner, dir, '/bin/sh', logBound], { stdio: 'ignore' });
  const closed = new Promise(resolve => child.once('close', resolve));
  while (!(await fs.stat(path.join(dir, 'runner-ready')).catch(() => null))) await sleep(5);
  return { dir, closed };
}

async function scanUntilDone(watchId, closed) {
  const file = path.join(watches.root, `${watchId}.json`);
  let now = Date.now(), done = false;
  closed.then(() => { done = true; });
  for (;;) {
    const w = scanWatch(file, now += 250);
    if (w.status !== 'running') break;
    if (done) { scanWatch(file, now += 250); break; }
    await sleep(50);
  }
  const events = [];
  for (let after = 0; ;) {
    const page = await watches.events(watchId, after);
    events.push(...page.events);
    if (page.events.length === 0) return events;
    after = page.next_sequence;
  }
}

try {
  // The job is quiet at first, so it has no output yet when the watch starts.
  const quiet = 'job-111111111111111111111111';
  const first = await startJob(quiet,
    "sleep .4; printf 'stage one\\n'; sleep .4; printf 'stage two\\n'; sleep .4; printf 'stage three\\n'");
  const watch = await watches.create(root, {
    job_id: quiet, from: 'start', patterns: [{ name: 'stage', match: 'stage' }], poll_ms: 250,
  });
  await fs.writeFile(path.join(first.dir, 'launch-ready'), '');
  const events = await scanUntilDone(watch.watch_id, first.closed);
  const matches = events.filter(e => e.kind === 'match').map(e => e.text);
  assert.deepEqual(matches, ['stage one', 'stage two', 'stage three'], 'each line matched exactly once');
  assert(!events.some(e => ['rotated', 'truncated', 'read-error'].includes(e.kind)),
    `log rewrites surfaced as events: ${JSON.stringify(events)}`);
  assert.equal(events.at(-1).kind, 'terminal');

  // Output that leaves the bounded log before a scan is reported as dropped,
  // and later output is still matched once.
  const burst = 'job-222222222222222222222222';
  const second = await startJob(burst,
    "printf 'early stage\\n'; yes filler | head -c 100000; printf '\\nlate stage\\n'");
  const burstWatch = await watches.create(root, {
    job_id: burst, from: 'start', patterns: [{ name: 'stage', match: 'stage' }], poll_ms: 250,
  });
  await fs.writeFile(path.join(second.dir, 'launch-ready'), '');
  await second.closed;
  const burstEvents = await scanUntilDone(burstWatch.watch_id, second.closed);
  assert.deepEqual(burstEvents.filter(e => e.kind === 'match').map(e => e.text), ['late stage']);
  const dropped = burstEvents.find(e => e.kind === 'dropped');
  assert(dropped && dropped.bytes > 0, `missing dropped event: ${JSON.stringify(burstEvents)}`);

  // `from: end` on a job that has already written starts after that output.
  const tail = 'job-333333333333333333333333';
  const third = await startJob(tail, "printf 'old stage\\n'; sleep .6; printf 'new stage\\n'");
  await fs.writeFile(path.join(third.dir, 'launch-ready'), '');
  while (!(await fs.readFile(path.join(third.dir, 'output.log'), 'utf8').catch(() => '')).includes('old')) {
    await sleep(20);
  }
  const tailWatch = await watches.create(root, {
    job_id: tail, patterns: [{ name: 'stage', match: 'stage' }], poll_ms: 250,
  });
  const tailEvents = await scanUntilDone(tailWatch.watch_id, third.closed);
  assert.deepEqual(tailEvents.filter(e => e.kind === 'match').map(e => e.text), ['new stage']);

  // A finished job's retained log larger than one 64 KiB read is drained before the watch
  // completes, so a match near the end is not lost.
  const big = 'job-444444444444444444444444';
  const fourth = await startJob(big,
    "printf 'first stage\\n'; yes filler | head -c 150000; printf '\\nsecond stage\\n'", '262144');
  const bigWatch = await watches.create(root, {
    job_id: big, from: 'start', patterns: [{ name: 'stage', match: 'stage' }], poll_ms: 250,
  });
  await fs.writeFile(path.join(fourth.dir, 'launch-ready'), '');
  await fourth.closed;
  const bigEvents = await scanUntilDone(bigWatch.watch_id, fourth.closed);
  assert.deepEqual(bigEvents.filter(e => e.kind === 'match').map(e => e.text), ['first stage', 'second stage']);
  assert.equal(bigEvents.at(-1).kind, 'terminal');
  assert(!bigEvents.some(e => e.kind === 'dropped'), `unexpected drop: ${JSON.stringify(bigEvents)}`);

  console.log('job output watch checks passed');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
