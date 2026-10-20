import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GoalRuntime } from "./runtime.js";
export async function showGoalSettings(
	runtime: GoalRuntime,
	ctx: ExtensionCommandContext,
	_options?: unknown,
) {
	ctx.ui.notify(
		`Goal limits: ${runtime.settings.continuationLimits.automaticTurns} automatic responses, ${runtime.settings.continuationLimits.noProgressTurns} repeated no-progress runs. Configure pi-goal.json to change limits.`,
		"info",
	);
}
