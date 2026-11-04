// Actual Pi tool validation/execution with an offline provider and disposable registry.
// No paid calls, child executors or user Goals. Usage: node <this-file> <Pi package dir>
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
const sdk = resolve(process.argv[2]);
const { createAgentSession, AgentSessionRuntime, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, initTheme } = await import(pathToFileURL(join(sdk, 'dist/index.js')));
const { AssistantMessageEventStream } = await import(pathToFileURL(join(sdk, 'node_modules/@earendil-works/pi-ai/dist/index.js')));
const { createJiti } = await import(pathToFileURL(join(sdk, 'node_modules/jiti/lib/jiti.mjs')));
const jiti = createJiti(import.meta.url, { alias: {
  '@earendil-works/pi-coding-agent': join(sdk, 'dist/index.js'),
  '@earendil-works/pi-ai': join(sdk, 'node_modules/@earendil-works/pi-ai/dist/index.js'),
  '@earendil-works/pi-tui': join(sdk, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
  typebox: join(sdk, 'node_modules/typebox/build/index.mjs'),
} });
const { default: workflows } = await jiti.import('../workflows/index.ts');
const text = message => typeof message.content === 'string' ? message.content : message.content.filter(p => p.type === 'text').map(p => p.text).join('\n');

test('actual Pi saved update edits, inserts and reorders without starting a Goal; schema rejects task status changes', { timeout: 20000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-saved-checklist-'));
  const oldRoot = process.env.PI_DELEGATED_GOALS_STATE_ROOT, originalFetch = globalThis.fetch;
  const oldDedicatedChild = process.env.PI_DEDICATED_GOAL_CHILD;
  delete process.env.PI_DEDICATED_GOAL_CHILD; // this disposable SDK fixture is a parent, even when the test runner is a worker
  process.env.PI_DELEGATED_GOALS_STATE_ROOT = join(directory, 'registry');
  globalThis.fetch = () => { throw Error('Network forbidden in saved checklist fixture'); };
  let session, owner, calls = 0, original, updated, mutation;
  const errors = [];
  try {
    initTheme('dark', false);
    const models = await ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: null, modelsStorePath: join(directory, 'models'), allowModelNetwork: false, refreshOnCreate: false });
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const fixture = pi => {
      workflows(pi, { goalSettingsPath: join(directory, 'goal-settings.json') });
      pi.on('session_start', async () => {
        const service = globalThis.__paeWorkflowsV1;
        const identity = { sessionId: service.sessionId, serviceEpoch: service.serviceEpoch, operation: 'start' };
        let snapshot = await service.handle({ ...identity, action: 'goals.create', requestId: randomUUID(), expectedGoalId: null, objective: 'Publish safe editing and wait for user-confirmed pin MR merge' });
        let entry = snapshot.delegatedGoals.entries[0];
        for (const [index, task] of ['Implement editing', 'Open only the nix-config pin MR', 'Wait for explicit user confirmation the pin MR merged'].entries()) {
          snapshot = await service.handle({ ...identity, action: 'goals.add_task', requestId: randomUUID(), expectedGoalId: entry.id, expectedEntryRevision: entry.revision, text: task });
          entry = snapshot.delegatedGoals.entries[0];
        }
        original = structuredClone(entry);
        mutation = { scope: 'saved', action: 'update', goal_id: entry.id, expected_revision: entry.revision, request_id: 'actual-tool-update', user_authorized: true, task_edits: [
          { id: entry.tasks[0].id, text: 'Implement and verify editing' },
          { text: 'Create isolated worktrees before editing', before_task_id: entry.tasks[0].id },
          { id: entry.tasks[2].id, before_task_id: entry.tasks[1].id },
          { text: 'e\u0301'.repeat(503) }, // canonical clusters, not UTF-16/schema maxLength
        ] };
      });
      pi.registerProvider('saved-checklist-test', {
        api: 'openai-completions', apiKey: 'offline', baseUrl: 'https://invalid.invalid',
        models: [{ id: 'offline', name: 'Offline', reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        streamSimple() {
          calls++; assert.ok(calls <= 6); assert.ok(mutation, JSON.stringify(errors));
          const results = session.sessionManager.getBranch().filter(e => e.type === 'message' && e.message.role === 'toolResult').map(e => e.message);
          let args, content;
          if (calls === 1 || calls === 2) args = mutation;
          if (calls === 2 || calls === 3) {
            const result = results.at(-1); assert.equal(result.isError ?? false, false, text(result));
            const value = JSON.parse(text(result)).goal;
            if (calls === 2) updated = value; else assert.deepEqual(value, updated);
          }
          if (calls === 3) args = { scope: 'saved', action: 'update', goal_id: original.id, expected_revision: updated.revision, request_id: 'schema-reject', user_authorized: true, task_edits: [{ id: original.tasks[0].id, status: 'completed' }] };
          if (calls === 4) { assert.equal(results.at(-1).isError, true); args = { scope: 'saved', action: 'status', goal_id: original.id }; }
          if (calls === 5) {
            assert.deepEqual(JSON.parse(text(results.at(-1))).goal, updated);
            args = { action: 'status', task_edits: [{ text: 'Wrong scope' }] };
          }
          if (calls === 6) {
            assert.equal(results.at(-1).isError, true);
            assert.equal(updated.id, original.id); assert.equal(updated.status, 'paused'); assert.equal(updated.child, null);
            assert.equal(updated.revision, original.revision + 1); assert.equal(updated.policyRevision, original.policyRevision);
            assert.equal(updated.tasks[0].text, 'Create isolated worktrees before editing'); assert.equal(updated.tasks[0].status, 'pending');
            assert.equal(updated.tasks[1].id, original.tasks[0].id); assert.equal(updated.tasks[1].text, 'Implement and verify editing');
            assert.deepEqual(updated.tasks.slice(2, 4), [original.tasks[2], original.tasks[1]]);
            assert.equal(updated.tasks[4].text, 'e\u0301'.repeat(503)); assert.equal(updated.tasks[4].status, 'pending');
            assert.equal(globalThis.__paeDelegatedGoalExecutorV1, undefined);
            content = [{ type: 'text', text: 'Verified saved checklist fixture; no Goal started or completed.' }];
          } else content = [{ type: 'toolCall', id: 'call-' + calls, name: 'goal_manage', arguments: args }];
          const message = { role: 'assistant', provider: 'saved-checklist-test', model: 'offline', api: 'openai-completions', timestamp: Date.now(), stopReason: calls === 6 ? 'stop' : 'toolUse', content,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          const stream = new AssistantMessageEventStream();
          queueMicrotask(() => { stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(); });
          return stream;
        },
      });
    };
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [fixture] });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: models, settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.create(directory, join(directory, 'sessions')), noTools: 'builtin' }));
    owner = new AgentSessionRuntime(session, { cwd: directory, agentDir: directory, modelRuntime: models, settingsManager: settings, resourceLoader: loader, diagnostics: [] }, async () => { throw Error('No session replacement'); });
    await session.bindExtensions({ onError: error => errors.push(error) });
    await session.setModel(models.getModel('saved-checklist-test', 'offline'));
    await session.prompt('Edit only the fixture saved checklist as specified; do not start or complete it.'); await session.waitForIdle();
    assert.equal(calls, 6, JSON.stringify(session.sessionManager.getBranch().filter(e => e.type === 'message' && e.message.role !== 'system').map(e => e.message))); assert.deepEqual(errors, []);
    const service = globalThis.__paeWorkflowsV1;
    const final = await service.handle({ sessionId: service.sessionId, serviceEpoch: service.serviceEpoch, operation: 'snapshot' });
    assert.equal(final.goal, null); assert.equal(final.delegatedGoals.entries[0].status, 'paused'); assert.equal(final.delegatedGoals.entries[0].child, null);
    assert.deepEqual(final.delegatedGoals.entries[0].tasks, updated.tasks);
  } finally {
    await session?.abort(); await owner?.dispose(); globalThis.fetch = originalFetch;
    if (oldRoot === undefined) delete process.env.PI_DELEGATED_GOALS_STATE_ROOT; else process.env.PI_DELEGATED_GOALS_STATE_ROOT = oldRoot;
    if (oldDedicatedChild === undefined) delete process.env.PI_DEDICATED_GOAL_CHILD; else process.env.PI_DEDICATED_GOAL_CHILD = oldDedicatedChild;
    await rm(directory, { recursive: true, force: true });
  }
});
