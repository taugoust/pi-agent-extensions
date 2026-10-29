import { isNonNegativeFiniteNumber, nonNegativeFiniteNumber, normalizeTokenBudget } from "./accounting.js";
import { validateGoalLimitOverrides, type GoalContinuationLimits } from "../../shared/delegated-goal-policy.ts";
import type { GoalStatus } from "./prompts.js";
import { createHash } from "node:crypto";
import { readScopedProgress, validateProgressArguments, type ProgressStep } from "../../progress/progress-state.js";
import { type GoalWait, type GoalWake, normalizeGoalWait, normalizeGoalWake } from "./wait.js";

const GOAL_STATE_ENTRY_TYPE = "goal-state";
const LEGACY_GOALS_STATE_ENTRY_TYPE = "goals-state";

export type SafetyPauseCause = "continuation_limit" | "no_progress";
const LEGACY_IMPLICIT_TOKEN_BUDGET = 250_000;

export interface ActiveGoal {
  id: string;
  /** Rotates on activation; never use the stable id as a stale-turn guard. */
  activationId?: string;
  /** Task/control mutation fence; usage-only checkpoints preserve this revision. */
  revision?: number;
  tasks?: ProgressStep[];
  requests?: Record<string, { fingerprint: string; result: { goalId: string; activationId: string; revision: number; status: string; steps: ProgressStep[] } }>;
  /** Legacy checklist key retained for faithful migration and history. */
  progressId?: string;
  text: string;
  status: GoalStatus;
  startedAt: number;
  updatedAt: number;
  /** Recorded checklist change, not a heartbeat or inferred work progress. */
  lastTaskUpdateAt?: number;
  iteration: number;
  tokenBudget?: number;
  /** Per-goal user policy, retained across reload/Resume without resetting counters. */
  continuationLimits?: Partial<GoalContinuationLimits>;
  /** Distinguishes explicit caps from the old silent 250k default during migration. */
  tokenBudgetExplicit?: boolean;
  tokensUsed: number;
  timeUsedSeconds: number;
  baselineTokens: number;
  activeStartedAt?: number;
  automaticModelTurns: number;
  toolFreeRepeatCount: number;
  lastToolFreeOutputFingerprint?: string;
  safetyPauseCause?: SafetyPauseCause;
  safetyResetPending?: boolean;
  waiting?: GoalWait;
  /** Last transition out of waiting; bounded diagnostic data, not authority. */
  lastWake?: GoalWake;
  /** Most recent accepted, evidenced blocker report; retained across resume. */
  lastBlocker?: { at: number; reason: string; evidence: string; repeatedTurns: number };
}

interface LegacyStoredGoal extends Omit<ActiveGoal, "status"> {
  status: GoalStatus | "queued";
}

export interface GoalStateEntryData {
  goal: ActiveGoal | null;
}

export interface LegacyQueueState {
  retainedGoals: number;
}

export interface LoadedGoalState {
  goal: ActiveGoal | undefined;
  legacyQueueState: LegacyQueueState | undefined;
}

interface SessionEntry {
  type?: string;
  customType?: string;
  data?: unknown;
}

interface SessionContext {
  sessionManager?: {
    getBranch?: () => SessionEntry[];
    getEntries?: () => SessionEntry[];
  };
}

export function serializeGoalState(goal: ActiveGoal | undefined): GoalStateEntryData {
  // Session managers may retain the supplied data object in memory. Accounting
  // and later mutations must never rewrite an earlier branch checkpoint.
  return { goal: goal ? structuredClone(goal) : null };
}

export function loadGoalStateFromSession(ctx: SessionContext): LoadedGoalState {
  const entries = ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
  const canonicalEntry = entries
    .filter((entry) => entry.type === "custom" && entry.customType === GOAL_STATE_ENTRY_TYPE)
    .pop();
  if (canonicalEntry) return migrateTasks(loadCanonicalGoalState(canonicalEntry.data), entries);

  const legacyEntry = entries
    .filter((entry) => entry.type === "custom" && entry.customType === LEGACY_GOALS_STATE_ENTRY_TYPE)
    .pop();
  return legacyEntry ? migrateTasks(loadLegacyGoalsState(legacyEntry.data), entries) : emptyGoalState();
}

function migrateTasks(loaded: LoadedGoalState, entries: SessionEntry[]): LoadedGoalState {
  const goal = loaded.goal;
  if (goal && goal.tasks === undefined) {
    // Only an explicit legacy scope key establishes ownership. Never associate
    // standalone history by text, timing, or the mere presence of a goal.
    goal.tasks = readScopedProgress(entries as any, goal.progressId ?? goal.id).map((step, index) => ({
      ...step,
      id: step.id ?? `legacy-${createHash("sha256").update(JSON.stringify([goal.progressId ?? goal.id, index, step])).digest("hex").slice(0, 32)}`,
    }));
  }
  return loaded;
}

function loadCanonicalGoalState(data: unknown): LoadedGoalState {
  if (!isRecord(data)) return emptyGoalState();
  const rawGoal = data.goal;
  if (rawGoal !== null && !isStoredGoal(rawGoal)) return emptyGoalState();
  const rawQueue = Object.hasOwn(data, "queue") ? data.queue : undefined;
  if (rawQueue !== undefined && (!Array.isArray(rawQueue) || !rawQueue.every(isQueueGoal))) {
    return emptyGoalState();
  }
  const pendingAction = Object.hasOwn(data, "pendingAction")
    ? normalizeCanonicalPendingAction(data.pendingAction)
    : undefined;
  if (Object.hasOwn(data, "pendingAction") && !pendingAction) return emptyGoalState();
  const hasQueueFields = rawQueue !== undefined || pendingAction !== undefined;
  if (hasQueueFields || (isStoredGoal(rawGoal) && rawGoal.status === "queued")) {
    return legacyQueueState({
      retainedGoals: countCanonicalLegacyGoals(rawGoal, rawQueue, pendingAction),
    });
  }

  let goal = rawGoal === null || !isCanonicalGoal(rawGoal) ? undefined : normalizeLoadedGoal(rawGoal);
  if (goal?.status === "complete") goal = undefined;
  return { goal, legacyQueueState: undefined };
}

function countCanonicalLegacyGoals(
  goal: unknown,
  queue: LegacyStoredGoal[] | undefined,
  pendingAction: { kind: string } | undefined,
) {
  let count = isStoredGoal(goal) && goal.status !== "complete" ? 1 : 0;
  count += (queue ?? []).filter((queuedGoal) => queuedGoal.status !== "complete").length;
  if (pendingAction?.kind === "prioritize") count += 1;
  return count;
}

function normalizeCanonicalPendingAction(value: unknown): { kind: string } | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "prioritize" && validObjective(value.objective)) return { kind: "prioritize" };
  if (
    value.kind === "advance" &&
    typeof value.goalId === "string" &&
    value.goalId.trim() &&
    (value.reason === "complete" || value.reason === "skip") &&
    validObjective(value.completedText)
  ) {
    return { kind: "advance" };
  }
  return undefined;
}

function loadLegacyGoalsState(data: unknown): LoadedGoalState {
  if (!isRecord(data)) return emptyGoalState();
  let rawGoals: LegacyStoredGoal[];
  if (Array.isArray(data.goals)) {
    if (!data.goals.every(isStoredGoal)) return emptyGoalState();
    rawGoals = data.goals.filter((goal) => goal.status !== "complete");
  } else if (isStoredGoal(data.goal) && data.goal.status !== "complete") {
    rawGoals = [data.goal];
  } else {
    rawGoals = [];
  }
  const pendingAction = normalizeLegacyPendingPrioritize(data.pendingUnshift);
  const onlyGoal = rawGoals.length === 1 ? rawGoals[0] : undefined;
  if (onlyGoal && isCanonicalGoal(onlyGoal) && pendingAction === undefined) {
    return {
      goal: normalizeLoadedGoal(onlyGoal),
      legacyQueueState: undefined,
    };
  }
  if (rawGoals.length === 0 && pendingAction === undefined) return emptyGoalState();
  return legacyQueueState({
    retainedGoals: rawGoals.length + (pendingAction ? 1 : 0),
  });
}

function normalizeLegacyPendingPrioritize(value: unknown): { objective: string } | undefined {
  if (!isRecord(value) || !validObjective(value.objective)) return undefined;
  return { objective: value.objective };
}

function validObjective(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= 4_000;
}

export function normalizeLoadedGoal(goal: ActiveGoal): ActiveGoal {
  const now = Date.now();
  const waiting = goal.status === "active" ? normalizeGoalWait(goal.waiting) : undefined;
  const storedTokenBudget = normalizeTokenBudget(goal.tokenBudget);
  // Older releases silently assigned 250k when no budget was requested. Treat that exact legacy
  // value as implicit; old budget-limited goals become paused, never auto-resumed. New explicit
  // budgets carry the marker and survive reloads.
  const wasLegacyImplicitBudget =
    goal.tokenBudgetExplicit === undefined &&
    storedTokenBudget === LEGACY_IMPLICIT_TOKEN_BUDGET;
  const tokenBudgetExplicit =
    goal.tokenBudgetExplicit ??
    (storedTokenBudget !== undefined &&
      storedTokenBudget !== LEGACY_IMPLICIT_TOKEN_BUDGET);
  const status =
    wasLegacyImplicitBudget && goal.status === "budget_limited"
      ? "paused"
      : goal.status;
  return {
    ...goal,
    status,
    activationId: goal.activationId ?? goal.id,
    revision: goal.revision ?? 0,
    progressId: typeof goal.progressId === "string" && goal.progressId.length > 0 && goal.progressId.length <= 128 ? goal.progressId : goal.id,
    startedAt: isNonNegativeFiniteNumber(goal.startedAt) ? goal.startedAt : now,
    updatedAt: isNonNegativeFiniteNumber(goal.updatedAt) ? goal.updatedAt : now,
    iteration: Math.max(0, Math.floor(nonNegativeFiniteNumber(goal.iteration))),
    tokenBudget: tokenBudgetExplicit ? storedTokenBudget : undefined,
    tokenBudgetExplicit,
    tokensUsed: nonNegativeFiniteNumber(goal.tokensUsed),
    timeUsedSeconds: nonNegativeFiniteNumber(goal.timeUsedSeconds),
    baselineTokens: nonNegativeFiniteNumber(goal.baselineTokens),
    activeStartedAt: goal.status === "active" && !waiting ? now : undefined,
    automaticModelTurns: normalizeSafetyCounter(goal.automaticModelTurns),
    toolFreeRepeatCount: normalizeSafetyCounter(goal.toolFreeRepeatCount),
    lastToolFreeOutputFingerprint: normalizeOutputFingerprint(goal.lastToolFreeOutputFingerprint),
    safetyPauseCause: normalizeSafetyPauseCause(goal.safetyPauseCause),
    safetyResetPending: goal.safetyResetPending === true ? true : undefined,
    waiting,
    lastTaskUpdateAt: isNonNegativeFiniteNumber(goal.lastTaskUpdateAt) ? goal.lastTaskUpdateAt : undefined,
    lastWake: normalizeGoalWake(goal.lastWake),
    lastBlocker: normalizeGoalBlocker(goal.lastBlocker),
  };
}

function normalizeGoalBlocker(value: unknown): ActiveGoal["lastBlocker"] {
  if (!isRecord(value) || !Number.isSafeInteger(value.at) || (value.at as number) < 0 ||
      typeof value.reason !== "string" || typeof value.evidence !== "string" ||
      !Number.isSafeInteger(value.repeatedTurns) || (value.repeatedTurns as number) < 3) return undefined;
  return { at: value.at as number, reason: value.reason.slice(0, 1_000), evidence: value.evidence.slice(0, 4_000), repeatedTurns: value.repeatedTurns as number };
}

function normalizeSafetyCounter(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeOutputFingerprint(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : undefined;
}

function normalizeSafetyPauseCause(value: unknown): SafetyPauseCause | undefined {
  return value === "continuation_limit" || value === "no_progress" ? value : undefined;
}

export function clearLegacyPersistedGoal(_cwd: string) {
  // The Paseo adaptation owns session entries only. Leave legacy global files
  // untouched rather than rewriting potentially corrupt or concurrently edited data.
}

function isStoredGoal(value: unknown): value is LegacyStoredGoal {
  if (!isRecord(value)) return false;
  try {
    validateGoalLimitOverrides(value.continuationLimits);
    if (value.tasks !== undefined) {
      const tasks = validateProgressArguments({ steps: value.tasks }).steps;
      if (tasks.some(step => !step.id) || new Set(tasks.map(step => step.id)).size !== tasks.length) return false;
    }
  } catch { return false; }
  if (value.activationId !== undefined && (typeof value.activationId !== "string" || !value.activationId || value.activationId.length > 128)) return false;
  if (value.revision !== undefined && (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0)) return false;
  return (
    typeof value.id === "string" &&
    Boolean(value.id) &&
    value.id === value.id.trim() &&
    validObjective(value.text) &&
    ["active", "queued", "paused", "blocked", "usage_limited", "budget_limited", "complete"].includes(
      String(value.status),
    ) &&
    typeof value.startedAt === "number" &&
    typeof value.updatedAt === "number" &&
    typeof value.iteration === "number" &&
    typeof value.tokensUsed === "number" &&
    typeof value.timeUsedSeconds === "number" &&
    typeof value.baselineTokens === "number" &&
    (value.activeStartedAt === undefined || typeof value.activeStartedAt === "number") &&
    (value.tokenBudgetExplicit === undefined || typeof value.tokenBudgetExplicit === "boolean") &&
    (value.safetyResetPending === undefined || typeof value.safetyResetPending === "boolean")
  );
}

function isCanonicalGoal(goal: LegacyStoredGoal): goal is ActiveGoal {
  return goal.status !== "queued";
}

function isQueueGoal(value: unknown): value is LegacyStoredGoal {
  return isStoredGoal(value) && value.status !== "complete";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyGoalState(): LoadedGoalState {
  return {
    goal: undefined,
    legacyQueueState: undefined,
  };
}

function legacyQueueState(legacyQueue: LegacyQueueState): LoadedGoalState {
  return {
    goal: undefined,
    legacyQueueState: legacyQueue,
  };
}
