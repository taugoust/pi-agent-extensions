import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { StampSettingsRuntime } from "./settings.js";
import type { StampSettings } from "./format.js";

/** Native Pi dialogs work in TUI and RPC; no terminal-only toolkit dependency. */
export async function showStampMenu(
	ctx: ExtensionCommandContext,
	runtime: StampSettingsRuntime,
	owner: { signal: AbortSignal; isCurrent(): boolean },
) {
	const choices: Partial<Record<keyof StampSettings, string[]>> = {
		hourCycle: ["24h", "12h"],
		dateContext: ["day-change", "always", "never"],
		responseTiming: ["off", "duration", "detailed"],
		assistantMetadata: ["off", "compact", "expanded"],
	};
	while (owner.isCurrent() && !owner.signal.aborted) {
		const state = runtime.get();
		if (!state.canSave) {
			ctx.ui.notify(
				`Repair ${runtime.getPath()} and reload before changing settings.`,
				"warning",
			);
			return;
		}
		const keys = Object.keys(state.settings) as (keyof StampSettings)[];
		const labels = keys.map((key) => `${key}: ${state.settings[key]}`);
		const selected = await ctx.ui.select(
			"Stamp settings (changes save immediately)",
			[...labels, "Close"],
			{ signal: owner.signal },
		);
		if (!owner.isCurrent() || !selected || selected === "Close") return;
		const key = keys[labels.indexOf(selected)];
		if (!key) return;
		const current = state.settings[key];
		let value: unknown;
		if (typeof current === "boolean") value = !current;
		else if (choices[key])
			value = await ctx.ui.select(key, choices[key]!, { signal: owner.signal });
		else
			value = await ctx.ui.input(key, String(current), {
				signal: owner.signal,
			});
		if (!owner.isCurrent() || owner.signal.aborted || value === undefined)
			continue;
		try {
			await runtime.update({ [key]: value } as Partial<StampSettings>);
		} catch {
			if (owner.isCurrent())
				ctx.ui.notify(
					"Could not save Stamp settings; previous settings retained.",
					"error",
				);
		}
	}
}
