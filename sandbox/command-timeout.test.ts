import assert from "node:assert/strict";
import {
  BUILTIN_COMMAND_EXECUTION_TIMEOUT_MS,
  MAX_AGENTSH_DURATION_MS,
  MAX_NODE_TIMER_MS,
  CommandExecutionTimeoutError,
  CommandTimeoutMetadataError,
  CommandTransportTimeoutError,
  commandExecutionTimeoutDetails,
  configuredCommandExecutionTimeout,
  configuredCommandTransportSlack,
  deriveCommandTimeoutBudget,
  parseCommandTimeoutMetadata,
  requestedCommandTimeoutMs,
} from "./command-timeout.js";

const envFallback = configuredCommandExecutionTimeout("250");
const terminalResponseMarginMs = 10;
const liveMetadata = {
  session_id: "session-timeout-test",
  command_timeout: { default_ms: 80, maximum_ms: 120, source: "policy" },
};

// Valid live hello/reconnect metadata wins over wrapper compatibility config.
{
  const parsed = parseCommandTimeoutMetadata(liveMetadata);
  assert.deepEqual(parsed, { defaultMs: 80, maximumMs: 120, source: "policy" });
  const budget = deriveCommandTimeoutBudget({ metadata: liveMetadata, fallback: envFallback, transportSlackMs: 30, terminalResponseMarginMs });
  assert.equal(budget.policy.origin, "metadata");
  assert.equal(budget.executionTimeoutMs, 80);
  assert.equal(budget.transportSlackMs, 30, "metadata without approval_extension_ms must preserve configured slack");
  assert.equal(budget.transportTimeoutMs, 110);
  assert.equal(budget.requestedTimeoutMs, undefined, "omitted timeout_ms must stay omitted on the wire");
  assert.ok(budget.transportTimeoutMs > 20, "omitted command did not outlive the deliberately smaller generic-tool fixture");
}

// A producer-advertised cumulative approval allowance raises the actual slack
// to allowance + the bounded terminal/cleanup margin. It never shortens a
// larger configured baseline, and zero is a valid advertised allowance.
{
  const metadata = {
    command_timeout: {
      default_ms: 80,
      maximum_ms: 120,
      approval_extension_ms: 70,
      source: "policy",
    },
  };
  assert.deepEqual(parseCommandTimeoutMetadata(metadata), {
    defaultMs: 80,
    maximumMs: 120,
    approvalExtensionMs: 70,
    source: "policy",
  });
  assert.equal(parseCommandTimeoutMetadata({
    command_timeout: { default_ms: 1, approval_extension_ms: MAX_AGENTSH_DURATION_MS, source: "policy" },
  })?.approvalExtensionMs, MAX_AGENTSH_DURATION_MS);

  const raised = deriveCommandTimeoutBudget({
    metadata,
    fallback: envFallback,
    transportSlackMs: 30,
    terminalResponseMarginMs,
  });
  assert.equal(raised.policy.approvalExtensionMs, 70);
  assert.equal(raised.transportSlackMs, 80);
  assert.equal(raised.transportTimeoutMs, 160);

  const configuredWins = deriveCommandTimeoutBudget({
    metadata,
    fallback: envFallback,
    transportSlackMs: 90,
    terminalResponseMarginMs,
  });
  assert.equal(configuredWins.transportSlackMs, 90);
  assert.equal(configuredWins.transportTimeoutMs, 170);

  const zeroAllowance = deriveCommandTimeoutBudget({
    metadata: { command_timeout: { default_ms: 80, approval_extension_ms: 0, source: "policy" } },
    fallback: envFallback,
    transportSlackMs: 0,
    terminalResponseMarginMs,
  });
  assert.equal(zeroAllowance.transportSlackMs, terminalResponseMarginMs);
  assert.equal(zeroAllowance.transportTimeoutMs, 80 + terminalResponseMarginMs);
}

// Attachment/workspace metadata is irrelevant to the shared REST budget.
{
  const direct = deriveCommandTimeoutBudget({ metadata: { ...liveMetadata, workspace_mode: "direct" }, fallback: envFallback, transportSlackMs: 30, terminalResponseMarginMs });
  const shadow = deriveCommandTimeoutBudget({ metadata: { ...liveMetadata, workspace_mode: "shadow" }, fallback: envFallback, transportSlackMs: 30, terminalResponseMarginMs });
  const remote = deriveCommandTimeoutBudget({ metadata: { ...liveMetadata, workspace_mode: "shadow", remote: "ssh" }, fallback: envFallback, transportSlackMs: 30, terminalResponseMarginMs });
  assert.deepEqual(direct, shadow);
  assert.deepEqual(shadow, remote);
}

// Only an absent field enables compatibility. A present malformed live field
// is a protocol/config error rather than silently changing timeout policy.
{
  assert.equal(parseCommandTimeoutMetadata({ session_id: "old-supervisor" }), undefined);
  const configured = deriveCommandTimeoutBudget({ metadata: { session_id: "old-supervisor" }, fallback: envFallback, transportSlackMs: 30, terminalResponseMarginMs });
  assert.equal(configured.policy.origin, "fallback");
  assert.equal(configured.executionTimeoutMs, 250);
  assert.equal(configured.transportSlackMs, 30, "older-server fallback must keep configured command slack");
  assert.equal(configured.policy.maximumMs, 250, "compatibility timeout must also be the client ceiling");
  assert.equal(configured.policy.source, "compatibility_env");

  const invalidMetadata = [
    { command_timeout: undefined },
    { command_timeout: null },
    { command_timeout: "80ms" },
    { command_timeout: {} },
    { command_timeout: { default_ms: 80, source: "" } },
    { command_timeout: { default_ms: 80, source: "policy_default" } },
    { command_timeout: { default_ms: 121, maximum_ms: 120, source: "policy" } },
    { command_timeout: { default_ms: 80, maximum_ms: null, source: "policy" } },
    { command_timeout: { default_ms: MAX_AGENTSH_DURATION_MS + 1, source: "policy" } },
    { command_timeout: { default_ms: 80, approval_extension_ms: null, source: "policy" } },
    { command_timeout: { default_ms: 80, approval_extension_ms: -1, source: "policy" } },
    { command_timeout: { default_ms: 80, approval_extension_ms: 1.5, source: "policy" } },
    { command_timeout: { default_ms: 80, approval_extension_ms: "1", source: "policy" } },
    { command_timeout: { default_ms: 80, approval_extension_ms: Number.NaN, source: "policy" } },
    { command_timeout: { default_ms: 80, approval_extension_ms: Number.MAX_SAFE_INTEGER + 1, source: "policy" } },
    { command_timeout: { default_ms: 80, approval_extension_ms: MAX_AGENTSH_DURATION_MS + 1, source: "policy" } },
  ];
  for (const metadata of invalidMetadata) {
    assert.throws(
      () => deriveCommandTimeoutBudget({ metadata, fallback: envFallback, transportSlackMs: 30, terminalResponseMarginMs }),
      (error) => error instanceof CommandTimeoutMetadataError && error.code === "E_COMMAND_TIMEOUT_METADATA",
    );
  }

  const builtin = configuredCommandExecutionTimeout(undefined);
  assert.deepEqual(builtin, { defaultMs: BUILTIN_COMMAND_EXECUTION_TIMEOUT_MS, source: "builtin_default" });
  assert.equal(BUILTIN_COMMAND_EXECUTION_TIMEOUT_MS, 14_400_000);
}

// Command slack is independent, permits zero, and defaults to approval+connect.
{
  assert.equal(configuredCommandTransportSlack("0", 300, 10), 0);
  const legacyDefaultSlack = configuredCommandTransportSlack(undefined, 300, 10);
  assert.equal(legacyDefaultSlack, 310);
  const legacyBudget = deriveCommandTimeoutBudget({
    metadata: { session_id: "old-supervisor" },
    fallback: envFallback,
    transportSlackMs: legacyDefaultSlack,
    terminalResponseMarginMs: 10,
  });
  assert.equal(legacyBudget.transportSlackMs, 310, "compatibility fallback changed the legacy default command slack");
  assert.throws(() => configuredCommandTransportSlack("-1", 300, 10), /non-negative safe integer/);
  assert.throws(() => configuredCommandExecutionTimeout("0"), /positive safe integer/);
}

// Explicit shorter values shorten both execution and transport and are sent unchanged.
{
  const budget = deriveCommandTimeoutBudget({
    metadata: liveMetadata,
    fallback: envFallback,
    transportSlackMs: 30,
    terminalResponseMarginMs,
    timeoutSeconds: 0.015,
  });
  assert.equal(budget.requestedTimeoutMs, 15);
  assert.equal(budget.executionTimeoutMs, 15);
  assert.equal(budget.transportTimeoutMs, 45);
  assert.equal(budget.executionTimeoutSource, "explicit_request");
}

// Requests above either a live maximum or the compatibility ceiling remain
// unchanged on the wire while the client lifetime uses the known cap.
{
  const budget = deriveCommandTimeoutBudget({
    metadata: liveMetadata,
    fallback: envFallback,
    transportSlackMs: 30,
    terminalResponseMarginMs,
    timeoutMs: 500,
  });
  assert.equal(budget.requestedTimeoutMs, 500);
  assert.equal(budget.executionTimeoutMs, 120);
  assert.equal(budget.transportTimeoutMs, 150);
  assert.equal(budget.executionTimeoutSource, "policy_cap");

  const compatibility = deriveCommandTimeoutBudget({
    metadata: {},
    fallback: envFallback,
    transportSlackMs: 30,
    terminalResponseMarginMs,
    timeoutMs: 500,
  });
  assert.equal(compatibility.requestedTimeoutMs, 500, "compatibility ceiling pre-capped the wire request");
  assert.equal(compatibility.executionTimeoutMs, 250);
  assert.equal(compatibility.transportTimeoutMs, 280);
  assert.equal(compatibility.executionTimeoutSource, "policy_cap");

  const maximumWireValue = deriveCommandTimeoutBudget({
    metadata: { command_timeout: { default_ms: 5, maximum_ms: 10, source: "policy" } },
    fallback: envFallback,
    transportSlackMs: 1,
    terminalResponseMarginMs,
    timeoutMs: MAX_AGENTSH_DURATION_MS,
  });
  assert.equal(maximumWireValue.requestedTimeoutMs, MAX_AGENTSH_DURATION_MS);
  assert.equal(maximumWireValue.executionTimeoutMs, 10);
  assert.equal(maximumWireValue.transportTimeoutMs, 11);
  assert.equal(MAX_AGENTSH_DURATION_MS, 9_223_372_036_854);
  assert.throws(() => deriveCommandTimeoutBudget({
    metadata: { command_timeout: { default_ms: 5, maximum_ms: 10, source: "policy" } },
    fallback: envFallback,
    transportSlackMs: 1,
    terminalResponseMarginMs,
    timeoutMs: MAX_AGENTSH_DURATION_MS + 1,
  }), /AgentSH\/Go time\.Duration limit/);
}

// Milliseconds must be exact and dispatched timer arithmetic must fit Node's limit.
{
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => requestedCommandTimeoutMs({ timeoutMs: value }), /positive safe integer/);
  }
  assert.throws(() => requestedCommandTimeoutMs({ timeoutMs: Number.MAX_SAFE_INTEGER }), /AgentSH\/Go time\.Duration limit/);
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => requestedCommandTimeoutMs({ timeoutSeconds: value }), /finite positive/);
  }
  assert.throws(() => requestedCommandTimeoutMs({ timeoutSeconds: 0.0005 }), /positive safe integer/);
  assert.throws(() => requestedCommandTimeoutMs({ timeoutSeconds: 0, timeoutMs: 20 }), /finite positive/);
  assert.throws(() => deriveCommandTimeoutBudget({
    metadata: { command_timeout: { default_ms: 5, source: "fallback" } },
    fallback: envFallback,
    transportSlackMs: 1,
    terminalResponseMarginMs,
    timeoutMs: MAX_NODE_TIMER_MS,
  }), /Node\.js timer limit/);
}

// Structured server markers, not exit code 124, select execution-timeout semantics.
// Only explicitly effective fields report a server-effective value/source.
{
  const structured = {
    ok: true,
    result: {
      exit_code: 124,
      termination_reason: "command_timeout",
      command_timeout: { effective_ms: 120, source: "policy_cap" },
      exec_response: { result: { error: { code: "E_COMMAND_TIMEOUT", message: "server killed the command tree" } } },
    },
  };
  assert.deepEqual(commandExecutionTimeoutDetails(structured, {
    executionTimeoutMs: 500,
    executionTimeoutSource: "explicit_request",
  }), {
    effectiveTimeoutMs: 120,
    source: "policy_cap",
    serverMessage: "server killed the command tree",
  });

  assert.deepEqual(commandExecutionTimeoutDetails({
    ok: false,
    result: { exit_code: 124, error_code: "E_COMMAND_TIMEOUT", timeout_ms: 90, timeout_source: "explicit_request" },
  }, {
    executionTimeoutMs: 80,
    executionTimeoutSource: "policy",
  }), {}, "generic timeout_ms fabricated a server-effective timeout/source");

  assert.deepEqual(commandExecutionTimeoutDetails({
    result: { terminationReason: "command_timeout", effectiveTimeoutMs: 70, effectiveTimeoutSource: "explicit_request" },
  }), { effectiveTimeoutMs: 70, source: "explicit_request" });

  assert.equal(commandExecutionTimeoutDetails({ ok: true, result: { exit_code: 124 } }, {
    executionTimeoutMs: 80,
    executionTimeoutSource: "policy",
  }), undefined, "ordinary child exit 124 was inferred to be a timeout");
}

// Public error classes retain machine-readable server/client budgets and can
// be augmented for the model without losing typed identity.
{
  const execution = new CommandExecutionTimeoutError({
    effectiveTimeoutMs: 120,
    timeoutSource: "policy_cap",
    clientExecutionTimeoutMs: 120,
    clientExecutionTimeoutSource: "policy_cap",
    result: { exit_code: 124 },
    serverMessage: "deadline reached",
  });
  assert.equal(execution.name, "CommandExecutionTimeoutError");
  assert.equal(execution.code, "E_COMMAND_TIMEOUT");
  assert.equal(execution.exitCode, 124);
  assert.equal(execution.effectiveTimeoutMs, 120);
  assert.equal(execution.timeoutSource, "policy_cap");
  assert.equal(execution.clientExecutionTimeoutMs, 120);
  assert.equal(execution.clientExecutionTimeoutSource, "policy_cap");
  assert.match(execution.message, /source: policy_cap, exit code 124/);
  assert.equal(execution.withToolOutput("partial stdout\nFull output: \/remote\/artifact"), execution);
  assert.match(execution.message, /partial stdout/);

  const legacy = new CommandExecutionTimeoutError({
    clientExecutionTimeoutMs: 80,
    clientExecutionTimeoutSource: "policy",
    result: { exit_code: 124, timeout_ms: 80 },
  });
  assert.equal(legacy.effectiveTimeoutMs, undefined);
  assert.equal(legacy.timeoutSource, undefined);
  assert.match(legacy.message, /effective server timeout unavailable/);
  assert.match(legacy.message, /client-derived execution budget 80ms \(source: policy\)/);

  const transport = new CommandTransportTimeoutError(120, 150, 30);
  assert.equal(transport.name, "CommandTransportTimeoutError");
  assert.equal(transport.code, "E_COMMAND_TRANSPORT_TIMEOUT");
  assert.equal(transport.executionTimeoutMs, 120);
  assert.equal(transport.transportTimeoutMs, 150);
  assert.equal(transport.transportSlackMs, 30);
  assert.match(transport.message, /selected transport slack 30ms/);
}
