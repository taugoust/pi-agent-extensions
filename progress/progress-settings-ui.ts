import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ProgressSettings } from "./settings.js";
export async function showProgressSettings(
	ctx: ExtensionCommandContext,
	state: {
		signal: AbortSignal;
		isCurrent(): boolean;
		get(): ProgressSettings;
		save(
			patch: Partial<ProgressSettings>,
			signal: AbortSignal,
		): Promise<ProgressSettings>;
		apply(settings: ProgressSettings): void;
	},
): Promise<"back" | "close" | "stale"> {
	while (state.isCurrent() && !state.signal.aborted) {
		const settings = state.get();
		const keys = Object.keys(settings) as (keyof ProgressSettings)[];
		const labels = keys.map((k) => `${k}: ${settings[k]}`);
		const selected = await ctx.ui.select(
			"Progress settings",
			[...labels, "Back"],
			{ signal: state.signal },
		);
		if (!state.isCurrent()) return "stale";
		if (!selected) return "close";
		if (selected === "Back") return "back";
		const key = keys[labels.indexOf(selected)];
		if (!key) return "close";
		let value: unknown;
		if (key === "displayMode")
			value = await ctx.ui.select(
				"Display mode",
				["adaptive", "expanded", "collapsed"],
				{ signal: state.signal },
			);
		else if (key === "maxVisibleItems") {
			const text = await ctx.ui.input(
				"Maximum visible steps (1–50; blank for automatic)",
				"",
				{ signal: state.signal },
			);
			value =
				text === undefined
					? undefined
					: text.trim() === ""
						? null
						: Number(text);
		} else value = !settings[key];
		if (!state.isCurrent()) return "stale";
		if (value === undefined) continue;
		try {
			const result = await state.save(
				{ [key]: value } as Partial<ProgressSettings>,
				state.signal,
			);
			if (state.isCurrent()) state.apply(result);
		} catch {
			if (state.isCurrent())
				ctx.ui.notify("Could not save progress settings.", "error");
		}
	}
	return "stale";
}
