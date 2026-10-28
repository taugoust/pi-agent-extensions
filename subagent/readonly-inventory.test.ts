import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TuiNativeManager } from './tui-native.ts';
import { TuiWorkerStore } from './tui-worker-store.ts';
import { TuiWorkerServer } from './tui-worker-server.ts';

export async function inventoryFixture(owner = 'parent', digit = 'a', attempt = 1) {
 const root = await mkdtemp(join(tmpdir(), 'readonly-inventory-'));
 const manager: any = new TuiNativeManager(root, () => 'native', () => true, 16);
 const directory = join(root, 'workers', digit.repeat(24));
 const store = new TuiWorkerStore(directory, true);
 const manifest: any = { protocol: 1, ownerSessionId: owner, taskId: `subagent-task-${digit.repeat(24)}`, runtimeId: `runtime-${digit}-${attempt}`, groupId: `subagent-job-${digit.repeat(24)}`,
  childId: `subagent-child-${digit.repeat(24)}`, attempt, workerEpoch: digit.repeat(32), controlToken: 'e'.repeat(64), controlSocket: join(directory, 'control.sock'), sessionFile: join(directory, 'session.jsonl'), launchMode: 'none', presentation: 'background',
  placement: { socketPath: '/tmp/tmux', serverEpoch: '1:2', sessionId: '$1', windowId: '@1', paneId: '%1', ownershipNonce: 'f'.repeat(64) } };
 store.writeManifest(manifest);
 const server: any = new TuiWorkerServer(store, { isIdle: () => true, send() { throw Error('must not send'); }, abort() { throw Error('must not abort'); }, shutdown() { throw Error('must not shutdown'); } });
 const child: any = { childId: manifest.childId, taskId: manifest.taskId, attempt, directory, spec: { task: 'Fixture' }, state: 'running', started: true, notifiedSequence: 0 };
 manager.owner = owner;
 manager.groups.set(manifest.groupId, { id: manifest.groupId, owner, children: [child] });
 manager.refresh = async () => { throw Error('must not refresh'); };
 manager.persistenceWriter = () => { throw Error('must not persist'); };
 await server.start(); server.running(true);
 return { manager, server, child, manifest, store, rows: () => manager.readonlyTaskInventory(owner, manager.readonlyTaskList(owner)),
  close: async () => { await server.close(); await manager.shutdown(false); await rm(root, {recursive:true,force:true}); } };
}

test('live inventory authenticates exact runtime, leaves retained snapshot stale and does not observe/control', async () => {
 const f = await inventoryFixture();
 try {
  assert.equal(f.manager.readonlyTaskList('parent')[0].stale, true);
  const before = await stat(f.store.path('state.json'),{bigint:true});
  const fresh = (await f.rows())[0]; assert.equal(fresh.stale, false); assert.ok(fresh.lastUpdated);
  assert.equal((await stat(f.store.path('state.json'),{bigint:true})).mtimeNs,before.mtimeNs,'status inventory never persists worker state');
  assert.equal(f.manager.readonlyTaskList('parent')[0].stale, true, 'freshness never persisted into retained snapshots');
  assert.equal((await f.manager.readonlyTaskInventory('parent', [{...fresh, runtimeId:'old-runtime'}]))[0].stale,true);
  assert.equal((await f.manager.readonlyTaskInventory('parent', [{...fresh, attempt:2,stale:true}]))[0].stale,true);
  f.child.state = 'completed'; assert.equal((await f.rows())[0].stale,true,'execution mismatch stays stale');
  f.child.state = 'running'; f.child.reaped = true; assert.equal((await f.rows())[0].stale,true);
  f.child.reaped = false;
  await f.server.close(); assert.equal((await f.rows())[0].stale,true,'disk state never proves liveness');
 } finally { await f.close(); }
});

test('legacy and malformed live status cannot bless retained inventory', async () => {
 const f = await inventoryFixture('parent','c');
 try {
  const snapshot = f.server.snapshot.bind(f.server);
  f.server.snapshot = () => ({active:true});
  assert.equal((await f.rows())[0].stale,true,'legacy identity is not live evidence');
  f.server.snapshot = () => ({...snapshot(),attempt:99});
  assert.equal((await f.rows())[0].stale,true,'foreign attempt cannot supply freshness');
  f.server.snapshot = snapshot;
  f.server.settled({timestamp:new Date().toISOString(),assistant:{content:[]}}); f.child.state='completed';
  assert.equal((await f.rows())[0].stale,true,'unobserved retained report is not fresh');
  f.child.report=f.server.snapshot().lastReport;
  assert.equal((await f.rows())[0].stale,false,'completed but still live exact runtime is fresh');
 } finally { await f.close(); }
});

test('slow status is bounded and does not turn retained snapshots into live evidence', async () => {
 const f = await inventoryFixture('parent','d');
 try {
  const handle=f.server.handle.bind(f.server);
  f.server.handle=(request:any)=>request.operation==='status'?new Promise(()=>{}):handle(request);
  const start=performance.now();const rows=await f.rows();
  assert.equal(rows[0].stale,true);assert.ok(performance.now()-start<600);
  assert.equal(f.child.state,'running');assert.equal(f.manager.readonlyTaskList('parent')[0].stale,true);
 } finally {await f.close();}
});

test('resumed attempt authenticates independently and old attempt cannot inherit freshness', async () => {
 const f = await inventoryFixture('parent','b',2);
 try {
  assert.equal((await f.rows())[0].stale,false);
  const old = {...f.manager.readonlyTaskList('parent')[0],attempt:1,runtimeId:'old-runtime'};
  assert.equal((await f.manager.readonlyTaskInventory('parent',[old]))[0].stale,true);
  f.manager.generation++;
  const reading=f.rows(); f.manager.generation++;
  assert.equal((await reading)[0].stale,true,'source generation change during read fails closed');
 } finally { await f.close(); }
});
