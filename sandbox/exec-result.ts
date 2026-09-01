type JsonObject = Record<string, unknown>;

export type ExecError = {
  code?: string;
  message?: string;
  policy_rule?: string;
  [key: string]: unknown;
};

export type ExecOutcome = {
  command_started?: boolean;
  dispatch_state?: string;
  failure_kind?: string;
  retryable?: boolean;
  code?: string;
  message?: string;
  queue_duration_ms?: number;
  execution_duration_ms?: number;
  [key: string]: unknown;
};

export type NormalizedExecFailure = {
  commandStarted?: boolean;
  dispatchState?: string;
  failureKind?: string;
  retryable?: boolean;
  code?: string;
  message?: string;
  policyRule?: string;
  queueDurationMs?: number;
  executionDurationMs?: number;
  source: "top-level" | "nested" | "legacy" | "transport";
};

export type ExecResult = {
  exitCode?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  normalizedFailure?: NormalizedExecFailure;
  [key: string]: unknown;
};

const LEGACY_PRE_EXEC_CODES = new Set(["E_COMMAND_NOT_STARTED", "E_COMMAND_START_FAILED", "E_PRE_EXEC_FAILED"]);
const SEMANTIC_EXEC_CODES = /^(?:E_(?:COMMAND|EXEC|QUEUE|POLICY|APPROVAL|NETHELPER|PRE_EXEC|REQUEST|CANCEL|TIMEOUT)_[A-Z0-9_]+)$/;

function truncate(text: string, max = 1800) {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function numericField(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function objectField(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function redactSensitiveText(value: string) {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, "$1 [REDACTED]")
    .replace(/([?&](?:access_token|api[_-]?key|key|token|secret|signature|sig|password)=)[^&#\s]*/gi, "$1[REDACTED]")
    .replace(/(["']?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|credential|password)["']?\s*[:=]\s*)(["'])[^"'\r\n]*\2/gi, "$1$2[REDACTED]$2")
    .replace(/\b(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|credential|password)\s*[:=]\s*[^\s,;}&]+/gi, "$1=[REDACTED]")
    .replace(/\b(sk-(?:live|test|proj)-[A-Za-z0-9_-]+|sk-ant-[A-Za-z0-9_-]+|gh[opusr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16})\b/g, "[REDACTED]");
}

function safeExecText(value: unknown, max = 1000) {
  if (typeof value !== "string") return undefined;
  const text = redactSensitiveText(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim());
  return text ? truncate(text, max) : undefined;
}

function firstDefined(...values: unknown[]) {
  return values.find((value) => value !== undefined);
}

export function normalizeExecResult(result: JsonObject): ExecResult {
  const nestedResult = objectField(objectField(result.exec_response)?.result);
  const topOutcome = objectField(result.outcome);
  const nestedOutcome = objectField(nestedResult?.outcome);
  const topError = objectField(result.error);
  const nestedError = objectField(nestedResult?.error);
  const promoted = Boolean(topOutcome || topError || result.command_started !== undefined || result.error_code !== undefined || result.error_message !== undefined);
  const typedNested = Boolean(nestedOutcome);

  const code = safeExecText(firstDefined(topOutcome?.code, topError?.code, result.error_code, nestedOutcome?.code, nestedError?.code), 160);
  const explicitCommandStarted = firstDefined(topOutcome?.command_started, result.command_started, nestedOutcome?.command_started);
  const commandStartedValue = typeof explicitCommandStarted === "boolean"
    ? explicitCommandStarted
    : code && LEGACY_PRE_EXEC_CODES.has(code) ? false : undefined;
  const failureKind = safeExecText(firstDefined(topOutcome?.failure_kind, result.failure_kind, nestedOutcome?.failure_kind), 80);
  const message = safeExecText(firstDefined(topOutcome?.message, topError?.message, result.error_message, nestedOutcome?.message, nestedError?.message));
  const dispatchState = safeExecText(firstDefined(topOutcome?.dispatch_state, result.dispatch_state, nestedOutcome?.dispatch_state), 80);
  const retryableValue = firstDefined(topOutcome?.retryable, result.retryable, nestedOutcome?.retryable);
  const policyRule = safeExecText(firstDefined(topError?.policy_rule, nestedError?.policy_rule), 240);
  const hasFailure = Boolean(message || code || (failureKind && failureKind !== "none") || commandStartedValue === false);
  const normalizedFailure: NormalizedExecFailure | undefined = hasFailure ? {
    commandStarted: commandStartedValue,
    dispatchState,
    failureKind,
    retryable: typeof retryableValue === "boolean" ? retryableValue : undefined,
    code,
    message,
    policyRule,
    queueDurationMs: numericField(firstDefined(topOutcome?.queue_duration_ms, result.queue_duration_ms, nestedOutcome?.queue_duration_ms)),
    executionDurationMs: numericField(firstDefined(topOutcome?.execution_duration_ms, result.execution_duration_ms, nestedOutcome?.execution_duration_ms)),
    source: promoted ? "top-level" : typedNested ? "nested" : "legacy",
  } : undefined;

  const stdout = String(result.stdout ?? nestedResult?.stdout ?? "");
  const stderr = String(result.stderr ?? nestedResult?.stderr ?? "");
  const explicitExit = numericField(result.exitCode) ?? numericField(result.exit_code) ?? numericField(nestedResult?.exit_code);
  const exitCode = explicitExit ?? (normalizedFailure ? 1 : 0);
  return { ...result, exitCode, stdout, stderr, normalizedFailure } as ExecResult;
}

export function recognizedSemanticExecFailure(result: JsonObject) {
  const nestedResult = objectField(objectField(result.exec_response)?.result);
  const outcomes = [objectField(result.outcome), objectField(nestedResult?.outcome)].filter(Boolean) as JsonObject[];
  if (outcomes.some((outcome) => typeof outcome.command_started === "boolean"
    && typeof outcome.failure_kind === "string" && outcome.failure_kind.length > 0 && outcome.failure_kind.length <= 80)) return true;
  const errors = [objectField(result.error), objectField(nestedResult?.error)].filter(Boolean) as JsonObject[];
  return errors.some((error) => typeof error.code === "string" && SEMANTIC_EXEC_CODES.test(error.code));
}

export function execFailureText(failure: NormalizedExecFailure, exitCode: number) {
  const message = failure.message || failure.code || "AgentSH refused the command";
  switch (failure.failureKind) {
    case "queue_timeout": return `Command was not executed: it timed out waiting in the AgentSH execution queue. ${message}`;
    case "caller_cancellation": return failure.commandStarted === false
      ? `Command was not executed: the queued request was cancelled. ${message}`
      : `Command was cancelled after it started. ${message}`;
    case "command_timeout": return failure.commandStarted === false
      ? `Command was not executed: its deadline expired before start. ${message}`
      : `Command timed out after it started. ${message}`;
    case "policy_or_approval_denial": return `Command was not executed: AgentSH policy or approval denied it. ${message}`;
    case "pre_exec_enforcement": return failure.commandStarted === true
      ? `Command started, but AgentSH enforcement cleanup failed; side effects may have occurred and the command must not be replayed automatically. ${message}`
      : `Command was not executed: AgentSH pre-execution/helper enforcement failed. ${message}`;
    case "post_start_cleanup": return `Command started, but AgentSH cleanup failed; side effects may have occurred and the command must not be replayed automatically. ${message}`;
    case "request_validation":
    case "command_start": return `Command was not executed: ${message}`;
    case "child_exit": return `Command exited with code ${exitCode}${failure.message ? `: ${failure.message}` : ""}`;
    default: return failure.commandStarted === false ? `Command was not executed: ${message}` : message;
  }
}
