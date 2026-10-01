/**
 * Separate interactive control surface shared by the root Paseo bridge and
 * native foreground-worker runtime. Keep keys and DTO shapes stable for the
 * cross-repository consumer. Never add mutations to the read-only harness API.
 *
 * Authentication/lifecycle contract:
 * - `__paeForegroundTasksV1` is published only by the owning interactive Pi
 *   extension. The bridge must validate its own parent capability before every
 *   execute() call; this service additionally requires the exact sessionId and
 *   extension epoch so stale bridge calls cannot cross reloads.
 * - Task commands target the exact taskId + childId + workerEpoch. The runtime
 *   checks worker epoch and its private authenticated child socket; requestId
 *   makes prompt/respond/stop retries idempotent.
 * - `__paeWorkerInteractionsV1` exists only in an RPC/headless helper. Pending
 *   typed interactions are committed by the worker before parent UI display.
 *   Closing the UI does not cancel them; worker cancellation records cancellation
 *   and must never become permission approval. Human permission decisions come
 *   only through the authenticated parent bridge, not model tool parameters.
 * - DTO history, interaction payloads, liveText and cursors are bounded. Cursors
 *   are opaque history positions and never filesystem paths or capabilities.
 */
export const FOREGROUND_TASKS_KEY = "__paeForegroundTasksV1";
export const WORKER_INTERACTIONS_KEY = "__paeWorkerInteractionsV1";
export const FOREGROUND_TASKS_PROTOCOL = 1 as const;

export type TaskTarget = { taskId: string; childId: string; workerEpoch: string };
export type TaskStatus = "pending" | "running" | "waiting-input" | "waiting-permission" | "completed" | "failed" | "cancelled" | "lost" | "reaped";
export type ForegroundTask = TaskTarget & {
  groupId: string;
  attempt: number;
  title: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  pendingInteractions: number;
  canPrompt: boolean;
  canStop: boolean;
};
export type TaskQuestion = {
  id: string;
  label?: string;
  prompt: string;
  options: Array<{ value: string; label: string; description?: string }>;
  allowOther: boolean;
};
export type TaskInteractionInput =
  | { kind: "permission"; title: string; options: string[]; detail?: string }
  | { kind: "questionnaire"; questions: TaskQuestion[] };
export type TaskInteractionAnswer =
  | { kind: "permission"; cancelled: boolean; value?: string }
  | { kind: "questionnaire"; cancelled: boolean; answers: Array<{ id: string; value: string; wasCustom: boolean }> };
export type TaskInteraction = {
  id: string;
  workerEpoch: string;
  createdAt: string;
  request: TaskInteractionInput;
};
export type TaskMessage = {
  id: string;
  role: "parent" | "user" | "assistant" | "tool" | "system";
  text: string;
  timestamp: string;
  toolName?: string;
  truncated?: boolean;
};
export type TaskView = {
  task: ForegroundTask;
  messages: TaskMessage[];
  interactions: TaskInteraction[];
  /** Stable opaque history cursor, not a filesystem path. */
  nextCursor?: string;
  liveText?: string;
  truncated: boolean;
};
export type ForegroundTaskCommand =
  | { operation: "list" }
  | { operation: "view"; target: TaskTarget; cursor?: string }
  | { operation: "prompt"; target: TaskTarget; requestId: string; message: string }
  | { operation: "respond"; target: TaskTarget; requestId: string; interactionId: string; answer: TaskInteractionAnswer }
  | { operation: "stop"; target: TaskTarget; requestId: string };
export type ForegroundTaskRequest = ForegroundTaskCommand & { sessionId: string; epoch: string };
export type ForegroundTaskResponse = {
  protocol: 1;
  sessionId: string;
  epoch: string;
  state: "available" | "unavailable" | "unsupported";
  tasks?: ForegroundTask[];
  view?: TaskView;
  accepted?: boolean;
  message?: string;
};
/** Published by the owning subagent extension; the bridge authenticates access separately. */
export type ForegroundTasksService = {
  protocol: 1;
  sessionId: string;
  epoch: string;
  execute(request: ForegroundTaskRequest): Promise<ForegroundTaskResponse>;
};
/** Present only inside a headless worker. Closing a client view does not cancel a request. */
export type WorkerInteractionsService = {
  protocol: 1;
  mode: "headless";
  workerEpoch: string;
  request(input: TaskInteractionInput, signal?: AbortSignal): Promise<TaskInteractionAnswer>;
};
export function foregroundTasksService(): ForegroundTasksService | undefined {
  const value = (globalThis as any)[FOREGROUND_TASKS_KEY];
  return value?.protocol === 1 && typeof value.sessionId === "string" && typeof value.epoch === "string" && typeof value.execute === "function" ? value : undefined;
}
export function workerInteractionsService(): WorkerInteractionsService | undefined {
  const value = (globalThis as any)[WORKER_INTERACTIONS_KEY];
  return value?.protocol === 1 && value.mode === "headless" && typeof value.workerEpoch === "string" && typeof value.request === "function" ? value : undefined;
}
