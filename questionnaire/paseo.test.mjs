import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { answerQuestionnaireInPaseo } from "./paseo.ts";

const key = "__piPaseoRemoteUiV1";
afterEach(() => { delete globalThis[key]; });
const question = { id: "scope", label: "Scope", prompt: "Which scope?", options: [{ value: "one", label: "One" }] };
const other = "Other (write an answer)";

function bridge(select, input) {
  globalThis[key] = { isConnected: () => true, select, ...(input ? { input } : {}) };
}

test("custom answer preserves literal input, signal and answer metadata", async () => {
  const signal = new AbortController().signal;
  const literal = "  custom {\"x\":1}\nsecond line  ";
  bridge(async (_title, options, settings) => {
    assert.ok(options.includes(other));
    assert.equal(settings.signal, signal);
    return other;
  }, async (title, placeholder, settings) => {
    assert.match(title, /Which scope/);
    assert.equal(placeholder, "Type your answer");
    assert.equal(settings.signal, signal);
    return literal;
  });
  assert.deepEqual(await answerQuestionnaireInPaseo([question], signal), {
    kind: "answered", answers: [{ id: "scope", value: literal, label: literal, wasCustom: true }],
  });
});

test("allowOther false does not expose or call custom input", async () => {
  bridge(async (_title, options) => {
    assert.ok(!options.includes(other));
    return "1. One";
  }, async () => { assert.fail("input must not be used"); });
  assert.deepEqual(await answerQuestionnaireInPaseo([{ ...question, allowOther: false }]), {
    kind: "answered", answers: [{ id: "scope", value: "one", label: "One", wasCustom: false, index: 1 }],
  });
});

test("legacy bridge without input preserves terminal fallback and fixed options", async () => {
  bridge(async (_title, options) => {
    assert.ok(!options.includes(other));
    assert.ok(options.includes("Answer in terminal"));
    return "Answer in terminal";
  });
  assert.deepEqual(await answerQuestionnaireInPaseo([question]), { kind: "terminal" });
});

for (const [name, value] of [["cancelled", undefined], ["empty", ""], ["blank", " \n\t "]]) {
  test(`${name} custom input does not fabricate an answer`, async () => {
    bridge(async () => other, async () => value);
    assert.deepEqual(await answerQuestionnaireInPaseo([question]), { kind: "cancelled" });
  });
}

test("only explicit remote Cancel carries human cancellation provenance", async () => {
  bridge(async () => "Cancel questionnaire");
  assert.deepEqual(await answerQuestionnaireInPaseo([question]), { kind: "cancelled", byUser: true });
  bridge(async () => { throw new Error("unavailable"); });
  assert.deepEqual(await answerQuestionnaireInPaseo([question]), { kind: "cancelled" });
});

test("remote input failure cancels rather than becoming a selected answer", async () => {
  bridge(async () => other, async () => { throw new Error("disconnected"); });
  assert.deepEqual(await answerQuestionnaireInPaseo([question]), { kind: "cancelled" });
});

test("custom and selected answers retain multi-question order", async () => {
  let step = 0;
  bridge(async () => ++step === 1 ? other : "1. One", async () => "custom first");
  const result = await answerQuestionnaireInPaseo([question, { ...question, id: "second" }]);
  assert.deepEqual(result, { kind: "answered", answers: [
    { id: "scope", value: "custom first", label: "custom first", wasCustom: true },
    { id: "second", value: "one", label: "One", wasCustom: false, index: 1 },
  ] });
});

for (const phase of ["select", "input"]) {
  test(`disconnect during ${phase} falls back to the existing terminal instead of cancelling the tool`, async () => {
    let connected = true;
    globalThis[key] = {
      isConnected: () => connected,
      select: async () => { if (phase === "input") return other; connected = false; return undefined; },
      input: async () => { connected = false; return undefined; },
    };
    assert.deepEqual(await answerQuestionnaireInPaseo([question]), { kind: "terminal" });
  });
}

test("an aborted tool signal still cancels rather than falling back on disconnect", async () => {
  const controller = new AbortController();
  let connected = true;
  globalThis[key] = { isConnected: () => connected, select: async () => {
    connected = false; controller.abort(); return undefined;
  } };
  assert.deepEqual(await answerQuestionnaireInPaseo([question], controller.signal), { kind: "cancelled" });
});

test("private correlation carries the real tool ID and global input capability across question phases", async () => {
  let index = 0;
  bridge(async (_title, _options, settings) => {
    assert.deepEqual(settings.paseoQuestionnaire, { v: 1, toolCallId: "real-tool-id", index, input: true });
    return index++ === 0 ? "1. One" : other;
  }, async (_title, _placeholder, settings) => {
    assert.deepEqual(settings.paseoQuestionnaire, { v: 1, toolCallId: "real-tool-id", index: 1, input: true });
    return "One";
  });
  const result = await answerQuestionnaireInPaseo([{ ...question, allowOther: false }, { ...question, id: "custom" }], undefined, "real-tool-id");
  assert.equal(result.answers[0].wasCustom, false);
  assert.deepEqual(result.answers[1], { id: "custom", value: "One", label: "One", wasCustom: true });
});

test("missing or disconnected bridge remains a terminal-only path", async () => {
  assert.equal(await answerQuestionnaireInPaseo([question]), null);
  globalThis[key] = { isConnected: () => false, select() { assert.fail("disconnected bridge called"); } };
  assert.equal(await answerQuestionnaireInPaseo([question]), null);
});
