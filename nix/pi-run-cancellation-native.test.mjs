// Actual standalone Pi process, public RPC protocol + test-only extension.
// No production test hooks, live providers, accounts, or pre-existing sessions.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
const [binary, fixture] = process.argv.slice(2).map(p => resolve(p));
assert.ok(binary && fixture, 'Usage: native.test.mjs PI_BINARY FIXTURE_EXTENSION');
const directory = await mkdtemp(join(tmpdir(), 'pi-cancellation-native-'));
const home = join(directory, 'home'), agentDir = join(home, 'agent'), cwd = join(directory, 'workspace');
await mkdir(agentDir, { recursive: true }); await mkdir(cwd);
await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, defaultThinkingLevel: 'off' }));
const child = spawn(binary, ['--mode', 'rpc', '--offline', '--no-session', '--no-extensions', '--no-skills', '--extension', fixture, '--provider', 'offline-cancellation-fixture', '--model', 'fixture'], {
  cwd, env: { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: directory, XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'), PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' }, stdio: ['pipe', 'pipe', 'pipe'],
});
const events = [], metrics = [], errors = [], bus = new EventEmitter();
let exited, sequence = 0;
const exit = new Promise(resolveExit => child.once('exit', (code, signal) => { exited = { code, signal }; bus.emit('change'); resolveExit(exited); }));
const stdout = createInterface({ input: child.stdout });
const stderr = createInterface({ input: child.stderr });
stdout.on('line', line => {
  try { events.push(JSON.parse(line)); } catch { errors.push(`Non-JSON RPC stdout: ${line}`); }
  bus.emit('change');
});
stderr.on('line', line => {
  if (line.startsWith('PI_CANCELLATION_FIXTURE ')) metrics.push(JSON.parse(line.slice('PI_CANCELLATION_FIXTURE '.length)));
  else errors.push(line);
  bus.emit('change');
});
function waitFor(read, label, timeout = 10000) {
  return new Promise((resolveWait, reject) => {
    const timer = setTimeout(() => finish(new Error(`Timeout: ${label}; stderr=${errors.join('\n')}`)), timeout);
    function finish(error, value) { clearTimeout(timer); bus.off('change', check); error ? reject(error) : resolveWait(value); }
    function check() {
      const value = read();
      if (value) finish(undefined, value);
      else if (exited) finish(new Error(`Pi exited before ${label}: ${JSON.stringify(exited)}; stderr=${errors.join('\n')}`));
    }
    bus.on('change', check); check();
  });
}
async function rpc(type, fields = {}) {
  const id = `fixture-${++sequence}`;
  child.stdin.write(JSON.stringify({ id, type, ...fields }) + '\n');
  const response = await waitFor(() => events.find(e => e.type === 'response' && e.id === id), `${type} response`);
  assert.equal(response.success, true, JSON.stringify(response));
  return response.data;
}
try {
  await rpc('get_state');
  await rpc('prompt', { message: 'Initial fixture wait' });
  await waitFor(() => metrics.find(m => m.event === 'tool_execute' && m.hold), 'first wait execution');
  await rpc('steer', { message: 'Preserved queued steering input' });
  await rpc('follow_up', { message: 'Preserved queued followup input' });
  await rpc('abort'); // Authoritative session-idle barrier, not a sleep/poll assumption.
  const canceledState = await rpc('get_state');
  const canceledModels = metrics.filter(m => m.event === 'model_dispatch');
  const canceledTools = metrics.filter(m => m.event === 'tool_execute');
  assert.equal(canceledModels.length, 1, 'Canceled native run dispatched another provider request');
  assert.equal(canceledTools.length, 1, 'Canceled native wait was replayed');
  assert.equal(metrics.filter(m => m.event === 'wait_cancelled').length, 1);
  assert.equal(canceledState.pendingMessageCount, 2, 'Native cancellation lost queued steering/followup input');
  assert.equal(canceledState.isStreaming, false);
  const firstResult = events.find(e => e.type === 'tool_execution_end');
  assert.equal(firstResult.result.content[0].text, 'Wait cancelled');
  assert.equal(firstResult.isError, true);
  const settled = events.filter(e => e.type === 'agent_settled').length;
  await rpc('prompt', { message: 'Fresh explicit fixture request' });
  await waitFor(() => events.filter(e => e.type === 'agent_settled').length > settled, 'fresh native run settlement');
  const finalState = await rpc('get_state');
  const models = metrics.filter(m => m.event === 'model_dispatch');
  const tools = metrics.filter(m => m.event === 'tool_execute');
  assert.equal(tools.length, 2, 'Fresh explicit run must execute exactly one new tool');
  assert.equal(tools[1].hold, false); assert.equal(tools[1].aborted, false);
  assert.notEqual(tools[1].signalId, tools[0].signalId, 'Fresh native run reused canceled controller');
  assert.ok(models.slice(1).every(m => m.aborted === false));
  assert.ok(models.slice(1).some(m => m.userTexts.includes('Preserved queued steering input')));
  assert.ok(models.slice(1).some(m => m.userTexts.includes('Preserved queued followup input')));
  assert.equal(finalState.pendingMessageCount, 0); assert.equal(finalState.isStreaming, false);
  assert.ok(events.some(e => e.type === 'tool_execution_end' && e.result.content[0]?.text === 'Fresh fixture tool succeeded' && !e.isError));
  assert.equal(events.filter(e => e.type === 'extension_error').length, 0);
  console.log('PASS actual native Pi RPC: canceled dispatches=1, tool executions=1, Wait cancelled exactly once, queued inputs preserved=2, explicit fresh signal clean, fresh tool executions=1');
} finally {
  child.stdin.end();
  if (!exited) child.kill('SIGTERM');
  const killDeadline = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 2000);
  killDeadline.unref();
  await exit;
  clearTimeout(killDeadline);
  stdout.close(); stderr.close();
  await rm(directory, { recursive: true, force: true });
}
