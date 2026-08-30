const DEFAULT_MAX_PARALLEL_RESULT_BYTES = 50 * 1024;

export type ParallelResultSection = {
  label: string;
  status: "completed" | "failed";
  output: string;
};

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateUTF8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (byteLength(value) <= maxBytes) return value;
  const marker = `\n\n… truncated (${byteLength(value)}B total)`;
  const contentBudget = Math.max(0, maxBytes - byteLength(marker));
  const bytes = Buffer.from(value, "utf8");
  let end = Math.min(contentBudget, bytes.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    try {
      return `${decoder.decode(bytes.subarray(0, end))}${marker}`;
    } catch {
      end--;
    }
  }
  return marker.slice(-maxBytes);
}

/**
 * Preserve useful output from every parallel child within one bounded tool
 * result. A single verbose child must not crowd later children out entirely.
 */
export function formatParallelResultContent(
  sections: ParallelResultSection[],
  successCount: number,
  maxBytes = DEFAULT_MAX_PARALLEL_RESULT_BYTES,
): string {
  const header = `Parallel: ${successCount}/${sections.length} succeeded`;
  if (sections.length === 0) return header;

  const labels = sections.map((section) => `[${section.label}] ${section.status}:\n`);
  const fixedBytes = byteLength(header) + byteLength("\n\n") * sections.length + labels.reduce((sum, label) => sum + byteLength(label), 0);
  const perChildBudget = Math.max(256, Math.floor(Math.max(0, maxBytes - fixedBytes) / sections.length));
  const rendered = sections.map((section, index) => `${labels[index]}${truncateUTF8(section.output || "(no output)", perChildBudget)}`);
  return truncateUTF8(`${header}\n\n${rendered.join("\n\n")}`, maxBytes);
}
