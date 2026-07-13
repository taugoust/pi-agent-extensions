import assert from "node:assert/strict";
import {
  abortSubagentProtocolStream,
  appendSubagentProtocolChunk,
  createSubagentProtocolState,
  finishSubagentProtocolStream,
  subagentProtocolSnapshot,
} from "./subagent-protocol.js";

function line(event: unknown): string {
  return `${JSON.stringify(event)}\n`;
}

{
  const state = createSubagentProtocolState();
  const events = [
    { event: "subagent_child_start", label: "child" },
    { event: "stdout", label: "child", data: "answer 🌍" },
    { event: "subagent_result", label: "child", result: { final: "answer 🌍" } },
    { event: "done", ok: true, result: { final: "answer 🌍" } },
  ];
  const bytes = Buffer.from(events.map((event) => JSON.stringify(event)).join("\n"), "utf8");
  const emojiOffset = bytes.indexOf(Buffer.from("🌍", "utf8"));
  const observed = [];
  for (const chunk of [bytes.subarray(0, 7), bytes.subarray(7, emojiOffset + 1), bytes.subarray(emojiOffset + 1, emojiOffset + 3), bytes.subarray(emojiOffset + 3)]) {
    observed.push(...appendSubagentProtocolChunk(state, chunk));
  }
  const finished = finishSubagentProtocolStream(state);
  observed.push(...finished.events);
  assert.deepEqual(observed.map((event) => event.event), ["subagent_child_start", "stdout", "subagent_result", "done"]);
  assert.equal((observed[1] as any).data, "answer 🌍");
  assert.equal(finished.finalResponse?.ok, true);
  assert.equal((finished.finalResponse?.result as any).final, "answer 🌍");
  assert.equal(finished.error, undefined);
}

{
  const state = createSubagentProtocolState();
  const observed = appendSubagentProtocolChunk(state, line({ event: "stdout", label: "child", data: "partial progress" }));
  const finished = finishSubagentProtocolStream(state);
  assert.equal(observed.length, 1);
  assert.equal(finished.finalResponse, undefined);
  assert.equal(finished.error, "stream ended without final done event");
  assert.equal(subagentProtocolSnapshot(state).eventCount, 1);
}

{
  const state = createSubagentProtocolState();
  const first = { event: "done", ok: true, result: { final: "first" } };
  const duplicate = { event: "done", ok: false, result: { final: "second" }, error: "must not win" };
  const observed = appendSubagentProtocolChunk(state, line(first) + line(duplicate) + line({ event: "stdout", data: "after done" }));
  const finished = finishSubagentProtocolStream(state);
  assert.deepEqual(observed.map((event) => event.event), ["done"]);
  assert.equal((finished.finalResponse?.result as any).final, "first");
  const snapshot = subagentProtocolSnapshot(state);
  assert.equal(snapshot.doneCount, 2);
  assert.equal(snapshot.ignoredAfterDone, 1);
  assert.deepEqual(snapshot.diagnostics.map((diagnostic) => diagnostic.kind), ["duplicate_done", "event_after_done"]);
}

{
  const state = createSubagentProtocolState();
  const observed = appendSubagentProtocolChunk(state, "not-json\n" + line({ nope: "missing event" }) + line({ event: "stdout", data: "recovered" }) + line({ event: "done", ok: true }));
  assert.deepEqual(observed.map((event) => event.event), ["stdout", "done"]);
  assert.deepEqual(subagentProtocolSnapshot(state).diagnostics.map((diagnostic) => diagnostic.kind), ["malformed_line", "invalid_event"]);
  assert.equal(JSON.stringify(subagentProtocolSnapshot(state)).includes("not-json"), false);
}

for (const fixture of [
  [
    { event: "subagent_result", label: "child", result: { final: "result first" } },
    { event: "stdout", label: "child", data: "final stdout" },
  ],
  [
    { event: "stdout", label: "child", data: "final stdout" },
    { event: "subagent_result", label: "child", result: { final: "result second" } },
  ],
]) {
  const state = createSubagentProtocolState();
  const observed = appendSubagentProtocolChunk(state, fixture.map(line).join("") + line({ event: "done", ok: true, result: { mode: "single" } }));
  finishSubagentProtocolStream(state);
  assert.deepEqual(observed.map((event) => event.event), [...fixture.map((event) => event.event), "done"]);
}

{
  const state = createSubagentProtocolState();
  const events = [
    { event: "subagent_child_start", label: "task 1", index: 0 },
    { event: "subagent_child_start", label: "task 2", index: 1 },
    { event: "stdout", label: "task 2", data: "two" },
    { event: "stdout", label: "task 1", data: "one" },
    { event: "subagent_result", label: "task 1", index: 0 },
    { event: "subagent_result", label: "task 2", index: 1 },
    { event: "done", ok: true, result: { mode: "parallel" } },
  ];
  const observed = appendSubagentProtocolChunk(state, events.map(line).join(""));
  finishSubagentProtocolStream(state);
  assert.deepEqual(observed.map((event) => (event as any).label).filter(Boolean), ["task 1", "task 2", "task 2", "task 1", "task 1", "task 2"]);
}

{
  const state = createSubagentProtocolState();
  const observed = appendSubagentProtocolChunk(state,
    line({ event: "subagent_result", label: "step 1", step: 1, result: { final: "kept" } }) +
    line({ event: "subagent_child_start", label: "step 2", step: 2 }),
  );
  const aborted = abortSubagentProtocolStream(state, "user_cancelled");
  assert.deepEqual(observed.map((event) => event.event), ["subagent_result", "subagent_child_start"]);
  assert.equal(aborted.error, "stream aborted: user_cancelled");
  assert.equal(subagentProtocolSnapshot(state).eventCount, 2);
  assert.equal(subagentProtocolSnapshot(state).diagnostics.at(-1)?.kind, "aborted");
  assert.deepEqual(appendSubagentProtocolChunk(state, line({ event: "done", ok: true })), []);
}

console.log("sandbox subagent outer protocol checks passed");
