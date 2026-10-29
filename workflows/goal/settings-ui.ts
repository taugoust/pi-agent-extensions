import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GoalRuntime } from "./runtime.js";
export async function showGoalSettings(
	runtime: GoalRuntime,
	ctx: ExtensionCommandContext,
	_options?: unknown,
) {
	if (!ctx.hasUI) return;
	const format = (value: number | null) => value === null ? "unlimited" : String(value);
	const defaults = runtime.settings.continuationLimits;
	const effective = runtime.continuationLimits;
	ctx.ui.notify(
		`Default limits: ${format(defaults.automaticTurns)} automatic responses, ${format(defaults.noProgressTurns)} repeated no-progress runs. Configure pi-goal.json to change defaults.${runtime.activeGoal ? ` Current goal effective limits: ${format(effective.automaticTurns)} automatic responses, ${format(effective.noProgressTurns)} repeated no-progress runs; use the goal limit editor for this goal.` : ""}`,
		"info",
	);
}
