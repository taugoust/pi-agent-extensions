// Offline stock-runtime contracts, not a universal model-dispatch guard.
// Run with Node 24.21: node --test idle-context-warning/stock-contract.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

const sdkDist = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
assert.equal(JSON.parse(readFileSync(join(sdkDist, '../package.json'), 'utf8')).version, '1.4.0');
assert.equal(process.versions.node, '24.21.0', 'probe targets the deployed Node runtime');
const { AssistantMessageEventStream } = await import(pathToFileURL(join(sdkDist, '../node_modules/@earendil-works/pi-ai/dist/index.js')).href);

async function probe(register, run) {
  const root = mkdtempSync(join(tmpdir(), 'idle-stock-contract-'));
  const originalFetch = globalThis.fetch;
  const stats = { sends: 0, network: 0, errors: [], payloads: [] };
  globalThis.fetch = async () => { stats.network++; throw Error('NETWORK FORBIDDEN'); };
  let session, runtime;
  try {
    runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, modelsStorePath: join(root, 'models'), allowModelNetwork: false, refreshOnCreate: false });
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' });
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => {
        pi.registerProvider('offline-contract', { apiKey: 'fake-local-only', baseUrl: 'https://invalid.invalid', api: 'openai-completions',
          models: [{ id: 'model', name: 'offline', reasoning: false, input: ['text'], contextWindow: 10000, maxTokens: 1000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
          streamSimple(model, transcript, options) {
            const stream = new AssistantMessageEventStream();
            queueMicrotask(async () => {
              try {
                const payload = { marker: 'original' };
                stats.payloads.push(await options.onPayload?.(payload, model) ?? payload);
                stats.sends++; // Simulated send, only after the supported instrumentation hook.
                const message = { role: 'assistant', provider: model.provider, model: model.id, api: model.api,
                  timestamp: Date.now(), content: [{ type: 'text', text: 'offline response' }], stopReason: 'stop',
                  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
                stream.push({ type: 'done', reason: 'stop', message });
              } finally { stream.end(); }
            });
            return stream;
          },
        });
        register(pi);
      }],
    });
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime,
      model: runtime.getModel('offline-contract', 'model'), settingsManager: settings,
      sessionManager: SessionManager.inMemory(root), resourceLoader: loader, noTools: 'builtin' }));
    await session.bindExtensions({ onError: error => stats.errors.push(error) });
    await session.setModel(runtime.getModel('offline-contract', 'model'));
    await run(session, stats);
  } finally {
    try { await session?.abort(); session?.dispose(); }
    finally { globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }); }
  }
  assert.equal(stats.network, 0, 'no external fetches');
}

test('handled input consumes its owned submission without a provider send', { timeout: 10000 }, async () => {
  await probe(pi => pi.on('input', () => ({ action: 'handled' })), async (session, stats) => {
    await session.prompt('offline handled input');
    assert.equal(stats.sends, 0);
  });
});

test('throwing before_provider_request is not a fail-closed veto on stock Pi', { timeout: 10000 }, async () => {
  await probe(pi => pi.on('before_provider_request', () => { throw Error('contract refusal'); }), async (session, stats) => {
    await session.prompt('offline transformer error');
    assert.equal(stats.sends, 1, 'handler errors are reported but payload dispatch continues');
    assert.ok(stats.errors.some(error => error.event === 'before_provider_request'));
    assert.deepEqual(stats.payloads, [{ marker: 'original' }]);
  });
});

test('cancel-shaped provider-hook result replaces payload rather than cancelling dispatch', { timeout: 10000 }, async () => {
  await probe(pi => pi.on('before_provider_request', () => ({ cancel: true })), async (session, stats) => {
    await session.prompt('offline replacement payload');
    assert.equal(stats.sends, 1);
    assert.deepEqual(stats.payloads, [{ cancel: true }]);
  });
});
