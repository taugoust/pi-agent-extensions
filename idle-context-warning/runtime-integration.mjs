// Deterministic, network-forbidden stock Pi/Node integration. No live sessions.
import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
assert.equal(process.version, 'v24.21.0');
const sdkDist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
assert.equal(JSON.parse(readFileSync(join(sdkDist, '../package.json'), 'utf8')).version, '1.4.0');
const root = pathToFileURL(join(import.meta.dirname, '..') + '/').href;
const aiUrl = pathToFileURL(join(sdkDist, '../node_modules/@earendil-works/pi-ai/dist/index.js')).href;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@earendil-works/pi-ai') return { url: aiUrl, shortCircuit: true };
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(root)) {
    const source = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (!existsSync(new URL(specifier, context.parentURL)) && existsSync(source)) return { url: source.href, shortCircuit: true };
  }
  return next(specifier, context);
}, load(url, context, next) {
  return next(url, url.endsWith('.json') && url.startsWith(root) ? { ...context, importAttributes: { ...context.importAttributes, type: 'json' } } : context);
} });
const { AssistantMessageEventStream } = await import(aiUrl);
const { default: idle, REMOTE_PREFLIGHT_KEY } = await import('./index.ts');
const { installQuietState } = await import('../shared/quiet-state.ts');
const { admitHarnessWake } = await import('../shared/idle-admission.ts');
const test = (name, fn) => nodeTest(name, { timeout: 10000 }, fn);
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(predicate) { for (let i = 0; i < 300; i++) { if (predicate()) return; await tick(); } throw Error('condition not reached'); }
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
function response(provider = 'probe', tokens = 3000) {
  return { role: 'assistant', provider, model: 'model', api: 'openai-completions', content: [{ type: 'text', text: 'Synthetic result' }], stopReason: 'stop', timestamp: Date.now(), usage: { input: tokens, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: tokens + 1, cost } };
}
async function fixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'idle-stock-'));
  const originalFetch = globalThis.fetch, previousWorker = process.env.PI_SUBAGENT_ID, previousAgent = process.env.AGENTSH_SUBAGENT_ID;
  delete process.env.PI_SUBAGENT_ID; delete process.env.AGENTSH_SUBAGENT_ID;
  if (options.worker) process.env.PI_SUBAGENT_ID = 'test-child';
  let network = 0;
  globalThis.fetch = async () => { network++; throw Error('NETWORK FORBIDDEN'); };
  const stats = { physical: 0, summary: 0, messages: [], hooks: [], modelSelections: [], errors: [] };
  const settings = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 128 }, retry: { enabled: false }, cacheWarming: 'off' });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models'), allowModelNetwork: false, refreshOnCreate: false });
  let ctx, quiet;
  const aliases = options.alias ? { role: 'probe/model' } : undefined;
  const extension = pi => {
    for (const provider of ['probe', 'small']) pi.registerProvider(provider, {
      api: 'openai-completions', apiKey: 'fake', baseUrl: 'https://invalid.invalid',
      models: ['model', 'small-model'].map(id => ({ id, name: `${provider}/${id}`, reasoning: true, input: ['text'], cost, contextWindow: 10000, maxTokens: 1000 })),
      streamSimple(model, transcript, streamOptions) {
        stats[model.id === 'small-model' ? 'summary' : 'physical']++;
        const stream = new AssistantMessageEventStream();
        queueMicrotask(async () => { try {
          await streamOptions?.onPayload?.({ messages: transcript.messages }, model);
          const output = model.id === 'model' && options.physical ? await options.physical(stats.physical) : response(provider);
          stream.push({ type: 'done', reason: 'stop', message: output });
        } catch (error) { stream.push({ type: 'error', reason: 'error', error: { ...response(provider), stopReason: 'error', errorMessage: String(error) } }); } finally { stream.end(); } });
        return stream;
      },
    });
    idle(pi, { readSettings: () => ({ idleMinutes: 1, contextPercent: 20, cheapCompactionModel: 'probe/small-model:off', guardedModels: aliases }), tombstonePath: join(dir, 'legacy-aliases.json') });
    quiet = installQuietState(pi, 1);
    pi.on('session_start', (_event, context) => { ctx = context; });
    pi.on('message_end', event => stats.messages.push(event.message));
    pi.on('model_select', event => stats.modelSelections.push(event));
    options.register?.(pi);
  };
  const manager = SessionManager.create(dir, join(dir, 'sessions'));
  manager.appendMessage({ role: 'user', content: 'Earlier request '.repeat(1000), timestamp: Date.now() - 120001 });
  manager.appendMessage({ ...response(), timestamp: Date.now() - 120000 });
  manager.appendMessage({ role: 'user', content: 'Recent request '.repeat(40), timestamp: Date.now() - 119999 });
  manager.appendMessage({ ...response(), timestamp: Date.now() - 119998 });
  manager.appendModelChange(options.alias ? 'idle-guard' : 'probe', options.alias ? 'role' : 'model');
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [extension] });
  await loader.reload();
  const model = modelRuntime.getModel(options.alias ? 'idle-guard' : 'probe', options.alias ? 'role' : 'model');
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, model, sessionManager: manager, settingsManager: settings, resourceLoader: loader, noTools: 'builtin' });
  await session.bindExtensions({ mode: 'rpc', onError: error => stats.errors.push(error) });
  // Extension registrations become available through the bound runtime. Select
  // only synthetic catalog models; no provider defaults or host credentials.
  await session.setModel(modelRuntime.getModel(options.alias ? 'idle-guard' : 'probe', options.alias ? 'role' : 'model'));
  if (options.alias) await session.prompt('/idle-context-migrate');
  return { dir, session, get ctx() { return ctx; }, manager, stats, get quiet() { return quiet; }, get capability() { return globalThis[REMOTE_PREFLIGHT_KEY]; },
    async close() {
      await session.abort(); session.dispose(); await modelRuntime.dispose?.();
      globalThis.fetch = originalFetch;
      if (previousWorker === undefined) delete process.env.PI_SUBAGENT_ID; else process.env.PI_SUBAGENT_ID = previousWorker;
      if (previousAgent === undefined) delete process.env.AGENTSH_SUBAGENT_ID; else process.env.AGENTSH_SUBAGENT_ID = previousAgent;
      delete globalThis.__piIdleContextParentV1;
      rmSync(dir, { recursive: true, force: true }); assert.equal(network, 0);
    },
  };
}

test('root RPC submission is consumed and remains pending without UI; Ignore releases exactly once', async () => {
  const f = await fixture();
  try {
    await f.session.prompt('request', { source: 'rpc' });
    await until(() => f.capability.pending);
    assert.equal(f.stats.physical, 0); assert.equal(f.capability.pending.state, 'pending');
    const id = f.capability.pending.id;
    await f.session.prompt(`/idle-context ignore ${id}`, { source: 'rpc' });
    await until(() => f.stats.physical === 1); await f.session.waitForIdle();
    assert.equal(f.capability.decide(id, 'ignore'), false); assert.equal(f.stats.physical, 1);
  } finally { await f.close(); }
});
test('Cancel drops submitted input without a model request', async () => {
  const f = await fixture(); try {
    await f.session.prompt('cancelled', { source: 'rpc' }); await until(() => f.capability.pending);
    f.capability.decide(f.capability.pending.id, 'cancel'); await until(() => !f.capability.pending);
    assert.equal(f.stats.physical, 0);
  } finally { await f.close(); }
});
test('explicit Compact persists native cheap summary before one ordinary-model request', async () => {
  const f = await fixture(); try {
    await f.session.prompt('after summary', { source: 'rpc' }); await until(() => f.capability.pending);
    f.capability.decide(f.capability.pending.id, 'compact');
    await until(() => f.stats.physical === 1).catch(error => { throw new Error(`${error.message}: ${JSON.stringify({ stats: f.stats, pending: f.capability.pending, branch: f.manager.getBranch().map(e => ({ type: e.type, id: e.id, parentId: e.parentId, customType: e.customType, data: e.data, details: e.details })) })}`); }); await f.session.waitForIdle();
    const compaction = f.manager.getBranch().findLast(e => e.type === 'compaction');
    assert.equal(compaction.details.idleContextNativeCompaction, 1); assert.ok(compaction.details.idleContextExplicitAttempt);
    assert.equal(f.stats.summary, 1); assert.equal(f.session.model.provider, 'probe');
  } finally { await f.close(); }
});
test('existing quiet completion queue asks root user, deduplicates while pending, and sends once', async () => {
  const f = await fixture(); try {
    const update = { kind: 'job', id: 'done', completion: true };
    assert.equal(f.quiet.enqueue(f.ctx, update), true); assert.equal(f.quiet.enqueue(f.ctx, update), true);
    await until(() => f.capability.pending); assert.equal(f.capability.pending.origin, 'notification'); assert.equal(f.stats.physical, 0);
    assert.equal(f.quiet.enqueue(f.ctx, update), true); f.capability.decide(f.capability.pending.id, 'ignore');
    await until(() => f.stats.physical === 1); await f.session.waitForIdle();
    const messages = f.manager.getBranch().filter(e => e.type === 'custom_message' && e.customType === 'harness-state');
    assert.equal(messages.length, 1); assert.equal(messages[0].details.updates.length, 1);
  } finally { await f.close(); }
});
test('ordinary guidance requires root admission; Cancel is durable across reload', async () => {
  const f = await fixture(); try {
    f.quiet.enqueue(f.ctx, { kind: 'notification', id: 'guidance-cancel', requires_guidance: true, message: 'ordinary guidance' });
    await until(() => f.capability.pending); assert.equal(f.stats.physical, 0);
    f.capability.decide(f.capability.pending.id, 'cancel'); await until(() => !f.capability.pending);
    await f.session.reload(); await tick(); assert.equal(f.capability.pending, undefined); assert.equal(f.stats.physical, 0);
  } finally { await f.close(); }
});
test('routing-relevant selection change revokes approval but retains queued completion', async () => {
  const f = await fixture(); try {
    f.quiet.enqueue(f.ctx, { kind: 'job', id: 'rethink', completion: true }); await until(() => f.capability.pending);
    const id = f.capability.pending.id; f.session.setThinkingLevel('low');
    await until(() => f.capability.pending && f.capability.pending.id !== id);
    assert.equal(f.capability.decide(id, 'ignore'), false); assert.equal(f.stats.physical, 0);
    f.capability.decide(f.capability.pending.id, 'cancel'); await until(() => !f.capability.pending);
  } finally { await f.close(); }
});
test('owning-parent worker decisions never open worker UI; missing parent stays pending', async () => {
  const f = await fixture({ worker: true }); try {
    const pending = f.capability.check(); await until(() => f.capability.pending);
    assert.equal(f.capability.pending.state, 'pending'); f.capability.decide(f.capability.pending.id, 'cancel'); assert.equal(await pending, 'cancel');
    let requested;
    globalThis.__piIdleContextParentV1 = { request: async details => { requested = details; return 'ignore'; } };
    assert.equal(await f.capability.check(), 'continue'); assert.equal(requested.model, 'probe/model'); assert.equal(f.stats.physical, 0);
  } finally { await f.close(); }
});
test('idle-decision control wake alone bypasses parent admission; ordinary guidance stays queued for root', async () => {
  const f = await fixture(); try {
    // Keep a normal root approval pending so a child cannot depend on that same
    // approval to deliver its parent-decision request.
    const root = f.capability.check(); await until(() => f.capability.pending);
    f.quiet.enqueue(f.ctx, { kind: 'notification', id: 'normal-help', requires_guidance: true, message: 'ordinary guidance' });
    f.quiet.enqueue(f.ctx, { kind: 'notification', id: 'idle-help', child_id: 'subagent-child-' + '1'.repeat(24), requires_guidance: true,
      admission_control: { kind: 'idle-decision', request_id: 'idle:' + '2'.repeat(32), worker_epoch: '3'.repeat(32) }, message: 'resolve child idle decision' });
    await until(() => f.stats.physical === 1); await f.session.waitForIdle();
    const sent = f.manager.getBranch().find(e => e.type === 'custom_message' && e.customType === 'harness-state');
    assert.deepEqual(sent.details.updates.map(u => u.id), ['idle-help']);
    f.capability.decide(f.capability.pending.id, 'cancel'); assert.equal(await root, 'cancel');
  } finally { await f.close(); }
});
test('resolved child idle-control requests stay suppressed even when old polling arrives after resolution or reload', async () => {
  const f = await fixture(); try {
    const child_id = 'subagent-child-' + '4'.repeat(24), request_id = 'idle:' + '5'.repeat(32), worker_epoch = '6'.repeat(32);
    f.quiet.enqueue(f.ctx, { kind: 'notification', id: 'resolved-first', child_id, admission_control: { kind: 'idle-decision-resolved', request_id, worker_epoch } });
    f.quiet.enqueue(f.ctx, { kind: 'notification', id: 'late-control', child_id, requires_guidance: true, admission_control: { kind: 'idle-decision', request_id, worker_epoch } });
    await tick(); assert.equal(f.stats.physical, 0); assert.equal(f.capability.pending, undefined);
    await f.session.reload();
    f.quiet.enqueue(f.ctx, { kind: 'notification', id: 'late-control', child_id, requires_guidance: true, admission_control: { kind: 'idle-decision', request_id, worker_epoch } });
    await tick(); assert.equal(f.stats.physical, 0);
  } finally { await f.close(); }
});
test('result read while notification admission waits suppresses the stale wake', async () => {
  const f = await fixture(); try {
    f.quiet.enqueue(f.ctx, { kind: 'job', id: 'read-first', completion: true }); await until(() => f.capability.pending);
    const id = f.capability.pending.id;
    f.quiet.consume(f.ctx, 'job', 'read-first');
    await until(() => !f.capability.pending); assert.equal(f.capability.decide(id, 'ignore'), false); await tick(); assert.equal(f.stats.physical, 0);
  } finally { await f.close(); }
});
test('legacy selected alias resolves through public model selection, no proxy/provider request', async () => {
  const f = await fixture({ alias: true }); try {
    assert.equal(f.session.model.provider, 'probe'); assert.equal(f.session.model.id, 'model');
    assert.equal(f.stats.physical, 0); assert.equal(f.stats.summary, 0);
    assert.equal(f.manager.getBranch().findLast(e => e.type === 'model_change').provider, 'probe');
  } finally { await f.close(); }
});
test('reload restores durable pending submission but never reuses approval', async () => {
  const f = await fixture(); try {
    await f.session.prompt('survive reload', { source: 'rpc' }); await until(() => f.capability.pending);
    const previous = f.capability, oldId = previous.pending.id;
    await f.session.reload(); await until(() => f.capability.pending).catch(error => { throw new Error(`${error.message}: ${JSON.stringify({ ready: f.capability?.ready, pending: f.capability?.pending, model: f.session.model, usage: f.ctx.getContextUsage(), records: f.manager.getBranch().filter(e => e.type === 'custom') })}`); });
    assert.notEqual(f.capability, previous); assert.notEqual(f.capability.pending.id, oldId);
    assert.equal(previous.decide(oldId, 'ignore'), false); assert.equal(f.stats.physical, 0);
    f.capability.decide(f.capability.pending.id, 'ignore'); await until(() => f.stats.physical === 1); await f.session.waitForIdle();
    const records = f.manager.getBranch().filter(e => e.type === 'custom' && e.customType === 'idle-context-submission');
    assert.equal(records.at(-1).data.state, 'released');
  } finally { await f.close(); }
});
test('reload preserves queued notification, no duplicate wake or approval across runtimes', async () => {
  const f = await fixture(); try {
    f.quiet.enqueue(f.ctx, { kind: 'job', id: 'reload-job', completion: true }); await until(() => f.capability.pending);
    const previous = f.capability, oldId = previous.pending.id;
    await f.session.reload(); await until(() => f.capability.pending);
    assert.equal(previous.decide(oldId, 'ignore'), false); assert.equal(f.stats.physical, 0);
    f.capability.decide(f.capability.pending.id, 'ignore'); await until(() => f.stats.physical === 1); await f.session.waitForIdle();
    await f.session.reload(); await tick(); assert.equal(f.stats.physical, 1);
  } finally { await f.close(); }
});
test('busy completion stays in existing queue and asks admission only after settlement', async () => {
  let release; const held = new Promise(resolve => release = resolve);
  const f = await fixture({ physical: async count => { if (count === 1) await held; return { ...response(), timestamp: Date.now() - 120000 }; } });
  try {
    const active = f.session.prompt('synthetic in-flight turn', { source: 'extension' }); await until(() => f.stats.physical === 1);
    f.quiet.enqueue(f.ctx, { kind: 'job', id: 'busy-job', completion: true }); await tick();
    assert.equal(f.capability.pending, undefined); assert.equal(f.stats.physical, 1);
    release(); await active; await until(() => f.capability.pending);
    assert.equal(f.stats.physical, 1); f.capability.decide(f.capability.pending.id, 'ignore');
    await until(() => f.stats.physical === 2); await f.session.waitForIdle();
  } finally { release(); await f.close(); }
});
test('shutdown revokes a pending decision; no stale approval or fake dispatch survives', async () => {
  const f = await fixture(); try {
    const controller = new AbortController(); const pending = admitHarnessWake(f.ctx, controller.signal);
    await until(() => f.capability.pending); const id = f.capability.pending.id;
    controller.abort(); assert.equal(await pending, 'cancel'); assert.equal(f.capability.decide(id, 'ignore'), false); assert.equal(f.stats.physical, 0);
  } finally { await f.close(); }
});
