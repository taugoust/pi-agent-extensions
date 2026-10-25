import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";
import { truncateUtf8 } from "../shared/harness-readonly.ts";

export type ConversationMessage = { id: string; role: "user" | "assistant" | "tool" | "parent"; text: string; truncated?: boolean };
const clean = (text: string) => text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
  .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

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

/** Read a bounded page of an already owner-validated worker session. Never starts or resumes it. */
export function readRetainedConversation(path: string, cursor = 0) {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid conversation cursor");
  const { fd, stat } = openValidatedConversation(path);
  try {
    if (cursor > stat.size) throw new Error("Conversation file unavailable");
    const bytes = Buffer.alloc(Math.min(256 * 1024, stat.size - cursor));
    const length = readSync(fd, bytes, 0, bytes.length, cursor);
    if (!length && cursor < stat.size) throw new Error("Conversation changed while reading");
    const lastNewline = bytes.subarray(0, length).lastIndexOf(10);
    const end = cursor + length < stat.size && lastNewline >= 0 ? lastNewline + 1 : length;
    const messages: ConversationMessage[] = [];
    let offset = 0, budget = 24 * 1024, truncated = false;
    while (offset < end && messages.length < 50) {
      const newline = bytes.indexOf(10, offset);
      const lineEnd = newline >= 0 && newline < end ? newline : end;
      const next = Math.min(lineEnd + 1, end);
      let entry: any;
      try { entry = JSON.parse(bytes.subarray(offset, lineEnd).toString("utf8")); }
      catch { truncated = true; offset = next; continue; }
      const custom = entry.type === "custom_message" && ["harness-control", "harness-user-control"].includes(entry.customType);
      const message = custom ? entry : entry.type === "message" ? entry.message : undefined;
      const role = custom ? entry.customType === "harness-user-control" ? "user" : "parent"
        : message?.role === "toolResult" ? "tool" : message?.role;
      if (!message || !["user", "assistant", "tool", "parent"].includes(role)) { offset = next; continue; }
      const content = message.content;
      let text = typeof content === "string" ? content : Array.isArray(content) ? content.flatMap((part: any) => {
        if (part?.type === "text" && typeof part.text === "string") return [part.text];
        if (part?.type === "toolCall") return [`Tool call: ${String(part.name ?? "tool")}\n${JSON.stringify(part.arguments ?? {})}`];
        if (part?.type === "image") return ["[Image]"];
        return []; // Do not expose thinking blocks or private non-message records.
      }).join("\n\n") : "";
      text = clean(text);
      if (!text) { offset = next; continue; }
      const record: ConversationMessage = { id: `${cursor + offset}:${String(entry.id ?? "").slice(0, 64)}`, role, text };
      let size = Buffer.byteLength(JSON.stringify(record));
      if (size > budget && messages.length) break;
      if (size > budget) {
        record.text = truncateUtf8(text, Math.max(1, Math.floor((budget - 512) / 2))).text;
        record.truncated = true;
        truncated = true;
        size = Buffer.byteLength(JSON.stringify(record));
      }
      messages.push(record);
      budget -= size;
      offset = next;
      if (budget < 1024) break;
    }
    return { messages, truncated, lastUpdated: stat.mtime.toISOString(),
      ...(cursor + offset < stat.size ? { nextCursor: cursor + offset } : {}) };
  } finally { closeSync(fd); }
}
