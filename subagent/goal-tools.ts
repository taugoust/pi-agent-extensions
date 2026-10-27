export const DEDICATED_GOAL_TOOLS = ["goal_manage", "goal_complete", "goal_blocked", "goal_wait", "update_progress"] as const;
/** Goal bootstrap must never undo an explicit caller/profile tool restriction. */
export function dedicatedGoalTools(parentTools: readonly string[]): string[] {
  const allowed = new Set(parentTools);
  const missing = DEDICATED_GOAL_TOOLS.filter(tool => !allowed.has(tool));
  if (missing.length) throw new Error(`Dedicated goal requires parent-allowed tools: ${missing.join(", ")}`);
  return [...DEDICATED_GOAL_TOOLS];
}
