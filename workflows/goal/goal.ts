import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGoalCommand } from "./command-registration.js";
import { GoalCommandController } from "./commands.js";
import { registerGoalLifecycle } from "./lifecycle.js";
import { GoalRunController } from "./run-protocol.js";
import { GoalRuntime } from "./runtime.js";
import { bindForgeGoal, FORGE_GOAL_GUARD_ENTRY, identityMatches, type ForgeGoalIdentity } from "../../shared/forge-goal.ts";
import { registerGoalTools } from "./tools.js";

interface GoalOptions {
  settingsPath?: string;
  /** Dedicated workers restore metadata only; activation requires structured Resume. */
  restorePaused?: boolean;
}

function registerGoalRuntime(pi: ExtensionAPI, options: GoalOptions = {}) {
  const runtime = new GoalRuntime(pi);
  const wakeSubscriptions = new Map<string, { identity: ForgeGoalIdentity; pending: boolean }>();
  const completionGuards = new Map<string, { identity: ForgeGoalIdentity; check: (identity: ForgeGoalIdentity) => Promise<string | undefined> }>();
  const requiredGuardKeys = new Map<string, Set<string>>();
  let bridgeGeneration = 0;
  let bridgeStateVersion = 0;
  let disposeBridge: (() => void) | undefined;
  const bridge = {
    snapshot: () => {
      const goal = runtime.activeGoal;
      if (!goal) return undefined;
      return { goalId: goal.id, activationId: goal.activationId ?? goal.id, status: goal.status, waiting: goal.status === "active" && !!goal.waiting, ...(goal.waiting ? { waitReason: goal.waiting.reason } : {}) };
    },
    subscribe: (identity: ForgeGoalIdentity) => {
      const goal = runtime.activeGoal;
      if (!goal || goal.status !== "active" || !identityMatches({ goalId: goal.id, activationId: goal.activationId ?? goal.id }, identity)) return undefined;
      const id = `${Date.now()}-${++bridgeGeneration}`;
      wakeSubscriptions.set(id, { identity: { ...identity }, pending: false });
      return id;
    },
    unsubscribe: (id: string) => wakeSubscriptions.delete(id),
    wake: (identity: ForgeGoalIdentity, id: string, message: string) => {
      const goal = runtime.activeGoal, subscription = wakeSubscriptions.get(id);
      const current = goal && { goalId: goal.id, activationId: goal.activationId ?? goal.id };
      if (!goal || goal.status !== "active" || !goal.waiting || !current || !subscription || subscription.pending || !identityMatches(current, identity) || !identityMatches(subscription.identity, identity)) return false;
      subscription.pending = true;
      try { pi.sendMessage({ customType: "forge-goal-wake", content: message.slice(0, 4_000), details: { goalId: identity.goalId, activationId: identity.activationId, subscriptionId: id } }, { deliverAs: "followUp", triggerTurn: true }); return true; }
      catch { subscription.pending = false; return false; }
    },
    consume: (identity: ForgeGoalIdentity, id: string) => {
      const goal = runtime.activeGoal, current = goal && { goalId: goal.id, activationId: goal.activationId ?? goal.id }, subscription = wakeSubscriptions.get(id);
      if (!goal || goal.status !== "active" || !goal.waiting || !current || !subscription?.pending || !identityMatches(current, identity) || !identityMatches(subscription.identity, identity)) return false;
      wakeSubscriptions.delete(id); return true;
    },
    registerGuard: (identity: ForgeGoalIdentity, key: string, check: (identity: ForgeGoalIdentity) => Promise<string | undefined>) => {
      const goal = runtime.activeGoal, current = goal && { goalId: goal.id, activationId: goal.activationId ?? goal.id };
      if (!goal || !["active", "paused"].includes(goal.status) || !current || !identityMatches(current, identity) || !key || key.length > 256 || typeof check !== "function") throw new Error("Guard requires exact current Goal activation and stable key");
      const keys = requiredGuardKeys.get(identity.goalId) ?? new Set<string>();
      if (!keys.has(key)) { pi.appendEntry(FORGE_GOAL_GUARD_ENTRY, { goalId: identity.goalId, key }); keys.add(key); requiredGuardKeys.set(identity.goalId, keys); }
      const id = `${identity.goalId}:${key}`;
      completionGuards.set(id, { identity: { ...identity }, check });
      bridgeStateVersion++;
      return () => { if (completionGuards.get(id)?.check === check) { completionGuards.delete(id); bridgeStateVersion++; } };
    },
    checkGuards: async (identity: ForgeGoalIdentity) => {
      const initial = bridge.snapshot();
      if (!initial || !identityMatches(initial, identity) || !["active", "paused"].includes(initial.status)) return "Goal identity changed before completion checks; completion denied";
      const version = bridgeStateVersion;
      const keys = [...(requiredGuardKeys.get(identity.goalId) ?? new Set<string>())];
      for (const key of keys) {
        const entry = completionGuards.get(`${identity.goalId}:${key}`);
        if (!entry || !identityMatches(entry.identity, identity)) return `Required completion guard '${key}' is unavailable for this Goal activation`;
        try {
          const rejection = await entry.check({ ...identity });
          if (rejection) return rejection;
        } catch { return `Required completion guard '${key}' failed; completion was denied`; }
        const latest = bridge.snapshot();
        if (bridgeStateVersion !== version || !latest || !identityMatches(latest, identity) || !["active", "paused"].includes(latest.status) || completionGuards.get(`${identity.goalId}:${key}`) !== entry)
          return "Goal activation or completion guards changed during fresh verification; completion denied";
      }
      const final = bridge.snapshot();
      if (bridgeStateVersion !== version || !final || !identityMatches(final, identity) || !["active", "paused"].includes(final.status))
        return "Goal activation or completion guards changed during fresh verification; completion denied";
      return undefined;
    },
  };
  pi.on("session_start", (_event, ctx) => {
    disposeBridge?.(); wakeSubscriptions.clear(); completionGuards.clear(); requiredGuardKeys.clear(); bridgeStateVersion++;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== FORGE_GOAL_GUARD_ENTRY) continue;
      const data = entry.data as { goalId?: unknown; key?: unknown } | undefined;
      if (typeof data?.goalId !== "string" || typeof data.key !== "string") continue;
      const keys = requiredGuardKeys.get(data.goalId) ?? new Set<string>(); keys.add(data.key); requiredGuardKeys.set(data.goalId, keys);
    }
    disposeBridge = bindForgeGoal(pi.events, bridge);
  });
  // The bus listener is inert before a session exists and supports extensions loaded late.
  disposeBridge = bindForgeGoal(pi.events, bridge);
  pi.on("session_shutdown", () => { disposeBridge?.(); disposeBridge = undefined; wakeSubscriptions.clear(); completionGuards.clear(); bridgeStateVersion++; });
  pi.on("cache_warming_decision", () => runtime.activeGoal?.status === "active" && !!runtime.activeGoal.waiting ? { action: "stop" } : undefined);
  const commands = new GoalCommandController(runtime);
  const runController = new GoalRunController(runtime, commands);

  // Keep registration order explicit: managed-run bus listeners exist before tools,
  // command routing, and session lifecycle bind the per-factory runtime.
  runController.register(pi);
  registerGoalTools(pi, runtime);
  registerGoalCommand(pi, runtime, commands, options);
  registerGoalLifecycle(pi, runtime, runController, options);
  return { runtime, commands };
}

export default function goal(pi: ExtensionAPI, options: GoalOptions = {}) {
  return registerGoalRuntime(pi, options);
}

export {
  assistantUsageTokens,
  cumulativeAssistantTokens,
  formatDuration,
  formatTokenCount,
} from "./accounting.js";

export {
  completeGoalArguments,
  parseCommand,
  parseTokenBudget,
  validateObjective,
} from "./command.js";

export { buildGoalSystemPrompt } from "./prompts.js";

export {
  findFinalAssistantMessage,
  formatStatus,
  isContradictoryCompletionSummary,
  isRetryableGoalInterruption,
  isUsageLimitedGoalInterruption,
} from "./runtime.js";
