import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { GoalRuntime } from "./runtime.js";
import type { GoalCommandController } from "./commands.js";
/** Native public Pi dialogs; the Paseo dashboard provides the richer management UI. */
export async function showGoalManager(
	runtime: GoalRuntime,
	commands: GoalCommandController,
	ctx: ExtensionCommandContext,
	_settings?: (ctx: ExtensionCommandContext, target?: string) => Promise<void>,
) {
	const generation = runtime.menuGeneration,
		owner = runtime.menuController,
		goalId = runtime.activeGoal?.id,
		activationId = runtime.activeGoal?.activationId;
	const sameSession = () =>
		runtime.menuGeneration === generation &&
		runtime.menuController === owner &&
		!owner.signal.aborted;
	const current = () => sameSession() && runtime.activeGoal?.id === goalId && runtime.activeGoal?.activationId === activationId;
	commands.showGoal(ctx);
	if (!ctx.hasUI || !current()) return;
	const action = await ctx.ui.select(
		"Goal",
		["Start goal", "Pause", "Resume", "Clear", "Close"],
		{ signal: owner.signal },
	);
	if (!current()) return;
	if (action === "Start goal") {
		const text = await ctx.ui.input(
			"Goal objective",
			"One sentence: what verifiable outcome should exist?",
		);
		if (text?.trim() && current())
			await commands.startGoal(
				text.trim(),
				undefined,
				ctx,
				undefined,
				undefined,
				sameSession,
			);
	} else if (action === "Pause") commands.pauseGoal(ctx);
	else if (action === "Resume") await commands.resumeGoal(ctx);
	else if (action === "Clear") {
		const id = runtime.activeGoal?.id;
		if (
			await ctx.ui.confirm(
				"Clear goal?",
				"Discard the current goal and pending continuation?",
			)
		) {
			if (current() && runtime.activeGoal?.id === id) commands.clearGoal(ctx);
		}
	}
}
