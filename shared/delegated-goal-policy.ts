/** Explicit dedicated-child limits, independent of either agent directory's settings.
 * Kept dependency-free so subagent-only bundles need not load workflows.
 */
export const DEDICATED_GOAL_LIMITS = Object.freeze({ automaticTurns: 3, noProgressTurns: 2 });
