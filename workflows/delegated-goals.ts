import {
  createGoalRecord, goalControlFingerprint, isFinalGoalStatus, mergeGoalChecklist,
  resolveGoalTransitionStatus, type GoalStatus,
} from "../shared/goal-model.ts";
import {
  emptyGoalStory, recordGoalEvent, validateGoalStory, mergeGoalStory,
  type GoalStory, type GoalQuestionReply, type GoalTimelineKind,
} from "./goal-story.ts";
import { validInteractionAnswer } from "../shared/task-interactions.ts";
import {
  validateGoalPlanning, pruneGoalDependencies, setGoalDependencies, addGoalBlocker,
  clearGoalBlocker, goalPlanningFields, type GoalPlanning, type GoalPlanningAction,
} from "./goal-planning.ts";
import { validateGoalDiagnostics, type GoalDiagnostics } from "./goal-diagnostics.ts";
import { validateGoalReview, mergeGoalReview, type GoalReviewReference } from "./goal-review.ts";
import {
  validateGoalLimitOverrides, type GoalContinuationLimits,
} from "../shared/delegated-goal-policy.ts";
import { completionSummaryRejection } from './goal/completion-summary.ts';
import { DelegatedGoalNoEffectError } from "../shared/delegated-goal-errors.ts";
import { mutateSavedGoalTasks, savedGoalTaskText } from "./saved-goal-tasks.ts";

export { DEDICATED_GOAL_LIMITS } from "../shared/delegated-goal-policy.ts";

export type DelegatedGoalStatus = GoalStatus;
export type DelegatedGoalChild = {
  taskId: string; childId: string; jobId: string; attempt: number; model?: string;
};
export type DelegatedGoalEntry = {
  id: string; revision: number; policyRevision?: number; text: string; status: DelegatedGoalStatus;
  tasks: Array<{
    id: string; text: string; status: "pending" | "in_progress" | "completed" | "blocked";
  }>;
  child: DelegatedGoalChild | null; tokenBudget: number | null; tokensUsed: number;
  continuationLimits?: Partial<GoalContinuationLimits>;
  automaticTurns: number; noProgressTurns: number; summary: string | null; waiting: string | null;
  story?: GoalStory;
  review?: GoalReviewReference[];
  reviewTruncated?: boolean;
  diagnostics?: GoalDiagnostics;
  planning?: GoalPlanning;
  /** Projection only: not a lifecycle transition or authority to execute. */
  observation?: { state: "current" | "unavailable"; at?: number; reason?: string };
};
export type DelegatedGoals = { version: 1; revision: number; entries: DelegatedGoalEntry[] };
export type DelegatedGoalAction =
  | "goals.create" | "goals.start" | "goals.pause" | "goals.resume" | "goals.edit"
  | "goals.limits" | "goals.clear" | "goals.complete" | "goals.add_task" | "goals.tasks"
  | "goals.answer" | "goals.reference" | GoalPlanningAction;
export type DelegatedGoalRequest = {
  action: DelegatedGoalAction; requestId: string; expectedGoalId: string | null;
  expectedEntryRevision?: number; expectedPolicyRevision?: number;
  expectedRegistryRevision?: number;
  objective?: string; text?: string; tokenBudget?: number | null;
  /** Atomic checklist creation; IDs are allocated by the canonical registry. */
  initialTasks?: string[];
  reviewTitle?: string; reviewTarget?: string; reviewRole?: "source" | "deliverable";
  taskId?: string; waitsFor?: string[];
  blockerReason?: string; blockerEvidence?: string; blockerTaskId?: string; blockerId?: string;
  questionId?: string; questionRevision?: number; workerEpoch?: string;
  answer?: GoalQuestionReply["answer"];
  continuationLimits?: Partial<GoalContinuationLimits>;
  user_authorized?: boolean; summary?: string;
  /** Explicit parent verification for existing tasks; never an implicit blanket completion. */
  taskEvidence?: Array<{ taskId: string; evidence: string }>;
  taskEdits?: Array<{ id?: string; text?: string; before_task_id?: string | null }>;
  removeTaskIds?: string[];
};
/** Child execution is deliberately injected: this registry never runs a parent goal. */
export type DelegatedGoalObservation = Partial<Pick<DelegatedGoalEntry,
  | "status" | "tasks" | "tokensUsed" | "automaticTurns" | "noProgressTurns"
  | "summary" | "waiting" | "story" | "diagnostics" | "review">>;
type ReadonlyEntry = Readonly<DelegatedGoalEntry>;
export interface DelegatedGoalExecutor {
  /** Live preflight; object presence alone does not authorize executable tools. */
  executionAvailable?(): boolean;
  executionUnavailableReason?(): string | null;
  start(entry: ReadonlyEntry): Promise<DelegatedGoalChild>;
  resume(entry: ReadonlyEntry): Promise<DelegatedGoalChild>;
  pause(entry: ReadonlyEntry): Promise<void | DelegatedGoalObservation>;
  updateLimits?(entry: ReadonlyEntry): Promise<void>;
  observe?(entry: ReadonlyEntry): Promise<DelegatedGoalObservation | null>;
  answer?(
    entry: ReadonlyEntry, reply: GoalQuestionReply, requestId: string,
  ): Promise<DelegatedGoalObservation>;
  verifyStopped?(entry: ReadonlyEntry): Promise<void>;
  reviewRoot?(entry: ReadonlyEntry): Promise<string>;
  registerReview?(
    entry: ReadonlyEntry, title: string, target: string, role: "source" | "deliverable",
  ): Promise<GoalReviewReference>;
}
export type DelegatedGoalIntent = {
  requestId: string; action: string; entryId: string; expectedEntryRevision: number;
};

const MAX_GOAL_ENTRIES = 1000;
const MAX_GOAL_TASKS = 50;
const MAX_OBJECTIVE_LENGTH = 4000;
const MAX_ID_LENGTH = 128;
const MAX_MODEL_LENGTH = 512;
const MAX_SUMMARY_LENGTH = 6000;
const MAX_WAITING_LENGTH = 1000;
const MAX_REASON_LENGTH = 1000;
const MAX_TOKEN_BUDGET = 1_000_000;
const MAX_REVIEW_REFERENCES = 16;
const MAX_TRACKED_REQUESTS = 2048;
const MAX_COMPLETION_REQUEST_BYTES = 48 * 1024;
const MAX_TASK_EVIDENCE_BYTES = 1000;

const GOAL_STATUSES = [
  "paused", "active", "blocked", "usage_limited", "budget_limited", "complete", "cleared",
];
const TASK_STATUSES = ["pending", "in_progress", "completed", "blocked"];
const LIFECYCLE_ACTIONS = ["goals.start", "goals.resume", "goals.pause"];
const PAUSE_OR_RESUME = ["goals.pause", "goals.resume"];
/** Actions still allowed on a completed or cleared goal. */
const FINAL_GOAL_ACTIONS = ["goals.reference", "goals.blocker.clear"];

/** Fields a child observation overwrites on its registry entry. */
const OBSERVED_FIELDS = [
  "status", "tasks", "tokensUsed", "automaticTurns", "noProgressTurns",
  "summary", "waiting", "diagnostics",
] as const;
type ObservedField = typeof OBSERVED_FIELDS[number];
/** Pause decides the status itself. */
const PAUSE_OBSERVED_FIELDS = OBSERVED_FIELDS.filter(key => key !== "status");

/** Request fields every action accepts. */
const BASE_REQUEST_FIELDS = [
  "operation", "sessionId", "serviceEpoch", "requestId", "action", "expectedGoalId",
];
const CREATE_REQUEST_FIELDS = [
  "expectedRegistryRevision", "objective", "tokenBudget", "continuationLimits", "initialTasks",
];
const ACTION_REQUEST_FIELDS = new Map<string, string[]>([
  ["goals.edit", ["objective", "tokenBudget", "continuationLimits"]],
  ["goals.limits", ["tokenBudget", "continuationLimits"]],
  ["goals.add_task", ["text"]],
  ["goals.tasks", ["taskEdits", "removeTaskIds"]],
  ["goals.complete", ["user_authorized", "summary", "taskEvidence"]],
  ["goals.reference", ["reviewTitle", "reviewTarget", "reviewRole"]],
  ["goals.answer", ["questionId", "questionRevision", "workerEpoch", "answer"]],
]);

/** Story event kind per action. Pause depends on the resulting status. Answers record none. */
const EVENT_KINDS = new Map<string, GoalTimelineKind>([
  ["goals.create", "created"],
  ["goals.start", "started"],
  ["goals.resume", "resumed"],
  ["goals.edit", "edited"],
  ["goals.limits", "edited"],
  ["goals.clear", "cleared"],
  ["goals.complete", "completed"],
  ["goals.add_task", "task"],
  ["goals.tasks", "edited"],
  ["goals.reference", "edited"],
  ["goals.dependencies", "edited"],
  ["goals.blocker.add", "edited"],
  ["goals.blocker.clear", "edited"],
]);

/** Runs a child effect behind the write-ahead journal. */
type EffectFence = <T>(call: () => Promise<T>) => Promise<T>;

const copy = <T>(value: T): T => structuredClone(value);
const fingerprint = (r: DelegatedGoalRequest) => {
  const fields = Object.keys(r).sort().map(k => [k, r[k as keyof typeof r]]);
  return JSON.stringify(fields);
};
const isPositiveInteger = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 1;
const isCount = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const isLinkId = (id: unknown) =>
  typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH;

/** Compatibility projection only: execution state follows the shared Goal domain.
 * Session clocks/baselines are owned by the executing GoalRuntime, never inferred
 * or independently accumulated by the catalog. */
function goalRecord(entry: DelegatedGoalEntry) {
  const waiting = entry.waiting
    ? { reason: entry.waiting, resumeAt: entry.diagnostics?.waitDeadline ?? undefined }
    : undefined;
  return {
    id: entry.id, text: entry.text, status: entry.status, tasks: entry.tasks,
    tokensUsed: entry.tokensUsed, tokenBudget: entry.tokenBudget ?? undefined,
    tokenBudgetExplicit: entry.tokenBudget !== null, continuationLimits: entry.continuationLimits,
    waiting,
  };
}
function controlFingerprint(entry: DelegatedGoalEntry) {
  const record = goalControlFingerprint(goalRecord(entry));
  return JSON.stringify([record, entry.child, entry.story?.questions, entry.planning]);
}
function nextStatus(entry: DelegatedGoalEntry, status: GoalStatus) {
  return resolveGoalTransitionStatus(goalRecord(entry), status);
}
function bumpPolicyRevision(entry: DelegatedGoalEntry) {
  entry.policyRevision = (entry.policyRevision ?? 1) + 1;
}
function checklist(previous: DelegatedGoalEntry["tasks"], additions: string[]) {
  const pending = additions.map(text => ({
    text: savedGoalTaskText(text), status: "pending" as const,
  }));
  return mergeGoalChecklist(previous, pending).map(task => ({ ...task, id: task.id! }));
}
function objective(value: unknown, max: number) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new Error(`Expected text of 1–${max} characters`);
  }
  return value.trim();
}
function budget(value: unknown) {
  const inRange = Number.isSafeInteger(value)
    && (value as number) >= 1 && (value as number) <= MAX_TOKEN_BUDGET;
  if (value !== undefined && !inRange) throw new Error("Invalid token budget");
  return value as number | undefined;
}

export function validateDelegatedGoals(state: DelegatedGoals): void {
  const validRegistry = state?.version === 1
    && Number.isSafeInteger(state.revision) && state.revision >= 0
    && Array.isArray(state.entries) && state.entries.length <= MAX_GOAL_ENTRIES;
  if (!validRegistry) throw new Error("Invalid delegated registry");
  const ids = new Set<string>();
  const childTasks = new Set<string>();
  for (const entry of state.entries) validateEntry(entry, ids, childTasks);
}

/** `ids` and `childTasks` collect what earlier entries claimed, to reject duplicates. */
function validateEntry(e: DelegatedGoalEntry, ids: Set<string>, childTasks: Set<string>): void {
  const validIdentity = e && /^[a-f0-9-]{36}$/i.test(e.id) && !ids.has(e.id)
    && isPositiveInteger(e.revision);
  if (!validIdentity) throw new Error("Invalid delegated identity");
  if (e.policyRevision !== undefined && !isPositiveInteger(e.policyRevision)) {
    throw new Error("Invalid goal policy revision");
  }
  ids.add(e.id);
  objective(e.text, MAX_OBJECTIVE_LENGTH);
  if (!GOAL_STATUSES.includes(e.status)) throw new Error("Invalid delegated status");
  budget(e.tokenBudget === null ? undefined : e.tokenBudget);
  validateGoalLimitOverrides(e.continuationLimits);
  validateGoalStory(e.story);
  validateGoalReview(e.review, e.id);
  if (e.reviewTruncated !== undefined && typeof e.reviewTruncated !== "boolean") {
    throw Error("Invalid review coverage");
  }
  validateQuestionAttachments(e);
  validateGoalDiagnostics(e.diagnostics);
  validateGoalPlanning(e.planning, e.tasks);
  if (![e.tokensUsed, e.automaticTurns, e.noProgressTurns].every(isCount)) {
    throw new Error("Invalid delegated accounting");
  }
  validateTasks(e.tasks);
  validateChild(e.child, childTasks);
  if (e.status === "active" && !e.child) {
    throw new Error("Active delegated goal requires child linkage");
  }
  const details = [[e.summary, MAX_SUMMARY_LENGTH], [e.waiting, MAX_WAITING_LENGTH]] as const;
  for (const [value, max] of details) {
    if (value !== null && (typeof value !== "string" || value.length > max)) {
      throw new Error("Invalid delegated status detail");
    }
  }
}

/** Each question attachment must be a review reference owned by that question.
 * A missing reference is only allowed once the review list was truncated. */
function validateQuestionAttachments(e: DelegatedGoalEntry): void {
  for (const question of e.story?.questions ?? []) {
    for (const id of question.attachmentIds ?? []) {
      const ref = e.review?.find(ref => ref.id === id);
      const owned = ref
        ? ref.questionId === question.id && ref.workerEpoch === question.workerEpoch
        : e.reviewTruncated === true;
      if (!owned) throw Error("Question review reference ownership changed");
    }
  }
}

function validateTasks(tasks: DelegatedGoalEntry["tasks"]): void {
  const validList = Array.isArray(tasks) && tasks.length <= MAX_GOAL_TASKS
    && new Set(tasks.map(t => t.id)).size === tasks.length;
  if (!validList) throw new Error("Invalid delegated tasks");
  if (new Set(tasks.map(t => savedGoalTaskText(t.text))).size !== tasks.length) {
    throw new Error("Goal tasks need distinct descriptions after trimming");
  }
  for (const task of tasks) {
    const valid = typeof task.id === "string" && task.id && task.id.length <= MAX_ID_LENGTH
      && TASK_STATUSES.includes(task.status);
    if (!valid) throw new Error("Invalid delegated task");
    savedGoalTaskText(task.text);
  }
}

function validateChild(child: DelegatedGoalChild | null, childTasks: Set<string>): void {
  if (child === null) return;
  const validLink = child && [child.taskId, child.childId, child.jobId].every(isLinkId)
    && isPositiveInteger(child.attempt);
  if (!validLink) throw new Error("Invalid child linkage");
  const validModel = child.model === undefined || (typeof child.model === "string"
    && child.model.trim() && child.model.length <= MAX_MODEL_LENGTH);
  if (!validModel) throw new Error("Invalid child launch model");
  if (childTasks.has(child.taskId)) {
    throw new Error("Dedicated child task cannot belong to multiple goals");
  }
  childTasks.add(child.taskId);
}

function belongsToAttempt(ref: GoalReviewReference, child: DelegatedGoalChild | null) {
  return ref.taskId === child?.taskId
    && ref.childId === child?.childId
    && ref.attempt === child?.attempt;
}

/** A resumed child keeps its task and either starts a newer attempt or is the same attempt. */
function isSameOrNewerAttempt(previous: DelegatedGoalChild, next: DelegatedGoalChild) {
  if (next.taskId !== previous.taskId) return false;
  if (next.attempt > previous.attempt) return true;
  return next.attempt === previous.attempt
    && next.childId === previous.childId
    && next.jobId === previous.jobId;
}

function applyObservedFields(
  entry: DelegatedGoalEntry, observed: DelegatedGoalObservation, fields: readonly ObservedField[],
): void {
  for (const key of fields) {
    if (Object.hasOwn(observed, key)) (entry as any)[key] = copy(observed[key]);
  }
}

function mergeObservedMetadata(
  entry: DelegatedGoalEntry, observed: DelegatedGoalObservation,
): void {
  if (observed.story) entry.story = mergeGoalStory(entry.story, observed.story);
  if (!observed.review) return;
  validateGoalReview(observed.review, entry.id);
  for (const ref of observed.review) {
    const known = entry.review?.some(previous => previous.id === ref.id);
    if (!known && !belongsToAttempt(ref, entry.child)) {
      throw Error("Observed review belongs to another child attempt");
    }
  }
  // Attachments of pending questions are kept when the list is truncated.
  const pendingAttachments = (entry.story?.questions ?? [])
    .filter(question => question.status === "pending")
    .flatMap(question => question.attachmentIds ?? []);
  const merged = mergeGoalReview(entry.review, observed.review, pendingAttachments);
  entry.review = merged.refs;
  if (merged.truncated) entry.reviewTruncated = true;
}

function normalizeTaskDescriptions(entry: DelegatedGoalEntry): void {
  const dependencies = JSON.stringify(entry.planning?.dependencies);
  pruneGoalDependencies(entry.planning, entry.tasks);
  if (dependencies !== JSON.stringify(entry.planning?.dependencies)) {
    const story = entry.story ??= emptyGoalStory();
    recordGoalEvent(story, "edited", "Task dependencies updated after a recorded task removal");
  }
  if (Array.isArray(entry.tasks)) {
    entry.tasks = entry.tasks.map(task => ({
      ...task, text: typeof task.text === "string" ? task.text.trim() : task.text,
    }));
  }
}

/** A Pause or Resume on a linked, unfinished goal whose child may already have completed. */
function mayHaveCompleted(entry: DelegatedGoalEntry, r: DelegatedGoalRequest) {
  return entry.child
    && !['complete', 'cleared'].includes(entry.status)
    && PAUSE_OR_RESUME.includes(r.action);
}

function allowedRequestFields(action: string): string[] {
  const planning = goalPlanningFields(action);
  if (action === "goals.create") {
    return [...BASE_REQUEST_FIELDS, ...CREATE_REQUEST_FIELDS, ...planning];
  }
  const revisionField = action === "goals.limits"
    ? "expectedPolicyRevision"
    : "expectedEntryRevision";
  const actionFields = ACTION_REQUEST_FIELDS.get(action) ?? [];
  return [...BASE_REQUEST_FIELDS, revisionField, ...actionFields, ...planning];
}

function eventKind(
  r: DelegatedGoalRequest, changed: DelegatedGoalEntry,
): GoalTimelineKind | undefined {
  if (r.action === "goals.pause") return changed.status === "complete" ? "completed" : "paused";
  return EVENT_KINDS.get(r.action);
}

function eventText(
  r: DelegatedGoalRequest, changed: DelegatedGoalEntry, kind: GoalTimelineKind | undefined,
): string {
  switch (r.action) {
    case "goals.dependencies": return "Advisory task dependencies updated";
    case "goals.blocker.add": return `Recorded blocker: ${r.blockerReason?.trim()}`;
    case "goals.blocker.clear": {
      const blocker = changed.planning?.blockers.find(blocker => blocker.id === r.blockerId);
      return `Recorded blocker cleared: ${blocker?.reason}`;
    }
    case "goals.complete": return `Parent verified completion: ${changed.summary}`;
    case "goals.add_task": return `Task added: ${r.text?.trim()}`;
    case "goals.tasks": return "Saved-Goal checklist edited";
    default: return `Goal ${kind}`;
  }
}

function createEntry(next: DelegatedGoals, r: DelegatedGoalRequest): DelegatedGoalEntry {
  if (r.expectedGoalId !== null || r.expectedEntryRevision !== undefined) {
    throw new Error("Create requires null goal identity");
  }
  const registryMoved = r.expectedRegistryRevision !== undefined
    && r.expectedRegistryRevision !== next.revision;
  if (registryMoved) throw new Error("Registry changed");
  if (next.entries.length >= MAX_GOAL_ENTRIES) {
    throw new Error("Delegated goal history limit reached");
  }
  const validInitialTasks = r.initialTasks === undefined
    || (Array.isArray(r.initialTasks) && r.initialTasks.length <= MAX_GOAL_TASKS);
  if (!validInitialTasks) throw new Error("Invalid initial Goal checklist");
  const record = createGoalRecord({
    text: objective(r.objective, MAX_OBJECTIVE_LENGTH),
    tokenBudget: budget(r.tokenBudget),
    baselineTokens: 0,
    now: Date.now(),
  });
  const tasks = checklist([], r.initialTasks ?? []);
  const limits = r.continuationLimits === undefined
    ? {}
    : { continuationLimits: copy(r.continuationLimits) };
  const entry: DelegatedGoalEntry = {
    id: record.id, revision: 1, policyRevision: 1, text: record.text, status: record.status,
    tasks, child: null,
    ...limits,
    tokenBudget: record.tokenBudget ?? null, tokensUsed: record.tokensUsed,
    automaticTurns: record.automaticModelTurns, noProgressTurns: record.toolFreeRepeatCount,
    summary: null, waiting: null,
  };
  next.entries.push(entry);
  return entry;
}

function editGoal(entry: DelegatedGoalEntry, r: DelegatedGoalRequest): void {
  if (entry.status === "active") throw new Error("Pause goal before editing metadata");
  entry.text = objective(r.objective, MAX_OBJECTIVE_LENGTH);
  if (r.tokenBudget !== undefined) {
    entry.tokenBudget = r.tokenBudget === null ? null : budget(r.tokenBudget)!;
  }
  if (r.continuationLimits !== undefined) entry.continuationLimits = copy(r.continuationLimits);
}

function addTask(entry: DelegatedGoalEntry, r: DelegatedGoalRequest): void {
  if (entry.status === "active") throw new Error("Pause goal before editing tasks");
  if (entry.tasks.length >= MAX_GOAL_TASKS) throw new Error("Goal task limit reached");
  entry.tasks = checklist(entry.tasks, [savedGoalTaskText(r.text)]);
}

function editTasks(entry: DelegatedGoalEntry, r: DelegatedGoalRequest): void {
  if (entry.status === "active") throw new Error("Pause goal before editing tasks");
  const edits = r.taskEdits === undefined ? [] : r.taskEdits;
  const removals = r.removeTaskIds === undefined ? [] : r.removeTaskIds;
  entry.tasks = mutateSavedGoalTasks(entry.tasks, edits, removals);
  pruneGoalDependencies(entry.planning, entry.tasks);
}

/** Checks the parent's completion request and returns the evidence per task it verifies. */
function verifiedTaskEvidence(
  entry: DelegatedGoalEntry, r: DelegatedGoalRequest,
): Map<string, string> {
  if (Buffer.byteLength(JSON.stringify(r), 'utf8') > MAX_COMPLETION_REQUEST_BYTES) {
    throw new Error('Completion evidence exceeds request budget');
  }
  if (entry.planning?.blockers.some(blocker => blocker.clearedAt === undefined)) {
    throw new Error('Resolve recorded blockers before completion');
  }
  if (entry.story?.questions.some(question => question.status === 'pending')) {
    throw new Error('Resolve pending questions before completion');
  }
  const evidence = r.taskEvidence ?? [];
  if (!Array.isArray(evidence) || evidence.length > MAX_GOAL_TASKS) {
    throw new Error('Invalid task completion evidence');
  }
  const verified = new Map<string, string>();
  for (const item of evidence) {
    const validTask = item
      && Object.keys(item).sort().join(',') === 'evidence,taskId'
      && typeof item.taskId === 'string'
      && !verified.has(item.taskId)
      && entry.tasks.some(task => task.id === item.taskId);
    if (!validTask) throw new Error('Completion evidence requires unique existing task IDs');
    const validEvidence = typeof item.evidence === 'string'
      && item.evidence.trim()
      && Buffer.byteLength(item.evidence, 'utf8') <= MAX_TASK_EVIDENCE_BYTES
      && !completionSummaryRejection(item.evidence.trim());
    if (!validEvidence) throw new Error('Invalid task verification evidence');
    verified.set(item.taskId, item.evidence.trim());
  }
  if (entry.tasks.some(task => task.status !== 'completed' && !verified.has(task.id))) {
    throw new Error(
      'Required tasks remain unfinished; supply explicit verification evidence for each',
    );
  }
  return verified;
}

type IntentJournal = {
  initial?: DelegatedGoalIntent | null;
  save: (intent: DelegatedGoalIntent | null) => void;
};

/** Session-bound durable metadata. One serialized mutation lane, including child RPC.
 * Persistence must be atomic and must not write goal-state or parent message history.
 * Child failures leave metadata unchanged; callers must inspect uncertain child RPC
 * outcomes before retrying with a new request ID.
 */
export class DelegatedGoalRegistry {
  private state: DelegatedGoals;
  private lane: Promise<unknown> = Promise.resolve();
  private requests = new Map<string, { fingerprint: string; promise: Promise<DelegatedGoals> }>();
  private pending: DelegatedGoalIntent | null;
  private observations = new Map<string, NonNullable<DelegatedGoalEntry["observation"]>>();
  constructor(
    readonly sessionId: string,
    private executor: DelegatedGoalExecutor,
    private persist: (state: DelegatedGoals) => void,
    initial: DelegatedGoals = { version: 1, revision: 0, entries: [] },
    private journal: IntentJournal = { save() {} },
  ) {
    validateDelegatedGoals(initial);
    this.state = copy(initial);
    for (const entry of this.state.entries) {
      normalizeTaskDescriptions(entry);
      entry.policyRevision ??= entry.revision;
      delete entry.observation;
    }
    this.pending = copy(journal.initial ?? null);
  }

  blockedReason(): string | null {
    if (!this.pending) return null;
    const { action, entryId } = this.pending;
    return `Dedicated child delivery requires reconciliation (${action}, goal ${entryId}); `
      + "affected-goal mutations and new child execution are blocked "
      + "to prevent duplicate execution";
  }

  snapshot(): DelegatedGoals {
    const result = copy(this.state);
    for (const entry of result.entries) {
      if (!entry.child) continue;
      entry.observation = copy(this.observations.get(entry.id) ?? { state: "unavailable" });
    }
    return result;
  }

  refresh(): Promise<void> {
    const result = this.lane.then(() => this.observeActiveChildren());
    this.lane = result.catch(() => {});
    return result;
  }

  mutate(sessionId: string, request: DelegatedGoalRequest): Promise<DelegatedGoals> {
    if (sessionId !== this.sessionId) {
      return Promise.reject(new Error("Stale delegated goal session"));
    }
    const r = copy(request);
    const key = fingerprint(r);
    const previous = this.requests.get(r.requestId);
    if (previous) {
      // A retried request ID replays the first result.
      if (previous.fingerprint !== key) return Promise.reject(new Error("Request ID conflict"));
      return previous.promise.then(copy);
    }
    if (!r.requestId || this.requests.size >= MAX_TRACKED_REQUESTS) {
      return Promise.reject(new Error("Invalid request or request limit reached"));
    }
    const promise = this.lane.then(() => this.apply(r));
    this.requests.set(r.requestId, { fingerprint: key, promise });
    this.lane = promise.catch(() => {});
    return promise.then(copy);
  }

  private commit(next: DelegatedGoals): void {
    validateDelegatedGoals(next);
    this.persist(copy(next));
    this.state = next;
  }

  private async observeActiveChildren(): Promise<void> {
    if (!this.executor.observe || this.pending) return;
    const next = copy(this.state);
    let changed = false;
    for (const entry of next.entries) {
      if (!entry.child || entry.status !== "active") continue;
      if (await this.observeChild(entry, next.revision)) changed = true;
    }
    if (!changed) return;
    next.revision++;
    this.commit(next);
  }

  /** Copies one child's observation onto its entry and returns whether the entry changed. */
  private async observeChild(
    entry: DelegatedGoalEntry, registryRevision: number,
  ): Promise<boolean> {
    let observed: DelegatedGoalObservation | null;
    try {
      observed = await this.executor.observe!(copy(entry));
      if (!observed) throw new Error("Child observation unavailable");
    } catch (error) {
      this.markObservationUnavailable(entry.id, error);
      return false;
    }
    if (observed.status === "cleared") throw new Error("Child cannot clear parent goal history");
    const previous = JSON.stringify(entry);
    const previousControl = controlFingerprint(entry);
    const previousStatus = entry.status;
    applyObservedFields(entry, observed, OBSERVED_FIELDS);
    mergeObservedMetadata(entry, observed);
    normalizeTaskDescriptions(entry);
    validateDelegatedGoals({ version: 1, revision: registryRevision, entries: [entry] });
    this.observations.set(entry.id, { state: "current", at: Date.now() });
    if (JSON.stringify(entry) === previous) return false;
    if (entry.status !== previousStatus) bumpPolicyRevision(entry);
    if (controlFingerprint(entry) !== previousControl) entry.revision++;
    return true;
  }

  private markObservationUnavailable(entryId: string, error: unknown): void {
    const previous = this.observations.get(entryId);
    const lastSeen = previous?.at === undefined ? {} : { at: previous.at };
    const message = String(error instanceof Error ? error.message : error);
    const reason = message.slice(0, MAX_REASON_LENGTH);
    this.observations.set(entryId, { state: "unavailable", ...lastSeen, reason });
  }

  private async apply(r: DelegatedGoalRequest): Promise<DelegatedGoals> {
    const next = copy(this.state);
    const blocked = this.pending
      && (r.expectedGoalId === this.pending.entryId || LIFECYCLE_ACTIONS.includes(r.action));
    if (blocked) throw new Error(this.blockedReason()!);
    const allowed = allowedRequestFields(r.action);
    if (Object.keys(r).some(key => !allowed.includes(key))) {
      throw new Error("Unknown delegated goal request fields");
    }

    let performedEffect = false;
    let changed: DelegatedGoalEntry | null;
    if (r.action === "goals.create") {
      changed = createEntry(next, r);
    } else {
      changed = await this.changeEntry(next, r, () => { performedEffect = true; });
      if (!changed) return this.snapshot();
    }

    changed.story ??= emptyGoalStory();
    if (r.action !== "goals.answer") {
      const kind = eventKind(r, changed);
      recordGoalEvent(changed.story, kind!, eventText(r, changed, kind));
    }
    next.revision++;
    next.entries.forEach(normalizeTaskDescriptions);
    this.commit(next);
    if (performedEffect) {
      this.journal.save(null);
      this.pending = null;
    }
    return this.snapshot();
  }

  /** Applies `r` to its existing entry.
   * Returns null when the request was settled without a change to record. */
  private async changeEntry(
    next: DelegatedGoals, r: DelegatedGoalRequest, onEffect: () => void,
  ): Promise<DelegatedGoalEntry | null> {
    const entry = next.entries.find(e => e.id === r.expectedGoalId);
    const revisionMatches = r.action === "goals.limits"
      ? entry?.policyRevision === r.expectedPolicyRevision
      : entry?.revision === r.expectedEntryRevision;
    if (!entry || !revisionMatches) throw new Error("Goal identity or revision changed");
    // A parent-completed goal is authoritative even if its historical child
    // still has paused metadata. Stale lifecycle controls cannot resurrect it.
    if (entry.status === 'complete' && PAUSE_OR_RESUME.includes(r.action)) return null;
    // Reconcile authenticated completion before writing a lifecycle intent.
    // A stale Pause or Resume is an observation, never a new execution.
    if (mayHaveCompleted(entry, r)) {
      const observed = await this.executor.observe?.(copy(entry));
      if (observed?.status === "complete") {
        this.recordChildCompletion(next, entry, observed);
        return null;
      }
    }
    if (isFinalGoalStatus(entry.status) && !FINAL_GOAL_ACTIONS.includes(r.action)) {
      throw new Error("Goal is terminal");
    }
    await this.applyEntryAction(entry, r, this.effectFence(r, entry, onEffect));
    if (r.action !== "goals.tasks") bumpPolicyRevision(entry);
    entry.revision++;
    return entry;
  }

  private recordChildCompletion(
    next: DelegatedGoals, entry: DelegatedGoalEntry, observed: DelegatedGoalObservation,
  ): void {
    applyObservedFields(entry, observed, OBSERVED_FIELDS);
    mergeObservedMetadata(entry, observed);
    entry.waiting = null;
    bumpPolicyRevision(entry);
    entry.revision++;
    next.revision++;
    this.commit(next);
  }

  /** Write-ahead fence: lost RPC receipts and persistence failures are uncertain.
   * The intent is journaled before the child call.
   * It is cleared only after the result is persisted. */
  private effectFence(
    r: DelegatedGoalRequest, entry: DelegatedGoalEntry, onEffect: () => void,
  ): EffectFence {
    return async <T>(call: () => Promise<T>): Promise<T> => {
      const launches = ["goals.start", "goals.resume"].includes(r.action);
      if (launches && this.executor.executionAvailable?.() === false) {
        const reason = this.executor.executionUnavailableReason?.();
        throw new Error(reason || "Dedicated child execution preflight refused");
      }
      const intent = {
        requestId: r.requestId, action: r.action,
        entryId: entry.id, expectedEntryRevision: entry.revision,
      };
      this.journal.save(copy(intent));
      this.pending = intent;
      onEffect();
      try {
        return await call();
      } catch (error) {
        if (error instanceof DelegatedGoalNoEffectError) {
          this.journal.save(null);
          this.pending = null;
        }
        throw error;
      }
    };
  }

  private applyEntryAction(
    entry: DelegatedGoalEntry, r: DelegatedGoalRequest, effect: EffectFence,
  ): Promise<void> | void {
    switch (r.action) {
      case "goals.start": return this.start(entry, effect);
      case "goals.resume": return this.resume(entry, effect);
      case "goals.pause": return this.pause(entry, effect);
      case "goals.answer": return this.answer(entry, r);
      case "goals.complete": return this.complete(entry, r);
      case "goals.clear": return this.clear(entry);
      case "goals.limits": return this.updateLimits(entry, r, effect);
      case "goals.edit": return editGoal(entry, r);
      case "goals.dependencies":
        entry.planning = setGoalDependencies(entry.planning, entry.tasks, r.taskId!, r.waitsFor!);
        return;
      case "goals.blocker.add":
        entry.planning = addGoalBlocker(
          entry.planning, entry.tasks, r.blockerReason!, r.blockerEvidence!, r.blockerTaskId,
        );
        return;
      case "goals.blocker.clear":
        entry.planning = clearGoalBlocker(entry.planning, entry.tasks, r.blockerId!);
        return;
      case "goals.reference": return this.registerReference(entry, r);
      case "goals.add_task": return addTask(entry, r);
      case "goals.tasks": return editTasks(entry, r);
      default: throw new Error("Unknown delegated goal action");
    }
  }

  private async start(entry: DelegatedGoalEntry, effect: EffectFence): Promise<void> {
    if (entry.status !== "paused" || entry.child) {
      throw new Error("Start requires an unstarted paused goal");
    }
    if (nextStatus(entry, "active") !== "active") {
      throw new Error("Goal token budget is still reached; edit or remove the cap before Start");
    }
    entry.child = await effect(() => this.executor.start(copy(entry)));
    entry.status = nextStatus(entry, "active");
  }

  private async resume(entry: DelegatedGoalEntry, effect: EffectFence): Promise<void> {
    if (entry.status === "active" || !entry.child) {
      throw new Error("Resume requires an inactive linked goal");
    }
    if (nextStatus(entry, "active") !== "active") {
      throw new Error("Goal token budget is still reached; edit or remove the cap before Resume");
    }
    const previous = entry.child;
    const child = await effect(() => this.executor.resume(copy(entry)));
    if (!isSameOrNewerAttempt(previous, child)) {
      throw new Error("Child task ownership or attempt changed");
    }
    entry.child = child;
    entry.status = nextStatus(entry, "active");
  }

  private async pause(entry: DelegatedGoalEntry, effect: EffectFence): Promise<void> {
    if (entry.status !== "active" || !entry.child) throw new Error("Goal is not active");
    await effect(async () => {
      const result = await this.executor.pause(copy(entry));
      const observed = result ?? await this.executor.observe?.(copy(entry));
      if (observed) {
        applyObservedFields(entry, observed, PAUSE_OBSERVED_FIELDS);
        mergeObservedMetadata(entry, observed);
      }
      // A child that stopped on its own (complete, blocked, ...) keeps that status.
      const observedStatus = observed?.status;
      const stoppedOnItsOwn = observedStatus && observedStatus !== "active";
      entry.status = nextStatus(entry, stoppedOnItsOwn ? observedStatus : "paused");
      if (entry.status === "complete") entry.waiting = null;
    });
  }

  private async answer(entry: DelegatedGoalEntry, r: DelegatedGoalRequest): Promise<void> {
    const question = entry.story?.questions?.find(q => q.id === r.questionId);
    const answerable = entry.status === "active" && entry.child && this.executor.answer
      && question && question.status === "pending"
      && question.revision === r.questionRevision
      && question.workerEpoch === r.workerEpoch
      && r.answer && validInteractionAnswer(question.request, r.answer);
    if (!answerable) throw new Error("Goal question changed or is unavailable");
    // Answers resolve one epoch-bound waiter with an idempotent request ID;
    // they cannot create/resume a child. A cancelled-question race must not
    // poison the lifecycle journal. Lost receipts reconcile via observation.
    const reply = {
      questionId: question.id, questionRevision: question.revision,
      workerEpoch: question.workerEpoch, answer: r.answer!,
    };
    const observed = await this.executor.answer!(copy(entry), reply, r.requestId);
    if (!observed.story) throw new Error("Goal answer receipt is missing");
    mergeObservedMetadata(entry, observed);
  }

  private async complete(entry: DelegatedGoalEntry, r: DelegatedGoalRequest): Promise<void> {
    if (entry.status !== 'paused') throw new Error('Parent completion requires a paused goal');
    if (r.user_authorized !== true) {
      throw new Error('Parent completion requires fresh explicit user authorization');
    }
    const summary = typeof r.summary === 'string' ? r.summary.trim() : '';
    const rejection = completionSummaryRejection(summary);
    if (rejection) throw new Error(`Goal completion rejected: ${rejection}`);
    const verified = verifiedTaskEvidence(entry, r);
    if (entry.child) {
      if (!this.executor.verifyStopped) {
        throw new Error('Cannot complete until exact owned child stop is verified');
      }
      await this.executor.verifyStopped(copy(entry));
    }
    for (const task of entry.tasks) {
      if (!verified.has(task.id)) continue;
      task.status = 'completed';
      const story = entry.story ??= emptyGoalStory();
      const text = `Parent verified: ${verified.get(task.id)}`;
      recordGoalEvent(story, 'task', text, task.id, Date.now(), 'completed');
    }
    entry.status = nextStatus(entry, "complete");
    entry.summary = summary;
    entry.waiting = null;
    if (entry.diagnostics) entry.diagnostics.waitDeadline = null;
  }

  private async clear(entry: DelegatedGoalEntry): Promise<void> {
    if (entry.status === "active") throw new Error("Pause child before clearing goal");
    if (entry.child) {
      if (!this.executor.verifyStopped) {
        throw new Error("Cannot clear until owned child stop is verified");
      }
      await this.executor.verifyStopped(copy(entry));
    }
    entry.status = nextStatus(entry, "cleared");
  }

  private async updateLimits(
    entry: DelegatedGoalEntry, r: DelegatedGoalRequest, effect: EffectFence,
  ): Promise<void> {
    if (r.tokenBudget === undefined || r.continuationLimits === undefined) {
      throw new Error("Explicit limit policy required");
    }
    entry.tokenBudget = r.tokenBudget === null ? null : budget(r.tokenBudget)!;
    validateGoalLimitOverrides(r.continuationLimits);
    entry.continuationLimits = copy(r.continuationLimits);
    if (!entry.child) return;
    if (!this.executor.updateLimits) throw new Error("Worker does not support limit editing");
    await effect(() => this.executor.updateLimits!(copy(entry)));
  }

  private async registerReference(
    entry: DelegatedGoalEntry, r: DelegatedGoalRequest,
  ): Promise<void> {
    const child = entry.child;
    const full = (entry.review?.length ?? 0) >= MAX_REVIEW_REFERENCES;
    if (!child || !this.executor.registerReview || full) {
      throw new Error("Review registration unavailable or full");
    }
    const ref = await this.executor.registerReview(
      copy(entry), r.reviewTitle!, r.reviewTarget!, r.reviewRole!,
    );
    validateGoalReview([ref], entry.id);
    if (!belongsToAttempt(ref, child)) throw new Error("Review attempt changed");
    (entry.review ??= []).push(ref);
  }
}
