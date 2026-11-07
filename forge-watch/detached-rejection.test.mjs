import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ForgeWatchEngine } from './engine.ts';
import { parseTarget } from './types.ts';

async function probe() {
  let state = { version: 1, targets: {}, subscriptions: {}, queues: {}, nextEvent: 1 };
  let eligible = false, failRollback = false, accept = false, attempts = 0, accepted = 0;
  let head = 'a';
  const reports = [];
  const storage = { async update(mutate) {
    const draft = structuredClone(state);
    const hadClaim = Object.values(state.subscriptions).some(sub => sub.deliveryClaim);
    const result = mutate(draft);
    const hasClaim = Object.values(draft.subscriptions).some(sub => sub.deliveryClaim);
    if (failRollback && hadClaim && !hasClaim) throw Error('rollback disk outage');
    state = draft;
    return result;
  } };
  const engine = new ForgeWatchEngine({ storage,
    adapter: { poll: async () => ({ head, state: 'open', comments: [], reviews: [], ci: [] }) },
    isEligible: () => eligible,
    wake: async () => { attempts++; if (!accept) throw Error('delivery rejected'); accepted++; },
    recoverDelivery: () => false, // authoritative fixture: rejected send was not recorded
    onError: error => reports.push(error.message),
    // start() immediately launches its detached receipt flush. Other scheduling
    // stays controlled; this is not an HTTP/model call or a real polling loop.
    setTimer: () => 1, clearTimer: () => {}, shutdownTimeoutMs: 100,
  });
  const target = parseTarget('https://github.com/fixture/repo/pull/1');
  await engine.watch({ target, identity: { sessionId: 's', goalId: 'g', activationId: 'a' } });
  await engine.pollOnce(target); head = 'b'; await engine.pollOnce(target);
  eligible = true; failRollback = true; engine.start();
  // Give the real Node rejection boundary time to run, without installing an
  // unhandledRejection handler that would hide a production-fatal rejection.
  await new Promise(resolve => setImmediate(() => setImmediate(resolve)));
  assert.ok(reports.some(message => message.includes('rollback disk outage')), JSON.stringify(reports));
  assert.ok(Object.values(state.subscriptions).some(sub => sub.deliveryClaim), 'failed rollback retains its uncertain claim');
  failRollback = false; accept = true;
  await engine.pollOnce(target);
  assert.equal(attempts, 2); assert.equal(accepted, 1, 'authoritatively absent abandoned claim recovers after storage returns');
  assert.ok(Object.values(state.subscriptions).every(sub => !sub.deliveryClaim && sub.deliveryNotified));
  await engine.stop();
  console.log('PASS detached delivery/rollback error was reported, recovery succeeded and shutdown settled');
}

if (process.argv.includes('--child')) {
  await probe();
} else {
  const { default: test } = await import('node:test');
  test('public start handles a rejected wake plus rollback storage failure without a detached rejection', () => {
    const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--experimental-transform-types', fileURLToPath(import.meta.url), '--child'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.error, undefined);
    assert.equal(child.signal, null);
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /PASS detached delivery\/rollback error/);
    assert.doesNotMatch(child.stderr, /UnhandledPromiseRejection|unhandled rejection/);
  });
  test('negative control rejects the original unhandled detached chain for the intended rollback failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'forge-detached-mutant-'));
    try {
      const source = await readFile(new URL('./engine.ts', import.meta.url), 'utf8');
      const handled = 'const task = this.flushPendingReceipts().catch((error) => { this.report(error); });';
      assert.equal(source.split(handled).length, 2, 'Mutation must target the unique production handler');
      await writeFile(join(directory, 'engine.ts'), source.replace(handled, 'const task = this.flushPendingReceipts();'));
      await writeFile(join(directory, 'types.ts'), await readFile(new URL('./types.ts', import.meta.url)));
      await writeFile(join(directory, 'probe.mjs'), await readFile(new URL(import.meta.url)));
      await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
      const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--experimental-transform-types', join(directory, 'probe.mjs'), '--child'], { encoding: 'utf8', timeout: 5000 });
      assert.equal(child.error, undefined); assert.equal(child.signal, null);
      assert.notEqual(child.status, 0, 'Original detached rejection must fail the real Node process');
      assert.match(child.stderr, /rollback disk outage/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
