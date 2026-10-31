import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const { createJiti } = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'))('jiti');
const { switchAccount } = await createJiti(import.meta.url).import(process.env.ACCOUNTS_RACE_MODULE ?? '../openai-accounts/accounts.ts');

for (const mutation of ['pin', 'route', 'reservation', 'cancel', 'owner']) {
  test(`TUI admission rejects ${mutation} during asynchronous model validation`, async () => {
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const controller = new AbortController();
    const session = { selectionRevisions: new Map([['openai', 0]]), routingProfile: { revision: 1 }, switchReserved: 0, openAIRequestCount: 0 };
    let current = true, persisted = false;
    const ctx = { isIdle: () => true, ui: { notify() {} } };
    const pending = switchAccount(ctx, {}, { id: 'openai', displayName: 'OpenAI' }, 'default', controller.signal,
      async () => { throw Error('stale selection must not activate'); },
      (_owner, _provider, _account, guard) => { if (!guard()) return false; persisted = true; return true; },
      session, () => current, async () => { entered(); await gate; return true; });
    await started;
    if (mutation === 'pin') session.selectionRevisions.set('openai', 1);
    if (mutation === 'route') session.routingProfile = { revision: 2 };
    if (mutation === 'reservation') session.switchReserved = 1;
    if (mutation === 'cancel') controller.abort();
    if (mutation === 'owner') current = false;
    release();
    await pending;
    assert.equal(persisted, false, 'concurrent manual pin/route must not be overwritten');
  });
}
