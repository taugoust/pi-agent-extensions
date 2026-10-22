// Real GoalRuntime/lifecycle + SDK Agent, with controlled extension/session facades.
// No full AgentSession/provider/auth integration and no network or active sessions.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const sourceRoot = resolve(process.argv[2] ?? '.');
const sdkRoot = realpathSync(resolve(process.argv[3] ?? 'node_modules/@earendil-works/pi-coding-agent'));
globalThis.fetch = () => { throw new Error('Network forbidden in Goal lifecycle regression'); };
globalThis.WebSocket = class { constructor() { throw new Error('Network forbidden'); } };
const { createJiti } = await import(pathToFileURL(join(sdkRoot, 'node_modules/jiti/lib/jiti.mjs')));
const jiti = createJiti(import.meta.url, { alias: {
  '@earendil-works/pi-tui': join(sdkRoot, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
  'typebox': join(sdkRoot, 'node_modules/typebox/build/index.mjs'),
} });
const { GoalRuntime, createGoal } = await jiti.import(join(sourceRoot, 'workflows/goal/runtime.ts'));
const { registerGoalLifecycle } = await jiti.import(join(sourceRoot, 'workflows/goal/lifecycle.ts'));
const core = ['node_modules/@earendil-works/pi-agent-core/dist', 'node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist'].find(p => existsSync(join(sdkRoot, p, 'agent.js')));
const { Agent } = await import(pathToFileURL(join(sdkRoot, core, 'agent.js')));
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model = { id: 'offline', name: 'offline', api: 'offline', provider: 'offline', baseUrl: '', reasoning: false, input: ['text'], cost: usage.cost, contextWindow: 10000, maxTokens: 1000 };
const message = (content, stopReason = 'toolUse') => ({ role: 'assistant', api: 'offline', provider: 'offline', model: 'offline', content, stopReason, usage, timestamp: 0 });
const stream = m => ({ async *[Symbol.asyncIterator]() { yield { type: m.stopReason === 'aborted' ? 'error' : 'done', message: m }; }, async result() { return m; } });
function fixture(status = 'paused') {
  const handlers = new Map(), entries = [], signals = [], results = [], hookResults = [];
  let agent, executions = 0, dispatches = 0;
  const pi = {
    on(name, fn) { handlers.set(name, fn); },
    appendEntry(customType, data) { entries.push({ type: 'custom', customType, data }); },
    events: new EventEmitter(), sendMessage() {},
    getActiveTools() { return ['goal_complete', 'goal_blocked', 'goal_wait']; },
  };
  const runtime = new GoalRuntime(pi);
  const sessionManager = { getBranch: () => entries, getEntries: () => entries };
  const ctx = {
    cwd: sourceRoot, sessionManager,
    ui: { notify() {}, setStatus() {}, confirm: async () => false },
    getContextUsage: () => ({ tokens: 0 }), isIdle: () => !agent?.signal,
    hasPendingMessages: () => false, abort() { agent?.abort(); },
  };
  runtime.bindWorkflowSession(sessionManager);
  assert.ok(runtime.acquireWorkflow());
  runtime.activeGoal = createGoal('offline interrupted goal', 9000, 100);
  registerGoalLifecycle(pi, runtime, { bindSession() {} });
  const initialGoal = structuredClone(runtime.activeGoal);
  runtime.stopActiveGoal(ctx, { kind: 'agent_interruption', expectedGoalId: runtime.activeGoal.id, status, reason: 'initial wait interruption' });
  assert.equal(runtime.activeGoal.status, status);
  assert.equal(runtime.staleGoalToolCallsBlocked, true);
  agent = new Agent({ initialState: { model, tools: [{ name: 'offline_tool', label: 'offline', description: 'no side effects', parameters: { type: 'object', properties: {} }, async execute() { executions++; return { content: [{ type: 'text', text: 'ok' }] }; } }] },
    beforeToolCall(context) {
      const result = handlers.get('tool_call')({ type: 'tool_call', toolName: context.toolCall.name, toolCallId: context.toolCall.id, input: context.args }, ctx);
      hookResults.push(result); return result;
    },
    streamFn(_m, context, options) {
      dispatches++;
      if (options.signal.aborted) return stream({ ...message([], 'aborted'), errorMessage: 'Request was aborted' });
      const toolTurn = context.messages.at(-1)?.role !== 'toolResult';
      return stream(message(toolTurn ? [{ type: 'toolCall', id: `call-${dispatches}`, name: 'offline_tool', arguments: {} }] : [{ type: 'text', text: 'done' }], toolTurn ? 'toolUse' : 'stop'));
    },
  });
  agent.subscribe(async (event, signal) => {
    if (event.type === 'agent_start') signals.push({ signal, initiallyAborted: signal.aborted });
    if (event.type === 'tool_execution_end') results.push(event.result.content[0].text);
    await handlers.get(event.type)?.(event, ctx);
  });
  const emit = (name, event) => handlers.get(name)?.(event, ctx);
  async function prompt(text, behavior) {
    // The real SDK maps ExtensionAPI.sendUserMessage to source=extension and
    // streamingBehavior=deliverAs. Paseo idle human prompts omit deliverAs.
    const input = await emit('input', { source: 'extension', text, streamingBehavior: behavior });
    if (input?.action === 'handled') return input;
    await emit('before_agent_start', { prompt: text });
    await agent.prompt(text); // Emits actual user message_start and tool pipeline events.
  }
  function claimSiblingWorkflow() {
    const sibling = new GoalRuntime(pi);
    sibling.bindWorkflowSession(sessionManager);
    sibling.activeGoal = createGoal('unrelated workflow owns mutex', undefined, 0);
    assert.ok(sibling.acquireWorkflow());
    return sibling;
  }
  return { runtime, agent, ctx, emit, prompt, signals, results, hookResults, initialGoal, claimSiblingWorkflow, executions: () => executions };
}
for (const status of ['paused', 'blocked']) {
  const f = fixture(status), stoppedGoal = structuredClone(f.runtime.activeGoal);
  const sibling = f.claimSiblingWorkflow();
  for (let i = 0; i < 4; i++) {
    await f.prompt(`fresh idle extension human ${i}`);
    assert.equal(f.results.at(-1), 'ok', 'Fresh unowned idle human tool must not be aborted by stopped Goal ownership');
    assert.equal(f.executions(), i + 1);
    assert.equal(f.signals.at(-1).initiallyAborted, false);
    assert.equal(f.signals.at(-1).signal.aborted, false);
    if (i > 0) assert.notEqual(f.signals.at(-1).signal, f.signals.at(-2).signal);
  }
  assert.deepEqual(f.runtime.activeGoal, stoppedGoal, 'No goal resume, budget reset, or fresh goal authorization');
  assert.equal(f.runtime.staleGoalToolCallsBlocked, false);
  assert.equal(f.runtime.ownsWorkflow(), false);
  assert.equal(sibling.ownsWorkflow(), true, 'Fresh human input must not steal/release sibling workflow mutex');
  console.log(`PASS four fresh idle extension-origin human prompts (${status}): distinct clean signals, four actual tool executions, Goal/budget/sibling mutex unchanged`);
}
{
  const f = fixture();
  const input = await f.emit('input', { source: 'extension', text: 'busy steer', streamingBehavior: 'steer' });
  assert.notEqual(input?.action, 'handled');
  // Busy steers join an existing run: no before_agent_start boundary.
  await f.emit('message_start', { message: { role: 'user', content: [{ type: 'text', text: 'busy steer' }] } });
  await f.agent.prompt('existing canceled run');
  assert.equal(f.executions(), 0);
  assert.equal(f.results.at(-1), 'Operation aborted');
  assert.equal(f.runtime.staleGoalToolCallsBlocked, true);
  // Even a facade misdelivering before_agent_start may not reinterpret a queued steer.
  const g = fixture();
  await g.emit('input', { source: 'extension', text: 'queued steer', streamingBehavior: 'steer' });
  await g.emit('before_agent_start', { prompt: 'queued steer' });
  assert.equal(g.runtime.staleGoalToolCallsBlocked, true);
  console.log('PASS busy steer cannot release stopped Goal cleanup ownership');
}
{
  const f = fixture();
  const pending = f.runtime.rememberPendingGoalPrompt(f.runtime.activeGoal.id, 'old queued Goal automation', false);
  assert.deepEqual(await f.emit('input', { source: 'extension', text: pending.prompt }), { action: 'handled' });
  assert.equal(f.runtime.staleGoalToolCallsBlocked, true);
  const cancelledGoal = 'cancelled automation\n<!-- pi-goal-prompt:cancelled -->';
  const cancelledContinuation = 'old continuation\n<!-- pi-goal-continuation:cancelled -->';
  f.runtime.cancelledGoalPromptMarkers.set('cancelled', cancelledGoal);
  f.runtime.cancelledContinuationMarkers.set('cancelled', cancelledContinuation);
  for (const text of [cancelledGoal, cancelledContinuation]) {
    assert.deepEqual(await f.emit('input', { source: 'extension', text }), { action: 'handled' });
    assert.equal(f.runtime.staleGoalToolCallsBlocked, true);
  }
  // Marker-bearing automation remains excluded even after its tombstone was consumed.
  for (const text of [pending.prompt, cancelledGoal, cancelledContinuation]) {
    await f.emit('before_agent_start', { prompt: text });
    assert.equal(f.runtime.staleGoalToolCallsBlocked, true);
  }
  console.log('PASS stale owned Goal/continuation/cancellation-marker prompts do not acquire fresh human ownership');
}
{
  for (const automation of ['recovery', 'budget-wrapup-delivered', 'budget-wrapup-pending']) {
    const f = fixture();
    if (automation === 'recovery') f.runtime.goalRecovery = { goalId: f.runtime.activeGoal.id, kind: 'provider_retry', automaticOwner: true };
    else {
      f.runtime.activeGoal.status = 'budget_limited';
      f.runtime.budgetWrapUp = { goalId: f.runtime.activeGoal.id, delivered: automation.endsWith('delivered') };
    }
    await f.emit('before_agent_start', { prompt: `internal ${automation}` });
    assert.equal(f.runtime.staleGoalToolCallsBlocked, true);
  }
  console.log('PASS recovery and pending/delivered budget-wrapup automation cannot release stale ownership');
}
{
  const f = fixture(), stoppedGoal = structuredClone(f.runtime.activeGoal);
  await f.emit('message_start', { message: { role: 'custom', customType: 'harness-state', content: 'background job terminal notification' } });
  assert.equal(f.runtime.staleGoalToolCallsBlocked, false);
  await f.prompt('human after custom harness-state');
  assert.equal(f.executions(), 1);
  assert.deepEqual(f.runtime.activeGoal, stoppedGoal);
  console.log('PASS custom harness-state retains existing non-goal recovery behavior without resuming paused Goal');
}
