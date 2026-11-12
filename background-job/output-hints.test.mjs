import assert from "node:assert/strict";
import { completionHint, completionMessage, outputTail, quietRunningHint, selectLines } from "./output-hints.js";

const result = (output, extra = {}) => ({
  schemaVersion: 1, status: "completed", exitCode: 0, finishedAt: new Date().toISOString(), output, ...extra,
});

// Output that only arrived at exit, as with | tail, gets a note on long jobs only.
assert.match(completionHint(result({ bytes: 1000, finalSecondBytes: 990, durationMs: 120_000 }), 30),
  /last second of a run that took 2 minutes.*\| tail or \| sort/);
assert.equal(completionHint(result({ bytes: 1000, finalSecondBytes: 990, durationMs: 30_000 }), 30), undefined);
assert.equal(completionHint(result({ bytes: 1000, finalSecondBytes: 100, durationMs: 120_000 }), 30), undefined);
assert.equal(completionHint(result({ bytes: 0, finalSecondBytes: 0, durationMs: 600_000 }), 0), undefined);
assert.equal(completionHint(result(undefined), 30), undefined);

// Very little output from a long job gets the gentler grep note.
assert.match(completionHint(result({ bytes: 80, finalSecondBytes: 0, durationMs: 600_000 }), 2),
  /Only 2 lines of output after 10 minutes.*\| grep/);
assert.equal(completionHint(result({ bytes: 80, finalSecondBytes: 0, durationMs: 120_000 }), 2), undefined);

// Running jobs that have been silent for a while.
const now = 1_000_000_000;
assert.match(quietRunningHint(now - 600_000, now - 300_000, now), /No new output for 5 minutes/);
assert.equal(quietRunningHint(now - 600_000, now - 60_000, now), undefined);
assert.equal(quietRunningHint(now - 60_000, now - 60_000, now), undefined);

// The completion message carries the exit status and the last lines.
const many = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
const tail = outputTail(many);
assert.equal(tail.lineCount, 40);
assert.equal(tail.tail.split("\n").length, 20);
assert.equal(tail.tail.split("\n").at(-1), "line 40");
assert.ok(Buffer.byteLength(outputTail("x".repeat(5000)).tail) <= 1503);
assert.equal(outputTail("").lineCount, 0);
const message = completionMessage(result({ bytes: 10, finalSecondBytes: 0, durationMs: 1000 }, { exitCode: 2 }), "a\nb\n");
assert.equal(message, "exit 2\nLast lines:\na\nb");
assert.equal(completionMessage(result(undefined, { exitCode: null, signal: "SIGTERM" }), ""), "signal SIGTERM\nNo output.");

// action=output can filter lines and take them from either end.
const text = "build a\ntest x\nbuild b\ntest y\nbuild c";
assert.deepEqual(selectLines(text, { match: "build" }), { text: "build a\nbuild b\nbuild c", matched: 3 });
assert.deepEqual(selectLines(text, { match: "build", lines: 2 }), { text: "build b\nbuild c", matched: 3 });
assert.deepEqual(selectLines(text, { match: "build", lines: 2, from: "start" }), { text: "build a\nbuild b", matched: 3 });
assert.deepEqual(selectLines(text, { lines: 1 }), { text: "build c" });
assert.deepEqual(selectLines(text, { match: "nothing" }), { text: "", matched: 0 });

console.log("background-job output hint checks passed");
