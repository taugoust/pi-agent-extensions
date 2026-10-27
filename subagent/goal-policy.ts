export type DedicatedGoalPolicy = { continuationLimits: { automaticTurns: number | null; noProgressTurns: number | null } };
/** Accept only the limits displayed by the parent confirmation, never arbitrary settings. */
export function dedicatedGoalPolicy(input: unknown): DedicatedGoalPolicy {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "continuationLimits"))
    throw new Error("Dedicated goal requires explicitly confirmed continuation limits");
  const limits = (input as DedicatedGoalPolicy).continuationLimits;
  if (!limits || typeof limits !== "object" || Array.isArray(limits)
    || Object.keys(limits).sort().join(",") !== "automaticTurns,noProgressTurns"
    || Object.values(limits).some(value => value !== null && !(Number.isSafeInteger(value) && value! > 0)))
    throw new Error("Invalid confirmed dedicated goal continuation limits");
  return structuredClone({ continuationLimits: limits });
}
export function sameGoalLimits(a: DedicatedGoalPolicy["continuationLimits"], b: unknown): boolean {
  if (!b || typeof b !== "object" || Array.isArray(b)) return false;
  const value = b as DedicatedGoalPolicy["continuationLimits"];
  return Object.keys(value).sort().join(",") === "automaticTurns,noProgressTurns"
    && a.automaticTurns === value.automaticTurns && a.noProgressTurns === value.noProgressTurns;
}
