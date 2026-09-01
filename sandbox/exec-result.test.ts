import assert from "node:assert/strict";
import * as execResultModule from "./exec-result.js";
import {
  execFailureText,
  normalizeExecResult,
  recognizedSemanticExecFailure,
  type ExecError,
  type ExecOutcome,
  type ExecResult,
  type NormalizedExecFailure,
} from "./exec-result.js";

assert.deepEqual(Object.keys(execResultModule).sort(), [
  "execFailureText",
  "normalizeExecResult",
  "recognizedSemanticExecFailure",
]);

const exportedTypeFixtures: {
  error: ExecError;
  outcome: ExecOutcome;
  result: ExecResult;
  failure: NormalizedExecFailure;
} = {
  error: { code: "E_TEST", message: "typed error", policy_rule: "test-rule" },
  outcome: { command_started: false, failure_kind: "request_validation" },
  result: { exitCode: 1, stdout: "", stderr: "" },
  failure: { source: "transport", failureKind: "transport_ambiguity" },
};
assert.equal(exportedTypeFixtures.failure.source, "transport");

// Promoted fields win independently over nested compatibility fields, while
// absent promoted values still fall through. Diagnostic text remains bounded,
// control-safe, and redacted.
{
  const normalized = normalizeExecResult({
    marker: "preserved",
    stdout: "top stdout",
    stderr: 7,
    exit_code: 127,
    command_started: true,
    outcome: {
      command_started: false,
      dispatch_state: "not\u0001dispatched",
      failure_kind: "pre_exec_enforcement",
      retryable: false,
      code: "E_NETHELPER_UNAVAILABLE",
      message: "helper failed token=top-secret",
      queue_duration_ms: 12,
    },
    error: {
      code: "E_LOWER_PRIORITY",
      message: "lower-priority message",
      policy_rule: "network api_key=policy-secret",
    },
    exec_response: {
      result: {
        stdout: "nested stdout",
        stderr: "nested stderr",
        exit_code: 3,
        outcome: {
          command_started: true,
          dispatch_state: "started",
          failure_kind: "child_exit",
          retryable: true,
          code: "E_WRONG_NESTED",
          message: "wrong nested message",
          execution_duration_ms: 34,
        },
        error: { code: "E_WRONG_ERROR", message: "wrong nested error", policy_rule: "wrong-rule" },
      },
    },
  });

  assert.equal(normalized.marker, "preserved");
  assert.equal(normalized.exitCode, 127);
  assert.equal(normalized.stdout, "top stdout");
  assert.equal(normalized.stderr, "7");
  assert.deepEqual(normalized.normalizedFailure, {
    commandStarted: false,
    dispatchState: "not dispatched",
    failureKind: "pre_exec_enforcement",
    retryable: false,
    code: "E_NETHELPER_UNAVAILABLE",
    message: "helper failed token=[REDACTED]",
    policyRule: "network api_key=[REDACTED]",
    queueDurationMs: 12,
    executionDurationMs: 34,
    source: "top-level",
  });
  assert.ok(!JSON.stringify(normalized.normalizedFailure).includes("top-secret"));
  assert.ok(!JSON.stringify(normalized.normalizedFailure).includes("policy-secret"));
  assert.ok(!JSON.stringify(normalized.normalizedFailure).includes("wrong nested"));
}

// Nested typed outcomes, legacy nested errors, and narrow legacy pre-exec codes
// retain their existing source and command-start evidence.
{
  const nested = normalizeExecResult({
    exec_response: {
      result: {
        stdout: "nested stdout",
        stderr: "nested stderr",
        outcome: {
          command_started: true,
          dispatch_state: "started",
          failure_kind: "child_exit",
          retryable: false,
          execution_duration_ms: 9,
        },
      },
    },
  });
  assert.equal(nested.exitCode, 1, "typed failure should retain the failure exit fallback");
  assert.equal(nested.stdout, "nested stdout");
  assert.equal(nested.stderr, "nested stderr");
  assert.deepEqual(nested.normalizedFailure, {
    commandStarted: true,
    dispatchState: "started",
    failureKind: "child_exit",
    retryable: false,
    code: undefined,
    message: undefined,
    policyRule: undefined,
    queueDurationMs: undefined,
    executionDurationMs: 9,
    source: "nested",
  });

  const legacy = normalizeExecResult({
    exec_response: {
      result: {
        exit_code: 127,
        stdout: "legacy stdout",
        error: { code: "E_COMMAND_FAILED", message: "legacy child returned 127" },
      },
    },
  });
  assert.equal(legacy.exitCode, 127);
  assert.equal(legacy.normalizedFailure?.source, "legacy");
  assert.equal(legacy.normalizedFailure?.commandStarted, undefined);
  assert.equal(legacy.normalizedFailure?.message, "legacy child returned 127");

  for (const code of ["E_COMMAND_NOT_STARTED", "E_COMMAND_START_FAILED", "E_PRE_EXEC_FAILED"]) {
    const preExec = normalizeExecResult({ exec_response: { result: { error: { code } } } });
    assert.equal(preExec.exitCode, 1, code);
    assert.equal(preExec.normalizedFailure?.source, "legacy", code);
    assert.equal(preExec.normalizedFailure?.commandStarted, false, code);
  }
}

// Successful and malformed numeric fields keep the exact output/exit fallback
// rules, including failure_kind="none" not creating a failure by itself.
{
  const success = normalizeExecResult({
    marker: true,
    exitCode: Number.NaN,
    exit_code: Number.POSITIVE_INFINITY,
    outcome: { command_started: true, failure_kind: "none" },
    exec_response: { result: { exit_code: 5, stdout: 42, stderr: false } },
  });
  assert.equal(success.exitCode, 5);
  assert.equal(success.stdout, "42");
  assert.equal(success.stderr, "false");
  assert.equal(success.normalizedFailure, undefined);

  const empty = normalizeExecResult({});
  assert.equal(empty.exitCode, 0);
  assert.equal(empty.stdout, "");
  assert.equal(empty.stderr, "");
  assert.equal(empty.normalizedFailure, undefined);
}

// Each normalized diagnostic field retains its original bound.
{
  const bounded = normalizeExecResult({
    outcome: {
      command_started: false,
      dispatch_state: "d".repeat(100),
      failure_kind: "f".repeat(100),
      code: "E_" + "C".repeat(200),
      message: "m".repeat(1100),
    },
    error: { policy_rule: "p".repeat(300) },
  }).normalizedFailure;
  assert.equal(bounded?.dispatchState?.length, 80);
  assert.equal(bounded?.failureKind?.length, 80);
  assert.equal(bounded?.code?.length, 160);
  assert.equal(bounded?.message?.length, 1000);
  assert.equal(bounded?.policyRule?.length, 240);
  for (const value of [bounded?.dispatchState, bounded?.failureKind, bounded?.code, bounded?.message, bounded?.policyRule]) {
    assert.ok(value?.endsWith("…"));
  }
}

const semanticCases: Array<{ name: string; result: Record<string, unknown>; expected: boolean }> = [
  {
    name: "top-level typed outcome",
    result: { outcome: { command_started: false, failure_kind: "queue_timeout" } },
    expected: true,
  },
  {
    name: "nested typed outcome",
    result: { exec_response: { result: { outcome: { command_started: true, failure_kind: "child_exit" } } } },
    expected: true,
  },
  {
    name: "top-level semantic error code",
    result: { error: { code: "E_NETHELPER_UNAVAILABLE" } },
    expected: true,
  },
  {
    name: "nested semantic error code",
    result: { exec_response: { result: { error: { code: "E_COMMAND_START_FAILED" } } } },
    expected: true,
  },
  {
    name: "outcome without command-start evidence",
    result: { outcome: { failure_kind: "queue_timeout" } },
    expected: false,
  },
  {
    name: "empty failure kind",
    result: { outcome: { command_started: false, failure_kind: "" } },
    expected: false,
  },
  {
    name: "oversized failure kind",
    result: { outcome: { command_started: false, failure_kind: "x".repeat(81) } },
    expected: false,
  },
  {
    name: "unrecognized error namespace",
    result: { error: { code: "E_POST_START_CLEANUP" } },
    expected: false,
  },
  {
    name: "array-shaped protocol fields",
    result: { outcome: [], error: [{ code: "E_COMMAND_FAILED" }] },
    expected: false,
  },
];

for (const testCase of semanticCases) {
  assert.equal(recognizedSemanticExecFailure(testCase.result), testCase.expected, testCase.name);
}

const failureTextCases: Array<{
  name: string;
  failure: NormalizedExecFailure;
  exitCode?: number;
  expected: string;
}> = [
  {
    name: "queue timeout",
    failure: { source: "top-level", failureKind: "queue_timeout", message: "queue deadline" },
    expected: "Command was not executed: it timed out waiting in the AgentSH execution queue. queue deadline",
  },
  {
    name: "queued cancellation",
    failure: { source: "top-level", failureKind: "caller_cancellation", commandStarted: false, message: "cancelled" },
    expected: "Command was not executed: the queued request was cancelled. cancelled",
  },
  {
    name: "started cancellation",
    failure: { source: "top-level", failureKind: "caller_cancellation", commandStarted: true, message: "cancelled" },
    expected: "Command was cancelled after it started. cancelled",
  },
  {
    name: "pre-start command timeout",
    failure: { source: "top-level", failureKind: "command_timeout", commandStarted: false, message: "deadline" },
    expected: "Command was not executed: its deadline expired before start. deadline",
  },
  {
    name: "started command timeout",
    failure: { source: "top-level", failureKind: "command_timeout", commandStarted: true, message: "deadline" },
    expected: "Command timed out after it started. deadline",
  },
  {
    name: "policy denial",
    failure: { source: "top-level", failureKind: "policy_or_approval_denial", code: "E_POLICY_DENIED" },
    expected: "Command was not executed: AgentSH policy or approval denied it. E_POLICY_DENIED",
  },
  {
    name: "pre-exec refusal",
    failure: { source: "top-level", failureKind: "pre_exec_enforcement", commandStarted: false, message: "helper unavailable" },
    expected: "Command was not executed: AgentSH pre-execution/helper enforcement failed. helper unavailable",
  },
  {
    name: "contradictory started pre-exec cleanup",
    failure: { source: "top-level", failureKind: "pre_exec_enforcement", commandStarted: true, message: "cleanup failed" },
    expected: "Command started, but AgentSH enforcement cleanup failed; side effects may have occurred and the command must not be replayed automatically. cleanup failed",
  },
  {
    name: "post-start cleanup",
    failure: { source: "top-level", failureKind: "post_start_cleanup", message: "cleanup failed" },
    expected: "Command started, but AgentSH cleanup failed; side effects may have occurred and the command must not be replayed automatically. cleanup failed",
  },
  {
    name: "request validation",
    failure: { source: "top-level", failureKind: "request_validation", message: "invalid cwd" },
    expected: "Command was not executed: invalid cwd",
  },
  {
    name: "command start",
    failure: { source: "top-level", failureKind: "command_start", message: "spawn failed" },
    expected: "Command was not executed: spawn failed",
  },
  {
    name: "child exit with message",
    failure: { source: "nested", failureKind: "child_exit", code: "E_COMMAND_FAILED", message: "child failed" },
    exitCode: 127,
    expected: "Command exited with code 127: child failed",
  },
  {
    name: "child exit without message",
    failure: { source: "nested", failureKind: "child_exit", code: "E_COMMAND_FAILED" },
    exitCode: 2,
    expected: "Command exited with code 2",
  },
  {
    name: "unknown non-started failure",
    failure: { source: "legacy", commandStarted: false, code: "E_UNKNOWN" },
    expected: "Command was not executed: E_UNKNOWN",
  },
  {
    name: "unknown ambiguous failure",
    failure: { source: "legacy" },
    expected: "AgentSH refused the command",
  },
];

for (const testCase of failureTextCases) {
  assert.equal(execFailureText(testCase.failure, testCase.exitCode ?? 1), testCase.expected, testCase.name);
}

console.log("sandbox exec result checks passed");
