// Explicit Node integration suite (kept outside Bun's *.test.* discovery).
// Run: node --test idle-context-warning/runtime-integration.mjs
import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
const test = (name, fn) => nodeTest(name, { timeout: 10000 }, fn);
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAgentSession, AgentSessionRuntime, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { registerHooks } from 'node:module';
const sdkDist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
assert.equal(JSON.parse(readFileSync(join(sdkDist, '../package.json'), 'utf8')).version, '1.0.0', 'integration contract is pinned to Pi 1.0.0');
const aiUrl = pathToFileURL(join(sdkDist, '../node_modules/@earendil-works/pi-ai/dist/index.js')).href;
// This checkout links only the SDK package; resolve its exact installed AI
// dependency, avoiding package installation or a second incompatible runtime.
registerHooks({ resolve(specifier, context, next) { return specifier === '@earendil-works/pi-ai' ? { url: aiUrl, shortCircuit: true } : next(specifier, context); } });
const { AssistantMessageEventStream } = await import(aiUrl);
const { registerCompaction } = await import('./compaction.ts');
const { registerGuard } = await import('./guard.ts');
const { installQuietState } = await import('../shared/quiet-state.ts');
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function message(provider, now, tokens = 3000, content = [{ type: 'text', text: 'fake response' }], stopReason = 'stop') {
  return { role: 'assistant', provider, model: 'model', api: 'openai-completions', content, stopReason, timestamp: now,
    usage: { input: tokens, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: tokens + 1, cost: { ...cost, total: 0 } } };
}
async function fixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'idle-proxy-integration-'));
  const OriginalDate = globalThis.Date, originalFetch = globalThis.fetch;
  let now = OriginalDate.now();
  const initial = now;
  // Entry counters are distinct from simulated HTTP sends; onPayload may
  // reject after a provider is entered but before it sends anything.
  const stats = { physical: 0, cheap: 0, physicalSends: 0, cheapSends: 0, network: 0, tools: [], errors: [], trace: [] };
  let config = options.initialConfig ?? { idleMinutes: 1, contextPercent: 20, cheapCompactionModel: 'cheap-probe/model:off', guardedModels: { alias: 'physical-probe/model' } };
  let session, owner;
  globalThis.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  globalThis.fetch = async () => { stats.network++; throw Error('NETWORK FORBIDDEN'); };
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models'), allowModelNetwork: false, refreshOnCreate: false });
  const settings = SettingsManager.inMemory({ compaction: { enabled: !!options.compact, reserveTokens: 1000, keepRecentTokens: 128 }, retry: { enabled: false } });
  const extension = pi => {
    for (const provider of ['physical-probe', 'cheap-probe']) pi.registerProvider(provider, {
      baseUrl: 'https://invalid.invalid', apiKey: `fake-${provider}`, headers: { 'X-Physical-Probe': provider }, api: 'openai-completions',
      models: [{ id: 'model', name: 'fake', reasoning: true, input: ['text'], cost, contextWindow: 10000, maxTokens: 1000 }],
      streamSimple(model, context, streamOptions) {
        const cheap = provider === 'cheap-probe';
        stats[cheap ? 'cheap' : 'physical']++;
        stats.trace.push({ event: cheap ? 'cheap' : 'physical', now });
        const stream = new AssistantMessageEventStream();
        queueMicrotask(async () => {
          try {
            // Custom-provider contract: await onPayload before any HTTP dispatch.
            // This fixture records a fake send only after that hook permits it.
            await streamOptions?.onPayload?.({ provider, messages: context.messages }, model);
            stats[cheap ? 'cheapSends' : 'physicalSends']++;
            const result = await (cheap ? options.cheap?.({ session, streamOptions }) : options.physical?.({ session, count: stats.physical, context, streamOptions }));
            const output = result ?? message(provider, now);
            stream.push(output.stopReason === 'error' ? { type: 'error', reason: 'error', error: output } : { type: 'done', reason: output.stopReason, message: output });
          } catch (error) {
            stream.push({ type: 'error', reason: 'error', error: { ...message(provider, now, 10, [], 'error'), errorMessage: String(error) } });
          } finally { stream.end(); }
        });
        return stream;
      },
    });
    options.register?.(pi, { stats, cold: () => { now += 60001; }, now: () => now });
    const guard = registerGuard(pi, () => config, { tombstonePath: join(dir, 'aliases.json') });
    registerCompaction(pi, () => config, guard.compactionProof);
  };
  async function create({ sessionManager, sessionStartEvent }) {
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [extension] });
    await loader.reload();
    const result = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, sessionManager, settingsManager: settings, resourceLoader: loader, noTools: 'builtin', sessionStartEvent });
    return { ...result, services: { cwd: dir, agentDir: dir, modelRuntime, settingsManager: settings, resourceLoader: loader, diagnostics: [] }, diagnostics: [] };
  }
  const manager = options.persisted ? SessionManager.create(dir, join(dir, 'sessions')) : SessionManager.inMemory(dir);
  manager.appendMessage({ role: 'user', content: 'Previous question '.repeat(200), timestamp: initial - 1 });
  manager.appendMessage(message('physical-probe', initial, options.compact ? 9500 : 3000));
  const created = await create({ sessionManager: manager });
  session = created.session;
  owner = new AgentSessionRuntime(session, created.services, create);
  const bind = async next => { session = next; await session.bindExtensions({ onError: e => stats.errors.push(e) }); };
  owner.setRebindSession(bind);
  await bind(session);
  const alias = modelRuntime.getModel('idle-guard', 'alias');
  assert.ok(alias, 'guard registered real provider alias');
  await session.setModel(alias);
  return { get session() { return session; }, owner, stats, initial, modelRuntime,
    cold() { now += 60001; }, setConfig(value) { config = value; },
    async close() { await session.abort(); await owner.dispose(); globalThis.Date = OriginalDate; globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }); assert.equal(stats.network, 0); },
  };
}

for (const outcome of ['failure', 'abort']) test(`post-route auto-compaction crosses idle, cheap ${outcome}, zero physical dispatch`, async () => {
  const f = await fixture({ compact: true,
    register(pi, clock) { pi.on('session_before_compact', async () => { await Promise.resolve(); clock.cold(); }); },
    cheap({ session }) { if (outcome === 'abort') { session.abortCompaction(); return; } throw Error('fake cheap failure'); },
  });
  try {
    await f.session.prompt('new input');
    await f.session.waitForIdle();
    assert.equal(f.stats.cheap, 1, 'one cheap attempt, no core auto-compaction retry storm');
    assert.equal(f.stats.physical, 0, 'final provider gate blocks cold physical dispatch');
    for (let n = 0; n < 3; n++) await f.session.prompt(`new cold input ${n}`);
    await f.session.waitForIdle();
    assert.equal(f.stats.physical, 0);
    assert.equal(f.stats.cheap, 1, 'ordinary new input cannot retry failed cheap compaction');
    await f.session.prompt('/idle-guard-retry');
    await f.session.waitForIdle();
    assert.equal(f.stats.cheap, 2, 'explicit retry permits exactly one additional cheap attempt');
    assert.equal(f.stats.physical, 0);
  } finally { await f.close(); }
});

test('cold guard ignores warning contextPercent threshold', async () => {
  const f = await fixture({ cheap() { throw Error('keep cold gate closed'); } });
  try {
    f.setConfig({ idleMinutes: 1, contextPercent: 100, cheapCompactionModel: 'cheap-probe/model:off', guardedModels: { alias: 'physical-probe/model' } });
    f.cold();
    await f.session.prompt('cold context is only 30 percent, warning threshold is 100');
    await f.session.waitForIdle();
    assert.equal(f.stats.physical, 0);
    assert.match(f.session.messages.findLast(item => item.role === 'assistant')?.errorMessage ?? '', /IDLE_GUARD_CLOSED/);
  } finally { await f.close(); }
});

test('fresh cold user input and queued custom notification never dispatch physical', async () => {
  const f = await fixture();
  try {
    f.cold();
    await f.session.sendCustomMessage({ customType: 'notification', content: 'notification', display: true }, { triggerTurn: false });
    await f.session.prompt('cold user input');
    await assert.rejects(f.session.sendUserMessage('input during guarded compaction'), /compaction is in progress/);
    f.session.abortCompaction();
    await f.session.waitForIdle();
    assert.equal(f.stats.physical, 0);
  } finally { await f.close(); }
});

test('sibling tools drain, queued steering/follow-up/notifications cannot bypass final gate', async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture({
    physical({ count }) { if (count === 1) return message('physical-probe', Date.now(), 3000, [1, 2].map(n => ({ type: 'toolCall', id: `call-${n}`, name: 'pause_probe', arguments: { n } })), 'toolUse'); },
    register(pi, clock) {
      pi.registerTool({ name: 'pause_probe', label: 'pause', description: 'In-process barrier', executionMode: 'parallel', parameters: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
        async execute(_id, args) { clock.stats.tools.push(args.n); if (clock.stats.tools.length === 2) entered.resolve(); if (args.n === 1) { await release.promise; clock.cold(); } return { content: [{ type: 'text', text: 'done' }] }; },
      });
    },
  });
  try {
    const running = f.session.prompt('call sibling tools');
    await entered.promise;
    await f.session.steer('queued steering input');
    await f.session.followUp('queued follow-up input');
    await f.session.sendCustomMessage({ customType: 'notice', content: 'queued notice', display: true }, { deliverAs: 'followUp', triggerTurn: true });
    release.resolve();
    await running;
    await f.session.waitForIdle();
    assert.deepEqual(f.stats.tools, [1, 2]);
    assert.equal(f.stats.physical, 1, 'only initial warm tool-call dispatch; none after tools cross idle');
  } finally { release.resolve(); await f.close(); }
});

for (const transition of ['reload', 'newSession']) test(`${transition} during guarded compaction invalidates late success`, async () => {
  const entered = deferred(), release = deferred();
  const f = await fixture({ async cheap() { entered.resolve(); await release.promise; } });
  try {
    f.cold();
    await f.session.prompt('cold request with suspended cheap compaction');
    await entered.promise;
    const replacing = transition === 'reload' ? f.session.reload() : f.owner.newSession();
    release.resolve();
    await replacing;
    await f.session.waitForIdle();
    assert.equal(f.stats.physical, 0, 'late cheap completion cannot resume invalidated session');
  } finally { release.resolve(); await f.close(); }
});

test('successful persisted native cheap compaction permits one resumed physical request', async () => {
  const dispatched = deferred();
  const f = await fixture({ persisted: true, physical() { dispatched.resolve(); } });
  try {
    f.cold();
    await f.session.prompt('cold request requiring native compaction');
    await dispatched.promise;
    await f.session.waitForIdle();
    assert.equal(f.stats.cheap, 1);
    assert.equal(f.stats.physical, 1);
    const compaction = f.session.sessionManager.getBranch().findLast(entry => entry.type === 'compaction');
    assert.equal(compaction.details.idleContextNativeCompaction, 1);
    assert.equal(compaction.details.idleContextGuard.alias, 'alias');
    const reopened = SessionManager.open(f.session.sessionFile);
    const durable = reopened.getBranch().findLast(entry => entry.type === 'compaction');
    assert.deepEqual(durable.details.idleContextGuard, compaction.details.idleContextGuard);
    const savedFile = f.session.sessionFile;
    await f.owner.newSession();
    await f.owner.switchSession(savedFile);
    assert.equal(f.session.model.provider, 'idle-guard');
    assert.equal(f.session.model.id, 'alias');
    await f.session.prompt('warm input after durable restore');
    assert.equal(f.stats.physical, 2);
  } finally { await f.close(); }
});

test('initially cold high-context request compacts once and dispatches only with durable proof', async () => {
  const f = await fixture({ persisted: true, compact: true });
  try {
    f.cold();
    await f.session.prompt('already cold and above native compaction threshold');
    await f.session.waitForIdle();
    assert.equal(f.stats.cheap, 1);
    assert.equal(f.stats.physical, 1);
    assert.equal(f.stats.physicalSends, 1);
    const branch = SessionManager.open(f.session.sessionFile).getBranch();
    const compactions = branch.filter(entry => entry.type === 'compaction');
    assert.equal(compactions.length, 1);
    assert.equal(compactions[0].details.idleContextGuard.alias, 'alias');
    const physicalEntry = branch.findLast(entry => entry.type === 'message' && entry.message.role === 'assistant' && entry.message.provider === 'physical-probe');
    assert.ok(branch.indexOf(compactions[0]) < branch.indexOf(physicalEntry), 'durable compaction precedes physical response');
  } finally { await f.close(); }
});

test('slow post-route auto-compaction success authorizes physical dispatch without redundant compaction', async () => {
  const dispatched = deferred();
  let crossed = false;
  const f = await fixture({ persisted: true, compact: true,
    register(pi, clock) { pi.on('session_before_compact', async () => { if (!crossed) { crossed = true; await Promise.resolve(); clock.cold(); } }); },
    physical() { dispatched.resolve(); },
  });
  try {
    await f.session.prompt('warm route, slow successful auto-compaction');
    let timer;
    try {
      await Promise.race([dispatched.promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(`No physical resume after successful auto-compaction: ${JSON.stringify(f.stats)}`)), 2000);
      })]);
    } finally { clearTimeout(timer); }
    await f.session.waitForIdle();
    assert.equal(f.stats.cheap, 1, 'one successful native summary, no redundant compaction');
    assert.equal(f.stats.physical, 1);
    const reopened = SessionManager.open(f.session.sessionFile);
    const compactions = reopened.getBranch().filter(entry => entry.type === 'compaction');
    assert.equal(compactions.length, 1);
    assert.equal(compactions[0].details.idleContextGuard.alias, 'alias');
  } finally { await f.close(); }
});

for (const producer of ['job', 'subagent', 'guidance']) test(`shared quiet-state ${producer} delivery cannot dispatch cold physical model`, async () => {
  let quiet, context;
  const delivered = deferred();
  const updates = [];
  const f = await fixture({
    cheap() { throw Error('intentional cheap failure preserves cold gate'); },
    register(pi) {
      quiet = installQuietState(pi, 0);
      pi.on('session_start', (_event, ctx) => { context = ctx; });
    },
  });
  let unsubscribe;
  let timer;
  try {
    f.cold();
    unsubscribe = f.session.subscribe(event => {
      if (event.type === 'message_end' && event.message.customType === 'harness-state') {
        updates.push(...event.message.details.updates);
        delivered.resolve();
      }
    });
    const update = producer === 'guidance'
      ? { kind: 'subagent', id: 'guidance-test', child_id: 'subagent-child-000000000000000000000001', requires_guidance: true, message: 'Need parent guidance' }
      : { kind: producer, id: `${producer}-completion-test`, job_id: `${producer}-job-test`, child_id: producer === 'subagent' ? 'subagent-child-000000000000000000000002' : undefined, state: 'completed', completion: true };
    assert.equal(quiet.enqueue(context, update), true);
    await Promise.race([delivered.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`No real harness-state delivery for ${producer}`)), 3000); })]);
    await f.session.waitForIdle();
    assert.ok(updates.some(item => item.id === update.id), 'actual shared producer message reached real session');
    const response = f.session.messages.findLast(item => item.role === 'assistant');
    assert.match(response?.errorMessage ?? '', /IDLE_GUARD_CLOSED/, 'producer wakeup reached and was rejected by final dispatch gate');
    assert.equal(f.stats.physical, 0);
    assert.ok(f.session.sessionManager.getBranch().some(entry => entry.type === 'custom' && entry.customType === 'harness-state-receipt'));
  } finally { clearTimeout(timer); unsubscribe?.(); await f.close(); }
});

test('delegated onPayload await crossing idle blocks send after physical provider entry', async () => {
  let payloadCalls = 0;
  const f = await fixture({
    cheap() { throw Error('intentional failure keeps guard closed'); },
    register(pi, clock) {
      pi.on('before_provider_request', async event => {
        if (event.payload.provider !== 'physical-probe') return;
        payloadCalls++;
        await Promise.resolve();
        clock.cold();
      });
    },
  });
  try {
    await f.session.prompt('warm dispatch, slow payload hook');
    await f.session.waitForIdle();
    assert.equal(payloadCalls, 1, 'original awaited provider hook executed');
    assert.equal(f.stats.physical, 1, 'physical stream implementation entered while warm');
    assert.equal(f.stats.physicalSends, 0, 'final post-onPayload check prevented simulated HTTP send');
    const response = f.session.messages.findLast(item => item.role === 'assistant');
    assert.match(response?.errorMessage ?? '', /IDLE_GUARD_CLOSED/);
  } finally { await f.close(); }
});

test('destination authentication await crossing idle blocks simulated HTTP dispatch', async () => {
  const f = await fixture({ cheap() { throw Error('intentional failure keeps guard closed'); } });
  const originalAuth = f.modelRuntime.getAuth.bind(f.modelRuntime);
  let authCalls = 0;
  f.modelRuntime.getAuth = async (model, options) => {
    if (typeof model !== 'string' && model.provider === 'physical-probe') {
      authCalls++;
      await Promise.resolve();
      f.cold();
    }
    return originalAuth(model, options);
  };
  try {
    await f.session.prompt('warm request, delayed destination credential resolution');
    await f.session.waitForIdle();
    assert.equal(authCalls, 1);
    assert.equal(f.stats.physicalSends, 0);
    assert.match(f.session.messages.findLast(item => item.role === 'assistant')?.errorMessage ?? '', /IDLE_GUARD_CLOSED/);
  } finally { f.modelRuntime.getAuth = originalAuth; await f.close(); }
});

test('warm summary crossing idle during destination auth stays closed before send', async () => {
  const f = await fixture();
  await f.session.prompt('establish a warm turn before manual compaction');
  const baselineSends = f.stats.physicalSends;
  let authCalls = 0;
  const originalAuth = f.modelRuntime.getAuth.bind(f.modelRuntime);
  f.modelRuntime.getAuth = async (model, options) => {
    if (typeof model !== 'string' && model.provider === 'physical-probe') { authCalls++; await Promise.resolve(); f.cold(); }
    return originalAuth(model, options);
  };
  try {
    await assert.rejects(f.session.compact());
    assert.equal(authCalls, 1, 'native summary reached destination credential resolution');
    assert.equal(f.stats.physicalSends, baselineSends);
    assert.equal(f.stats.cheap, 0, 'warm attempt cancels rather than silently changing summary policy');
    await f.session.prompt('input after cancelled warm summary');
    assert.equal(f.stats.physicalSends, baselineSends);
  } finally { f.modelRuntime.getAuth = originalAuth; await f.close(); }
});

test('warm automatic threshold compaction uses physical summary and physical continuation', async () => {
  const thinking = [];
  const f = await fixture({ compact: true, persisted: true, physical({ streamOptions }) { thinking.push(streamOptions.reasoning); } });
  try {
    f.session.setThinkingLevel('high');
    await f.session.prompt('warm automatic compaction policy');
    await f.session.waitForIdle();
    assert.equal(f.stats.physicalSends, 2, 'one physical summary and one conversation response');
    assert.equal(f.stats.cheap, 0);
    assert.deepEqual(thinking, ['high', 'high']);
    const entry = SessionManager.open(f.session.sessionFile).getBranch().findLast(item => item.type === 'compaction');
    assert.equal(entry.details.idleContextGuard.mode, 'physical');
  } finally { await f.close(); }
});

test('warm guarded native compaction keeps physical model and selected thinking', async () => {
  let observed;
  const f = await fixture({ persisted: true, physical({ streamOptions }) { observed = streamOptions; } });
  try {
    f.setConfig({ idleMinutes: 1, contextPercent: 20, cheapCompactionModel: null, guardedModels: { alias: 'physical-probe/model' } });
    f.session.setThinkingLevel('high');
    await f.session.prompt('establish a warm turn before manual compaction');
    const baseline = f.stats.physical;
    await f.session.compact();
    assert.equal(f.stats.physical, baseline + 1, 'warm summary uses physical conversation model');
    assert.equal(f.stats.physicalSends, baseline + 1);
    assert.equal(f.stats.cheap, 0);
    assert.equal(observed.reasoning, 'high');
    assert.equal(f.session.thinkingLevel, 'high');
    assert.equal(f.session.model.provider, 'idle-guard');
    const entry = SessionManager.open(f.session.sessionFile).getBranch().findLast(item => item.type === 'compaction');
    assert.equal(entry.details.idleContextNativeCompaction, 1);
    assert.equal(entry.details.idleContextGuard.target, 'physical-probe/model');
  } finally { await f.close(); }
});

test('warm dispatch preserves non-off thinking and physical credentials/headers', async () => {
  let observed;
  const f = await fixture({ physical({ streamOptions }) { observed = streamOptions; } });
  try {
    f.session.setThinkingLevel('high');
    await f.session.prompt('warm reasoning request');
    assert.equal(f.stats.physical, 1);
    assert.equal(f.session.thinkingLevel, 'high');
    assert.equal(observed.reasoning, 'high');
    assert.equal(observed.apiKey, 'fake-physical-probe');
    assert.equal(observed.headers['X-Physical-Probe'], 'physical-probe');
    assert.notEqual(observed.apiKey, 'idle-guard-local-only');
  } finally { await f.close(); }
});

test('first-time malformed target retains a closed selectable alias', async () => {
  const f = await fixture({ initialConfig: { idleMinutes: 1, contextPercent: 20, cheapCompactionModel: 'cheap-probe/model:off', guardedModels: { alias: 'malformed-target' } } });
  try {
    await f.session.prompt('invalid target must not fall back');
    assert.equal(f.session.model.provider, 'idle-guard');
    assert.equal(f.stats.physical, 0);
    assert.equal(f.stats.cheap, 0);
  } finally { await f.close(); }
});

test('removed alias tombstone survives reload after a physical response', async () => {
  const f = await fixture();
  try {
    await f.session.prompt('warm initial request');
    assert.equal(f.stats.physical, 1);
    f.setConfig({ idleMinutes: 1, contextPercent: 20, guardedModels: {} });
    await f.session.reload();
    assert.equal(f.session.model.provider, 'idle-guard');
    assert.equal(f.session.model.id, 'alias');
    await f.session.prompt('removed alias must not fall back to physical history');
    assert.equal(f.stats.physical, 1);
  } finally { await f.close(); }
});

test('reload, newSession and switchSession preserve cold isolation', async () => {
  const f = await fixture({ persisted: true });
  try {
    const originalFile = f.session.sessionFile;
    assert.ok(originalFile);
    f.cold();
    await f.session.reload();
    await f.session.prompt('cold after reload');
    assert.equal(f.stats.physical, 0);
    await f.owner.newSession({ setup: async manager => {
      manager.appendMessage({ role: 'user', content: 'restored question', timestamp: f.initial - 1 });
      manager.appendMessage(message('physical-probe', f.initial));
    } });
    await f.session.setModel(f.modelRuntime.getModel('idle-guard', 'alias'));
    await f.session.prompt('cold after real runtime replacement');
    assert.equal(f.stats.physical, 0);
    await f.owner.switchSession(originalFile);
    await f.session.setModel(f.modelRuntime.getModel('idle-guard', 'alias'));
    await f.session.prompt('cold after switchSession restore');
    assert.equal(f.stats.physical, 0);
  } finally { await f.close(); }
});
