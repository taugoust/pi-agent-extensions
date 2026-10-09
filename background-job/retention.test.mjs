import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import backgroundJob from './index.js';
import { BackgroundJobManager } from './manager.js';
import { JobStore } from './store.js';
import { TmuxBackend } from './tmux.js';
import { OUTPUT_RETENTION_MS, reapExpiredRetrieved } from './retention.js';

const tmux = process.env.TEST_TMUX;
const runner = process.env.TEST_RUNNER;
assert.ok(tmux, 'TEST_TMUX must point at the tmux executable');
assert.ok(runner, 'TEST_RUNNER must point at the background-job runner');
const work = await mkdtemp(join(tmpdir(), 'background-job-retention-'));
const agentDir = join(work, 'agent');
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.XDG_RUNTIME_DIR;
const root = join(agentDir, 'state', 'background-jobs-v1');
const runtimeRoot = join('/tmp', `pi-bg-${process.getuid?.() ?? process.pid}-${createHash('sha256').update(root).digest('hex').slice(0, 16)}`);
const store = new JobStore(root, runtimeRoot);
await store.initialize();
const manager = new BackgroundJobManager(store, new TmuxBackend(store, tmux, process.execPath, runner));
const sentinelSocket = join(work, 'sentinel.sock');
execFileSync(tmux, ['-S', sentinelSocket, 'new-session', '-d', '-x', '240', '-y', '200', '-s', 'retention-caller', 'sleep 120']);
const sentinelPane = execFileSync(tmux, ['-S', sentinelSocket, 'display-message', '-p', '#{pane_id}'], { encoding: 'utf8' }).trim();
const sentinelPid = Number(execFileSync(tmux, ['-S', sentinelSocket, 'display-message', '-p', '#{pane_pid}'], { encoding: 'utf8' }).trim());
process.env.TMUX = `${sentinelSocket},0,0`;
process.env.TMUX_PANE = sentinelPane;
let poll;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
globalThis.setInterval = (callback, ms, ...args) => {
  if (ms === 2000) { poll = callback; return { unref() {} }; }
  return originalSetInterval(callback, ms, ...args);
};
const handlers = new Map();
let tool;
const entries = [];
const messages = [];
const ctx = {
  cwd: process.cwd(), hasUI: false, isIdle: () => true, hasPendingMessages: () => false,
  sessionManager: { getSessionId: () => 'retention-session', getBranch: () => entries },
};
backgroundJob({
  registerTool(value) { tool = value; },
  registerCommand() {},
  on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  appendEntry(customType, data) { entries.push({ type: 'custom', customType, data }); },
  sendMessage(message, options) { messages.push({ message, options }); entries.push({ type: 'custom_message', ...message }); },
});
const call = params => tool.execute('retention-test', params, undefined, undefined, ctx);
const waitFor = async (predicate, message, timeout = 10_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(message);
};
let active;
let adopted;
try {
  for (const handler of handlers.get('session_start') ?? []) await handler({}, ctx);
  const first = await manager.start({ command: "printf 'first output\\n'", cwd: process.cwd(), sessionId: 'retention-session' });
  const second = await manager.start({ command: "printf 'second output\\n'", cwd: process.cwd(), sessionId: 'retention-session' });
  const notified = await manager.start({ command: "printf 'notification output\\n'", cwd: process.cwd(), sessionId: 'retention-session' });
  await manager.wait(first.metadata.id, 10_000);
  await manager.wait(second.metadata.id, 10_000);
  await waitFor(async () => Boolean(await store.readResult(notified.metadata.id)), 'third job did not finish');

  await waitFor(() => { poll(); return messages.some(item => item.message.details?.updates?.some(update => update.id === notified.metadata.id)); }, 'terminal notification was not delivered');
  assert.ok(messages.some(item => item.message.details?.updates?.some(update => update.id === notified.metadata.id)), 'unread terminal job notification must be delivered');
  assert.equal(await store.readRetrieved(notified.metadata.id), undefined, 'notifications must not retrieve output');
  await call({ action: 'status', job_id: first.metadata.id });
  assert.equal(await store.readRetrieved(first.metadata.id), undefined, 'status must not retrieve output');
  await call({ action: 'list' });
  assert.equal(await store.readRetrieved(first.metadata.id), undefined, 'list must not retrieve output');
  await call({ action: 'wait', job_id: first.metadata.id, timeout_ms: 0 });
  assert.equal(await store.readRetrieved(first.metadata.id), undefined, 'wait without lines must not retrieve output');

  await call({ action: 'output', job_id: first.metadata.id });
  const initialRetrievedAt = await store.readRetrieved(first.metadata.id);
  assert.ok(Number.isSafeInteger(initialRetrievedAt), 'output must persist retrieval timestamp');
  await call({ action: 'wait', job_id: second.metadata.id, timeout_ms: 0, lines: 10 });
  const secondRetrievedAt = await store.readRetrieved(second.metadata.id);
  assert.ok(Number.isSafeInteger(secondRetrievedAt), 'wait(lines) must persist retrieval timestamp');

  await new Promise(resolve => setTimeout(resolve, 5));
  await call({ action: 'output', job_id: first.metadata.id });
  const resetAt = await store.readRetrieved(first.metadata.id);
  assert.ok(resetAt > initialRetrievedAt, 'output retrieval must strictly reset retention timer');
  const oldExpiry = initialRetrievedAt + OUTPUT_RETENTION_MS;
  await reapExpiredRetrieved(manager, store, oldExpiry);
  assert.ok((await store.listIds()).includes(first.metadata.id), 'sweep at prior expiry must preserve freshly retrieved output');

  // Active jobs and terminal adopted panes are excluded even if a timestamp exists.
  active = await manager.start({ command: 'sleep 60', cwd: process.cwd(), sessionId: 'retention-session' });
  await store.markRetrieved(active.metadata.id, 1);
  const adoptedPane = execFileSync(tmux, ['-S', sentinelSocket, 'split-window', '-d', '-P', '-F', '#{pane_id}', '-t', sentinelPane, 'sleep 60'], { encoding: 'utf8' }).trim();
  adopted = await manager.adoptPane({ paneId: adoptedPane, socket: sentinelSocket, cwd: process.cwd(), sessionId: 'retention-session' });
  await manager.cancel(adopted.metadata.id);
  assert.ok((await manager.get(adopted.metadata.id)).result, 'adopted pane fixture must be terminal');
  await store.markRetrieved(adopted.metadata.id, 1);
  const expiry = Math.max(resetAt, secondRetrievedAt) + OUTPUT_RETENTION_MS;
  const reopenedStore = new JobStore(root, runtimeRoot);
  const reopenedManager = new BackgroundJobManager(reopenedStore, new TmuxBackend(reopenedStore, tmux, process.execPath, runner));
  assert.equal(await reopenedStore.readRetrieved(first.metadata.id), resetAt, 'retrieval timestamp must persist across manager/store recreation');
  await reapExpiredRetrieved(reopenedManager, reopenedStore, expiry);
  const remaining = await reopenedStore.listIds();
  assert.ok(!remaining.includes(first.metadata.id), 'expired retrieved output must be deleted from disk');
  assert.ok(!remaining.includes(second.metadata.id), 'wait(lines) result must be deleted at expiry');
  assert.ok(remaining.includes(active.metadata.id), 'running job must not be expired');
  assert.ok(remaining.includes(adopted.metadata.id), 'terminal adopted pane must not be expired');
  assert.ok(remaining.includes(notified.metadata.id), 'unretrieved terminal job must be retained');
  const panes = execFileSync(tmux, ['-S', sentinelSocket, 'list-panes', '-a', '-F', '#{pane_id}'], { encoding: 'utf8' }).trim().split(/\r?\n/);
  assert.ok(!panes.includes(first.launch.paneId), 'expired native job pane must actually be deleted');
  assert.ok(!panes.includes(second.launch.paneId), 'wait(lines) expiry must delete the native pane');
  assert.ok(panes.includes(adoptedPane), 'unexpired adopted pane must remain in tmux');
  process.kill(sentinelPid, 0);
  console.log('background-job real-store retention integration tests passed');
} finally {
  if (active) await manager.cancel(active.metadata.id).catch(() => {});
  if (adopted) {
    await manager.cancel(adopted.metadata.id).catch(() => {});
    await manager.reap(adopted.metadata.id).catch(() => {});
  }
  for (const handler of handlers.get('session_shutdown') ?? []) {
    try { await handler({ reason: 'quit' }, ctx); } catch {}
  }
  try { execFileSync(tmux, ['-S', sentinelSocket, 'kill-server']); } catch {}
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
  await rm(work, { recursive: true, force: true });
  await rm(runtimeRoot, { recursive: true, force: true });
}
