import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliverMode, mergeModeDeliveries, modeDeliveryNotice } from './operator-mode.ts';
import { TuiNativeManager } from './tui-native.ts';
import { processIdentity } from './tui-worker-tmux.ts';

const fail = (message: string) => async () => { throw new Error(message); };
const ok = async () => {};

test('mixed live, stopped and failing workers are reported per child', async () => {
  const sent: string[] = [];
  const result = await deliverMode([
    { childId: 'live', send: async () => { sent.push('live'); }, stopped: async () => false },
    { childId: 'gone', send: async () => { sent.push('gone'); }, stopped: async () => true },
    { childId: 'gone-after-send', send: fail('connect ENOENT'), stopped: (() => { let n = 0; return async () => n++ > 0; })() },
    { childId: 'unreachable', send: fail('connect ECONNREFUSED'), stopped: async () => false },
    { childId: 'unknown', send: fail('timeout'), stopped: fail('no identity') },
  ]);
  assert.deepEqual(sent, ['live'], 'a verifiably stopped worker is not contacted');
  assert.deepEqual(result.applied, ['live']);
  assert.deepEqual(result.stopped.sort(), ['gone', 'gone-after-send']);
  assert.deepEqual(result.failed.map(f => f.childId).sort(), ['unknown', 'unreachable'], 'uncertain failures stay visible');
  const notice = modeDeliveryNotice(mergeModeDeliveries([result, undefined]))!;
  assert.equal(notice.level, 'error');
  assert.match(notice.text, /not applied to 2 of 5 worker\(s\)/);
  assert.match(notice.text, /Applied to 1; skipped 2 stopped worker\(s\)/);
  assert.equal(modeDeliveryNotice({ applied: ['a'], stopped: ['b'], failed: [] })!.level, 'info');
  assert.equal(modeDeliveryNotice({ applied: [], stopped: [], failed: [] }), undefined);
});

test('native fan-out skips a stale lost worker by process identity and still updates the live one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'operator-mode-'));
  const manager: any = new TuiNativeManager(root, () => 'guard-only', () => true, 16);
  try {
    manager.liveOperatorMode = () => false;
    manager.save = () => {};
    const child = (id: string, state: string) => ({ childId: `subagent-child-${id.repeat(24)}`, taskId: `subagent-task-${id.repeat(24)}`, attempt: 1, state, directory: join(root, id) });
    const live = child('a', 'running'), lost = child('b', 'lost');
    manager.groups.set('g', { id: 'g', owner: 'parent', launchMode: 'guard-only', children: [live, lost] });
    // The lost worker's recorded pane process no longer exists: this pid is free and its token is made up.
    const liveToken = await processIdentity(process.pid);
    manager.manifest = (c: any) => c === lost ? { panePid: 4194301, paneProcessToken: '4194301:1' } : { panePid: process.pid, paneProcessToken: liveToken };
    const sent: string[] = [];
    manager.sendMode = async (_g: any, c: any) => { if (c === lost) throw new Error('connect ENOENT'); sent.push(c.childId); };
    const result = await manager.operatorMode('parent', false);
    assert.deepEqual(sent, [live.childId]);
    assert.deepEqual(result.stopped, [lost.childId]);
    assert.deepEqual(result.failed, []);
    // A worker without a recorded identity is never assumed dead.
    manager.manifest = () => ({});
    manager.sendMode = async (_g: any, c: any) => { if (c === lost) throw new Error('connect ENOENT'); };
    const unknown = await manager.operatorMode('parent', false);
    assert.deepEqual(unknown.failed.map((f: any) => f.childId), [lost.childId]);
    assert.equal(await manager.operatorMode('parent', true), undefined, 'stale bus event is ignored');
  } finally { await manager.shutdown(false); await rm(root, { recursive: true, force: true }); }
});
