/** Normalize typed tool transports before clipping. A string is always literal
 * output: content that happens to resemble a transport is not evidence of one.
 * Presentation metadata travels separately from the text to the client. */
import { truncateUtf8 } from "./harness-readonly.ts";
const LIMIT = 64 * 1024;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function clean(text: string): string {
  return text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
function bounded(text: string, maximum = LIMIT): string {
  const value = clean(text), marker = "\n[truncated]";
  return Buffer.byteLength(value) <= maximum ? value : truncateUtf8(value, maximum - marker.length).text + marker;
}
function media(block: Record<string, unknown>): boolean {
  return typeof block.type === "string" &&
    (["image", "image_url", "audio", "resource", "resource_link"].includes(block.type) ||
      typeof block.mimeType === "string" && typeof block.data === "string");
}
function envelope(value: unknown): value is Record<string, unknown> {
  if (!record(value)) return false;
  if (value.type === "tool_result" || value.type === "toolResult") return "content" in value;
  if (Object.keys(value).some(k => !["content", "structuredContent", "isError", "_meta", "details"].includes(k))) return false;
  if (value.isError !== undefined && typeof value.isError !== "boolean") return false;
  return Array.isArray(value.content) || typeof value.content === "string" || value.structuredContent !== undefined;
}
export function normalizedToolResultText(input: unknown): string {
  function decode(value: unknown, depth: number): string {
    if (depth >= 6) return "[tool output nesting limit]";
    if (typeof value === "string") return bounded(value);
    if (!envelope(value)) {
      if (record(value) && media(value)) return `[unsupported content: ${bounded(String(value.type), 128)}]`;
      try { return bounded(JSON.stringify(value ?? "") ?? ""); } catch { return "[unavailable tool output]"; }
    }
    let output = "";
    if (Array.isArray(value.content)) {
      output = value.content.slice(0, 128).map(block => {
        if (!record(block)) return "[unsupported content]";
        if (block.type === "text" && typeof block.text === "string") return bounded(block.text);
        if (block.type === "resource" && record(block.resource) && typeof block.resource.text === "string") return bounded(block.resource.text);
        if (block.type === "resource_link" && typeof block.uri === "string") return bounded(`${typeof block.name === "string" ? block.name + ": " : ""}${block.uri}`);
        if (envelope(block)) return decode(block, depth + 1);
        return `[unsupported content${typeof block.type === "string" ? `: ${bounded(block.type, 128)}` : ""}]`;
      }).join("\n");
      if (value.content.length > 128) output += "\n[truncated]";
    } else if ("content" in value) output = decode(value.content, depth + 1);
    // structuredContent is application data, not another transport position.
    if (!output && value.structuredContent !== undefined) {
      output = typeof value.structuredContent === "string" ? bounded(value.structuredContent)
        : bounded(JSON.stringify(value.structuredContent) ?? "");
    }
    return bounded((value.isError === true ? "[tool error]\n" : "") + output);
  }
  try { return decode(input, 0); } catch { return "[unavailable tool output]"; }
}
export type BoundedToolResult = string | { truncated: true; normalized: true; preview: string };
/** Bound the serialized DTO, including escaping and truncation metadata. */
export function boundedToolResult(input: unknown, maximum = 2048): BoundedToolResult {
  if (!Number.isSafeInteger(maximum) || maximum < 128 || maximum > LIMIT) throw new Error("Invalid tool result byte budget");
  const text = normalizedToolResultText(input);
  if (Buffer.byteLength(JSON.stringify(text)) <= maximum) return text;
  let preview = truncateUtf8(text, maximum - 96).text;
  while (Buffer.byteLength(JSON.stringify({ truncated: true, normalized: true, preview })) > maximum) {
    preview = truncateUtf8(preview, Math.floor(Buffer.byteLength(preview) / 2)).text;
  }
  return { truncated: true, normalized: true, preview };
}
export function boundedToolResultText(input: unknown, maximum = 2048): string {
  if (!Number.isSafeInteger(maximum) || maximum < 128 || maximum > LIMIT) throw new Error("Invalid tool result byte budget");
  return bounded(normalizedToolResultText(input), maximum);
}
