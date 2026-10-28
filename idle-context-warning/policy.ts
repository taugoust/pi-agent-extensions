export type Config = { idleMinutes: number; contextPercent: number; cheapCompactionModel?: unknown; guardedModels?: unknown };

// Use persisted model responses, not process uptime, user input, tools, cache
// warming, or compaction entries. This also works after reload/resume/fork.
export function lastModelActivity(branch: any[]): number | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "message" || entry.message?.role !== "assistant" || !entry.message?.model) continue;
    // Failed routing produces an assistant error too. It must not warm the
    // idle clock (nor may provider errors or cancelled requests).
    if (entry.message.stopReason === "error" || entry.message.stopReason === "aborted") continue;
    const timestamp = Number(entry.message.timestamp ?? Date.parse(entry.timestamp));
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return undefined;
}

export function isIdle(idleAt: number | undefined, now: number, idleMinutes: number): boolean {
  return idleAt !== undefined && now - idleAt >= idleMinutes * 60_000;
}

// Presentation only: admission and compaction remain owned by their callers.
export function warningTitle(model: string, idleAt: number, now: number, usage: { tokens: number | null; contextWindow: number; percent: number }): string {
  const minutes = Math.floor((now - idleAt) / 60_000);
  const percentage = Math.round(usage.percent);
  const tokens = usage.tokens == null ? "unknown" : Math.round(usage.tokens).toLocaleString();
  const window = usage.contextWindow.toLocaleString();
  return `Model: ${model}\nLast model response: ${minutes} minutes ago\nContext: ${tokens} / ${window} tokens (${percentage}%). The model cache may have expired.`;
}

export function shouldWarn(idleAt: number | undefined, now: number, percent: number | null | undefined, settings: Config): boolean {
  return isIdle(idleAt, now, settings.idleMinutes) && percent != null && Number.isFinite(percent) && percent >= settings.contextPercent;
}
