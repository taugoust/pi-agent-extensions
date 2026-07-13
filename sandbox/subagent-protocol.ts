import { appendUtf8LineChunk, flushUtf8LineChunk } from "./subagent-stream.js";

export type SubagentProtocolMessage = {
  event: string;
  [key: string]: unknown;
};

export type SubagentProtocolFinalResponse = {
  ok: boolean;
  result?: unknown;
  error: string;
};

export type SubagentProtocolDiagnostic = {
  kind: "malformed_line" | "invalid_event" | "oversized_line" | "duplicate_done" | "event_after_done" | "aborted";
  event?: string;
  bytes?: number;
  cause?: string;
};

export type SubagentProtocolState = {
  buffer: string;
  decoder?: TextDecoder;
  discardingOversizeLine: boolean;
  closed: boolean;
  doneCount: number;
  eventCount: number;
  ignoredAfterDone: number;
  finalResponse?: SubagentProtocolFinalResponse;
  diagnostics: SubagentProtocolDiagnostic[];
  error?: string;
};

export type SubagentProtocolFinishResult = {
  events: SubagentProtocolMessage[];
  finalResponse?: SubagentProtocolFinalResponse;
  error?: string;
};

export const MAX_SUBAGENT_PROTOCOL_LINE_BYTES = 32 * 1024 * 1024;
const MAX_SUBAGENT_PROTOCOL_DIAGNOSTICS = 16;
const MAX_PROTOCOL_CAUSE_BYTES = 512;

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function boundedCause(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= MAX_PROTOCOL_CAUSE_BYTES) return text;
  return bytes.subarray(0, MAX_PROTOCOL_CAUSE_BYTES).toString("utf8");
}

function recordDiagnostic(state: SubagentProtocolState, diagnostic: SubagentProtocolDiagnostic) {
  state.diagnostics.push(diagnostic);
  if (state.diagnostics.length > MAX_SUBAGENT_PROTOCOL_DIAGNOSTICS) {
    state.diagnostics.splice(0, state.diagnostics.length - MAX_SUBAGENT_PROTOCOL_DIAGNOSTICS);
  }
}

export function createSubagentProtocolState(): SubagentProtocolState {
  return {
    buffer: "",
    discardingOversizeLine: false,
    closed: false,
    doneCount: 0,
    eventCount: 0,
    ignoredAfterDone: 0,
    diagnostics: [],
  };
}

function processSubagentProtocolLine(state: SubagentProtocolState, line: string): SubagentProtocolMessage[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  const bytes = byteLength(trimmed);
  if (bytes > MAX_SUBAGENT_PROTOCOL_LINE_BYTES) {
    recordDiagnostic(state, { kind: "oversized_line", bytes });
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    recordDiagnostic(state, { kind: "malformed_line", bytes });
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    recordDiagnostic(state, { kind: "invalid_event" });
    return [];
  }
  const message = parsed as Record<string, unknown>;
  const event = typeof message.event === "string" ? message.event : "";
  if (!event) {
    recordDiagnostic(state, { kind: "invalid_event" });
    return [];
  }

  if (event === "done") {
    state.doneCount++;
    if (state.finalResponse) {
      recordDiagnostic(state, { kind: "duplicate_done", event });
      return [];
    }
    state.finalResponse = {
      ok: message.ok === true,
      result: message.result,
      error: typeof message.error === "string" ? message.error : "",
    };
    state.eventCount++;
    return [message as SubagentProtocolMessage];
  }

  if (state.finalResponse) {
    state.ignoredAfterDone++;
    recordDiagnostic(state, { kind: "event_after_done", event: boundedCause(event) });
    return [];
  }

  state.eventCount++;
  return [message as SubagentProtocolMessage];
}

export function appendSubagentProtocolChunk(state: SubagentProtocolState, chunk: string | Uint8Array): SubagentProtocolMessage[] {
  if (state.closed || !chunk || (typeof chunk !== "string" && chunk.byteLength === 0)) return [];
  const decoded = appendUtf8LineChunk(state.buffer, state.decoder, chunk);
  state.decoder = decoded.decoder;
  let lines = decoded.lines;
  if (state.discardingOversizeLine) {
    if (!lines.length) {
      state.buffer = "";
      return [];
    }
    lines = lines.slice(1);
    state.discardingOversizeLine = false;
  }

  const events = lines.flatMap((line) => processSubagentProtocolLine(state, line));
  state.buffer = decoded.buffer;
  if (byteLength(state.buffer) > MAX_SUBAGENT_PROTOCOL_LINE_BYTES) {
    recordDiagnostic(state, { kind: "oversized_line", bytes: byteLength(state.buffer) });
    state.buffer = "";
    state.discardingOversizeLine = true;
  }
  return events;
}

export function finishSubagentProtocolStream(state: SubagentProtocolState): SubagentProtocolFinishResult {
  if (state.closed) return { events: [], finalResponse: state.finalResponse, error: state.error };
  state.closed = true;
  const decoded = flushUtf8LineChunk(state.buffer, state.decoder);
  state.buffer = "";
  state.decoder = undefined;
  let events: SubagentProtocolMessage[] = [];
  if (!state.discardingOversizeLine) {
    events = decoded.lines.flatMap((line) => processSubagentProtocolLine(state, line));
  }
  state.discardingOversizeLine = false;
  if (!state.finalResponse) state.error = "stream ended without final done event";
  return { events, finalResponse: state.finalResponse, error: state.error };
}

export function abortSubagentProtocolStream(state: SubagentProtocolState, cause: string): SubagentProtocolFinishResult {
  if (!state.closed) {
    state.closed = true;
    state.buffer = "";
    state.decoder = undefined;
    state.discardingOversizeLine = false;
    const safeCause = boundedCause(cause) ?? "cancelled";
    state.error = `stream aborted: ${safeCause}`;
    recordDiagnostic(state, { kind: "aborted", cause: safeCause });
  }
  return { events: [], finalResponse: state.finalResponse, error: state.error };
}

export function subagentProtocolSnapshot(state: SubagentProtocolState) {
  return {
    closed: state.closed,
    doneCount: state.doneCount,
    eventCount: state.eventCount,
    ignoredAfterDone: state.ignoredAfterDone,
    finalResponse: state.finalResponse ? { ...state.finalResponse } : undefined,
    diagnostics: state.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    error: state.error,
  };
}
