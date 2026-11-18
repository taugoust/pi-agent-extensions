import { pathToFileURL } from "node:url";
import path from "node:path";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const moduleUrl = pathToFileURL(path.join(process.argv[2], "questionnaire/paseo.js")).href;
const { answerQuestionnaireInPaseo } = await import(moduleUrl);
const questions = [
  {
    id: "scope",
    label: "Scope",
    prompt: "Which scope?",
    options: [
      { value: "one", label: "Same", description: "First choice" },
      { value: "two", label: "Same", description: "Second choice" },
    ],
  },
  {
    id: "priority",
    label: "Priority",
    prompt: "Which priority?",
    options: [{ value: "high", label: "High" }],
  },
];

delete globalThis.__piPaseoRemoteUiV1;
assert(
  (await answerQuestionnaireInPaseo(questions)) === null,
  "missing Paseo bridge did not use terminal fallback",
);

let calls = 0;
globalThis.__piPaseoRemoteUiV1 = {
  isConnected: () => false,
  select: async () => {
    calls += 1;
    return "1. Same";
  },
};
assert(
  (await answerQuestionnaireInPaseo(questions)) === null,
  "disconnected Paseo bridge did not use terminal fallback",
);
assert(calls === 0, "disconnected Paseo bridge was called");

const remoteCalls = [];
const controller = new AbortController();
globalThis.__piPaseoRemoteUiV1 = {
  isConnected: () => true,
  async select(title, options, settings) {
    remoteCalls.push({ title, options, settings });
    return remoteCalls.length === 1 ? "2. Same" : "1. High";
  },
};
const answered = await answerQuestionnaireInPaseo(questions, controller.signal);
assert(answered.kind === "answered", "Paseo questionnaire was not answered");
assert(
  answered.answers[0].value === "two" && answered.answers[0].index === 2,
  "Paseo questionnaire confused duplicate labels",
);
assert(answered.answers[1].value === "high", "Paseo questionnaire lost second answer");
assert(remoteCalls.length === 2, "multi-question Paseo questionnaire did not use sequential cards");
assert(
  remoteCalls[0].title.includes("Question 1 of 2 · Scope"),
  "Paseo questionnaire omitted progress and label",
);
assert(
  remoteCalls[0].title.includes("First choice") && remoteCalls[0].title.includes("Second choice"),
  "Paseo questionnaire omitted descriptions",
);
assert(
  remoteCalls[0].options.join(",") === "1. Same,2. Same,Answer in terminal,Cancel questionnaire",
  "Paseo questionnaire choices changed",
);
assert(
  remoteCalls[0].settings.signal === controller.signal,
  "Paseo questionnaire dropped cancellation signal",
);

globalThis.__piPaseoRemoteUiV1.select = async () => "Answer in terminal";
const terminal = await answerQuestionnaireInPaseo(questions);
assert(terminal.kind === "terminal", "Paseo questionnaire terminal handoff failed");

globalThis.__piPaseoRemoteUiV1.select = async () => "unexpected";
const unknown = await answerQuestionnaireInPaseo(questions);
assert(unknown.kind === "cancelled", "unknown Paseo questionnaire choice did not fail closed");

globalThis.__piPaseoRemoteUiV1.select = async () => {
  throw new Error("disconnected");
};
const failed = await answerQuestionnaireInPaseo(questions);
assert(failed.kind === "cancelled", "failed Paseo questionnaire did not fail closed");
delete globalThis.__piPaseoRemoteUiV1;
