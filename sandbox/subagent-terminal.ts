import { stripSubagentTerminalControls } from "./subagent-text.js";

export type SubagentTerminalState = "completed" | "failed" | "cancelled" | "timed_out";
export type SubagentFailureKind = "auth" | "model" | "compaction" | "protocol" | "transport" | "process" | "configuration" | "unknown";
export type SubagentCancellationCause = "user_cancelled" | "child_timeout" | "request_timeout" | "parent_cancelled" | "client_disconnected" | "supervisor_shutdown";
export type SubagentTermination = "natural" | "graceful" | "forced";

export type SubagentTerminal = {
  state: SubagentTerminalState;
  failureKind?: SubagentFailureKind;
  cancellationCause?: SubagentCancellationCause;
  exitCode?: number;
  signal?: string;
  termination?: SubagentTermination;
  retryable: boolean;
  message?: string;
};

const STATES = new Set<SubagentTerminalState>(["completed", "failed", "cancelled", "timed_out"]);
const FAILURE_KINDS = new Set<SubagentFailureKind>(["auth", "model", "compaction", "protocol", "transport", "process", "configuration", "unknown"]);
const CANCELLATION_CAUSES = new Set<SubagentCancellationCause>(["user_cancelled", "child_timeout", "request_timeout", "parent_cancelled", "client_disconnected", "supervisor_shutdown"]);
const TERMINATIONS = new Set<SubagentTermination>(["natural", "graceful", "forced"]);
const MAX_TERMINAL_MESSAGE_BYTES = 2 * 1024;

function truncateUTF8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString("utf8");
}

function sanitizedMessage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const visible = stripSubagentTerminalControls(value).trim();
  if (!visible) return undefined;
  return truncateUTF8(visible, MAX_TERMINAL_MESSAGE_BYTES)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|passwd|secret)\b\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function normalizeSubagentTerminal(value: unknown, legacy: { exitCode?: unknown; stopReason?: unknown; error?: unknown } = {}): SubagentTerminal | undefined {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const rawState = source?.state;
  if (typeof rawState === "string" && STATES.has(rawState as SubagentTerminalState)) {
    const state = rawState as SubagentTerminalState;
    const rawFailureKind = source?.failure_kind ?? source?.failureKind;
    const rawCancellationCause = source?.cancellation_cause ?? source?.cancellationCause;
    const rawTermination = source?.termination;
    const failureKind = typeof rawFailureKind === "string" && FAILURE_KINDS.has(rawFailureKind as SubagentFailureKind) ? rawFailureKind as SubagentFailureKind : undefined;
    const cancellationCause = typeof rawCancellationCause === "string" && CANCELLATION_CAUSES.has(rawCancellationCause as SubagentCancellationCause) ? rawCancellationCause as SubagentCancellationCause : undefined;
    const termination = typeof rawTermination === "string" && TERMINATIONS.has(rawTermination as SubagentTermination) ? rawTermination as SubagentTermination : undefined;
    return {
      state,
      failureKind,
      cancellationCause,
      exitCode: finiteNumber(source?.exit_code ?? source?.exitCode),
      signal: typeof source?.signal === "string" ? truncateUTF8(source.signal, 128) : undefined,
      termination,
      retryable: source?.retryable === true,
      message: sanitizedMessage(source?.message),
    };
  }

  const exitCode = finiteNumber(legacy.exitCode);
  const stopReason = typeof legacy.stopReason === "string" ? legacy.stopReason.toLowerCase() : "";
  if (exitCode === undefined && !stopReason) return undefined;
  if (stopReason === "timeout" || stopReason === "timed_out") {
    return { state: "timed_out", failureKind: "process", cancellationCause: "request_timeout", exitCode, retryable: true, message: sanitizedMessage(legacy.error) };
  }
  if (stopReason === "cancelled" || stopReason === "canceled" || stopReason === "aborted") {
    return { state: "cancelled", cancellationCause: "parent_cancelled", exitCode, retryable: true, message: sanitizedMessage(legacy.error) };
  }
  if (exitCode === 0 && (!stopReason || stopReason === "completed" || stopReason === "stop")) {
    return { state: "completed", exitCode, termination: "natural", retryable: false };
  }
  if (exitCode === -1 || stopReason === "running") return undefined;
  return { state: "failed", failureKind: "unknown", exitCode, termination: "natural", retryable: false, message: sanitizedMessage(legacy.error) };
}

export function subagentTerminalFailed(terminal: SubagentTerminal | undefined): boolean {
  return terminal !== undefined && terminal.state !== "completed";
}

export function cloneSubagentTerminal(terminal: SubagentTerminal | undefined): SubagentTerminal | undefined {
  return terminal ? { ...terminal } : undefined;
}
