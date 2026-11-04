import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

// Only SDK presentation/schema imports are stubbed. Execute, deadline, Paseo,
// recorder and interaction validation all run their actual implementations.
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith("/questionnaire/index.ts") && specifier === "./paseo.js") {
    return { url: new URL("./paseo.ts", context.parentURL).href, shortCircuit: true };
  }
  if (specifier === "@mariozechner/pi-tui") return { url: "data:text/javascript," + encodeURIComponent(`
    export class Editor { setText() {} handleInput() {} }
    export class Text { constructor(text) { this.text = text; } }
    export const Key = {enter:'enter',escape:'escape',shift:key=>'shift-'+key};
    export const matchesKey = (data,key) => data === key;
    export const truncateToWidth = value => value;
  `), shortCircuit: true };
  if (specifier === "@sinclair/typebox") return { url: "data:text/javascript," + encodeURIComponent(`
    export const Type = {Object:properties=>({properties}),String:()=>({}),Boolean:()=>({}),Optional:x=>x,Array:items=>({items})};
  `), shortCircuit: true };
  return next(specifier, context);
} });
const { default: questionnaire } = await import("./index.ts");
const { QUESTIONNAIRE_TIMEOUT_MS, QUESTIONNAIRE_TIMEOUT_REASON, withQuestionnaireTimeout } = await import("./timeout.ts");
const { createGoalQuestions, GOAL_QUESTION_RECORDER_KEY } = await import("../workflows/goal-questions.ts");
const keys = ["__paeWorkerInteractionsV1", "__paeGuidanceHumanV1", "__piPaseoRemoteUiV1", "__PI_AGENTSH_PUBLISH_EVENT__", "__PI_AGENTSH_GET_QUESTION_ANSWER__", GOAL_QUESTION_RECORDER_KEY];
const questions = [{ id: "scope", prompt: "Which scope?", recommendation: "chosen", options: [{ value: "chosen", label: "Chosen" }], allowOther: true }];
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fixture(t) {
  const saved = keys.map(key => [key, globalThis[key]]), env = process.env.PI_SUBAGENT_GUIDANCE_V1;
  keys.forEach(key => delete globalThis[key]); delete process.env.PI_SUBAGENT_GUIDANCE_V1;
  t.after(() => { for (const [key, value] of saved) value === undefined ? delete globalThis[key] : globalThis[key] = value;
    env === undefined ? delete process.env.PI_SUBAGENT_GUIDANCE_V1 : process.env.PI_SUBAGENT_GUIDANCE_V1 = env; });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1700000000000 });
  let tool, component, doneCalls = 0, abortCalls = 0, openedResolve;
  const opened = new Promise(resolve => { openedResolve = resolve; });
  const events = [];
  globalThis.__PI_AGENTSH_PUBLISH_EVENT__ = async (...event) => { events.push(event); return true; };
  const theme = { fg: (_color, text) => text, bold: text => text };
  questionnaire({ registerTool(value) { tool = value; } });
  const ctx = { cwd: "/fixture", mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "timeout-session" },
    abort() { abortCalls++; }, ui: { custom(factory) { return new Promise(resolve => {
      component = factory({ requestRender() {} }, theme, {}, result => { doneCalls++; resolve(result); }); openedResolve();
    }); } } };
  return { tool, ctx, opened, events, theme, get component() { return component; }, get doneCalls() { return doneCalls; }, get abortCalls() { return abortCalls; },
    execute: (input = questions, signal) => tool.execute("timeout-fixture", { questions: input }, signal, undefined, ctx) };
}
function assertTimeout(result, f) {
  assert.deepEqual(result.content, [{ type: "text", text: "Questionnaire timed out." }]);
  assert.equal(result.isError, undefined);
  assert.equal(result.details.timedOut, true);
  assert.equal(result.details.cancelled, false);
  assert.equal(result.details.cancelledByHuman, undefined);
  assert.equal(result.details.failure, undefined);
  assert.deepEqual(result.details.answers, []);
  assert.equal(f.abortCalls, 0, "expiry must not abort or pause the agent");
  assert.equal(f.tool.renderResult(result, {}, f.theme).text, "Timed out");
}

test("default deadline is exactly five minutes, even if the headless transport ignores abort", async t => {
  const f = fixture(t); let forwardedSignal;
  globalThis.__paeWorkerInteractionsV1 = { protocol: 1, mode: "headless", workerEpoch: "worker", request(_input, signal) {
    forwardedSignal = signal; return new Promise(() => {});
  } };
  const agent = new AbortController(); const pending = f.execute(questions, agent.signal); let settled = false;
  pending.then(() => { settled = true; });
  assert.equal(QUESTIONNAIRE_TIMEOUT_MS, 300000);
  t.mock.timers.tick(299999); await flush(); assert.equal(settled, false);
  t.mock.timers.tick(1); assertTimeout(await pending, f);
  assert.equal(forwardedSignal.aborted, true);
  assert.equal(forwardedSignal.reason, QUESTIONNAIRE_TIMEOUT_REASON);
  assert.equal(agent.signal.aborted, false);
});

test("terminal expiry dismisses the UI and records timeout, never a user cancellation", async t => {
  const f = fixture(t); const pending = f.execute(); await f.opened;
  t.mock.timers.tick(300000); assertTimeout(await pending, f); await flush();
  assert.equal(f.doneCalls, 1);
  const event = f.events.find(([type]) => type === "agent.question.answered");
  assert.equal(event[1], "Questionnaire timed out"); assert.equal(event[3].timed_out, true); assert.equal(event[3].cancelled, false);
  f.component.handleInput("escape"); f.component.handleInput("enter");
  assert.equal(f.doneCalls, 1); assert.equal(f.abortCalls, 0, "late keys must not affect another turn");
});

test("partial terminal answers are discarded on the single questionnaire deadline", async t => {
  const f = fixture(t); const input = [...questions, { ...questions[0], id: "detail" }];
  const pending = f.execute(input); await f.opened; f.component.handleInput("enter");
  t.mock.timers.tick(300000); assertTimeout(await pending, f);
});

test("Paseo expiry aborts its pending native card and closes the terminal without stopping the agent", async t => {
  const f = fixture(t); let nativeSignal, cancelled = false;
  globalThis.__piPaseoRemoteUiV1 = { isConnected: () => true, select(_title, _choices, settings) {
    nativeSignal = settings.signal;
    return new Promise(resolve => nativeSignal.addEventListener("abort", () => { cancelled = true; resolve(undefined); }, { once: true }));
  } };
  const pending = f.execute(); await f.opened;
  t.mock.timers.tick(300000); assertTimeout(await pending, f);
  assert.equal(nativeSignal.aborted, true); assert.equal(cancelled, true); assert.equal(f.doneCalls, 1);
});

test("Paseo partial answers do not reset the deadline or become a timeout answer", async t => {
  const f = fixture(t); let calls = 0, secondStarted;
  const second = new Promise(resolve => { secondStarted = resolve; });
  globalThis.__piPaseoRemoteUiV1 = { isConnected: () => true, async select(_title, _choices, { signal }) {
    calls++;
    if (calls === 1) return "1. Chosen";
    secondStarted(); return new Promise(resolve => signal.addEventListener("abort", () => resolve(undefined), { once: true }));
  } };
  const pending = f.execute([...questions, { ...questions[0], id: "detail" }]); await second;
  t.mock.timers.tick(300000); assertTimeout(await pending, f); assert.equal(calls, 2);
});

test("remote-to-terminal handoff shares the original deadline", async t => {
  const f = fixture(t); let select;
  globalThis.__piPaseoRemoteUiV1 = { isConnected: () => true, select() { return new Promise(resolve => { select = resolve; }); } };
  const pending = f.execute(); await f.opened;
  t.mock.timers.tick(240000); select("Answer in terminal"); await flush();
  t.mock.timers.tick(59999); let settled = false; pending.then(() => { settled = true; }); await flush(); assert.equal(settled, false);
  t.mock.timers.tick(1); assertTimeout(await pending, f);
});

test("late remote choices cannot open a custom-input step after expiry", async t => {
  const f = fixture(t); let select, inputCalls = 0;
  globalThis.__piPaseoRemoteUiV1 = { isConnected: () => true, select() { return new Promise(resolve => { select = resolve; }); }, input() { inputCalls++; } };
  const pending = f.execute(); await f.opened; t.mock.timers.tick(300000); assertTimeout(await pending, f);
  select("Other (write an answer)"); await flush(); assert.equal(inputCalls, 0); assert.equal(f.doneCalls, 1);
});

test("actual Goal recorder cancels its pending waiter on expiry, with no manufactured human answer", async t => {
  const f = fixture(t); let forwarded;
  const recorder = createGoalQuestions("11111111-1111-4111-8111-111111111111", "epoch", [], () => {});
  t.after(() => recorder.dispose());
  globalThis.__paeWorkerInteractionsV1 = { protocol: 1, mode: "headless", workerEpoch: "epoch", request(_input, signal) { forwarded = signal; return new Promise(() => {}); } };
  globalThis[GOAL_QUESTION_RECORDER_KEY] = { protocol: 1, sessionId: "timeout-session", request: (input, signal, upstream) => recorder.request(input, signal, (request, forwardedSignal) => upstream.request(request, forwardedSignal)) };
  const pending = f.execute(); const question = recorder.snapshot()[0]; assert.equal(question.status, "pending");
  t.mock.timers.tick(300000); assertTimeout(await pending, f);
  assert.equal(forwarded.aborted, true); const expired = recorder.snapshot()[0];
  assert.equal(expired.status, "cancelled"); assert.equal(expired.answer, undefined);
  assert.throws(() => recorder.answer({ questionId: question.id, questionRevision: question.revision, workerEpoch: "epoch", answer: { kind: "questionnaire", cancelled: false, answers: [{ id: "scope", value: "chosen", wasCustom: false }] } }, "late"), /changed|invalid/);
});

test("answering normally clears the old deadline and does not dismiss a later questionnaire", async t => {
  const f = fixture(t); const first = f.execute(); await f.opened;
  t.mock.timers.tick(200000); f.component.handleInput("enter");
  const answered = await first; assert.equal(answered.details.timedOut, undefined); assert.equal(answered.details.answers[0].value, "chosen");
  const second = f.execute(); await flush(); let settled = false; second.then(() => { settled = true; });
  t.mock.timers.tick(100000); await flush(); assert.equal(settled, false, "old timeout affected the new questionnaire");
  t.mock.timers.tick(200000); assertTimeout(await second, f);
});

test("parent abort is immediate even for an uncooperative headless transport, not a timeout", async t => {
  const f = fixture(t); let forwarded;
  globalThis.__paeWorkerInteractionsV1 = { protocol: 1, mode: "headless", workerEpoch: "epoch", request(_input, signal) { forwarded = signal; return new Promise(() => {}); } };
  const parent = new AbortController(); const pending = f.execute(questions, parent.signal); parent.abort();
  const result = await pending; assert.match(result.content[0].text, /aborted/); assert.equal(result.details.timedOut, undefined); assert.equal(forwarded.aborted, true);
});

test("terminal parent abort closes the screen without pretending the human cancelled", async t => {
  const f = fixture(t); const parent = new AbortController(); const pending = f.execute(questions, parent.signal); await f.opened;
  parent.abort(); const result = await pending; assert.match(result.content[0].text, /aborted/);
  assert.equal(result.details.timedOut, undefined); assert.equal(result.details.cancelledByHuman, undefined); assert.equal(f.doneCalls, 1); assert.equal(f.abortCalls, 0);
});

for (const remote of [false, true]) test(`${remote ? "remote" : "terminal"} explicit Cancel retains human provenance when ctx.abort cancels the parent signal`, async t => {
  const f = fixture(t); const parent = new AbortController();
  f.ctx.abort = () => parent.abort();
  if (remote) globalThis.__piPaseoRemoteUiV1 = { isConnected: () => true, select: async () => "Cancel questionnaire" };
  const pending = f.execute(questions, parent.signal); await f.opened;
  if (!remote) f.component.handleInput("escape");
  const result = await pending; assert.equal(result.content[0].text, "User cancelled the questionnaire");
  assert.equal(result.details.cancelledByHuman, true); assert.equal(result.details.timedOut, undefined); assert.equal(result.details.failure, undefined);
});

test("a blocked pending-event publisher cannot extend the deadline or open a late screen", async t => {
  const f = fixture(t); let release, calls = 0;
  globalThis.__PI_AGENTSH_PUBLISH_EVENT__ = () => { calls++; return new Promise(resolve => { release = resolve; }); };
  const pending = f.execute(); t.mock.timers.tick(300000); assertTimeout(await pending, f);
  release(true); await flush(); assert.equal(f.component, undefined); assert.equal(calls, 1);
});

test("late external answers are ignored after timeout", async t => {
  const f = fixture(t); let reply;
  globalThis.__PI_AGENTSH_GET_QUESTION_ANSWER__ = () => new Promise(resolve => { reply = resolve; });
  const pending = f.execute(); await f.opened; t.mock.timers.tick(300000); assertTimeout(await pending, f);
  reply({ cancelled: false, answers: [{ id: "scope", value: "chosen", label: "Chosen", wasCustom: false }] }); await flush(); assert.equal(f.doneCalls, 1);
});

test("normal completion and rejection release the deadline timer", async t => {
  fixture(t); let onTimeout = 0, onAbort = 0; const parent = new AbortController();
  assert.equal(await withQuestionnaireTimeout(parent.signal, async () => "answer", () => { onTimeout++; return "expired"; }, () => { onAbort++; return "aborted"; }), "answer");
  await assert.rejects(withQuestionnaireTimeout(parent.signal, async () => { throw Error("fixture failure"); }, () => { onTimeout++; }, () => { onAbort++; }), /fixture failure/);
  t.mock.timers.tick(300000); parent.abort(); assert.equal(onTimeout, 0); assert.equal(onAbort, 0);
});
