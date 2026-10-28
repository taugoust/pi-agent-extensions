import type { AgentProfileLaunchInput } from "./profiles.ts";

/** New coordinators use the named role; retained attempts never rediscover it.
 * The caller's model resolver remains responsible for current provider/account
 * authority and unavailable-model errors before any attempt is mutated.
 */
export async function resolveCoordinatorRole<T extends AgentProfileLaunchInput>(
  retained: T | undefined,
  discover: (input: { agent: "coordinator" }) => Promise<T>,
): Promise<T> {
  return retained ?? await discover({ agent: "coordinator" });
}
