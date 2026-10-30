/** Engine-owned evidence, separate from a checklist, ownership or execution authority. */
export type GoalDiagnostics = {
  waitDeadline?: number | null; lastTaskUpdateAt?: number | null;
  lastWake?: { at: number; reason: "deadline" | "custom_message" | "user_input" | "explicit_resume"; customType?: string } | null;
  lastBlocker?: { at: number; reason: string; evidence: string; repeatedTurns: number } | null;
};
export function validateGoalDiagnostics(value: GoalDiagnostics | undefined): void {
  if (value === undefined) return;
  const at = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["waitDeadline", "lastTaskUpdateAt", "lastWake", "lastBlocker"].includes(key))) throw new Error("Invalid goal diagnostics");
  for (const key of ["waitDeadline", "lastTaskUpdateAt"] as const) if (value[key] != null && !at(value[key])) throw new Error("Invalid goal diagnostic timestamp");
  const wake = value.lastWake;
  if (wake != null && (!at(wake.at) || !["deadline", "custom_message", "user_input", "explicit_resume"].includes(wake.reason) || (wake.customType !== undefined && (typeof wake.customType !== "string" || wake.customType.length > 128)))) throw new Error("Invalid goal wake evidence");
  const blocker = value.lastBlocker;
  if (blocker != null && (!at(blocker.at) || typeof blocker.reason !== "string" || blocker.reason.length > 1000 || typeof blocker.evidence !== "string" || blocker.evidence.length > 4000 || !Number.isSafeInteger(blocker.repeatedTurns) || blocker.repeatedTurns < 0)) throw new Error("Invalid goal blocker evidence");
}
