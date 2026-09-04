export const MAX_RETAINED_SUBAGENT_REPORT_BYTES = 16 * 1024 * 1024;
export const MAX_RETAINED_SUBAGENT_JOB_BYTES = 32 * 1024 * 1024;
// Reserve 2 KiB of the 50 KiB parent response budget for page metadata and continuation guidance.
export const MAX_SUBAGENT_RESULT_PAGE_BYTES = 48 * 1024;

export type RetainedSubagentReport = {
  /** Stable one-based child ordinal. Optional only for legacy/single reports. */
  child?: number;
  /** Stable opaque child identity. Optional for legacy reports. */
  childId?: string;
  label: string;
  text: string;
  totalBytes?: number;
  complete?: boolean;
};

const RETAINED_REPORTS = Symbol.for("pi-agent-extensions.retained-subagent-reports.v1");

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function stripTerminalControls(value: string): string {
  let visible = "";
  for (let index = 0; index < value.length;) {
    const code = value.charCodeAt(index);
    if (code === 0x1b) {
      const kind = value[index + 1];
      if (kind === "[") {
        index += 2;
        while (index < value.length && !(value.charCodeAt(index) >= 0x40 && value.charCodeAt(index) <= 0x7e)) index++;
        index = Math.min(value.length, index + 1);
      } else if (kind === "]") {
        index += 2;
        while (index < value.length && value.charCodeAt(index) !== 0x07 && !(value.charCodeAt(index) === 0x1b && value[index + 1] === "\\")) index++;
        index = Math.min(value.length, index + (value.charCodeAt(index) === 0x1b ? 2 : 1));
      } else {
        index = Math.min(value.length, index + 2);
      }
      continue;
    }
    if ((code < 0x20 && code !== 0x0a && code !== 0x0d && code !== 0x09) || code === 0x7f) {
      index++;
      continue;
    }
    visible += value[index++];
  }
  return visible;
}

function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  return stripTerminalControls(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|passwd|secret)\b\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/g, "[private key redacted]")
    .trim();
}

function assistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as any;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter((part: any) => part?.type === "text")
      .map((part: any) => String(part.text ?? ""))
      .join("");
    if (text.trim()) return text;
  }
  return "";
}

export function extractRetainedSubagentReports(source: unknown): RetainedSubagentReport[] {
  const object = source && typeof source === "object" ? source as any : undefined;
  const symbolReports = object?.[RETAINED_REPORTS];
  if (Array.isArray(symbolReports)) return symbolReports.map((report: any) => ({
    ...(Number.isSafeInteger(report.child) && report.child >= 1 && report.child <= 8 ? { child: report.child } : {}),
    ...(typeof report.childId === "string" && /^subagent-child-[0-9a-f]{24}$/.test(report.childId) ? { childId: report.childId } : {}),
    label: String(report.label),
    text: String(report.text),
    ...(Number.isSafeInteger(report.totalBytes) ? { totalBytes: report.totalBytes } : {}),
    ...(typeof report.complete === "boolean" ? { complete: report.complete } : {}),
  }));

  const details = object?.details && typeof object.details === "object" ? object.details : object;
  const results = Array.isArray(details?.results) ? details.results : [];
  const reports = results.map((result: any, index: number) => {
    const label = cleanText(result?.label) || `result ${index + 1}`;
    const rawText = typeof result?.final === "string" && result.final.trim()
      ? result.final
      : assistantText(result?.messages) || result?.errorMessage || result?.error || result?.terminal?.message || "(no visible terminal report)";
    const text = cleanText(rawText) || "(no visible terminal report)";
    const visibleBytes = Buffer.byteLength(text, "utf8");
    const rawBytes = Buffer.byteLength(String(rawText), "utf8");
    const declaredTotal = Number(result?.final_total_bytes ?? result?.finalTotalBytes);
    const declaredTruncated = result?.final_truncated === true || result?.finalTruncated === true;
    const totalBytes = declaredTruncated && Number.isSafeInteger(declaredTotal) && declaredTotal > rawBytes ? declaredTotal : visibleBytes;
    const explicitChild = Number.isSafeInteger(result?.child) ? Number(result.child)
      : Number.isSafeInteger(result?.step) ? Number(result.step)
        : undefined;
    const childId = typeof result?.child_id === "string" && /^subagent-child-[0-9a-f]{24}$/.test(result.child_id)
      ? result.child_id
      : undefined;
    return {
      ...(explicitChild !== undefined && explicitChild >= 1 && explicitChild <= 8 ? { child: explicitChild } : {}),
      ...(childId ? { childId } : {}),
      label,
      text,
      totalBytes,
      complete: visibleBytes >= totalBytes,
    };
  });
  if (reports.length > 0) return reports;

  const content = Array.isArray(object?.content)
    ? object.content.filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("\n")
    : "";
  const fallback = cleanText(content || details?.final || details?.summary);
  return fallback ? [{ label: "result", text: fallback }] : [];
}

/** Keep complete reports available to the in-process background adopter without serializing them into Pi details. */
export function attachRetainedReports<T extends object>(target: T, reports: RetainedSubagentReport[]): T {
  if (reports.length > 0) Object.defineProperty(target, RETAINED_REPORTS, { value: reports, enumerable: false });
  return target;
}

export function attachRetainedSubagentReports<T extends object>(target: T, rawResult: unknown): T {
  return attachRetainedReports(target, extractRetainedSubagentReports(rawResult));
}

export function formatRemoteSubagentArtifactHints(results: unknown, truncate: (value: string, maximum: number) => string): string {
  if (!Array.isArray(results)) return "";
  const hints = results.flatMap((child: any) => {
    const label = cleanText(child?.label) || "subagent";
    const path = typeof child?.fullResultPath === "string" ? child.fullResultPath : "";
    if (path) {
      const bytes = Number.isFinite(Number(child?.artifactBytes)) ? Number(child.artifactBytes) : 0;
      const total = Number.isFinite(Number(child?.finalTotalBytes)) ? Number(child.finalTotalBytes) : 0;
      const completeness = child?.artifactComplete === false && total
        ? ` (${formatBytes(bytes)} of ${formatBytes(total)} retained)`
        : "";
      return [`Full subagent result [${label}]: ${path}${completeness}`];
    }
    if (typeof child?.artifactError === "string" && child.artifactError) {
      return [`Subagent result artifact unavailable [${label}]: ${cleanText(child.artifactError)}`];
    }
    return [];
  });
  return truncate(hints.join("\n"), 4 * 1024);
}
