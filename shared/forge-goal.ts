import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Public in-repo forge/watch bridge. Session scope is the ExtensionAPI instance.
 * Guards cover autonomous goal_complete and explicit paused goal_manage complete
 * only; both routes await checks immediately before shared lifecycle transition.
 * Other extensions' private transitions/post-transition reporting are outside
 * this guard. Checklist/event payloads are never guard results: callbacks must
 * fetch/check their own authority.
 */
export interface ForgeGoalIdentity {
  goalId: string;
  activationId: string;
}

export interface ForgeGoalSnapshot extends ForgeGoalIdentity {
  status: "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete";
  waiting: boolean;
  waitReason?: string;
}

export interface ForgeGoalBinding {
  snapshot(): ForgeGoalSnapshot | undefined;
  wakeSubscriptions: Map<string, ForgeGoalIdentity>;
  completionGuards: Map<string, { identity: ForgeGoalIdentity; check: (identity: ForgeGoalIdentity) => Promise<string | undefined> }>;
  nextId(): string;
  sendWake(identity: ForgeGoalIdentity, subscriptionId: string, message: string): boolean;
}

const bindings = new WeakMap<ExtensionAPI, ForgeGoalBinding>();

/** Internal registration is called once by the in-repo Goal extension. */
export function bindForgeGoal(pi: ExtensionAPI, binding: ForgeGoalBinding): () => void {
  bindings.set(pi, binding);
  return () => { if (bindings.get(pi) === binding) bindings.delete(pi); };
}

/** Read authoritative live Goal state; absent/terminal goals return undefined. */
export function getCurrentForgeGoal(pi: ExtensionAPI): ForgeGoalSnapshot | undefined {
  return bindings.get(pi)?.snapshot();
}

/** Explicitly authorize a watcher to wake exactly one active, waiting activation. */
export function subscribeForgeGoalWake(pi: ExtensionAPI, identity: ForgeGoalIdentity): { subscriptionId: string; unsubscribe(): void } | undefined {
  const binding = bindings.get(pi);
  const current = binding?.snapshot();
  if (!binding || !current || !current.waiting || current.status !== "active" || !matches(current, identity)) return undefined;
  const subscriptionId = binding.nextId();
  binding.wakeSubscriptions.set(subscriptionId, { ...identity });
  return { subscriptionId, unsubscribe: () => binding.wakeSubscriptions.delete(subscriptionId) };
}

export function consumeForgeGoalWake(pi: ExtensionAPI, identity: ForgeGoalIdentity, subscriptionId: string): boolean {
  const binding = bindings.get(pi);
  const current = binding?.snapshot();
  const subscribed = binding?.wakeSubscriptions.get(subscriptionId);
  if (!binding || !current || !current.waiting || current.status !== "active" || !subscribed || !matches(current, identity) || !matches(subscribed, identity)) return false;
  binding.wakeSubscriptions.delete(subscriptionId);
  return true;
}

/** Deliver only through Goal's normal custom-message wake routing. */
export function wakeForgeGoal(pi: ExtensionAPI, identity: ForgeGoalIdentity, subscriptionId: string, message: string): boolean {
  return bindings.get(pi)?.sendWake(identity, subscriptionId, message) ?? false;
}

/** Register a fresh async completion check; its result is never supplied by the model/event payload. */
export function registerForgeGoalCompletionGuard(
  pi: ExtensionAPI,
  identity: ForgeGoalIdentity,
  guard: (identity: ForgeGoalIdentity) => Promise<string | undefined>,
): () => void {
  const binding = bindings.get(pi);
  if (!binding) throw new Error("Goal runtime is not available in this session");
  const id = binding.nextId();
  const current = binding.snapshot();
  if (!current || !matches(current, identity)) throw new Error("Completion guard requires the exact current Goal activation");
  binding.completionGuards.set(id, { identity: { ...identity }, check: guard });
  return () => binding.completionGuards.delete(id);
}

export async function checkForgeGoalCompletionGuards(pi: ExtensionAPI, identity: ForgeGoalIdentity): Promise<string | undefined> {
  const binding = bindings.get(pi);
  if (!binding) return undefined;
  for (const entry of [...binding.completionGuards.values()]) {
    if (!matches(entry.identity, identity)) continue;
    try {
      const rejection = await entry.check({ ...identity });
      if (rejection) return rejection;
    } catch {
      return "A registered Goal completion check failed; completion was denied.";
    }
  }
  return undefined;
}

function matches(a: ForgeGoalIdentity, b: ForgeGoalIdentity): boolean {
  return a.goalId === b.goalId && a.activationId === b.activationId;
}
