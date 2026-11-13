/** Optional Goal extensions are loaded separately, never through the basic permission proxy. */
export function guardedGoalBaseTools(requested: string[] | undefined, authorizedGoalTools?: readonly string[]): string[] | undefined {
  return requested?.filter(tool => !(["questionnaire", "goal_reference"].includes(tool) && authorizedGoalTools?.includes(tool)));
}

export const DEDICATED_GOAL_TOOLS = ["goal_manage", "goal_complete", "goal_blocked", "goal_wait", "update_progress"] as const;
/** Goal bootstrap must never undo an explicit caller/profile tool restriction. */
export function dedicatedGoalTools(parentTools: readonly string[]): string[] {
  const allowed = new Set(parentTools);
  const missing = DEDICATED_GOAL_TOOLS.filter(tool => !allowed.has(tool));
  if (missing.length) throw new Error(`Dedicated goal requires parent-allowed tools: ${missing.join(", ")}`);
  const optional = [
    ...(allowed.has("questionnaire") ? ["questionnaire"] : []),
    ...(allowed.has("goal_reference") && allowed.has("read") ? ["goal_reference"] : []),
    ...(allowed.has("goal_pr") ? ["goal_pr"] : []),
  ];
  return [...DEDICATED_GOAL_TOOLS, ...optional];
}
