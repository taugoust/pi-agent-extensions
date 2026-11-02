/** SDK-free canonical checklist validation. Legacy progress transports re-export it. */
export const MAX_PROGRESS_STEPS = 50;
export const MAX_PROGRESS_TEXT_LENGTH = 503;
export const PROGRESS_STATUSES = ["pending", "in_progress", "completed", "blocked"] as const;
export type ProgressStatus = (typeof PROGRESS_STATUSES)[number];
export interface ProgressStep { id?: string; text: string; status: ProgressStatus }

export function validateProgressArguments(value: unknown): { steps: ProgressStep[]; goal_id?: string | null } {
  if (!isRecord(value) || !hasOnlyKeys(value, ["steps", "goal_id"])) reject("input must contain steps and optional goal_id.");
  if (value.goal_id !== undefined && value.goal_id !== null && (typeof value.goal_id !== "string" || !value.goal_id.trim() || value.goal_id.length > 128)) reject("goal_id must be the exact current goal ID or null.");
  if (!Array.isArray(value.steps)) reject("steps must be an array.");
  if (value.steps.length > MAX_PROGRESS_STEPS) reject(`steps contains ${value.steps.length} items; the maximum is ${MAX_PROGRESS_STEPS}.`);
  const steps: ProgressStep[] = [];
  for (const [index, entry] of value.steps.entries()) {
    const item = index + 1;
    if (!isRecord(entry)) reject(`item ${item} must be an object.`);
    if (!hasOnlyKeys(entry, ["text", "status", "id"])) reject(`item ${item} contains an unsupported field.`);
    if (typeof entry.text !== "string") reject(`item ${item} text must be a string.`);
    if (!entry.text.trim()) reject(`item ${item} text must contain non-whitespace text.`);
    if (!hasMaxGraphemeLength(entry.text, MAX_PROGRESS_TEXT_LENGTH)) reject(`item ${item} text exceeds ${MAX_PROGRESS_TEXT_LENGTH} characters.`);
    if (!PROGRESS_STATUSES.includes(entry.status as ProgressStatus)) reject(`item ${item} status must be pending, in_progress, completed, or blocked.`);
    if (entry.id !== undefined && (typeof entry.id !== "string" || !entry.id.trim() || entry.id.length > 128)) reject(`item ${item} has an invalid task id.`);
    steps.push({ text: entry.text, status: entry.status as ProgressStatus, ...(entry.id !== undefined ? { id: entry.id as string } : {}) });
  }
  return { steps, ...(value.goal_id !== undefined ? { goal_id: value.goal_id as string | null } : {}) };
}
function reject(message: string): never { throw new Error(`Progress update rejected: ${message} Fix the input and retry with the current goal identity and revision.`); }
function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]) { return Object.keys(record).every(key => allowed.includes(key)) && allowed.some(key => Object.hasOwn(record, key)); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

// Preserve historical cluster counting for legacy decoding as well as new input.
export function hasMaxGraphemeLength(value: string, maximum: number): boolean {
  let count = 0, index = 0;
  while (index < value.length) {
    index = nextGraphemeClusterIndex(value, index);
    if (++count > maximum) return false;
  }
  return true;
}
function nextGraphemeClusterIndex(value: string, clusterStart: number): number {
  const start = value.codePointAt(clusterStart) ?? 0;
  let clusterEnd = consumeGraphemeModifiers(value, clusterStart + codePointLength(start));
  while (clusterEnd < value.length - 1 && value.codePointAt(clusterEnd) === 0x200d) {
    clusterEnd += 1 + codePointLength(value.codePointAt(clusterEnd + 1) ?? 0);
    clusterEnd = consumeGraphemeModifiers(value, clusterEnd);
  }
  if (isBetween(start, 0x1f1e6, 0x1f1ff) && clusterEnd < value.length && isBetween(value.codePointAt(clusterEnd) ?? 0, 0x1f1e6, 0x1f1ff)) clusterEnd += codePointLength(value.codePointAt(clusterEnd) ?? 0);
  return clusterEnd;
}
function consumeGraphemeModifiers(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const point = value.codePointAt(index) ?? 0;
    if (!isCombiningMark(point) && !isBetween(point, 0xfe00, 0xfe0f)) break;
    index += codePointLength(point);
  }
  return index;
}
function isCombiningMark(value: number): boolean { return isBetween(value, 0x0300, 0x036f) || isBetween(value, 0x1ab0, 0x1aff) || isBetween(value, 0x1dc0, 0x1dff) || isBetween(value, 0xfe20, 0xfe2f); }
function codePointLength(value: number): number { return value > 0xffff ? 2 : 1; }
function isBetween(value: number, minimum: number, maximum: number): boolean { return value >= minimum && value <= maximum; }
