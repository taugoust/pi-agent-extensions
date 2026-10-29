/** Shared defaults and per-goal overrides; dependency-free for narrow bundles. */
export type GoalContinuationLimits = { automaticTurns: number | null; noProgressTurns: number | null };
export const DEDICATED_GOAL_LIMITS: Readonly<GoalContinuationLimits> = Object.freeze({ automaticTurns: null, noProgressTurns: null });
export function validateGoalLimitOverrides(value: unknown): asserts value is Partial<GoalContinuationLimits> | undefined {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.entries(value).some(([key, limit]) => !["automaticTurns", "noProgressTurns"].includes(key)
      || (limit !== null && !(Number.isSafeInteger(limit) && limit > 0)))) throw new Error("Invalid goal continuation limits");
}
export function resolveGoalLimits(overrides: Partial<GoalContinuationLimits> | undefined, defaults: GoalContinuationLimits): GoalContinuationLimits {
  validateGoalLimitOverrides(overrides);
  return { automaticTurns: overrides?.automaticTurns ?? defaults.automaticTurns, noProgressTurns: overrides?.noProgressTurns ?? defaults.noProgressTurns };
}
