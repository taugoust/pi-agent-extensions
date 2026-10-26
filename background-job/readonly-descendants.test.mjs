import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access, symlink, stat, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { JobStore } from './store.js';
import { BackgroundJobManager } from './manager.js';
import { TuiWorkerStore, atomicPrivateJson } from '../subagent/tui-worker-store.js';
import extension from './index.js';
const root = await mkdtemp(join(tmpdir(), 'rj-'));
const oldAgent = process.env.PI_CODING_AGENT_DIR, oldRoot = process.env.PI_TUI_WORKER_STATE_ROOT;
process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
process.env.PI_TUI_WORKER_STATE_ROOT = join(root, 'tree');
const handlers = new Map();
let ctx;
try {
  const tree = process.env.PI_TUI_WORKER_STATE_ROOT;
  await mkdir(join(tree, 'groups'), { recursive: true, mode: 0o700 });
  const manifests = [];
  for (let i = 0; i < 3; i++) {
    const id = String(i + 1).repeat(24), nonce = String(i + 1).repeat(64), directory = join(tree, 'workers', id);
    const worker = new TuiWorkerStore(directory, true);
    const manifest = { protocol: 1, ownerSessionId: `owner-${i}`, taskId: `subagent-task-${id}`, childId: `subagent-child-${id}`,
      runtimeId: `runtime-${i}`, groupId: `subagent-job-${id}`, attempt: 1, workerEpoch: String(i + 1).repeat(32), controlToken: nonce,
      controlSocket: join(directory, 'control.sock'), sessionFile: join(directory, 'session.jsonl'), presentation: 'background', launchMode: 'none',
      operatorCapabilityHash: createHash('sha256').update(nonce).digest('hex'),
      placement: { socketPath: '/tmp/tmux', serverEpoch: '1:2', sessionId: '$1', windowId: `@${i}`, paneId: `%${i}`, ownershipNonce: nonce } };
    worker.writeManifest(manifest);
    await writeFile(manifest.sessionFile, JSON.stringify({ type: 'session', id: `owner-${i + 1}` }) + '\n', { mode: 0o600 });
    atomicPrivateJson(join(tree, 'groups', `${manifest.groupId}.json`), { version: 1, id: manifest.groupId, owner: manifest.ownerSessionId,
      children: [{ taskId: manifest.taskId, childId: manifest.childId, attempt: 1, directory, operatorCapability: nonce, started: true, reaped: i === 0 }] });
    manifests.push(manifest);
  }
  const store = new JobStore(join(process.env.PI_CODING_AGENT_DIR, 'state', 'background-jobs-v1'));
  await store.initialize();
  async function job(n, sessionId, extra = {}) {
    const id = `job-${n.toString(16).padStart(24, '0')}`;
    await store.create({ schemaVersion: 1, id, name: `fixture-${n}`, command: ':', cwd: root, shell: '/bin/sh', createdAt: new Date(1700000000000 + n).toISOString(), ownerPid: process.pid, sessionId, ...extra }, ':', Buffer.alloc(0));
    await store.publishResult(id, { schemaVersion: 1, status: 'completed', exitCode: 0, finishedAt: new Date().toISOString() });
    await writeFile(store.path(id, 'output.log'), `owned-output-${n}\n`, { mode: 0o600 });
    return id;
  }
  const direct = await job(1, 'owner-0'), child = await job(2, 'owner-1'), grandchild = await job(3, 'owner-3');
  const delegated = await job(4, 'owner-0', { childId: manifests[0].childId });
  const foreign = await job(5, 'foreign'), infra = await job(6, 'owner-3', { infrastructure: true });
  const forged = await job(7, 'owner-0', { childId: 'subagent-child-' + 'f'.repeat(24) });
  const aliased = await job(8, 'owner-0');
  const aliasMetadata = await store.readMetadata(aliased);
  await writeFile(store.path(aliased, 'metadata.json'), JSON.stringify({ ...aliasMetadata, id: direct }), { mode: 0o600 });
  for (let n = 10; n < 66; n++) await job(n, 'owner-3');
  const boundedManager = new BackgroundJobManager(store, {});
  await assert.rejects(boundedManager.listReadOnlyOwners([{ sessionId: 'owner-0' }], 1), /byte capacity exceeded/);
  extension({ registerTool() {}, registerCommand() {}, sendMessage() {}, on(name, handler) { const previous = handlers.get(name); handlers.set(name, previous ? async (...args) => { await previous(...args); await handler(...args); } : handler); } });
  ctx = { cwd: root, hasUI: false, isIdle: () => true, sessionManager: { getSessionId: () => 'owner-0', getBranch: () => [] } };
  await handlers.get('session_start')({}, ctx);
  const api = globalThis.__paeHarnessReadOnlyV1.jobs;
  const runtime = join(process.env.XDG_RUNTIME_DIR || '/tmp', `pi-bg-${process.getuid?.() ?? process.pid}-${createHash('sha256').update(store.root).digest('hex').slice(0, 16)}`);
  const first = await api.list({ sessionId: 'owner-0', limit: 50 });
  const configMtime = (await stat(join(runtime, 'tmux.conf'))).mtimeMs;
  assert.equal(first.items.length, 50); assert.ok(first.nextCursor);
  const second = await api.list({ sessionId: 'owner-0', limit: 50, cursor: first.nextCursor });
  const all = [...first.items, ...second.items];
  assert.equal(all.length, 60); assert.equal(new Set(all.map(item => item.jobId)).size, 60);
  assert.equal(all.find(item => item.jobId === direct).fromSubagent, undefined);
  for (const id of [child, grandchild, delegated]) {
    assert.equal(all.find(item => item.jobId === id).fromSubagent, true);
    assert.match((await api.output({ sessionId: 'owner-0', jobId: id })).item.text, /owned-output/);
  }
  for (const id of [foreign, infra, forged, aliased]) {
    assert.ok(!all.some(item => item.jobId === id));
    await assert.rejects(api.output({ sessionId: 'owner-0', jobId: id }), /another owner/);
  }
  assert.ok(Buffer.byteLength((await api.output({ sessionId: 'owner-0', jobId: grandchild, maxBytes: 4 })).item.text) <= 4);
  await writeFile(store.path(grandchild, 'output.log'), '🧪'.repeat(20000), { mode: 0o600 });
  const bounded = (await api.output({ sessionId: 'owner-0', jobId: grandchild })).item;
  assert.ok(Buffer.byteLength(bounded.text) <= 48 * 1024); assert.equal(bounded.truncated, true);
  assert.ok(!bounded.text.includes('\ufffd'), 'UTF8 tails remain valid');
  assert.equal((await stat(join(runtime, 'tmux.conf'))).mtimeMs, configMtime, 'read RPC must not rewrite runtime/config state');
  await assert.rejects(access(store.path(grandchild, 'notified')));
  await assert.rejects(access(store.path(grandchild, 'retrieved-at')));
  await rm(store.path(grandchild, 'output.log'));
  await symlink(store.path(foreign, 'output.log'), store.path(grandchild, 'output.log'));
  await assert.rejects(api.output({ sessionId: 'owner-0', jobId: grandchild }), /ELOOP/);
  await rm(store.path(grandchild, 'output.log'));
  await writeFile(store.path(grandchild, 'output.log'), 'restored-owned-output', { mode: 0o600 });
  await rename(store.jobsRoot, store.jobsRoot + '-retained');
  await symlink(store.jobsRoot + '-retained', store.jobsRoot);
  await assert.rejects(api.list({ sessionId: 'owner-0' }), /symlinks/);
  await assert.rejects(api.output({ sessionId: 'owner-0', jobId: grandchild }), /symlinks/);
  await rm(store.jobsRoot);
  await rename(store.jobsRoot + '-retained', store.jobsRoot);
  await assert.rejects(api.output({ sessionId: 'foreign', jobId: direct }));
  const originalReadMetadata = JobStore.prototype.readMetadata;
  const originalReadResult = JobStore.prototype.readResult;
  let metadataReads = 0, foreignProbes = 0;
  JobStore.prototype.readMetadata = async function(id) {
    const metadata = await originalReadMetadata.call(this, id);
    return id === grandchild && ++metadataReads === 2 ? { ...metadata, sessionId: 'raced-foreign-owner' } : metadata;
  };
  JobStore.prototype.readResult = async function(id) {
    if (id === grandchild) foreignProbes++;
    return originalReadResult.call(this, id);
  };
  await assert.rejects(api.output({ sessionId: 'owner-0', jobId: grandchild }), /ownership changed/);
  assert.equal(foreignProbes, 0, 'ownership must be checked before result/pane/process observation');
  metadataReads = 0;
  await api.list({ sessionId: 'owner-0' });
  assert.equal(foreignProbes, 0, 'list must reject raced metadata before observing foreign state');
  JobStore.prototype.readMetadata = originalReadMetadata;
  JobStore.prototype.readResult = originalReadResult;
  let mutate = true;
  JobStore.prototype.readMetadata = async function(id) {
    const metadata = await originalReadMetadata.call(this, id);
    if (id === grandchild && mutate) {
      mutate = false;
      await writeFile(manifests[2].sessionFile, '{"type":"session","id":"raced-session"}\n');
    }
    return metadata;
  };
  await assert.rejects(api.output({ sessionId: 'owner-0', jobId: grandchild }), /ownership changed/);
  JobStore.prototype.readMetadata = originalReadMetadata;
  await writeFile(manifests[2].sessionFile, '{"type":"session","id":"owner-3"}\n');
  mutate = true;
  JobStore.prototype.readMetadata = async function(id) {
    const metadata = await originalReadMetadata.call(this, id);
    if (id === grandchild && mutate) {
      mutate = false;
      await writeFile(manifests[2].sessionFile, '{"type":"session","id":"raced-list"}\n');
    }
    return metadata;
  };
  await assert.rejects(api.list({ sessionId: 'owner-0' }), /ancestry changed/);
  JobStore.prototype.readMetadata = originalReadMetadata;
  await writeFile(manifests[2].sessionFile, '{"type":"session","id":"replacement"}\n');
  await assert.rejects(api.list({ sessionId: 'owner-0', cursor: first.nextCursor }), /snapshot changed/);
  await assert.rejects(api.output({ sessionId: 'owner-0', jobId: grandchild }), /another owner/);
  console.log('compiled readonly descendants: direct/nested/grandchild/delegated, unrelated/infra/forged, paging/dedup, stale ancestry, bounded authorized output passed');
} finally {
  if (ctx) await handlers.get('session_shutdown')?.({ reason: 'quit' }, ctx);
  if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
  if (oldRoot === undefined) delete process.env.PI_TUI_WORKER_STATE_ROOT; else process.env.PI_TUI_WORKER_STATE_ROOT = oldRoot;
  await rm(root, { recursive: true, force: true });
}
