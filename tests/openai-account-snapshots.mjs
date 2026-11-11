import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createJiti } =
  createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'))('jiti');
const jiti = createJiti(import.meta.url);
const { createAccountControlsSnapshot } =
  await jiti.import('../openai-accounts/account-controls.ts');
const { default: usage } = await jiti.import('../openai-usage/index.ts');

const CODEX = 'openai-codex';
const codexModel = {
  id: 'codex', provider: CODEX, api: 'openai-codex-responses',
  baseUrl: 'https://chatgpt.com/backend-api',
};
const oauth = (access) => ({ type: 'oauth', access, refresh: 'fake-refresh', expires: 1 });

function owner() {
  return {
    sessionId: 's', signal: new AbortController().signal, selections: { [CODEX]: 'work' },
    selectionRevisions: new Map([[CODEX, 2]]), results: new Map([[CODEX, { status: 'active' }]]),
    appliedIdentities: new Map([[CODEX, 'work:fake-original-token']]),
    pendingSyncTasks: new Map(), switchReserved: 0, openAIRequestCount: 0,
    context: {
      isIdle: () => true,
      modelRegistry: {
        getProvider: () => ({ baseUrl: codexModel.baseUrl, getModels: () => [codexModel] }),
        getAll: () => [codexModel],
        getProviderAuthStatus() { throw Error('Must not fall back to builtin profile'); },
      },
    },
  };
}
function store(credential) {
  return {
    readAsync: async () => ({
      providers: { [CODEX]: { accounts: credential ? { work: credential } : {} } },
    }),
  };
}

test('removed or replaced named credentials never report builtin authentication', async () => {
  for (const credential of [undefined, oauth('fake-new-token')]) {
    const snapshot = await createAccountControlsSnapshot(owner(), store(credential), 'epoch');
    assert.equal(snapshot.providerId, CODEX);
    assert.equal(snapshot.defaultSelected, false);
    assert.equal(snapshot.currentAccountId, 'work');
    assert.equal(snapshot.usage.status, 'unavailable');
    assert.equal(snapshot.usage.settingsUrl, null);
    assert.notEqual(snapshot.activationStatus, 'active');
    assert.equal(JSON.stringify(snapshot).includes('fake-'), false);
  }
  const matched = await createAccountControlsSnapshot(
    owner(), store(oauth('fake-original-token')), 'epoch');
  assert.equal(matched.activationStatus, 'active');
  assert.equal(matched.usage.status, 'local-binding-confirmed');
  assert.equal(JSON.stringify(matched).includes('fake-original-token'), false);
});

test('snapshot busy flags are checked after asynchronous store access', async () => {
  const o = owner();
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  const pending = createAccountControlsSnapshot(o, {
    readAsync: async () => {
      await ready;
      return { providers: { [CODEX]: { accounts: { work: oauth('fake-original-token') } } } };
    },
  }, 'epoch');
  o.context.isIdle = () => false;
  release();
  const snapshot = await pending;
  assert.equal(snapshot.busy, true);
  assert.equal(snapshot.canSwitch, false);
});

test('legacy usage entrypoint registers no redundant command', () => {
  const commands = [];
  usage({ registerCommand: (name) => commands.push(name) });
  assert.deepEqual(commands, []);
});
