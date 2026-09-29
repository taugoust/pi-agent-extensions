/**
 * Cross-extension contract for the Paseo read-only harness dashboard.
 * This surface is observation only: no control, reconciliation, adoption,
 * acknowledgement, or cleanup operations are represented here.
 */
export const HARNESS_READONLY_KEY = "__paeHarnessReadOnlyV1";
export const HARNESS_READONLY_PROTOCOL = 1 as const;

export type ReadonlyState = "available" | "unavailable" | "unsupported";
export type ReadonlyPage<T> = {
  protocol: typeof HARNESS_READONLY_PROTOCOL;
  state: ReadonlyState;
  /** Exact Pi session that owns this snapshot. */
  sessionId: string;
  items: T[];
  /** Timestamp for the underlying snapshot, not the time this response was sent. */
  lastUpdated: string | null;
  /** True when data is a retained snapshot rather than a live observation. */
  stale: boolean;
  /** Opaque pagination token; callers must pass it back unchanged. */
  nextCursor?: string;
  message?: string;
};

export type ReadonlyDetail<T> = {
  protocol: typeof HARNESS_READONLY_PROTOCOL;
  state: ReadonlyState;
  sessionId: string;
  item?: T;
  lastUpdated: string | null;
  stale: boolean;
  message?: string;
};

export type ReadonlyJob = {
  jobId: string;
  status: "starting" | "running" | "completed" | "failed" | "cancelled" | "lost" | "unavailable" | "unknown";
  name?: string;
  createdAt: string;
  updatedAt: string | null;
  /** Observation-only adopted PID/log jobs remain explicitly labeled. */
  observationOnly: boolean;
  /** Child job ownership is not exposed through this first-version root API. */
};

export type ReadonlyJobOutput = {
  jobId: string;
  text: string;
  truncated: boolean;
  source: "log" | "pane" | "none";
  lastUpdated: string | null;
  stale: boolean;
};

export type ReadonlySubagentTask = {
  /** Stable task identifier; use for task-specific report lookup. */
  taskId: string;
  /** Public native-worker navigation identity; never a capability. */
  childId: string;
  groupId: string;
  runtimeId: string | null;
  attempt: number;
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped" | "lost" | "unknown";
  title: string;
  summary?: string;
  lastUpdated: string | null;
  stale: boolean;
};

export type ReadonlyTaskReport = {
  taskId: string;
  childId: string;
  groupId: string;
  runtimeId: string | null;
  attempt: number;
  /** Bounded answer-only text, never diagnostics or raw session/state data. */
  text: string;
  truncated: boolean;
  lastUpdated: string | null;
  stale: boolean;
};

/** Explicit owner-session scoped read methods. Limits: 1..50; output/report <= 48 KiB. */
export type HarnessReadOnlyJobs = {
  protocol: typeof HARNESS_READONLY_PROTOCOL;
  sessionId: string;
  list(input: { sessionId: string; limit?: number; cursor?: string }): Promise<ReadonlyPage<ReadonlyJob>>;
  output(input: { sessionId: string; jobId: string; maxBytes?: number }): Promise<ReadonlyDetail<ReadonlyJobOutput>>;
};

export type HarnessReadOnlySubagents = {
  protocol: typeof HARNESS_READONLY_PROTOCOL;
  sessionId: string;
  list(input: { sessionId: string; limit?: number; cursor?: string }): Promise<ReadonlyPage<ReadonlySubagentTask>>;
  report(input: { sessionId: string; taskId: string; maxBytes?: number }): Promise<ReadonlyDetail<ReadonlyTaskReport>>;
};

/** Lifetime-owned registry published by the supplying extensions. */
export type HarnessReadOnlyRegistry = {
  protocol: typeof HARNESS_READONLY_PROTOCOL;
  jobs?: HarnessReadOnlyJobs;
  subagents?: HarnessReadOnlySubagents;
};

export function harnessReadOnlyRegistry(): HarnessReadOnlyRegistry | undefined {
  const value = (globalThis as any)[HARNESS_READONLY_KEY] as HarnessReadOnlyRegistry | undefined;
  if (value?.protocol !== HARNESS_READONLY_PROTOCOL) return undefined;
  return value;
}

export function truncateUtf8(text: string, maxBytes: number, fromEnd = false): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let selected = fromEnd ? bytes.subarray(-maxBytes) : bytes.subarray(0, maxBytes);
  let decoded = "";
  while (selected.length) {
    try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(selected); break; }
    catch { selected = fromEnd ? selected.subarray(1) : selected.subarray(0, -1); }
  }
  return { text: decoded, truncated: true };
}

export function assertReadonlySession(service: { protocol: number; sessionId: string }, sessionId: string): void {
  if (service.protocol !== HARNESS_READONLY_PROTOCOL || !sessionId || service.sessionId !== sessionId) {
    throw new Error("Read-only harness service is unavailable for this Pi session");
  }
}
