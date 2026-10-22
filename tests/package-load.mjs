// Native package-load contract: registration must actually execute, not merely
// leave source files present or print a model list with a successful exit code.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [pi, ...arguments_] = process.argv.slice(2);
assert.ok(pi, 'Pi executable is required; this integration must not silently skip');
const separator = arguments_.indexOf('--expect');
assert.ok(separator > 0, 'Supply extension paths followed by --expect COMMAND...');
const extensions = arguments_.slice(0, separator);
const expected = arguments_.slice(separator + 1);
assert.ok(expected.length > 0, 'At least one registration must be observed');
const home = await mkdtemp(join(tmpdir(), 'pi-package-load-'));
const child = spawn(pi, ['--offline', '--mode', 'rpc', '--no-session', '--no-extensions', '--no-skills',
  ...extensions.flatMap(path => ['--extension', path])], {
  cwd: home,
  env: {
    PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR ?? tmpdir(),
    XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'),
    XDG_STATE_HOME: join(home, 'state'), XDG_DATA_HOME: join(home, 'data'),
    PI_CODING_AGENT_DIR: join(home, 'agent'), PI_OFFLINE: '1',
    PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1', TERM: 'dumb',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const closed = once(child, 'close');
let stderr = '', buffer = '', unexpectedTurn = false;
const waiting = new Map();
function fail(error) {
  for (const { reject, timer } of waiting.values()) { clearTimeout(timer); reject(error); }
  waiting.clear();
}
child.on('error', fail);
child.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); });
child.stdout.on('data', data => {
  buffer += data;
  for (let newline; (newline = buffer.indexOf('\n')) !== -1;) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    let frame;
    try { frame = JSON.parse(line); } catch { fail(new Error(`Invalid RPC frame: ${line.slice(0, 200)}`)); continue; }
    if (frame.type === 'agent_start') {
      unexpectedTurn = true;
      fail(new Error('Package-load check must not invoke a model'));
    }
    const request = waiting.get(frame.id);
    if (request) { clearTimeout(request.timer); waiting.delete(frame.id); request.resolve(frame); }
  }
});
child.on('close', () => fail(new Error(`Pi exited before RPC completion: ${stderr}`)));
function request(id, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`RPC ${type} deadline: ${stderr}`)); }, 15000);
    waiting.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, type })}\n`);
  });
}
try {
  const commands = await request('registrations', 'get_commands');
  assert.equal(commands.success, true, JSON.stringify(commands));
  for (const name of expected) {
    assert.ok(commands.data.commands.some(command => command.name === name && command.source === 'extension'),
      `Missing registered command ${name}; native extension load did not succeed. ${stderr}`);
  }
  const state = await request('idle', 'get_state');
  assert.equal(state.success, true, JSON.stringify(state));
  assert.equal(state.data.isStreaming, false, 'Loading an extension must not start a model turn');
  assert.equal(unexpectedTurn, false, 'A model turn was started during package loading');
  console.log(`PASS native immutable package registrations: ${expected.join(', ')}; offline and idle with no model turn`);
} finally {
  fail(new Error('Check finished'));
  child.stdin.end();
  const terminate = setTimeout(() => child.kill('SIGTERM'), 2000);
  const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await closed; } finally {
    clearTimeout(terminate); clearTimeout(kill);
    await rm(home, { recursive: true, force: true });
  }
}
