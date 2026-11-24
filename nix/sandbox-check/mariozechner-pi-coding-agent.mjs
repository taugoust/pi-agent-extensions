export const DEFAULT_MAX_BYTES = 50 * 1024;
export const DEFAULT_MAX_LINES = 2000;
export function formatSize(bytes) {
  if (bytes < 1024) return String(bytes) + "B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "KB";
  return (bytes / (1024 * 1024)).toFixed(1) + "MB";
}
export function getMarkdownTheme() {
  return {};
}
export function getAgentDir() {
  return process.env.PI_TEST_AGENT_DIR || "/tmp/pi-test-agent";
}
// Background API fixtures must not open a real session.
export class SessionManager {
  static open() {
    throw new Error("SessionManager.open is unavailable in the offline fixture");
  }
}
export function truncateHead(value, options = {}) {
  const text = String(value);
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const lines = text.split("\n");
  const totalBytes = Buffer.byteLength(text);
  if (lines.length <= maxLines && totalBytes <= maxBytes) {
    return {
      content: text,
      truncated: false,
      truncatedBy: null,
      totalLines: lines.length,
      totalBytes,
      outputLines: lines.length,
      outputBytes: totalBytes,
      maxLines,
      maxBytes,
      firstLineExceedsLimit: false,
    };
  }
  if (Buffer.byteLength(lines[0]) > maxBytes) {
    return {
      content: "",
      truncated: true,
      truncatedBy: "bytes",
      totalLines: lines.length,
      totalBytes,
      outputLines: 0,
      outputBytes: 0,
      maxLines,
      maxBytes,
      firstLineExceedsLimit: true,
    };
  }
  const selected = [];
  let selectedBytes = 0;
  for (let index = 0; index < lines.length && selected.length < maxLines; index++) {
    const lineBytes = Buffer.byteLength(lines[index]) + (selected.length ? 1 : 0);
    if (selectedBytes + lineBytes > maxBytes) break;
    selected.push(lines[index]);
    selectedBytes += lineBytes;
  }
  const content = selected.join("\n");
  return {
    content,
    truncated: true,
    truncatedBy: selected.length >= maxLines ? "lines" : "bytes",
    totalLines: lines.length,
    totalBytes,
    outputLines: selected.length,
    outputBytes: Buffer.byteLength(content),
    maxLines,
    maxBytes,
    firstLineExceedsLimit: false,
  };
}
export function truncateTail(value, options = {}) {
  const text = String(value);
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const lines = text.split("\n");
  const totalBytes = Buffer.byteLength(text);
  if (lines.length <= maxLines && totalBytes <= maxBytes) {
    return {
      content: text,
      truncated: false,
      truncatedBy: null,
      totalLines: lines.length,
      totalBytes,
      outputLines: lines.length,
      outputBytes: totalBytes,
      maxLines,
      maxBytes,
      lastLinePartial: false,
    };
  }
  const selected = [];
  let selectedBytes = 0;
  let lastLinePartial = false;
  let truncatedBy = lines.length > maxLines ? "lines" : "bytes";
  for (let index = lines.length - 1; index >= 0 && selected.length < maxLines; index--) {
    const line = lines[index];
    const lineBytes = Buffer.byteLength(line) + (selected.length ? 1 : 0);
    if (selectedBytes + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      if (selected.length === 0) {
        const bytes = Buffer.from(line);
        let start = Math.max(0, bytes.length - maxBytes);
        while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
        selected.unshift(bytes.subarray(start).toString("utf8"));
        selectedBytes = Buffer.byteLength(selected[0]);
        lastLinePartial = true;
      }
      break;
    }
    selected.unshift(line);
    selectedBytes += lineBytes;
  }
  const content = selected.join("\n");
  return {
    content,
    truncated: true,
    truncatedBy,
    totalLines: lines.length,
    totalBytes,
    outputLines: selected.length,
    outputBytes: Buffer.byteLength(content),
    maxLines,
    maxBytes,
    lastLinePartial,
  };
}
export function renderDiff(text) {
  return String(text);
}
