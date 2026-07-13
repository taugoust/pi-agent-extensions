import { stripSubagentTerminalControls } from "./subagent-text.js";
import { cloneSubagentTerminal, normalizeSubagentTerminal, type SubagentTerminal } from "./subagent-terminal.js";

export type SubagentUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  contextWindow: number;
  turns: number;
};

export type RetainedSubagentToolCall = {
  name: string;
  args: Record<string, unknown>;
};

export type SubagentCompletedTool = {
  name: string;
  args: Record<string, unknown>;
  isError: boolean;
  path?: string;
  resultPreview?: string;
};

export type SubagentProtocolDiagnostic = {
  kind: "malformed_line" | "unknown_event" | "oversized_line";
  detail?: string;
};

export type RetainedSubagentMessage = {
  role: "assistant" | "toolResult";
  content: Array<Record<string, unknown>>;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: Record<string, unknown>;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
};

export type SubagentCompactionResult = {
  tokensBefore?: number;
  estimatedTokensAfter?: number;
};

export type SubagentCompactionEvent = {
  type: "compaction_start" | "compaction_end";
  reason?: string;
  result?: SubagentCompactionResult;
  aborted?: boolean;
  willRetry?: boolean;
  errorMessage?: string;
};

export type SubagentCompactionState = {
  active: boolean;
  reason?: string;
  count: number;
  events: SubagentCompactionEvent[];
  lastResult?: SubagentCompactionResult;
  aborted?: boolean;
  willRetry?: boolean;
  errorMessage?: string;
};

export type SubagentStreamState = {
  label: string;
  task?: string;
  cwd?: string;
  tools?: string[];
  prefix: string;
  liveText: string;
  rawText: string;
  stdoutBuffer: string;
  stdoutDecoder?: TextDecoder;
  stdoutDiscardingOversizeLine: boolean;
  sawPiJsonStdout: boolean;
  usage: SubagentUsage;
  model?: string;
  messages: RetainedSubagentMessage[];
  activeMessageIndex?: number;
  lastEvent?: Record<string, unknown>;
  lastToolCall?: RetainedSubagentToolCall;
  lastToolResult?: string;
  toolStatus?: string;
  completedTools: SubagentCompletedTool[];
  readFiles: string[];
  modifiedFiles: string[];
  protocolDiagnostics: SubagentProtocolDiagnostic[];
  compaction?: SubagentCompactionState;
  terminal?: SubagentTerminal;
  exitCode: number;
  stopReason?: string;
  final?: string;
  errorMessage?: string;
  stderr?: string;
};

export type SubagentStreamInitialState = Partial<Omit<SubagentStreamState, "usage" | "messages" | "stdoutDecoder">> & {
  label: string;
  usage?: Partial<SubagentUsage>;
  messages?: unknown[];
};

export type Utf8LineChunkResult = {
  lines: string[];
  buffer: string;
  decoder?: TextDecoder;
};

function configuredPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const MAX_SUBAGENT_RESULT_BYTES = configuredPositiveInteger(process.env.PI_AGENTSH_SUBAGENT_RESULT_MAX_BYTES, 50 * 1024);
export const MAX_SUBAGENT_LINE_BYTES = 64 * 1024;
const MAX_RETAINED_MESSAGES = 16;
const MAX_RETAINED_CONTENT_PARTS = 16;
const MAX_RETAINED_TEXT_BYTES = 4 * 1024;
const MAX_RETAINED_TOOL_RESULT_BYTES = 4 * 1024;
const MAX_RETAINED_COMPACTION_EVENTS = 16;
const MAX_RETAINED_TOOLS = 16;
const MAX_RETAINED_PATHS = 32;
const MAX_PROTOCOL_DIAGNOSTICS = 8;
const MAX_TOOL_PREVIEW_BYTES = 512;
const MAX_DIAGNOSTIC_BYTES = 2 * 1024;
const MAX_METADATA_BYTES = 1024;
const MAX_LIVE_TOOL_STATUS_BYTES = 500;
const liveToolStatuses = new WeakMap<SubagentStreamState, string>();

export function usageZero(): SubagentUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, contextWindow: 0, turns: 0 };
}

export function usageNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf-8");
}

function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function truncateByBytes(text: string, maxBytes = MAX_SUBAGENT_RESULT_BYTES): string {
  if (maxBytes <= 0) return "";
  const bytes = byteLength(text);
  if (bytes <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLength(text.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  let prefix = text.slice(0, lo);
  const finalCodeUnit = prefix.charCodeAt(prefix.length - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) prefix = prefix.slice(0, -1);
  return `${prefix}\n\n… truncated at ${formatByteCount(maxBytes)} (${formatByteCount(bytes)} total)`;
}

function boundedString(value: unknown, maxBytes = MAX_METADATA_BYTES): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? truncateByBytes(trimmed, maxBytes) : undefined;
}

function sanitizedDiagnostic(value: unknown): string | undefined {
  const text = boundedString(typeof value === "string" ? stripSubagentTerminalControls(value) : value, MAX_DIAGNOSTIC_BYTES);
  if (!text) return undefined;
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|passwd|secret)\b\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/g, "[private key redacted]");
}

function numericField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitizeUsage(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const usage: Record<string, unknown> = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
    const number = numericField(source[key]);
    if (number !== undefined) usage[key] = number;
  }
  const totalCost = numericField((source.cost as Record<string, unknown> | undefined)?.total);
  if (totalCost !== undefined) usage.cost = { total: totalCost };
  return Object.keys(usage).length ? usage : undefined;
}

export function sanitizeSubagentToolArgs(toolName: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const args = value as Record<string, unknown>;
  const safeText = (input: unknown, maxBytes = MAX_METADATA_BYTES): string | undefined => {
    const text = sanitizedDiagnostic(boundedString(input, maxBytes));
    return text ? truncateByBytes(text.replace(/\s+/g, " "), maxBytes) : undefined;
  };
  const safeNumber = (input: unknown): number | undefined =>
    typeof input === "number" && Number.isSafeInteger(input) && input >= 0 ? input : undefined;
  const withDefined = (entries: Array<[string, unknown]>): Record<string, unknown> =>
    Object.fromEntries(entries.filter((entry) => entry[1] !== undefined));

  if (toolName === "bash") {
    return withDefined([["command", safeText(args.command, MAX_LIVE_TOOL_STATUS_BYTES)]]);
  }
  if (toolName === "read") {
    return withDefined([
      ["path", safeText(args.path ?? args.file_path)],
      ["offset", safeNumber(args.offset)],
      ["limit", safeNumber(args.limit)],
    ]);
  }
  if (toolName === "write" || toolName === "edit") {
    return withDefined([["path", safeText(args.path ?? args.file_path)]]);
  }
  if (toolName === "ls") {
    return withDefined([
      ["path", safeText(args.path)],
      ["limit", safeNumber(args.limit)],
    ]);
  }
  if (toolName === "find") {
    return withDefined([
      ["pattern", safeText(args.pattern, 256)],
      ["path", safeText(args.path)],
      ["limit", safeNumber(args.limit)],
    ]);
  }
  if (toolName === "grep") {
    return withDefined([
      ["pattern", safeText(args.pattern, 256)],
      ["path", safeText(args.path)],
      ["glob", safeText(args.glob, 256)],
      ["ignoreCase", typeof args.ignoreCase === "boolean" ? args.ignoreCase : undefined],
      ["literal", typeof args.literal === "boolean" ? args.literal : undefined],
      ["context", safeNumber(args.context)],
      ["limit", safeNumber(args.limit)],
    ]);
  }
  // Unknown arguments may contain credentials and are not copied into
  // parent-facing progress state.
  return {};
}

function sanitizeToolCall(toolNameValue: unknown, argsValue: unknown): RetainedSubagentToolCall {
  const name = boundedString(toolNameValue, 128) ?? "unknown";
  return { name, args: sanitizeSubagentToolArgs(name, argsValue) };
}

function sanitizeCompletedTool(value: unknown): SubagentCompletedTool | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const name = boundedString(source.name, 128);
  if (!name) return undefined;
  const path = boundedString(source.path, MAX_METADATA_BYTES);
  const args = sanitizeSubagentToolArgs(name, source.args ?? (path ? { path } : undefined));
  const resultPreview = sanitizedDiagnostic(source.resultPreview);
  return {
    name,
    args,
    isError: source.isError === true,
    path,
    resultPreview: resultPreview ? truncateByBytes(resultPreview, MAX_TOOL_PREVIEW_BYTES) : undefined,
  };
}

function rememberPath(paths: string[], value: unknown) {
  const path = boundedString(value, MAX_METADATA_BYTES);
  if (!path) return;
  const existing = paths.indexOf(path);
  if (existing >= 0) paths.splice(existing, 1);
  paths.push(path);
  if (paths.length > MAX_RETAINED_PATHS) paths.splice(0, paths.length - MAX_RETAINED_PATHS);
}

function recordProtocolDiagnostic(state: SubagentStreamState, kind: SubagentProtocolDiagnostic["kind"], detail?: string) {
  state.protocolDiagnostics.push({ kind, detail: detail ? truncateByBytes(detail, 256) : undefined });
  if (state.protocolDiagnostics.length > MAX_PROTOCOL_DIAGNOSTICS) state.protocolDiagnostics.splice(0, state.protocolDiagnostics.length - MAX_PROTOCOL_DIAGNOSTICS);
}

function sanitizeAssistantPart(part: unknown): Record<string, unknown> | undefined {
  if (!part || typeof part !== "object") return undefined;
  const source = part as Record<string, unknown>;
  const type = String(source.type ?? "");
  if (type === "text" || type === "markdown" || type === "text_delta") {
    const text = truncateByBytes(stripSubagentTerminalControls(String(source.text ?? source.delta ?? "")), MAX_RETAINED_TEXT_BYTES);
    return text ? { type: "text", text } : undefined;
  }
  if (type === "toolCall") {
    const call = sanitizeToolCall(source.name, source.arguments);
    return { type: "toolCall", name: call.name, arguments: call.args };
  }
  // Thinking/reasoning and unknown provider-specific blocks are deliberately omitted.
  return undefined;
}

function sanitizeToolResultPart(part: unknown): Record<string, unknown> | undefined {
  if (!part || typeof part !== "object") return undefined;
  const source = part as Record<string, unknown>;
  if (source.type === "text") {
    const text = truncateByBytes(String(source.text ?? ""), MAX_RETAINED_TOOL_RESULT_BYTES);
    return text ? { type: "text", text } : undefined;
  }
  if (source.type === "image") {
    const sourceMetadata = source.source && typeof source.source === "object" ? source.source as Record<string, unknown> : undefined;
    const mimeType = boundedString(source.mimeType ?? sourceMetadata?.media_type, 128) ?? "unknown";
    return { type: "text", text: `[image: ${mimeType}]` };
  }
  return undefined;
}

function sanitizeMessage(value: unknown): RetainedSubagentMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  if (source.role !== "assistant" && source.role !== "toolResult") return undefined;

  const rawContent = Array.isArray(source.content) ? source.content : typeof source.content === "string" ? [{ type: "text", text: source.content }] : [];
  const content = rawContent
    .slice(0, MAX_RETAINED_CONTENT_PARTS)
    .map((part) => source.role === "assistant" ? sanitizeAssistantPart(part) : sanitizeToolResultPart(part))
    .filter((part): part is Record<string, unknown> => part !== undefined);
  const result: RetainedSubagentMessage = { role: source.role, content };

  if (source.role === "assistant") {
    result.model = boundedString(source.model, 256);
    result.stopReason = boundedString(source.stopReason, 128);
    result.errorMessage = sanitizedDiagnostic(source.errorMessage);
    result.usage = sanitizeUsage(source.usage);
  } else {
    result.toolCallId = boundedString(source.toolCallId, 256);
    result.toolName = boundedString(source.toolName, 128);
    result.isError = source.isError === true;
  }
  return result;
}

function cloneMessage(message: RetainedSubagentMessage): RetainedSubagentMessage {
  return {
    ...message,
    content: message.content.map((part) => {
      const clone = { ...part };
      if (clone.arguments && typeof clone.arguments === "object") clone.arguments = { ...(clone.arguments as Record<string, unknown>) };
      return clone;
    }),
    usage: message.usage ? { ...message.usage, ...(message.usage.cost && typeof message.usage.cost === "object" ? { cost: { ...(message.usage.cost as Record<string, unknown>) } } : {}) } : undefined,
  };
}

function updateUsageFromAssistantMessage(usage: SubagentUsage, msg: unknown) {
  if (!msg || typeof msg !== "object" || (msg as Record<string, unknown>).role !== "assistant") return;
  const source = msg as Record<string, unknown>;
  usage.turns++;
  const msgUsage = source.usage as Record<string, unknown> | undefined;
  if (msgUsage) {
    usage.input += usageNumber(msgUsage.input);
    usage.output += usageNumber(msgUsage.output);
    usage.cacheRead += usageNumber(msgUsage.cacheRead);
    usage.cacheWrite += usageNumber(msgUsage.cacheWrite);
    usage.cost += usageNumber((msgUsage.cost as Record<string, unknown> | undefined)?.total);
    usage.contextTokens = usageNumber(msgUsage.totalTokens) || usage.contextTokens;
  }
}

function toolResultText(value: unknown): string {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const content = Array.isArray(source?.content) ? source.content : Array.isArray(value) ? value : undefined;
  if (!content) return typeof value === "string" ? truncateByBytes(value, MAX_RETAINED_TOOL_RESULT_BYTES) : "";
  return truncateByBytes(content
    .map((part) => sanitizeToolResultPart(part))
    .map((part) => part?.text ? String(part.text) : "")
    .filter(Boolean)
    .join("\n"), MAX_RETAINED_TOOL_RESULT_BYTES);
}

function safeCompactionReason(value: unknown): string | undefined {
  return value === "manual" || value === "threshold" || value === "overflow" ? value : undefined;
}

function sanitizeCompactionResult(value: unknown): SubagentCompactionResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const result: SubagentCompactionResult = {};
  const tokensBefore = numericField(source.tokensBefore);
  const estimatedTokensAfter = numericField(source.estimatedTokensAfter);
  if (tokensBefore !== undefined) result.tokensBefore = tokensBefore;
  if (estimatedTokensAfter !== undefined) result.estimatedTokensAfter = estimatedTokensAfter;
  return Object.keys(result).length ? result : undefined;
}

function sanitizeCompactionEvent(event: unknown, eventType?: string): SubagentCompactionEvent | undefined {
  if (!event || typeof event !== "object") return undefined;
  const source = event as Record<string, unknown>;
  const type = eventType ?? source.type;
  if (type !== "compaction_start" && type !== "compaction_end") return undefined;
  const safe: SubagentCompactionEvent = { type };
  safe.reason = safeCompactionReason(source.reason);
  if (type === "compaction_end") {
    safe.result = sanitizeCompactionResult(source.result);
    safe.aborted = source.aborted === true;
    safe.willRetry = source.willRetry === true;
    safe.errorMessage = sanitizedDiagnostic(source.errorMessage);
  }
  return safe;
}

function cloneCompactionEvent(event: SubagentCompactionEvent): SubagentCompactionEvent {
  return { ...event, result: event.result ? { ...event.result } : undefined };
}

function cloneCompactionState(value: SubagentCompactionState | undefined): SubagentCompactionState | undefined {
  if (!value) return undefined;
  return {
    active: value.active === true,
    reason: safeCompactionReason(value.reason),
    count: Math.max(0, usageNumber(value.count)),
    events: Array.isArray(value.events) ? value.events.slice(-MAX_RETAINED_COMPACTION_EVENTS).map(cloneCompactionEvent) : [],
    lastResult: value.lastResult ? { ...value.lastResult } : undefined,
    aborted: value.aborted,
    willRetry: value.willRetry,
    errorMessage: sanitizedDiagnostic(value.errorMessage),
  };
}

function safeEventSummary(event: unknown, eventType: string): Record<string, unknown> {
  if (eventType === "compaction_start" || eventType === "compaction_end") {
    return sanitizeCompactionEvent(event, eventType) ?? { type: eventType };
  }
  if (!event || typeof event !== "object") return { type: eventType || "unknown" };
  const source = event as Record<string, unknown>;
  if (eventType === "message_start" || eventType === "message_update" || eventType === "message_end" || eventType === "tool_result_end") {
    const message = source.message && typeof source.message === "object" ? source.message as Record<string, unknown> : undefined;
    return { type: eventType, ...(typeof message?.role === "string" ? { role: message.role } : {}) };
  }
  if (eventType.startsWith("tool_execution_")) {
    return {
      type: eventType,
      ...(boundedString(source.toolName, 128) ? { toolName: boundedString(source.toolName, 128) } : {}),
      ...(eventType === "tool_execution_end" ? { isError: source.isError === true } : {}),
    };
  }
  return { type: eventType || "unknown" };
}

export function createSubagentStreamState(initial: SubagentStreamInitialState): SubagentStreamState {
  const messages = (initial.messages ?? []).map(sanitizeMessage).filter((message): message is RetainedSubagentMessage => message !== undefined).slice(-MAX_RETAINED_MESSAGES);
  const usage = usageZero();
  for (const key of Object.keys(usage) as Array<keyof SubagentUsage>) usage[key] = usageNumber(initial.usage?.[key]);
  return {
    label: boundedString(initial.label, 256) ?? "subagent",
    task: boundedString(initial.task, MAX_RETAINED_TEXT_BYTES),
    cwd: boundedString(initial.cwd, MAX_METADATA_BYTES),
    tools: Array.isArray(initial.tools) ? initial.tools.slice(0, 32).map((tool) => boundedString(tool, 128)).filter((tool): tool is string => tool !== undefined) : undefined,
    prefix: truncateByBytes(initial.prefix ?? "", MAX_SUBAGENT_RESULT_BYTES),
    liveText: truncateByBytes(initial.liveText ?? "", MAX_RETAINED_TEXT_BYTES),
    rawText: truncateByBytes(initial.rawText ?? "", MAX_SUBAGENT_RESULT_BYTES),
    stdoutBuffer: truncateByBytes(initial.stdoutBuffer ?? "", MAX_SUBAGENT_LINE_BYTES),
    stdoutDiscardingOversizeLine: initial.stdoutDiscardingOversizeLine === true,
    sawPiJsonStdout: initial.sawPiJsonStdout ?? false,
    usage,
    model: boundedString(initial.model, 256),
    messages,
    activeMessageIndex: initial.activeMessageIndex !== undefined && initial.activeMessageIndex >= 0 && initial.activeMessageIndex < messages.length ? initial.activeMessageIndex : undefined,
    lastEvent: initial.lastEvent && typeof initial.lastEvent === "object" ? safeEventSummary(initial.lastEvent, String((initial.lastEvent as Record<string, unknown>).type ?? "unknown")) : undefined,
    lastToolCall: initial.lastToolCall ? sanitizeToolCall(initial.lastToolCall.name, initial.lastToolCall.args) : undefined,
    lastToolResult: initial.lastToolResult ? truncateByBytes(initial.lastToolResult, MAX_RETAINED_TOOL_RESULT_BYTES) : undefined,
    toolStatus: initial.toolStatus ? truncateByBytes(initial.toolStatus, MAX_METADATA_BYTES) : undefined,
    completedTools: (initial.completedTools ?? []).map(sanitizeCompletedTool).filter((tool): tool is SubagentCompletedTool => tool !== undefined).slice(-MAX_RETAINED_TOOLS),
    readFiles: (initial.readFiles ?? []).map((path) => boundedString(path, MAX_METADATA_BYTES)).filter((path): path is string => path !== undefined).slice(-MAX_RETAINED_PATHS),
    modifiedFiles: (initial.modifiedFiles ?? []).map((path) => boundedString(path, MAX_METADATA_BYTES)).filter((path): path is string => path !== undefined).slice(-MAX_RETAINED_PATHS),
    protocolDiagnostics: (initial.protocolDiagnostics ?? []).slice(-MAX_PROTOCOL_DIAGNOSTICS).map((diagnostic) => ({ kind: diagnostic.kind, detail: boundedString(diagnostic.detail, 256) })),
    compaction: cloneCompactionState(initial.compaction),
    terminal: normalizeSubagentTerminal(initial.terminal, { exitCode: initial.exitCode, stopReason: initial.stopReason, error: initial.errorMessage }),
    exitCode: usageNumber(initial.exitCode ?? -1),
    stopReason: boundedString(initial.stopReason, 128),
    final: initial.final ? truncateByBytes(initial.final, MAX_SUBAGENT_RESULT_BYTES) : undefined,
    errorMessage: sanitizedDiagnostic(initial.errorMessage),
    stderr: initial.stderr ? truncateByBytes(initial.stderr, MAX_SUBAGENT_RESULT_BYTES) : undefined,
  };
}

export function appendUtf8LineChunk(buffer: string, decoder: TextDecoder | undefined, chunk: string | Uint8Array): Utf8LineChunkResult {
  let text: string;
  if (typeof chunk === "string") {
    text = `${decoder ? decoder.decode() : ""}${chunk}`;
    decoder = undefined;
  } else {
    decoder ??= new TextDecoder();
    text = decoder.decode(chunk, { stream: true });
  }
  const lines = `${buffer}${text}`.split(/\r?\n/);
  return { lines: lines.slice(0, -1), buffer: lines.at(-1) ?? "", decoder };
}

export function flushUtf8LineChunk(buffer: string, decoder: TextDecoder | undefined): Utf8LineChunkResult {
  const text = `${buffer}${decoder ? decoder.decode() : ""}`;
  return { lines: text ? [text] : [], buffer: "", decoder: undefined };
}

export function parseSubagentPiJsonStdout(stdout: string) {
  const state = createSubagentStreamState({ label: "subagent" });
  for (const line of stdout.split(/\r?\n/)) processSubagentStdoutLine(state, line);
  return {
    messages: state.messages.map(cloneMessage),
    usage: { ...state.usage },
    model: state.model,
    lastEvent: state.lastEvent ? { ...state.lastEvent } : undefined,
    lastToolCall: state.lastToolCall ? { name: state.lastToolCall.name, args: { ...state.lastToolCall.args } } : undefined,
    lastToolResult: state.lastToolResult,
    completedTools: state.completedTools.map((tool) => ({ ...tool, args: { ...tool.args } })),
    readFiles: [...state.readFiles],
    modifiedFiles: [...state.modifiedFiles],
    protocolDiagnostics: state.protocolDiagnostics.map((diagnostic) => ({ ...diagnostic })),
    compaction: cloneCompactionState(state.compaction),
  };
}

export function appendSubagentRawText(state: SubagentStreamState, text: string) {
  const visible = stripSubagentTerminalControls(text);
  if (!visible.trim()) return;
  state.rawText = truncateByBytes(state.rawText + visible, MAX_SUBAGENT_RESULT_BYTES);
}

const PI_JSON_EVENT_TYPES = new Set([
  "session",
  "agent_start",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "tool_result_end",
  "compaction_start",
  "compaction_end",
]);

function textFromPiMessageContent(content: unknown): string {
  if (typeof content === "string") return truncateByBytes(content, MAX_RETAINED_TEXT_BYTES);
  if (!Array.isArray(content)) return "";
  return truncateByBytes(content
    .map((part) => sanitizeAssistantPart(part))
    .map((part) => part?.type === "text" ? String(part.text ?? "") : "")
    .join(""), MAX_RETAINED_TEXT_BYTES);
}

function assistantTextFromPiJsonEvent(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const source = event as Record<string, unknown>;
  const assistantEvent = source.assistantMessageEvent && typeof source.assistantMessageEvent === "object" ? source.assistantMessageEvent as Record<string, unknown> : undefined;
  const message = source.message ?? assistantEvent?.partial;
  if (!message || typeof message !== "object" || (message as Record<string, unknown>).role !== "assistant") return undefined;
  return textFromPiMessageContent((message as Record<string, unknown>).content);
}

export function appendSubagentPrefix(state: SubagentStreamState, text: string) {
  const visible = stripSubagentTerminalControls(text);
  if (!visible) return;
  let prefix = state.prefix;
  if (prefix && !prefix.endsWith("\n")) prefix += "\n";
  prefix += visible.endsWith("\n") ? visible : `${visible}\n`;
  state.prefix = truncateByBytes(prefix, MAX_SUBAGENT_RESULT_BYTES);
}

function summarizeLiveSubagentToolCall(toolName: string, value: unknown): string {
  const args = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const liveArgument = (argument: unknown): string => {
    const bounded = boundedString(argument, MAX_LIVE_TOOL_STATUS_BYTES);
    return sanitizedDiagnostic(bounded)?.replace(/\s+/g, " ") ?? "...";
  };
  if (toolName === "bash") {
    const command = liveArgument(args.command);
    return command === "..." ? "$ bash" : `$ ${truncateByBytes(command, MAX_LIVE_TOOL_STATUS_BYTES)}`;
  }
  if (toolName === "read") return `read ${liveArgument(args.path ?? args.file_path)}`;
  if (toolName === "write") return `write ${liveArgument(args.path ?? args.file_path)}`;
  if (toolName === "edit") return `edit ${liveArgument(args.path ?? args.file_path)}`;
  if (toolName === "ls") return `ls ${liveArgument(args.path) === "..." ? "." : liveArgument(args.path)}`;
  if (toolName === "find") return `find ${liveArgument(args.pattern) === "..." ? "*" : liveArgument(args.pattern)} in ${liveArgument(args.path) === "..." ? "." : liveArgument(args.path)}`;
  if (toolName === "grep") return `grep /${liveArgument(args.pattern) === "..." ? "" : liveArgument(args.pattern)}/ in ${liveArgument(args.path) === "..." ? "." : liveArgument(args.path)}`;
  return toolName;
}

export function subagentLiveToolStatus(state: SubagentStreamState): string | undefined {
  return liveToolStatuses.get(state) ?? state.toolStatus;
}

function rememberSubagentToolCallFromMessage(state: SubagentStreamState, msg: unknown) {
  if (!msg || typeof msg !== "object") return;
  const source = msg as Record<string, unknown>;
  if (source.role !== "assistant" || !Array.isArray(source.content)) return;
  for (const part of source.content) {
    if (part && typeof part === "object" && (part as Record<string, unknown>).type === "toolCall") {
      const toolPart = part as Record<string, unknown>;
      state.lastToolCall = sanitizeToolCall(toolPart.name, toolPart.arguments);
    }
  }
}

function upsertSubagentStreamMessage(state: SubagentStreamState, msg: unknown, final: boolean) {
  rememberSubagentToolCallFromMessage(state, msg);
  const source = msg && typeof msg === "object" ? msg as Record<string, unknown> : undefined;
  if (source?.role === "toolResult") state.lastToolResult = toolResultText(source.content);
  const retained = sanitizeMessage(msg);
  if (retained) {
    if (state.activeMessageIndex !== undefined && state.messages[state.activeMessageIndex]) {
      state.messages[state.activeMessageIndex] = retained;
    } else {
      state.messages.push(retained);
      if (state.messages.length > MAX_RETAINED_MESSAGES) state.messages.splice(0, state.messages.length - MAX_RETAINED_MESSAGES);
      state.activeMessageIndex = state.messages.length - 1;
    }
  }
  if (final) {
    if (source?.role === "assistant") {
      updateUsageFromAssistantMessage(state.usage, source);
      state.model = boundedString(source.model, 256) ?? state.model;
      state.stopReason = boundedString(source.stopReason, 128) ?? state.stopReason;
      state.errorMessage = sanitizedDiagnostic(source.errorMessage) ?? state.errorMessage;
    }
    state.activeMessageIndex = undefined;
  }
}

function recordCompactionEvent(state: SubagentStreamState, event: unknown, eventType: "compaction_start" | "compaction_end") {
  const safeEvent = sanitizeCompactionEvent(event, eventType);
  if (!safeEvent) return;
  const compaction = state.compaction ?? { active: false, count: 0, events: [] };
  compaction.events.push(safeEvent);
  if (compaction.events.length > MAX_RETAINED_COMPACTION_EVENTS) compaction.events.splice(0, compaction.events.length - MAX_RETAINED_COMPACTION_EVENTS);
  if (eventType === "compaction_start") {
    compaction.active = true;
    compaction.count++;
    compaction.reason = safeEvent.reason;
    compaction.aborted = undefined;
    compaction.willRetry = undefined;
    compaction.errorMessage = undefined;
  } else {
    compaction.active = false;
    compaction.reason = safeEvent.reason ?? compaction.reason;
    compaction.lastResult = safeEvent.result ? { ...safeEvent.result } : undefined;
    compaction.aborted = safeEvent.aborted;
    compaction.willRetry = safeEvent.willRetry;
    compaction.errorMessage = safeEvent.errorMessage;
  }
  state.compaction = compaction;
}

export function subagentStreamResult(state: SubagentStreamState) {
  return {
    label: state.label,
    task: state.task,
    exitCode: state.exitCode,
    stopReason: state.stopReason || (state.exitCode === -1 ? "running" : "completed"),
    final: state.final,
    errorMessage: state.errorMessage,
    stderr: state.stderr,
    usage: { ...state.usage },
    messages: state.messages.map(cloneMessage),
    model: state.model,
    tools: state.tools ? [...state.tools] : undefined,
    cwd: state.cwd,
    lastEvent: state.lastEvent ? { ...state.lastEvent } : undefined,
    lastToolCall: state.lastToolCall ? { name: state.lastToolCall.name, args: { ...state.lastToolCall.args } } : undefined,
    lastToolResult: state.lastToolResult,
    completedTools: state.completedTools.map((tool) => ({ ...tool, args: { ...tool.args } })),
    readFiles: [...state.readFiles],
    modifiedFiles: [...state.modifiedFiles],
    protocolDiagnostics: state.protocolDiagnostics.map((diagnostic) => ({ ...diagnostic })),
    compaction: cloneCompactionState(state.compaction),
    terminal: cloneSubagentTerminal(state.terminal),
  };
}

export function processSubagentStdoutLine(state: SubagentStreamState, line: string) {
  const trimmed = line.trim();
  if (!trimmed) {
    if (!state.sawPiJsonStdout) appendSubagentRawText(state, "\n");
    return;
  }
  if (byteLength(trimmed) > MAX_SUBAGENT_LINE_BYTES) {
    appendSubagentRawText(state, `[oversized child output line omitted: ${formatByteCount(byteLength(trimmed))}]\n`);
    recordProtocolDiagnostic(state, "oversized_line", formatByteCount(byteLength(trimmed)));
    return;
  }

  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    appendSubagentRawText(state, `${line}\n`);
    recordProtocolDiagnostic(state, "malformed_line", formatByteCount(byteLength(line)));
    return;
  }

  const source = event && typeof event === "object" ? event as Record<string, unknown> : {};
  const eventType = typeof source.type === "string" ? source.type : "";
  if (!PI_JSON_EVENT_TYPES.has(eventType)) {
    appendSubagentRawText(state, `[unrecognized child event${eventType ? `: ${truncateByBytes(eventType, 128)}` : ""}]\n`);
    recordProtocolDiagnostic(state, "unknown_event", eventType || undefined);
    state.lastEvent = safeEventSummary(event, eventType);
    return;
  }

  state.sawPiJsonStdout = true;
  state.lastEvent = safeEventSummary(event, eventType);
  if ((eventType === "message_start" || eventType === "message_update" || eventType === "message_end") && source.message) {
    upsertSubagentStreamMessage(state, source.message, eventType === "message_end");
  } else if (eventType === "tool_execution_start") {
    const call = sanitizeToolCall(source.toolName, source.args);
    state.lastToolCall = call;
    state.toolStatus = `[running ${call.name}]`;
    liveToolStatuses.set(state, `${state.toolStatus} ${truncateByBytes(summarizeLiveSubagentToolCall(call.name, call.args), MAX_LIVE_TOOL_STATUS_BYTES)}`);
  } else if (eventType === "tool_execution_update" && source.partialResult) {
    const text = toolResultText(source.partialResult);
    if (text) state.lastToolResult = text;
  } else if (eventType === "tool_execution_end") {
    const toolName = boundedString(source.toolName, 128) ?? state.lastToolCall?.name ?? "unknown";
    const args = source.args ?? (state.lastToolCall?.name === toolName ? state.lastToolCall.args : {});
    state.lastToolCall = sanitizeToolCall(toolName, args);
    const text = toolResultText(source.result);
    if (text) state.lastToolResult = text;
    const path = typeof state.lastToolCall.args.path === "string" ? state.lastToolCall.args.path : undefined;
    state.completedTools.push({ name: toolName, args: { ...state.lastToolCall.args }, isError: source.isError === true, path, resultPreview: text ? truncateByBytes(sanitizedDiagnostic(text) ?? "", MAX_TOOL_PREVIEW_BYTES) || undefined : undefined });
    if (state.completedTools.length > MAX_RETAINED_TOOLS) state.completedTools.splice(0, state.completedTools.length - MAX_RETAINED_TOOLS);
    if (toolName === "read") rememberPath(state.readFiles, path);
    if (toolName === "write" || toolName === "edit") rememberPath(state.modifiedFiles, path);
    state.toolStatus = undefined;
    const runningStatus = liveToolStatuses.get(state);
    if (source.isError === true) {
      liveToolStatuses.delete(state);
      const summary = sanitizedDiagnostic(text) || "tool returned an error";
      appendSubagentPrefix(state, `[tool failed: ${toolName}] ${truncateByBytes(summary, 1200)}`);
    } else if (runningStatus) {
      const summary = runningStatus.replace(/^\[running [^\]]+\]\s*/, "");
      liveToolStatuses.set(state, `[completed ${toolName}]${summary ? ` ${summary}` : ""}`);
    }
  } else if (eventType === "tool_result_end" && source.message) {
    upsertSubagentStreamMessage(state, source.message, true);
  } else if (eventType === "compaction_start" || eventType === "compaction_end") {
    recordCompactionEvent(state, event, eventType);
  }
  const assistantText = assistantTextFromPiJsonEvent(event);
  if (assistantText !== undefined) {
    state.liveText = assistantText;
    if (assistantText) liveToolStatuses.delete(state);
  }
}

export function appendSubagentStdoutChunk(state: SubagentStreamState, chunk: string | Uint8Array) {
  if (!chunk || (typeof chunk !== "string" && chunk.byteLength === 0)) return;
  const decoded = appendUtf8LineChunk(state.stdoutBuffer, state.stdoutDecoder, chunk);
  state.stdoutDecoder = decoded.decoder;
  let lines = decoded.lines;
  if (state.stdoutDiscardingOversizeLine) {
    if (!lines.length) {
      state.stdoutBuffer = "";
      return;
    }
    lines = lines.slice(1);
    state.stdoutDiscardingOversizeLine = false;
  }
  for (const line of lines) processSubagentStdoutLine(state, line);
  state.stdoutBuffer = decoded.buffer;
  if (byteLength(state.stdoutBuffer) > MAX_SUBAGENT_LINE_BYTES) {
    appendSubagentRawText(state, `[oversized child output line omitted: more than ${formatByteCount(MAX_SUBAGENT_LINE_BYTES)}]\n`);
    recordProtocolDiagnostic(state, "oversized_line", `more than ${formatByteCount(MAX_SUBAGENT_LINE_BYTES)}`);
    state.stdoutBuffer = "";
    state.stdoutDiscardingOversizeLine = true;
  }
}

export function flushSubagentStdout(state: SubagentStreamState) {
  const decoded = flushUtf8LineChunk(state.stdoutBuffer, state.stdoutDecoder);
  state.stdoutDecoder = undefined;
  state.stdoutBuffer = "";
  if (state.stdoutDiscardingOversizeLine) {
    state.stdoutDiscardingOversizeLine = false;
    return;
  }
  for (const line of decoded.lines) processSubagentStdoutLine(state, line);
}
