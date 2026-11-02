export const MAX_COMPLETION_SUMMARY_LENGTH = 4_000;
const CONTRADICTORY_COMPLETION_PATTERNS = [
  /(?<!could\s)\bnot\s+(?:yet\s+)?(?:complete|completed|done|finished)\b/i,
  /\bstill\s+(?:incomplete|failing|failing\s+tests?|fails?)\b/i,
  /\btests?\s+(?:still\s+)?fail(?:ing)?\b/i,
] as const;
export function isContradictoryCompletionSummary(summary: string) {
  return CONTRADICTORY_COMPLETION_PATTERNS.some(pattern => pattern.test(summary));
}
export function completionSummaryRejection(summary: string): string | undefined {
  return !summary ? 'summary is empty' : summary.length > MAX_COMPLETION_SUMMARY_LENGTH
    ? 'summary is too long' : isContradictoryCompletionSummary(summary)
      ? 'summary says the goal is not complete' : undefined;
}
