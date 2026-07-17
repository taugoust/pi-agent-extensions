export const BUILTIN_COMMAND_EXECUTION_TIMEOUT_MS = 4 * 60 * 60 * 1000;
export const MAX_NODE_TIMER_MS = 2_147_483_647;
/** floor(math.MaxInt64 / time.Millisecond), matching AgentSH's Go wire limit. */
export const MAX_AGENTSH_DURATION_MS = Number(((2n ** 63n) - 1n) / 1_000_000n);

export type CommandTimeoutMetadata = {
  defaultMs: number;
  maximumMs?: number;
  /** Server-enforced maximum cumulative approval-wait extension for one command. */
  approvalExtensionMs?: number;
  source: "policy" | "fallback";
};

export type CommandTimeoutFallback = {
  defaultMs: number;
  source: "compatibility_env" | "builtin_default";
};

export type CommandTimeoutPolicy = Omit<CommandTimeoutMetadata, "source"> & {
  source: CommandTimeoutMetadata["source"] | CommandTimeoutFallback["source"];
  origin: "metadata" | "fallback";
};

export type CommandTimeoutBudget = {
  /** The value sent to AgentSH. Undefined means timeout_ms must be omitted. */
  requestedTimeoutMs?: number;
  /** The client-side estimate of AgentSH's effective execution window. */
  executionTimeoutMs: number;
  /** The selected actual slack after applying any server-advertised minimum. */
  transportSlackMs: number;
  /** The absolute lifetime of one dispatched buffered REST request. */
  transportTimeoutMs: number;
  /** The independently client-derived execution-budget source. */
  executionTimeoutSource: string;
  policy: CommandTimeoutPolicy;
};

type UnknownObject = Record<string, unknown>;

function objectValue(value: unknown): UnknownObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownObject
    : undefined;
}

function hasOwn(object: UnknownObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer number of milliseconds`);
  }
  return value;
}

function positiveAgentSHDurationMilliseconds(value: unknown, label: string): number {
  const milliseconds = positiveSafeInteger(value, label);
  if (milliseconds > MAX_AGENTSH_DURATION_MS) {
    throw new Error(`${label} must not exceed the AgentSH/Go time.Duration limit of ${MAX_AGENTSH_DURATION_MS}ms`);
  }
  return milliseconds;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer number of milliseconds`);
  }
  return value;
}

function nonNegativeAgentSHDurationMilliseconds(value: unknown, label: string): number {
  const milliseconds = nonNegativeSafeInteger(value, label);
  if (milliseconds > MAX_AGENTSH_DURATION_MS) {
    throw new Error(`${label} must not exceed the AgentSH/Go time.Duration limit of ${MAX_AGENTSH_DURATION_MS}ms`);
  }
  return milliseconds;
}

function optionalEnvironmentInteger(raw: string | undefined, label: string, allowZero: boolean): number | undefined {
  if (raw === undefined || !raw.trim()) return undefined;
  const value = Number(raw.trim());
  return allowZero
    ? nonNegativeSafeInteger(value, label)
    : positiveSafeInteger(value, label);
}

/**
 * Capture the trusted wrapper/operator compatibility default once, before any
 * session/project environment refresh can occur.
 */
export function configuredCommandExecutionTimeout(raw: string | undefined): CommandTimeoutFallback {
  const configured = optionalEnvironmentInteger(raw, "PI_AGENTSH_COMMAND_EXECUTION_TIMEOUT_MS", false);
  if (configured !== undefined) return { defaultMs: configured, source: "compatibility_env" };
  return { defaultMs: BUILTIN_COMMAND_EXECUTION_TIMEOUT_MS, source: "builtin_default" };
}

/**
 * The configured command-specific slack defaults to the legacy approval
 * allowance plus one supervisor connection allowance. Unlike execution time,
 * zero slack is a valid explicit operator choice. Live producer metadata may
 * raise this baseline for a particular session command.
 */
export function configuredCommandTransportSlack(
  raw: string | undefined,
  approvalSlackMs: number,
  connectTimeoutMs: number,
): number {
  const configured = optionalEnvironmentInteger(raw, "PI_AGENTSH_COMMAND_TRANSPORT_SLACK_MS", true);
  if (configured !== undefined) return configured;

  const approval = nonNegativeSafeInteger(approvalSlackMs, "PI_AGENTSH_APPROVAL_TIMEOUT_SLACK_MS");
  const connect = nonNegativeSafeInteger(connectTimeoutMs, "PI_AGENTSH_CONNECT_TIMEOUT_MS");
  const combined = approval + connect;
  if (!Number.isSafeInteger(combined)) {
    throw new Error("default AgentSH command transport slack exceeds the JavaScript safe-integer range");
  }
  return combined;
}

export class CommandTimeoutMetadataError extends Error {
  readonly code = "E_COMMAND_TIMEOUT_METADATA";

  constructor(detail: string) {
    super(`AgentSH command_timeout metadata is malformed: ${detail}`);
    this.name = "CommandTimeoutMetadataError";
  }
}

function malformedCommandTimeoutMetadata(detail: string): never {
  throw new CommandTimeoutMetadataError(detail);
}

/**
 * Return complete live command-timeout metadata. Absence is the only legacy
 * compatibility case; a present malformed field is a protocol/config error.
 */
export function parseCommandTimeoutMetadata(metadata: unknown): CommandTimeoutMetadata | undefined {
  const container = objectValue(metadata);
  if (!container || !hasOwn(container, "command_timeout")) return undefined;

  const raw = objectValue(container.command_timeout);
  if (!raw) malformedCommandTimeoutMetadata("command_timeout must be an object");

  let defaultMs: number;
  try {
    defaultMs = positiveAgentSHDurationMilliseconds(raw.default_ms, "command_timeout.default_ms");
  } catch (error) {
    malformedCommandTimeoutMetadata(error instanceof Error ? error.message : String(error));
  }

  const source = typeof raw.source === "string" ? raw.source.trim() : "";
  if (source !== "policy" && source !== "fallback") {
    malformedCommandTimeoutMetadata('command_timeout.source must be "policy" or "fallback"');
  }

  let maximumMs: number | undefined;
  if (hasOwn(raw, "maximum_ms")) {
    try {
      maximumMs = positiveAgentSHDurationMilliseconds(raw.maximum_ms, "command_timeout.maximum_ms");
    } catch (error) {
      malformedCommandTimeoutMetadata(error instanceof Error ? error.message : String(error));
    }
    if (defaultMs > maximumMs) {
      malformedCommandTimeoutMetadata("command_timeout.default_ms must not exceed command_timeout.maximum_ms");
    }
  }

  let approvalExtensionMs: number | undefined;
  if (hasOwn(raw, "approval_extension_ms")) {
    try {
      approvalExtensionMs = nonNegativeAgentSHDurationMilliseconds(
        raw.approval_extension_ms,
        "command_timeout.approval_extension_ms",
      );
    } catch (error) {
      malformedCommandTimeoutMetadata(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    defaultMs,
    maximumMs,
    ...(approvalExtensionMs !== undefined ? { approvalExtensionMs } : {}),
    source,
  };
}

export function resolveCommandTimeoutPolicy(metadata: unknown, fallback: CommandTimeoutFallback): CommandTimeoutPolicy {
  const live = parseCommandTimeoutMetadata(metadata);
  if (live) return { ...live, origin: "metadata" };

  const defaultMs = positiveAgentSHDurationMilliseconds(fallback.defaultMs, "AgentSH command execution fallback");
  return {
    defaultMs,
    // The compatibility value mirrors the older downstream policy ceiling, so
    // it bounds explicit client lifetimes as well as supplying their default.
    maximumMs: defaultMs,
    source: fallback.source,
    origin: "fallback",
  };
}

/** Convert either public seconds or global-API milliseconds into one exact request value. */
export function requestedCommandTimeoutMs(input: { timeoutSeconds?: unknown; timeoutMs?: unknown }): number | undefined {
  let secondsMilliseconds: number | undefined;
  if (input.timeoutSeconds !== undefined) {
    if (typeof input.timeoutSeconds !== "number" || !Number.isFinite(input.timeoutSeconds) || input.timeoutSeconds <= 0) {
      throw new Error("AgentSH Bash timeout must be a finite positive number of seconds");
    }
    const milliseconds = input.timeoutSeconds * 1000;
    if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
      throw new Error("AgentSH Bash timeout must resolve to a positive safe integer number of milliseconds");
    }
    secondsMilliseconds = positiveAgentSHDurationMilliseconds(milliseconds, "AgentSH Bash timeout");
  }
  if (input.timeoutMs !== undefined) {
    return positiveAgentSHDurationMilliseconds(input.timeoutMs, "AgentSH Bash timeout_ms");
  }
  return secondsMilliseconds;
}

export function deriveCommandTimeoutBudget(input: {
  metadata?: unknown;
  fallback: CommandTimeoutFallback;
  /** Operator-configured command transport slack baseline. */
  transportSlackMs: number;
  /** Bounded post-approval terminal/cleanup response margin. */
  terminalResponseMarginMs: number;
  timeoutSeconds?: unknown;
  timeoutMs?: unknown;
}): CommandTimeoutBudget {
  const policy = resolveCommandTimeoutPolicy(input.metadata, input.fallback);
  const requestedTimeoutMs = requestedCommandTimeoutMs({
    timeoutSeconds: input.timeoutSeconds,
    timeoutMs: input.timeoutMs,
  });
  const configuredTransportSlackMs = nonNegativeSafeInteger(input.transportSlackMs, "AgentSH command transport slack");
  const terminalResponseMarginMs = nonNegativeSafeInteger(
    input.terminalResponseMarginMs,
    "AgentSH command terminal/cleanup response margin",
  );
  let transportSlackMs = configuredTransportSlackMs;
  if (policy.approvalExtensionMs !== undefined) {
    if (policy.approvalExtensionMs > Number.MAX_SAFE_INTEGER - terminalResponseMarginMs) {
      throw new Error("AgentSH approval extension plus terminal/cleanup response margin exceeds the JavaScript safe-integer range");
    }
    transportSlackMs = Math.max(
      configuredTransportSlackMs,
      policy.approvalExtensionMs + terminalResponseMarginMs,
    );
  }

  let executionTimeoutMs: number;
  let executionTimeoutSource: string;
  if (requestedTimeoutMs === undefined) {
    executionTimeoutMs = policy.defaultMs;
    executionTimeoutSource = policy.source;
  } else if (policy.maximumMs !== undefined && requestedTimeoutMs > policy.maximumMs) {
    executionTimeoutMs = policy.maximumMs;
    executionTimeoutSource = "policy_cap";
  } else {
    executionTimeoutMs = requestedTimeoutMs;
    executionTimeoutSource = "explicit_request";
  }

  if (executionTimeoutMs > Number.MAX_SAFE_INTEGER - transportSlackMs) {
    throw new Error("AgentSH command execution timeout plus transport slack exceeds the JavaScript safe-integer range");
  }
  const transportTimeoutMs = executionTimeoutMs + transportSlackMs;
  if (transportTimeoutMs > MAX_NODE_TIMER_MS) {
    throw new Error(`AgentSH command transport timeout must not exceed the Node.js timer limit of ${MAX_NODE_TIMER_MS}ms`);
  }

  return {
    requestedTimeoutMs,
    executionTimeoutMs,
    transportSlackMs,
    transportTimeoutMs,
    executionTimeoutSource,
    policy,
  };
}

export type CommandExecutionTimeoutDetails = {
  /** Present only when the server supplied an explicitly effective field. */
  effectiveTimeoutMs?: number;
  /** Present only when reported alongside the server's effective timeout. */
  source?: string;
  serverMessage?: string;
};

const STRUCTURED_TIMEOUT_CHILD_KEYS = [
  "result",
  "exec_response",
  "outcome",
  "error",
  "timeout",
  "command_timeout",
  "details",
  "context",
  "termination",
] as const;

function responseObjects(raw: unknown): UnknownObject[] {
  const root = objectValue(raw);
  if (!root) return [];
  const found: UnknownObject[] = [];
  const seen = new Set<UnknownObject>();
  const queue: Array<{ value: UnknownObject; depth: number }> = [{ value: root, depth: 0 }];
  while (queue.length) {
    const item = queue.shift()!;
    if (seen.has(item.value)) continue;
    seen.add(item.value);
    found.push(item.value);
    if (item.depth >= 6) continue;
    for (const key of STRUCTURED_TIMEOUT_CHILD_KEYS) {
      const child = objectValue(item.value[key]);
      if (child) queue.push({ value: child, depth: item.depth + 1 });
    }
  }
  return found;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

type ReportedEffectiveTimeout = {
  effectiveTimeoutMs?: number;
  source?: string;
};

function reportedEffectiveTimeout(objects: UnknownObject[]): ReportedEffectiveTimeout {
  for (const object of objects) {
    // Generic timeout_ms/timeoutMs can describe the request. Only fields whose
    // names explicitly say "effective" are server-effective evidence.
    const values = [object.effective_timeout_ms, object.effectiveTimeoutMs, object.effective_ms, object.effectiveMs];
    for (const value of values) {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > MAX_AGENTSH_DURATION_MS) continue;
      const source = stringValue(object.effective_timeout_source)
        || stringValue(object.effectiveTimeoutSource)
        || stringValue(object.timeout_source)
        || stringValue(object.timeoutSource)
        || stringValue(object.source);
      return {
        effectiveTimeoutMs: value,
        ...(source ? { source } : {}),
      };
    }
  }
  return {};
}

/**
 * Recognize only explicit server semantics. Exit code 124 by itself is never a
 * timeout marker because a child process may legitimately return that code.
 * The optional client budget parameter is accepted for API compatibility but
 * is deliberately not used to synthesize server-reported fields.
 */
export function commandExecutionTimeoutDetails(
  raw: unknown,
  _clientBudget?: { executionTimeoutMs: number; executionTimeoutSource: string },
): CommandExecutionTimeoutDetails | undefined {
  const objects = responseObjects(raw);
  const structured = objects.some((object) => object.code === "E_COMMAND_TIMEOUT"
    || object.error_code === "E_COMMAND_TIMEOUT"
    || object.termination_reason === "command_timeout"
    || object.terminationReason === "command_timeout");
  if (!structured) return undefined;

  const reported = reportedEffectiveTimeout(objects);
  const serverMessage = objects.map((object) => stringValue(object.message)).find(Boolean);
  return {
    ...reported,
    ...(serverMessage ? { serverMessage: serverMessage.slice(0, 1000) } : {}),
  };
}

export class CommandTransportTimeoutError extends Error {
  readonly code = "E_COMMAND_TRANSPORT_TIMEOUT";

  constructor(
    readonly executionTimeoutMs: number,
    readonly transportTimeoutMs: number,
    readonly transportSlackMs: number,
  ) {
    super(`AgentSH command transport timed out after ${transportTimeoutMs}ms while waiting for the buffered exec_bash response (derived execution budget ${executionTimeoutMs}ms; selected transport slack ${transportSlackMs}ms)`);
    this.name = "CommandTransportTimeoutError";
  }
}

export type CommandExecutionTimeoutErrorOptions = {
  effectiveTimeoutMs?: number;
  timeoutSource?: string;
  clientExecutionTimeoutMs: number;
  clientExecutionTimeoutSource: string;
  result?: unknown;
  serverMessage?: string;
};

export class CommandExecutionTimeoutError extends Error {
  readonly code = "E_COMMAND_TIMEOUT";
  readonly exitCode = 124;
  readonly terminationReason = "command_timeout";
  readonly effectiveTimeoutMs?: number;
  readonly timeoutSource?: string;
  readonly clientExecutionTimeoutMs: number;
  readonly clientExecutionTimeoutSource: string;
  readonly result?: unknown;
  readonly serverMessage?: string;
  modelOutput?: string;
  toolDetails?: unknown;

  constructor(options: CommandExecutionTimeoutErrorOptions) {
    const effectiveTimeoutMs = options.effectiveTimeoutMs === undefined
      ? undefined
      : positiveAgentSHDurationMilliseconds(options.effectiveTimeoutMs, "AgentSH effective command timeout");
    const timeoutSource = stringValue(options.timeoutSource);
    const clientExecutionTimeoutMs = positiveSafeInteger(options.clientExecutionTimeoutMs, "client-derived AgentSH command execution budget");
    const clientExecutionTimeoutSource = stringValue(options.clientExecutionTimeoutSource);
    if (!clientExecutionTimeoutSource) {
      throw new Error("client-derived AgentSH command execution budget source must be a non-empty string");
    }

    const clientBudget = `client-derived execution budget ${clientExecutionTimeoutMs}ms (source: ${clientExecutionTimeoutSource})`;
    let message: string;
    if (effectiveTimeoutMs === undefined) {
      const reportedSource = timeoutSource ? `; server-reported source: ${timeoutSource}` : "";
      message = `AgentSH command execution timed out (effective server timeout unavailable${reportedSource}; ${clientBudget}; exit code 124)`;
    } else if (timeoutSource) {
      message = `AgentSH command execution timed out after ${effectiveTimeoutMs}ms (source: ${timeoutSource}, exit code 124)`;
    } else {
      message = `AgentSH command execution timed out after ${effectiveTimeoutMs}ms (server source unavailable; ${clientBudget}; exit code 124)`;
    }
    if (options.serverMessage) message += `: ${options.serverMessage}`;
    super(message);
    this.name = "CommandExecutionTimeoutError";
    this.effectiveTimeoutMs = effectiveTimeoutMs;
    this.timeoutSource = timeoutSource;
    this.clientExecutionTimeoutMs = clientExecutionTimeoutMs;
    this.clientExecutionTimeoutSource = clientExecutionTimeoutSource;
    this.result = options.result;
    this.serverMessage = options.serverMessage;
  }

  /** Attach bounded model-facing tool output without losing typed identity. */
  withToolOutput(output: string, details?: unknown): this {
    this.modelOutput = output;
    this.toolDetails = details;
    if (output) this.message += `\n\n${output}`;
    return this;
  }
}
