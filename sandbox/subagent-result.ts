import { cloneSubagentTerminal, normalizeSubagentTerminal, type SubagentTerminal } from "./subagent-terminal.js";
import { sanitizeSubagentToolArgs, truncateByBytes, usageNumber, type RetainedSubagentMessage, type SubagentCompletedTool, type SubagentCompactionState, type SubagentProtocolDiagnostic, type SubagentStreamState, type SubagentUsage } from "./subagent-stream.js";
import { stripSubagentTerminalControls } from "./subagent-text.js";

export const MAX_SUBAGENT_CAPSULE_BYTES = 12 * 1024;
const MAX_CAPSULE_TEXT_BYTES = 2 * 1024;
const MAX_CAPSULE_ERROR_BYTES = 1024;
const MAX_CAPSULE_STDERR_BYTES = 2 * 1024;
const MAX_CAPSULE_MESSAGES_BYTES = 2 * 1024;
const MAX_CAPSULE_TOOLS = 8;
const MAX_CAPSULE_PATHS = 16;
const MAX_CAPSULE_DIAGNOSTICS = 8;

export type SubagentProgressCapsule = {
  label: string;
  task?: string;
  exitCode: number;
  stopReason: string;
  terminal?: SubagentTerminal;
  final?: string;
  errorMessage?: string;
  stderrTail?: string;
  usage: SubagentUsage;
  model?: string;
  modelStopReason?: string;
  tools?: string[];
  cwd?: string;
  lastAssistantText?: string;
  messages: RetainedSubagentMessage[];
  completedTools: SubagentCompletedTool[];
  activeTool?: { name: string; args: Record<string, unknown> };
  readFiles: string[];
  modifiedFiles: string[];
  compaction?: SubagentCompactionState;
  protocolSettled: boolean;
  stdoutTruncated: boolean;
  stdoutTotalBytes: number;
  protocolDiagnostics: SubagentProtocolDiagnostic[];
  fullResultPath?: string;
  finalTruncated?: boolean;
  finalTotalBytes?: number;
  finalInlineBytes?: number;
  artifactBytes?: number;
  artifactComplete?: boolean;
  artifactError?: string;
};

type CapsuleSource = Partial<Omit<SubagentStreamState, "terminal">> & {
  label?: string;
  exitCode?: number;
  stopReason?: string;
  terminal?: unknown;
  fullResultPath?: string;
  finalTruncated?: boolean;
  finalTotalBytes?: number;
  finalInlineBytes?: number;
  artifactBytes?: number;
  artifactComplete?: boolean;
  artifactError?: string;
};

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function sanitizeCapsuleText(value: string): string {
  return stripSubagentTerminalControls(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|passwd|secret)\b\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/g, "[private key redacted]");
}

export function sanitizeSubagentParentText(value: string, maxBytes = MAX_CAPSULE_TEXT_BYTES): string {
  return truncateByBytes(sanitizeCapsuleText(value), maxBytes);
}

function tailByBytes(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  return bytes.subarray(bytes.byteLength - maxBytes).toString("utf8");
}

function lastAssistantText(messages: RetainedSubagentMessage[] | undefined): string | undefined {
  if (!messages) return undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const text = message.content.filter((part) => part.type === "text").map((part) => String(part.text ?? "")).join("").trim();
    return text ? truncateByBytes(sanitizeCapsuleText(text), MAX_CAPSULE_TEXT_BYTES) : undefined;
  }
  return undefined;
}

function boundedMessages(messages: RetainedSubagentMessage[] | undefined): RetainedSubagentMessage[] {
  if (!messages) return [];
  const retained: RetainedSubagentMessage[] = [];
  let bytes = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const safe: RetainedSubagentMessage = {
      role: "assistant",
      content: message.content
        .filter((part) => part.type === "text" || part.type === "toolCall")
        .map((part) => {
          if (part.type === "text") return { type: "text", text: sanitizeCapsuleText(String(part.text ?? "")) };
          const name = truncateByBytes(String(part.name || "unknown"), 128);
          return { type: "toolCall", name, arguments: sanitizeSubagentToolArgs(name, part.arguments) };
        }),
      model: message.model,
      stopReason: message.stopReason,
      errorMessage: message.errorMessage ? truncateByBytes(sanitizeCapsuleText(message.errorMessage), MAX_CAPSULE_ERROR_BYTES) : undefined,
    };
    const candidateBytes = byteLength(safe);
    if (retained.length && bytes + candidateBytes > MAX_CAPSULE_MESSAGES_BYTES) break;
    retained.unshift(safe);
    bytes += candidateBytes;
    if (bytes >= MAX_CAPSULE_MESSAGES_BYTES) break;
  }
  return retained;
}

function boundedCompletedToolArgs(tool: SubagentCompletedTool): Record<string, unknown> {
  const source = tool.args && typeof tool.args === "object" && !Array.isArray(tool.args) ? { ...tool.args } : {};
  if (source.path === undefined && typeof tool.path === "string") source.path = tool.path;
  return sanitizeSubagentToolArgs(tool.name, source);
}

function boundedUsage(value: Partial<SubagentUsage> | undefined): SubagentUsage {
  return {
    input: usageNumber(value?.input),
    output: usageNumber(value?.output),
    cacheRead: usageNumber(value?.cacheRead),
    cacheWrite: usageNumber(value?.cacheWrite),
    cost: usageNumber(value?.cost),
    contextTokens: usageNumber(value?.contextTokens),
    contextWindow: usageNumber(value?.contextWindow),
    turns: usageNumber(value?.turns),
  };
}

function cloneCompaction(value: SubagentCompactionState | undefined): SubagentCompactionState | undefined {
  if (!value) return undefined;
  return {
    active: value.active === true,
    reason: value.reason,
    count: usageNumber(value.count),
    events: (value.events ?? []).slice(-8).map((event) => ({ ...event, result: event.result ? { ...event.result } : undefined })),
    lastResult: value.lastResult ? { ...value.lastResult } : undefined,
    aborted: value.aborted,
    willRetry: value.willRetry,
    errorMessage: value.errorMessage ? truncateByBytes(sanitizeCapsuleText(value.errorMessage), MAX_CAPSULE_ERROR_BYTES) : undefined,
  };
}

export function createSubagentProgressCapsule(source: CapsuleSource): SubagentProgressCapsule {
  const exitCode = typeof source.exitCode === "number" && Number.isFinite(source.exitCode) ? source.exitCode : -1;
  const stopReason = source.stopReason || (exitCode === -1 ? "running" : "completed");
  const terminal = normalizeSubagentTerminal(source.terminal, { exitCode, stopReason, error: source.errorMessage });
  const messages = boundedMessages(source.messages);
  const assistantText = lastAssistantText(source.messages);
  const activeTool = source.toolStatus && source.lastToolCall
    ? {
        name: truncateByBytes(source.lastToolCall.name, 128),
        args: sanitizeSubagentToolArgs(source.lastToolCall.name, source.lastToolCall.args),
      }
    : undefined;
  const capsule: SubagentProgressCapsule = {
    label: truncateByBytes(String(source.label || "subagent"), 256),
    task: source.task ? truncateByBytes(source.task, 1024) : undefined,
    exitCode,
    stopReason,
    terminal: cloneSubagentTerminal(terminal),
    final: source.final ? truncateByBytes(sanitizeCapsuleText(source.final), MAX_CAPSULE_TEXT_BYTES) : undefined,
    errorMessage: source.errorMessage ? truncateByBytes(sanitizeCapsuleText(source.errorMessage), MAX_CAPSULE_ERROR_BYTES) : undefined,
    stderrTail: source.stderr ? sanitizeCapsuleText(tailByBytes(source.stderr, MAX_CAPSULE_STDERR_BYTES)) : undefined,
    usage: boundedUsage(source.usage),
    model: source.model ? truncateByBytes(source.model, 256) : undefined,
    modelStopReason: source.modelStopReason ? truncateByBytes(source.modelStopReason, 128) : undefined,
    tools: source.tools?.slice(0, 32).map((tool) => truncateByBytes(tool, 128)),
    cwd: source.cwd ? truncateByBytes(source.cwd, 1024) : undefined,
    lastAssistantText: assistantText,
    messages,
    completedTools: (source.completedTools ?? []).slice(-MAX_CAPSULE_TOOLS).map((tool) => {
      const args = boundedCompletedToolArgs(tool);
      return {
        name: truncateByBytes(tool.name, 128),
        args,
        isError: tool.isError === true,
        path: typeof args.path === "string" ? args.path : undefined,
        resultPreview: tool.resultPreview ? truncateByBytes(sanitizeCapsuleText(tool.resultPreview), 256) : undefined,
      };
    }),
    activeTool,
    readFiles: (source.readFiles ?? []).slice(-MAX_CAPSULE_PATHS).map((path) => truncateByBytes(path, 1024)),
    modifiedFiles: (source.modifiedFiles ?? []).slice(-MAX_CAPSULE_PATHS).map((path) => truncateByBytes(path, 1024)),
    compaction: cloneCompaction(source.compaction),
    protocolSettled: source.protocolSettled === true,
    stdoutTruncated: source.stdoutTruncated === true,
    stdoutTotalBytes: usageNumber(source.stdoutTotalBytes),
    protocolDiagnostics: (source.protocolDiagnostics ?? []).slice(-MAX_CAPSULE_DIAGNOSTICS).map((diagnostic) => ({ ...diagnostic, detail: diagnostic.detail ? truncateByBytes(diagnostic.detail, 256) : undefined })),
    fullResultPath: source.fullResultPath ? truncateByBytes(stripSubagentTerminalControls(source.fullResultPath), 512) : undefined,
    finalTruncated: source.finalTruncated === true || undefined,
    finalTotalBytes: usageNumber(source.finalTotalBytes) || undefined,
    finalInlineBytes: usageNumber(source.finalInlineBytes) || undefined,
    artifactBytes: usageNumber(source.artifactBytes) || undefined,
    artifactComplete: typeof source.artifactComplete === "boolean" ? source.artifactComplete : undefined,
    artifactError: source.artifactError ? truncateByBytes(sanitizeCapsuleText(source.artifactError), 512) : undefined,
  };

  if (byteLength(capsule) > MAX_SUBAGENT_CAPSULE_BYTES) capsule.messages = [];
  if (byteLength(capsule) > MAX_SUBAGENT_CAPSULE_BYTES) capsule.completedTools = capsule.completedTools.slice(-4);
  if (byteLength(capsule) > MAX_SUBAGENT_CAPSULE_BYTES) {
    capsule.readFiles = capsule.readFiles.slice(-4);
    capsule.modifiedFiles = capsule.modifiedFiles.slice(-4);
    capsule.protocolDiagnostics = capsule.protocolDiagnostics.slice(-4);
  }
  if (byteLength(capsule) > MAX_SUBAGENT_CAPSULE_BYTES) {
    capsule.final = capsule.final ? truncateByBytes(capsule.final, 512) : undefined;
    capsule.lastAssistantText = capsule.lastAssistantText ? truncateByBytes(capsule.lastAssistantText, 512) : undefined;
    capsule.stderrTail = capsule.stderrTail ? tailByBytes(capsule.stderrTail, 512) : undefined;
  }
  if (byteLength(capsule) > MAX_SUBAGENT_CAPSULE_BYTES) {
    capsule.tools = undefined;
    capsule.compaction = capsule.compaction ? { ...capsule.compaction, events: [] } : undefined;
    capsule.completedTools = [];
    capsule.readFiles = [];
    capsule.modifiedFiles = [];
  }
  if (byteLength(capsule) > MAX_SUBAGENT_CAPSULE_BYTES) {
    capsule.task = undefined;
    capsule.cwd = undefined;
    capsule.errorMessage = capsule.errorMessage ? truncateByBytes(capsule.errorMessage, 256) : undefined;
    capsule.artifactError = capsule.artifactError ? truncateByBytes(capsule.artifactError, 256) : undefined;
  }
  return capsule;
}

export function boundSubagentProgressCapsules(capsules: SubagentProgressCapsule[], maxBytes = MAX_SUBAGENT_CAPSULE_BYTES): SubagentProgressCapsule[] {
  const bounded = capsules.map((capsule) => ({
    ...capsule,
    terminal: cloneSubagentTerminal(capsule.terminal),
    usage: { ...capsule.usage },
    messages: capsule.messages.map((message) => ({ ...message, content: message.content.map((part) => ({ ...part })) })),
    completedTools: capsule.completedTools.map((tool) => ({ ...tool, args: { ...tool.args } })),
    activeTool: capsule.activeTool ? { name: capsule.activeTool.name, args: { ...capsule.activeTool.args } } : undefined,
    readFiles: [...capsule.readFiles],
    modifiedFiles: [...capsule.modifiedFiles],
    protocolDiagnostics: capsule.protocolDiagnostics.map((diagnostic) => ({ ...diagnostic })),
    compaction: cloneCompaction(capsule.compaction),
  }));
  if (byteLength({ results: bounded }) <= maxBytes) return bounded;

  for (const capsule of bounded) {
    capsule.task = capsule.task ? truncateByBytes(capsule.task, 256) : undefined;
    capsule.cwd = capsule.cwd ? truncateByBytes(capsule.cwd, 256) : undefined;
    capsule.final = capsule.final ? truncateByBytes(capsule.final, 512) : undefined;
    capsule.lastAssistantText = capsule.lastAssistantText ? truncateByBytes(capsule.lastAssistantText, 512) : undefined;
    capsule.errorMessage = capsule.errorMessage ? truncateByBytes(capsule.errorMessage, 256) : undefined;
    capsule.artifactError = capsule.artifactError ? truncateByBytes(capsule.artifactError, 256) : undefined;
    capsule.stderrTail = capsule.stderrTail ? tailByBytes(capsule.stderrTail, 512) : undefined;
    capsule.messages = [];
    capsule.completedTools = capsule.completedTools.slice(-2).map((tool) => ({ name: tool.name, args: { ...tool.args }, isError: tool.isError, path: tool.path ? truncateByBytes(tool.path, 256) : undefined }));
    capsule.readFiles = capsule.readFiles.slice(-4).map((path) => truncateByBytes(path, 256));
    capsule.modifiedFiles = capsule.modifiedFiles.slice(-4).map((path) => truncateByBytes(path, 256));
    capsule.protocolDiagnostics = capsule.protocolDiagnostics.slice(-2);
    capsule.compaction = capsule.compaction ? { ...capsule.compaction, events: [] } : undefined;
    capsule.tools = capsule.tools?.slice(0, 8);
    if (capsule.terminal?.message) capsule.terminal.message = truncateByBytes(capsule.terminal.message, 256);
  }
  if (byteLength({ results: bounded }) <= maxBytes) return bounded;

  for (const capsule of bounded) {
    capsule.task = undefined;
    capsule.cwd = undefined;
    capsule.tools = undefined;
    capsule.stderrTail = undefined;
    capsule.messages = [];
    capsule.completedTools = [];
    capsule.activeTool = undefined;
    capsule.readFiles = [];
    capsule.modifiedFiles = [];
    capsule.compaction = undefined;
    capsule.protocolDiagnostics = [];
    capsule.final = capsule.final ? truncateByBytes(capsule.final, 256) : undefined;
    capsule.lastAssistantText = capsule.final ? undefined : capsule.lastAssistantText ? truncateByBytes(capsule.lastAssistantText, 256) : undefined;
    capsule.label = truncateByBytes(capsule.label, 64);
    capsule.model = capsule.model ? truncateByBytes(capsule.model, 128) : undefined;
    capsule.errorMessage = capsule.errorMessage ? truncateByBytes(capsule.errorMessage, 128) : undefined;
    capsule.artifactError = capsule.artifactError ? truncateByBytes(capsule.artifactError, 128) : undefined;
    if (capsule.terminal?.message) capsule.terminal.message = truncateByBytes(capsule.terminal.message, 128);
  }
  return bounded;
}
