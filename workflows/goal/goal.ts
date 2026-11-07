import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGoalCommand } from "./command-registration.js";
import { GoalCommandController } from "./commands.js";
import { registerGoalLifecycle } from "./lifecycle.js";
import { GoalRunController } from "./run-protocol.js";
import { GoalRuntime } from "./runtime.js";
import { bindForgeGoal, type ForgeGoalIdentity } from "../../shared/forge-goal.ts";
import { registerGoalTools } from "./tools.js";

interface GoalOptions {
  settingsPath?: string;
  /** Dedicated workers restore metadata only; activation requires structured Resume. */
  restorePaused?: boolean;
}

function registerGoalRuntime(pi: ExtensionAPI, options: GoalOptions = {}) {
  const runtime = new GoalRuntime(pi);
  const wakeSubscriptions = new Map<string, ForgeGoalIdentity>();
  const completionGuards = new Map<string, { identity: ForgeGoalIdentity; check: (identity: ForgeGoalIdentity) => Promise<string | undefined> }>();
  let bridgeGeneration = 0;
  bindForgeGoal(pi, {
    wakeSubscriptions,
    completionGuards,
    nextId: () => `${Date.now()}-${++bridgeGeneration}`,
    snapshot: () => {
      const goal = runtime.activeGoal;
      if (!goal) return undefined;
      return { goalId: goal.id, activationId: goal.activationId ?? goal.id, status: goal.status, waiting: goal.status === "active" && !!goal.waiting, ...(goal.waiting ? { waitReason: goal.waiting.reason } : {}) };
    },
    sendWake: (identity, subscriptionId, message) => {
      const goal = runtime.activeGoal;
      const current = goal && { goalId: goal.id, activationId: goal.activationId ?? goal.id };
      const subscribed = wakeSubscriptions.get(subscriptionId);
      if (!goal || goal.status !== "active" || !goal.waiting || !current || !subscribed || current.goalId !== identity.goalId || current.activationId !== identity.activationId || subscribed.goalId !== identity.goalId || subscribed.activationId !== identity.activationId) return false;
      try {
        pi.sendMessage({ customType: "forge-goal-wake", content: message.slice(0, 4_000), details: { goalId: identity.goalId, activationId: identity.activationId, subscriptionId } }, { deliverAs: "followUp", triggerTurn: true });
        return true;
      } catch {
        return false;
      }
    },
  });
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
