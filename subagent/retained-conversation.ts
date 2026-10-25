import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";
import { truncateUtf8 } from "../shared/harness-readonly.ts";

export type ConversationToolCall = { type: "toolCall"; id: string; name: string; arguments: unknown; status?: "completed" | "failed" | "unknown"; result?: string };
export type ConversationMessage = {
  id: string; role: "user" | "assistant" | "tool" | "parent"; text: string; truncated?: boolean;
  parts?: Array<{ type: "text"; text: string } | ConversationToolCall>;
  toolCallId?: string; toolName?: string; status?: "completed" | "failed" | "unknown";
};
const PAGE_BYTES = 256 * 1024;
const MAX_MESSAGES = 50;
const MAX_RESPONSE_BYTES = 24 * 1024;
const MAX_RESULT_BYTES = 2048;
const clean = (text: string) => text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
  .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
function contentText(content: unknown, maximum = MAX_RESULT_BYTES): string {
  const text = typeof content === "string" ? content : Array.isArray(content)
    ? content.flatMap((part: any) => part?.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n") : "";
  return truncateUtf8(clean(text), maximum).text;
}
function resultStatus(message: any): "completed" | "failed" { return message?.isError === true ? "failed" : "completed"; }

/** Correlate structured results beyond a page boundary; never infer a status from missing text. */
function collectFollowingToolResults(fd: number, start: number, size: number, pending: Set<string>, statuses: Map<string, "completed" | "failed">, results: Map<string, string>): void {
  if (!pending.size || start >= size) return;
  const length = Math.min(PAGE_BYTES, size - start);
  const bytes = Buffer.alloc(length);
  const read = readSync(fd, bytes, 0, length, start);
  let offset = 0;
  while (offset < read && pending.size) {
    const newline = bytes.indexOf(10, offset);
    if (newline < 0) break;
    if (newline - offset <= 64 * 1024) {
      try {
        const entry = JSON.parse(bytes.subarray(offset, newline).toString("utf8"));
        const message = entry?.type === "message" ? entry.message : undefined;
        if (message?.role === "toolResult" && typeof message.toolCallId === "string" && pending.delete(message.toolCallId)) {
          statuses.set(message.toolCallId, resultStatus(message));
          results.set(message.toolCallId, contentText(message.content));
        }
      } catch { /* Malformed or oversized rows cannot authorize a tool status. */ }
    }
    offset = newline + 1;
  }
}

/** Open only a private, bounded, single-link regular session file beneath a private directory. */
function openValidatedConversation(path: string) {
  const directory = lstatSync(dirname(path));
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700
    || (typeof process.getuid === "function" && directory.uid !== process.getuid())) throw new Error("Conversation directory unavailable");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (typeof process.getuid === "function" && stat.uid !== process.getuid())
      || (stat.mode & 0o077) !== 0 || stat.nlink !== 1 || stat.size > 32 * 1024 * 1024) throw new Error("Conversation file unavailable");
    return { fd, stat };
  } catch (error) { closeSync(fd); throw error; }
}

/** Lightweight validation for bridge session references; does not parse/read session contents. */
export function validateRetainedConversationFile(path: string): void {
  const { fd } = openValidatedConversation(path);
  closeSync(fd);
}

/** Read the newest bounded page by default; cursor is the exclusive end of an explicit older page. */
export function readRetainedConversation(path: string, cursor?: number) {
  if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) throw new Error("Invalid conversation cursor");
  const { fd, stat } = openValidatedConversation(path);
  try {
    const end = cursor ?? stat.size;
    if (end > stat.size) throw new Error("Conversation file unavailable");
    const windowStart = Math.max(0, end - PAGE_BYTES);
    const bytes = Buffer.alloc(end - windowStart);
    const length = readSync(fd, bytes, 0, bytes.length, windowStart);
    if (!length && end > 0) throw new Error("Conversation changed while reading");
    const lastNewline = bytes.subarray(0, length).lastIndexOf(10);
    const completeEnd = lastNewline < 0 ? 0 : lastNewline + 1;
    let firstComplete = 0;
    if (windowStart > 0) {
      const firstNewline = bytes.indexOf(10, 0);
      firstComplete = firstNewline < 0 ? completeEnd : firstNewline + 1;
    }
    const olderCursor = windowStart + firstComplete;
    const messages: ConversationMessage[] = [];
    const toolStatuses = new Map<string, "completed" | "failed">();
    const toolResults = new Map<string, string>();
    let offset = firstComplete, truncated = windowStart > 0 || completeEnd < length;
    while (offset < completeEnd) {
      const newline = bytes.indexOf(10, offset);
      if (newline < 0 || newline >= completeEnd) break;
      const lineEnd = newline;
      const next = newline + 1;
      if (lineEnd - offset <= 64 * 1024) {
        let entry: any;
        try { entry = JSON.parse(bytes.subarray(offset, lineEnd).toString("utf8")); }
        catch { truncated = true; offset = next; continue; }
        const custom = entry.type === "custom_message" && ["harness-control", "harness-user-control"].includes(entry.customType);
        const message = custom ? entry : entry.type === "message" ? entry.message : undefined;
        const role = custom ? entry.customType === "harness-user-control" ? "user" : "parent"
          : message?.role === "toolResult" ? "tool" : message?.role;
        if (message && ["user", "assistant", "tool", "parent"].includes(role)) {
          const parts: NonNullable<ConversationMessage["parts"]> = [];
          const content = message.content;
          const text = typeof content === "string" ? clean(content) : Array.isArray(content) ? content.flatMap((part: any) => {
            if (part?.type === "text" && typeof part.text === "string") return [clean(part.text).slice(0, 8192)];
            if (part?.type === "toolCall" && typeof part.id === "string" && part.id.length > 0 && part.id.length <= 128 && typeof part.name === "string" && part.name.length > 0 && part.name.length <= 128) {
              if (parts.filter(item => item.type === "toolCall").length >= 4) return [];
              let args: unknown = part.arguments ?? {};
              try { if (Buffer.byteLength(JSON.stringify(args)) > 1024) args = { truncated: true, preview: Buffer.from(JSON.stringify(args)).subarray(0, 900).toString("utf8") }; } catch { args = "[unavailable]"; }
              parts.push({ type: "toolCall", id: part.id, name: part.name, arguments: args, status: "unknown" }); return [];
            }
            if (part?.type === "image") return ["[Image]"];
            return [];
          }).join("\n\n") : "";
          const safeText = truncateUtf8(clean(text), 8192).text;
          const resultId = role === "tool" && typeof message.toolCallId === "string" && message.toolCallId.length > 0 && message.toolCallId.length <= 128 ? message.toolCallId : undefined;
          if (resultId) {
            const status = resultStatus(message);
            toolStatuses.set(resultId, status);
            toolResults.set(resultId, contentText(content));
          }
          if (text || parts.length || role === "tool") messages.push({
            id: `${windowStart + offset}:${String(entry.id ?? "").slice(0, 64)}`, role, text: role === "tool" ? contentText(content) : safeText,
            ...(parts.length ? { parts } : {}),
            ...(resultId ? { toolCallId: resultId, toolName: typeof message.toolName === "string" ? message.toolName.slice(0, 128) : "tool",
              status: resultStatus(message) } : {}),
            ...(role === "tool" && !resultId ? { status: "unknown" as const } : {}),
          });
        }
      } else truncated = true;
      offset = next;
    }

    const pageMessages = messages.slice(-MAX_MESSAGES);
    let olderBoundary = olderCursor;
    if (messages.length > MAX_MESSAGES && pageMessages.length) olderBoundary = Number(pageMessages[0]!.id.slice(0, pageMessages[0]!.id.indexOf(":")));
    const pendingToolCalls = new Set(pageMessages.flatMap(message => (message.parts ?? []).flatMap(part => part.type === "toolCall" && !toolStatuses.has(part.id) ? [part.id] : [])));
    const readEnd = windowStart + completeEnd;
    collectFollowingToolResults(fd, readEnd, stat.size, pendingToolCalls, toolStatuses, toolResults);
    for (const message of pageMessages) for (const part of message.parts ?? []) if (part.type === "toolCall") {
      part.status = toolStatuses.get(part.id) ?? "unknown";
      const result = toolResults.get(part.id);
      if (result) part.result = result;
    }

    const selected: ConversationMessage[] = [];
    let budget = MAX_RESPONSE_BYTES - 2; // Include the serialized array brackets and commas.
    for (let index = pageMessages.length - 1; index >= 0; index--) {
      const message = pageMessages[index]!;
      const size = Buffer.byteLength(JSON.stringify(message)) + (selected.length ? 1 : 0);
      if (size <= budget) { selected.push(message); budget -= size; continue; }
      if (!selected.length) {
        message.truncated = true;
        // Measure JSON, not just text bytes: escaped strings and structured
        // arguments/results also count toward the wire budget.
        while (Buffer.byteLength(JSON.stringify(message)) > budget) {
          if (message.text) {
            message.text = truncateUtf8(message.text, Math.floor(Buffer.byteLength(message.text) / 2)).text;
            continue;
          }
          const result = message.parts?.find(part => part.type === "toolCall" && part.result);
          if (result?.type === "toolCall" && result.result) {
            result.result = truncateUtf8(result.result, Math.floor(Buffer.byteLength(result.result) / 2)).text;
            continue;
          }
          const args = message.parts?.find(part => part.type === "toolCall" && JSON.stringify(part.arguments) !== "{}");
          if (args?.type === "toolCall") { args.arguments = {}; continue; }
          if (message.parts?.length) { message.parts.pop(); continue; }
          throw new Error("Conversation record exceeds response budget");
        }
        selected.push(message);
        truncated = true;
      }
      break;
    }
    selected.reverse();
    if (selected.length && selected.length < pageMessages.length) {
      const boundary = Number(selected[0]!.id.slice(0, selected[0]!.id.indexOf(":")));
      if (Number.isSafeInteger(boundary)) olderBoundary = boundary;
    }
    if (messages.length > MAX_MESSAGES || selected.length < pageMessages.length) truncated = true;
    return { messages: selected, truncated, lastUpdated: stat.mtime.toISOString(),
      ...(olderBoundary > 0 ? { nextCursor: olderBoundary } : {}) };
  } finally { closeSync(fd); }
}
