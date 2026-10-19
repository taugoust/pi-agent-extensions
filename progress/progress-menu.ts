import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
export async function showProgressMenu(
	ctx: ExtensionCommandContext,
	state: {
		signal: AbortSignal;
		isCurrent(): boolean;
		getState(): {
			widget: string;
			total: number;
			completed: number;
			inProgress: number;
			blocked: number;
		};
		hideWidget(): void;
		showSettings(signal: AbortSignal): Promise<string>;
	},
) {
	while (state.isCurrent() && !state.signal.aborted) {
		const s = state.getState();
		const choice = await ctx.ui.select(
			`Progress · ${s.completed}/${s.total} complete · ${s.blocked} blocked · ${s.widget}`,
			["Settings", "Clear widget", "Close"],
			{ signal: state.signal },
		);
		if (!state.isCurrent() || !choice || choice === "Close") return;
		if (choice === "Clear widget") {
			state.hideWidget();
			return;
		}
		if ((await state.showSettings(state.signal)) !== "back") return;
	}
}
