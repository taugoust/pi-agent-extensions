import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  bindForgeGoal,
  FORGE_GOAL_GUARD_ENTRY,
  FORGE_GOAL_READY_EVENT,
  identityMatches,
  type ForgeGoalIdentity,
} from "../../shared/forge-goal.ts";
import type { GoalRuntime } from "./runtime.js";

/** Real session bridge implementation shared by Goal runtime registration and focused fixtures. */
export function bindGoalForgeBridge(pi: ExtensionAPI, runtime: GoalRuntime) {
  const wakeSubscriptions = new Map<string, { identity: ForgeGoalIdentity; pending: boolean }>();
  const completionGuards = new Map<string, { identity: ForgeGoalIdentity; check: (identity: ForgeGoalIdentity, signal?: AbortSignal) => Promise<string | undefined> }>();
  const requiredGuardKeys = new Map<string, Set<string>>();
  let bridgeGeneration = 0, bridgeStateVersion = 0, bridgeReady = false;
  let disposeBridge: (() => void) | undefined;
  const refreshGuardMarkers = (ctx: ExtensionContext) => {
    requiredGuardKeys.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== FORGE_GOAL_GUARD_ENTRY) continue;
      const data = entry.data as { goalId?: unknown; key?: unknown } | undefined;
      if (typeof data?.goalId !== "string" || typeof data.key !== "string") continue;
      const keys = requiredGuardKeys.get(data.goalId) ?? new Set<string>();
      keys.add(data.key); requiredGuardKeys.set(data.goalId, keys);
    }
  };
  const invalidate = () => { wakeSubscriptions.clear(); completionGuards.clear(); bridgeStateVersion++; };
  const bridge = {
    ready: () => bridgeReady,
    snapshot: () => {
      const goal = runtime.activeGoal;
      if (!goal) return undefined;
      return { goalId: goal.id, activationId: goal.activationId ?? goal.id, status: goal.status, waiting: goal.status === "active" && !!goal.waiting, ...(goal.waiting ? { waitReason: goal.waiting.reason } : {}) };
    },
    subscribe: (identity: ForgeGoalIdentity) => {
      const goal = runtime.activeGoal;
      if (!bridgeReady || !goal || goal.status !== "active" || !identityMatches({ goalId: goal.id, activationId: goal.activationId ?? goal.id }, identity)) return undefined;
      const id = `${Date.now()}-${++bridgeGeneration}`;
      wakeSubscriptions.set(id, { identity: { ...identity }, pending: false });
      return id;
    },
    unsubscribe: (id: string) => wakeSubscriptions.delete(id),
    wake: (identity: ForgeGoalIdentity, id: string, message: string) => {
      const goal = runtime.activeGoal, subscription = wakeSubscriptions.get(id);
      const current = goal && { goalId: goal.id, activationId: goal.activationId ?? goal.id };
      if (!bridgeReady || !goal || goal.status !== "active" || !goal.waiting || !current || !subscription || subscription.pending || !identityMatches(current, identity) || !identityMatches(subscription.identity, identity)) return false;
      subscription.pending = true;
      try { pi.sendMessage({ customType: "forge-goal-wake", content: message.slice(0, 4_000), details: { goalId: identity.goalId, activationId: identity.activationId, subscriptionId: id } }, { deliverAs: "followUp", triggerTurn: true }); return true; }
      catch { subscription.pending = false; return false; }
    },
    consume: (identity: ForgeGoalIdentity, id: string) => {
      const goal = runtime.activeGoal, current = goal && { goalId: goal.id, activationId: goal.activationId ?? goal.id }, subscription = wakeSubscriptions.get(id);
      if (!bridgeReady || !goal || goal.status !== "active" || !goal.waiting || !current || !subscription?.pending || !identityMatches(current, identity) || !identityMatches(subscription.identity, identity)) return false;
      wakeSubscriptions.delete(id); return true;
    },
    registerGuard: (identity: ForgeGoalIdentity, key: string, check: (identity: ForgeGoalIdentity, signal?: AbortSignal) => Promise<string | undefined>) => {
      const goal = runtime.activeGoal, current = goal && { goalId: goal.id, activationId: goal.activationId ?? goal.id };
      if (!bridgeReady || !goal || !["active", "paused"].includes(goal.status) || !current || !identityMatches(current, identity) || !key || key.length > 256 || typeof check !== "function") throw new Error("Guard requires exact current Goal activation and stable key");
      const keys = requiredGuardKeys.get(identity.goalId) ?? new Set<string>();
      if (!keys.has(key)) { pi.appendEntry(FORGE_GOAL_GUARD_ENTRY, { goalId: identity.goalId, key }); keys.add(key); requiredGuardKeys.set(identity.goalId, keys); }
      const id = `${identity.goalId}:${key}`;
      completionGuards.set(id, { identity: { ...identity }, check });
      bridgeStateVersion++;
      return () => { if (completionGuards.get(id)?.check === check) { completionGuards.delete(id); bridgeStateVersion++; } };
    },
    checkGuards: async (identity: ForgeGoalIdentity, signal?: AbortSignal) => {
      const authorizedStatus = () => {
        const goal = runtime.activeGoal;
        if (!goal || !identityMatches({ goalId: goal.id, activationId: goal.activationId ?? goal.id }, identity)) return false;
        return ["active", "paused"].includes(goal.status) || (goal.status === "budget_limited" && runtime.hasActiveBudgetWrapUp());
      };
      signal?.throwIfAborted();
      const initial = bridge.snapshot();
      if (!bridgeReady || !initial || !identityMatches(initial, identity) || !authorizedStatus()) return "Goal identity changed before completion checks; completion denied";
      const version = bridgeStateVersion, keys = [...(requiredGuardKeys.get(identity.goalId) ?? new Set<string>())];
      for (const key of keys) {
        const entry = completionGuards.get(`${identity.goalId}:${key}`);
        if (!entry || !identityMatches(entry.identity, identity)) return `Required completion guard '${key}' is unavailable for this Goal activation`;
        try {
          signal?.throwIfAborted();
          const rejection = await entry.check({ ...identity }, signal);
          signal?.throwIfAborted();
          if (rejection) return rejection;
        } catch (error) {
          if (signal?.aborted) throw error;
          return `Required completion guard '${key}' failed; completion was denied`;
        }
        const latest = bridge.snapshot();
        if (bridgeStateVersion !== version || !latest || !identityMatches(latest, identity) || !authorizedStatus() || completionGuards.get(`${identity.goalId}:${key}`) !== entry)
          return "Goal activation or completion guards changed during fresh verification; completion denied";
      }
      const final = bridge.snapshot();
      if (bridgeStateVersion !== version || !final || !identityMatches(final, identity) || !authorizedStatus()) return "Goal activation or completion guards changed during fresh verification; completion denied";
      return undefined;
    },
  };
  disposeBridge = bindForgeGoal(pi.events, bridge);
  return {
    beginSession(ctx: ExtensionContext) {
      bridgeReady = false; disposeBridge?.(); invalidate(); refreshGuardMarkers(ctx); disposeBridge = bindForgeGoal(pi.events, bridge);
    },
    beginTree() { bridgeReady = false; invalidate(); requiredGuardKeys.clear(); },
    refreshMarkers(ctx: ExtensionContext) { invalidate(); refreshGuardMarkers(ctx); },
    markReady() {
      bridgeReady = true;
      const goal = runtime.activeGoal;
      pi.events.emit(FORGE_GOAL_READY_EVENT, goal ? { goalId: goal.id, activationId: goal.activationId ?? goal.id } : {});
    },
    shutdown() { bridgeReady = false; disposeBridge?.(); disposeBridge = undefined; invalidate(); requiredGuardKeys.clear(); },
  };
}
