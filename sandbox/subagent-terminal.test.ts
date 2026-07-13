import assert from "node:assert/strict";
import { normalizeSubagentTerminal, subagentTerminalFailed } from "./subagent-terminal.js";

{
  const terminal = normalizeSubagentTerminal({
    state: "timed_out",
    failure_kind: "process",
    cancellation_cause: "request_timeout",
    exit_code: 124,
    signal: "terminated",
    termination: "graceful",
    retryable: true,
    message: "request expired",
  });
  assert.deepEqual(terminal, {
    state: "timed_out",
    failureKind: "process",
    cancellationCause: "request_timeout",
    exitCode: 124,
    signal: "terminated",
    termination: "graceful",
    retryable: true,
    message: "request expired",
  });
  assert.equal(subagentTerminalFailed(terminal), true);
}

{
  const terminal = normalizeSubagentTerminal(undefined, { exitCode: 0, stopReason: "completed" });
  assert.equal(terminal?.state, "completed");
  assert.equal(subagentTerminalFailed(terminal), false);
}

{
  const terminal = normalizeSubagentTerminal(undefined, { exitCode: 130, stopReason: "cancelled", error: "parent stopped" });
  assert.equal(terminal?.state, "cancelled");
  assert.equal(terminal?.cancellationCause, "parent_cancelled");
}

{
  const terminal = normalizeSubagentTerminal({ state: "failed", failure_kind: "auth", retryable: false, message: "authorization=secret-value Bearer abc.def" });
  assert.equal(terminal?.failureKind, "auth");
  assert.equal(JSON.stringify(terminal).includes("secret-value"), false);
  assert.equal(JSON.stringify(terminal).includes("abc.def"), false);
}

{
  const terminal = normalizeSubagentTerminal({ state: "failed", failure_kind: "protocol", retryable: true, message: "\u001bP$q q\u001b\\visible\u001b[6 q" });
  assert.equal(terminal?.message, "visible");
  assert.equal(JSON.stringify(terminal).includes("\u001b"), false);
}

{
  assert.equal(normalizeSubagentTerminal({ state: "invented" }), undefined);
  assert.equal(normalizeSubagentTerminal(undefined, { exitCode: -1, stopReason: "running" }), undefined);
}

console.log("sandbox subagent terminal checks passed");
