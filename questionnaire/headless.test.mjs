import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const imported = await import(pathToFileURL(join(process.argv[2], 'questionnaire/index.js')).href);
const questionnaire = imported.default?.default ?? imported.default;
let tool;
questionnaire({ registerTool(definition) { tool = definition; } });
let requests = [], localCalls = 0;
const questions = [
  { id: 'scope', prompt: 'Which scope?', options: [{ value: 'small', label: 'Small' }], allowOther: false },
  { id: 'detail', prompt: 'Details?', options: [{ value: 'default', label: 'Default' }] },
];
const ctx = { mode: 'rpc', hasUI: true, cwd: '/fixture', ui: { custom() { throw Error('RPC must not invoke custom TUI'); } }, abort() {} };
function service(answer) {
  globalThis.__paeWorkerInteractionsV1 = { protocol: 1, mode: 'headless', workerEpoch: 'fixture-epoch',
    async request(input, signal) { requests.push({ input, signal }); return typeof answer === 'function' ? await answer(input, signal) : answer; } };
}
const good = { kind: 'questionnaire', cancelled: false, answers: [
  { id: 'scope', value: 'small', wasCustom: false }, { id: 'detail', value: 'custom detail', wasCustom: true },
] };
const execute = (signal, context = ctx) => tool.execute('fixture-question', { questions }, signal, undefined, context);
try {
  service(good);
  const controller = new AbortController();
  const result = await execute(controller.signal);
  assert.equal(result.details.cancelled, false);
  assert.deepEqual(result.details.answers.map(({ id, value, label, wasCustom, index }) => ({ id, value, label, wasCustom, index })), [
    { id: 'scope', value: 'small', label: 'Small', wasCustom: false, index: 1 },
    { id: 'detail', value: 'custom detail', label: 'custom detail', wasCustom: true, index: undefined },
  ]);
  assert.match(result.content[0].text, /\n/);
  assert.equal(requests[0].signal, controller.signal);
  assert.equal(requests[0].input.questions[1].allowOther, true);
  for (const answer of [
    { ...good, answers: [{ id: 'scope', value: 'unknown', wasCustom: false }, good.answers[1]] },
    { ...good, answers: [{ id: 'scope', value: 'custom forbidden', wasCustom: true }, good.answers[1]] },
    { ...good, answers: [good.answers[0], good.answers[0]] },
    { ...good, answers: [good.answers[0]] },
    { kind: 'permission', cancelled: false, value: 'Allow' },
    { ...good, cancelled: 'false' },
  ]) {
    service(answer);
    const invalid = await execute();
    assert.equal(invalid.details.cancelled, true, 'invalid answer was accepted');
    assert.match(invalid.content[0].text, /Error:/, 'invalid response attributed to user cancellation');
  }
  service({ kind: 'questionnaire', cancelled: true, answers: [] });
  assert.equal((await execute()).content[0].text, 'User cancelled the questionnaire');
  const before = requests.length;
  const aborted = new AbortController(); aborted.abort();
  assert.equal((await execute(aborted.signal)).details.cancelled, true);
  assert.equal(requests.length, before, 'pre-aborted question was dispatched');
  const during = new AbortController();
  service((_input, signal) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true });
    queueMicrotask(() => during.abort());
  }));
  assert.equal((await execute(during.signal)).details.cancelled, true);
  service(() => { throw Error('UI transport unavailable'); });
  assert.match((await execute()).content[0].text, /interaction failed/);
  delete globalThis.__paeWorkerInteractionsV1;
  assert.match((await execute()).content[0].text, /service unavailable/);
  assert.match((await execute(undefined, { ...ctx, mode: 'print', hasUI: false })).content[0].text, /UI not available/);
  const tui = { ...ctx, mode: 'tui', ui: { async custom() {
    localCalls++;
    return { questions, answers: [{ id: 'scope', value: 'small', label: 'Small', wasCustom: false, index: 1 }], cancelled: false };
  } } };
  assert.equal((await execute(undefined, tui)).details.cancelled, false);
  assert.equal(localCalls, 1, 'existing TUI path was not used');
  console.log('headless questionnaire adapter tests passed');
} finally { delete globalThis.__paeWorkerInteractionsV1; }
