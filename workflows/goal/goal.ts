import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGoalCommand } from "./command-registration.js";
import { GoalCommandController } from "./commands.js";
import { bindGoalForgeBridge } from "./forge-bridge.js";
import { registerGoalLifecycle } from "./lifecycle.js";
import { GoalRunController } from "./run-protocol.js";
import { GoalRuntime } from "./runtime.js";
import { registerGoalTools } from "./tools.js";

interface GoalOptions {
  settingsPath?: string;
  /** Dedicated workers restore metadata only; activation requires structured Resume. */
  restorePaused?: boolean;
}

function registerGoalRuntime(pi: ExtensionAPI, options: GoalOptions = {}) {
  const runtime = new GoalRuntime(pi);
  const forgeBridge = bindGoalForgeBridge(pi, runtime);
  const commands = new GoalCommandController(runtime);
  const runController = new GoalRunController(runtime, commands);

  pi.on("session_start", (_event, ctx) => forgeBridge.beginSession(ctx));
  pi.on("session_tree", () => forgeBridge.beginTree());
  pi.on("session_shutdown", () => forgeBridge.shutdown());
  pi.on("cache_warming_decision", () => runtime.activeGoal?.status === "active" && !!runtime.activeGoal.waiting ? { action: "stop" } : undefined);

  // Keep registration order explicit: managed-run bus listeners exist before tools,
  // command routing, and session lifecycle bind the per-factory runtime.
  runController.register(pi);
  registerGoalTools(pi, runtime);
  registerGoalCommand(pi, runtime, commands, options);
  registerGoalLifecycle(pi, runtime, runController, {
    ...options,
    refreshForgeGoalMarkers: ctx => forgeBridge.refreshMarkers(ctx),
  });
  // Readiness becomes true only after GoalLifecycle has fully restored current branch state.
  pi.on("session_start", () => forgeBridge.markReady());
  pi.on("session_tree", () => forgeBridge.markReady());
  return { runtime, commands, forgeBridge };
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
