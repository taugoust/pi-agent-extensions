/** Dedicated bootstrap identity is execution-local, never inherited by ordinary workers. */
export function setDedicatedGoalEnvironment(env: Record<string, string | undefined>, binding?: unknown): void {
  delete env.PI_DEDICATED_GOAL_CHILD;
  delete env.PI_DEDICATED_GOAL_BINDING;
  if (binding !== undefined) {
    env.PI_DEDICATED_GOAL_CHILD = "1";
    env.PI_DEDICATED_GOAL_BINDING = JSON.stringify(binding);
  }
}
