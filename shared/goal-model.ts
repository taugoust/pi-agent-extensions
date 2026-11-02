import { randomUUID } from "node:crypto";
import { validateProgressArguments, type ProgressStep } from "./goal-checklist.ts";

/** Canonical execution record shared by the session engine and saved-goal registry adapters.
 * Catalog/ownership metadata is intentionally not part of this execution record; adapters map
 * catalog revisions and ownership fences separately rather than treating projections as execution state.
 */
export type GoalStatus = "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete" | "cleared";

export interface GoalRecord {
  id: string;
  activationId?: string;
  revision?: number;
  tasks?: ProgressStep[];
  requests?: Record<string, { fingerprint: string; result: { goalId: string; activationId: string; revision: number; status: string; steps: ProgressStep[] } }>;
  progressId?: string;
  text: string;
  status: GoalStatus;
  startedAt: number;
  updatedAt: number;
  lastTaskUpdateAt?: number;
  iteration: number;
  tokenBudget?: number;
  continuationLimits?: { automaticTurns?: number | null; noProgressTurns?: number | null };
  tokenBudgetExplicit?: boolean;
  tokensUsed: number;
  timeUsedSeconds: number;
  baselineTokens: number;
  activeStartedAt?: number;
  automaticModelTurns: number;
  toolFreeRepeatCount: number;
  lastToolFreeOutputFingerprint?: string;
  safetyPauseCause?: "continuation_limit" | "no_progress";
  safetyResetPending?: boolean;
  waiting?: { reason: string; resumeAt?: number };
  lastWake?: unknown;
  lastBlocker?: { at: number; reason: string; evidence: string; repeatedTurns: number };
}

export interface GoalAccountingRecord {
  status: string;
  baselineTokens: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  activeStartedAt?: number;
  updatedAt: number;
}

/** Construct a fresh canonical Goal. IDs and timestamps may be injected by adapters/tests. */
export function createGoalRecord(
  input: { id?: string; activationId?: string; text: string; now: number; baselineTokens: number; tokenBudget?: number; status?: GoalStatus },
): GoalRecord {
  return {
    id: input.id ?? randomUUID(),
    activationId: input.activationId ?? randomUUID(),
    revision: 0,
    tasks: [],
    text: input.text,
    status: input.status ?? "paused",
    startedAt: input.now,
    updatedAt: input.now,
    iteration: 0,
    tokenBudget: input.tokenBudget,
    tokenBudgetExplicit: input.tokenBudget !== undefined,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    baselineTokens: input.baselineTokens,
    activeStartedAt: input.status === "active" ? input.now : undefined,
    automaticModelTurns: 0,
    toolFreeRepeatCount: 0,
  };
}

/** The one lifecycle policy used by both execution and catalog adapters. */
export function resolveGoalTransitionStatus(goal: Pick<GoalRecord, "status" | "tokensUsed" | "tokenBudget">, requestedStatus: GoalStatus): GoalStatus {
  if (isFinalGoalStatus(goal.status) && requestedStatus !== goal.status) throw new Error("Goal is terminal");
  return requestedStatus === "active" && goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget ? "budget_limited" : requestedStatus;
}

/** Execution adapters additionally checkpoint their own session clock. */
export function transitionGoalRecord<T extends GoalRecord>(goal: T, requestedStatus: GoalStatus, now: number): T {
  const status = resolveGoalTransitionStatus(goal, requestedStatus);
  const next = { ...goal, status, updatedAt: now, ...(status === "active" ? {} : { waiting: undefined }) } as T;
  return checkpointGoalRecordTime(next, now, status === "active" && !next.waiting);
}

/** Stable-ID checklist patch semantics shared by tool/UI and saved Goal mutation adapters. */
export function mergeGoalChecklist(
  previous: readonly ProgressStep[],
  updates: readonly ProgressStep[],
  removals: readonly string[] = [],
  createId: () => string = randomUUID,
): ProgressStep[] {
  const supplied = updates.filter(step => step.id).map(step => step.id!);
  if (new Set(supplied).size !== supplied.length || new Set(removals).size !== removals.length) throw new Error("Duplicate task ID");
  const known = new Set(previous.map(step => step.id));
  if ([...supplied, ...removals].some(id => !known.has(id))) throw new Error("Unknown or foreign task ID; use this goal's current checklist");
  if (supplied.some(id => removals.includes(id))) throw new Error("Cannot update and remove the same task");
  const byId = new Map(updates.filter(step => step.id).map(step => [step.id, step]));
  const next = [
    ...previous.filter(step => !removals.includes(step.id!)).map(step => byId.get(step.id) ?? step),
    ...updates.filter(step => !step.id).map(step => ({ ...step, id: createId() })),
  ];
  if (new Set(next.map(step => step.text.trim())).size !== next.length) throw new Error("Goal tasks need distinct descriptions");
  return validateProgressArguments({ steps: next }).steps;
}

/** Shared accounting update; token total is cumulative session usage minus the original baseline. */
export function updateGoalRecordAccounting<T extends GoalAccountingRecord>(
  goal: T,
  totalTokens: number,
  now: number,
  continueClock = goal.status === "active",
): T {
  const baseline = nonNegative(goal.baselineTokens);
  const next = { ...goal, baselineTokens: baseline, tokensUsed: Math.max(0, nonNegative(totalTokens) - baseline), updatedAt: now };
  return checkpointGoalRecordTime(next, now, continueClock);
}

export function checkpointGoalRecordTime<T extends GoalAccountingRecord>(goal: T, now: number, continueClock: boolean): T {
  const accumulated = nonNegative(goal.timeUsedSeconds);
  const elapsed = typeof goal.activeStartedAt === "number" && Number.isFinite(goal.activeStartedAt)
    ? Math.max(0, now - goal.activeStartedAt) / 1000
    : 0;
  return { ...goal, timeUsedSeconds: accumulated + elapsed, activeStartedAt: continueClock ? now : undefined };
}

/**
 * Control-plane fingerprint: intentionally excludes usage, clocks, iteration, and safety counters.
 * Both session and saved adapters should increment/fence their control revision only when this
 * fingerprint changes, not when an accounting observation refreshes the Goal projection.
 */
export function goalControlFingerprint(goal: Pick<GoalRecord, "id" | "text" | "status" | "tokensUsed"> & Partial<GoalRecord>): string {
  return JSON.stringify([
    goal.id, goal.activationId ?? goal.id, goal.progressId ?? goal.id,
    goal.text, goal.status,
    goal.tasks?.map(task => [task.id, task.text, task.status]),
    goal.tokenBudget, goal.tokenBudgetExplicit,
    goal.continuationLimits?.automaticTurns, goal.continuationLimits?.noProgressTurns,
    goal.waiting ? [goal.waiting.reason, goal.waiting.resumeAt] : undefined,
    goal.safetyPauseCause, goal.safetyResetPending,
    Object.entries(goal.requests ?? {}).map(([id, receipt]) => [id, receipt.fingerprint]),
  ]);
}

/** Goal lifetime and execution lifetime are different: a paused Goal is retained. */
export function isFinalGoalStatus(status: GoalStatus | "cleared"): boolean {
  return status === "complete" || status === "cleared";
}

export function isGoalExecutionStopped(status: GoalStatus | "cleared"): boolean {
  return status !== "active";
}

function nonNegative(value: number) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
