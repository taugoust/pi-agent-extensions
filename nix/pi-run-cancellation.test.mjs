// Offline release-artifact regression: no credentials, provider SDK, or active sessions.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
const [rootArg = '.', target = 'node', expectation = 'patched'] = process.argv.slice(2);
const root = resolve(rootArg);
// Fail before any accidental transport use.
globalThis.fetch = () => { throw new Error('Network forbidden in cancellation test'); };
globalThis.WebSocket = class { constructor() { throw new Error('WebSocket forbidden in cancellation test'); } };
let Agent, AgentSession;
if (globalThis.__piCancellationArtifact) {
  ({ Agent, AgentSession } = globalThis.__piCancellationArtifact);
} else if (target === 'bundle') {
  const chunks = `${root}/dist/bundle/chunks`;
  const { readFileSync } = await import('node:fs');
  const file = readdirSync(chunks).find(f => f.endsWith('.js') && readFileSync(`${chunks}/${f}`, 'utf8').includes('async function runLoop('));
  const bundled = await import(pathToFileURL(`${chunks}/${file}`));
  Agent = bundled.dist_exports.Agent;
  AgentSession = bundled.AgentSession;
} else {
  const core = ['node_modules/@earendil-works/pi-agent-core/dist', 'node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist'].find(p => existsSync(`${root}/${p}/agent.js`));
  ({ Agent } = await import(pathToFileURL(`${root}/${core}/agent.js`)));
  ({ AgentSession } = await import(pathToFileURL(`${root}/dist/core/agent-session.js`)));
}
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = { id: 'offline', name: 'offline', api: 'offline', provider: 'offline', baseUrl: '', reasoning: false, input: ['text'], cost: usage.cost, contextWindow: 10000, maxTokens: 1000 };
const user = text => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 0 });
const call = id => ({ type: 'toolCall', id, name: 'wait', arguments: {} });
const msg = (content, stopReason = 'toolUse') => ({ role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, usage, stopReason, timestamp: 0 });
const stream = message => ({ async *[Symbol.asyncIterator]() { yield { type: 'done', message }; }, async result() { return message; } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function scenario(mode) {
  let dispatches = 0, executions = 0, canceled = false, stopListener;
  const signals = [], results = [], entered = deferred(), release = deferred(), freshEntered = deferred(), freshRelease = deferred();
  let agent;
  agent = new Agent({ initialState: { model, tools: [{ name: 'wait', label: 'wait', description: 'offline', parameters: { type: 'object', properties: {} }, async execute(_id, _args, signal) {
    executions++;
    if (!canceled) { entered.resolve(); await release.promise; if (signal.aborted) throw new Error('Wait cancelled'); }
    else { freshEntered.resolve(); await freshRelease.promise; }
    return { content: [{ type: 'text', text: 'ok' }] };
  } }] }, streamFn(_m, _c, options) {
    signals.push(options.signal); dispatches++;
    // Deliberately ignore cancellation to detect unwanted core model admission.
    return stream(msg(dispatches === 1 || dispatches === 3 ? [call(`tool-${dispatches}`)] : [], dispatches === 1 || dispatches === 3 ? 'toolUse' : 'stop'));
  } });
  agent.subscribe(e => { if (e.type === 'tool_execution_end') results.push(e.result.content[0].text); });
  const running = agent.prompt('first');
  await entered.promise;
  const oldController = agent.activeRun.abortController;
  agent.steer(user('queued steering'));
  agent.followUp(user('queued followup'));
  if (mode === 'pending') { agent.abort(); canceled = true; release.resolve(); }
  else { canceled = true; release.resolve(); stopListener = agent.subscribe(e => { if (e.type === 'turn_end' && e.message.stopReason !== 'aborted') agent.abort(); }); }
  await running;
  const initial = { dispatches, executions, queued: agent.hasQueuedMessages(), stopReason: agent.state.messages.at(-1).stopReason };
  if (expectation === 'original') {
    assert.ok(initial.dispatches > 1 || !initial.queued, `Expected original defect: ${JSON.stringify(initial)}`);
    console.log(`PASS original defect observed (${target}/${mode}): ${JSON.stringify(initial)}`);
    return;
  }
  assert.equal(dispatches, 1, 'No second model dispatch after cancellation');
  assert.equal(executions, 1, 'Pending tool not replayed');
  assert.equal(agent.state.messages.at(-1).stopReason, 'aborted');
  assert.ok(agent.hasQueuedMessages(), 'Queued input preserved');
  assert.equal(agent.state.messages.filter(m => m.role === 'user').length, 1, 'Canceled run consumed no queued input');
  assert.equal(agent.signal, undefined);
  // A delayed event tied to the old signal cannot cancel the fresh controller.
  const oldSignal = signals[0];
  // Remove the test's turn_end cancellation listener before explicit fresh admission.
  stopListener?.();
  dispatches = 2;
  const freshRun = agent.prompt('explicit fresh user request');
  await freshEntered.promise;
  oldController.abort(); // A delayed cancellation belonging to the settled run.
  assert.notEqual(signals[1], oldSignal);
  assert.equal(signals[1].aborted, false);
  assert.equal(oldSignal.aborted, true);
  freshRelease.resolve();
  await freshRun;
  assert.equal(executions, 2, 'Only explicitly requested fresh tool executes');
  assert.equal(agent.hasQueuedMessages(), false);
  const text = agent.state.messages.filter(m => m.role === 'user').map(m => m.content[0].text);
  assert.equal(text.filter(t => t === 'queued steering').length, 1);
  assert.equal(text.filter(t => t === 'queued followup').length, 1);
  assert.equal(results.filter(t => t === 'ok').length, mode === 'pending' ? 1 : 2);
  console.log(`PASS cancellation boundary (${target}/${mode}): initialDispatches=1, initialToolExecutions=1, queuedInputPreserved=true, freshSignal=true, freshToolExecutions=1`);
}
await scenario('pending');
await scenario('turn-end');
if (expectation !== 'original') {
  // agent_end is not settlement: awaited listeners still own the old controller.
  {
    let dispatches = 0, canceled = false;
    const agent = new Agent({ initialState: { model }, streamFn() { dispatches++; return stream(msg([], 'stop')); } });
    agent.subscribe(async e => {
      if (e.type === 'agent_end' && !canceled) {
        await Promise.resolve();
        canceled = true;
        agent.steer(user('late queued user'));
        agent.abort();
      }
    });
    await agent.prompt('late cancellation');
    assert.equal(dispatches, 1);
    assert.equal(agent.state.messages.at(-1).stopReason, 'aborted');
    assert.ok(agent.hasQueuedMessages());
    await agent.continue(); // Explicit admission, not an automatic retry.
    assert.equal(dispatches, 2);
    assert.equal(agent.hasQueuedMessages(), false);
    console.log(`PASS late agent_end cancellation remains terminal until explicit fresh admission (${target})`);
  }
  // Cancellation during a queue poll must restore, not discard, already-drained input.
  for (const kind of ['steering', 'followUp']) {
    let agent, dispatches = 0, canceled = false;
    agent = new Agent({ initialState: { model }, streamFn() { dispatches++; return stream(msg([], 'stop')); } });
    agent[kind === 'steering' ? 'steer' : 'followUp'](user(`racing ${kind}`));
    const create = agent.createLoopConfig.bind(agent);
    agent.createLoopConfig = (...args) => {
      const config = create(...args), key = kind === 'steering' ? 'getSteeringMessages' : 'getFollowUpMessages', poll = config[key];
      config[key] = async () => { const messages = await poll(); if (!canceled && messages.length) { canceled = true; agent.abort(); } return messages; };
      return config;
    };
    await agent.prompt('race');
    assert.ok(agent.hasQueuedMessages());
    assert.equal(agent.peekQueuedMessages()[0].content[0].text, `racing ${kind}`);
    assert.equal(agent.state.messages.filter(m => m.role === 'user').length, 1);
    console.log(`PASS queue poll cancellation restores ${kind} (${target})`);
  }
  // Exercise the ACTUAL session scheduler method without auth/resources/provider setup.
  let continued = 0, boundaries = 0;
  const session = {
    _agentRunAbortRequested: false, _pendingToolNames: new Set(), _retryAttempt: 1,
    _finishCancelledRetry: AgentSession.prototype._finishCancelledRetry,
    _emit(event) { assert.equal(event.type, 'auto_retry_end'); assert.equal(event.success, false); },
    _recordSelection() {}, _flushPendingBashMessages() {}, _flushPendingCustomMessages() {}, async _emitAgentSettled() {},
    agent: { async prompt() { session._lastAssistantMessage = { stopReason: 'aborted' }; }, async continue() { continued++; } },
    async _handlePostAgentRun() { continued++; return false; }, async _runBeforeSettleBoundary() { boundaries++; return false; },
  };
  await AgentSession.prototype._runAgentPrompt.call(session, [user('offline')]);
  assert.equal(continued, 0); assert.equal(boundaries, 0); assert.equal(session._retryAttempt, 0);
  console.log(`PASS aborted session neither retries nor enters continuation boundary (${target})`);
}
