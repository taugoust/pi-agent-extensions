import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
// Public Pi dialogs replace the candidate's terminal toolkit. Domain flows remain unchanged.
type Item = {
	id: string;
	label: string;
	action?: string;
	description?: string;
	statusText?: string;
	details?: string[];
};
type Screen = {
	kind: string;
	title: string;
	lines?: string[];
	items: Item[];
	action?: string;
};
type Menu<S> = {
	start: string;
	screens: Record<string, (context: { state: S }) => Screen>;
	actions: Record<
		string,
		(context: {
			signal: AbortSignal;
			itemId?: string;
		}) => Promise<{ kind: string; screen?: string }>
	>;
};
export function defineMenu<S, K extends string, A extends string, C>(
	menu: Menu<S>,
): Menu<S> {
	return menu;
}
export async function runMenu<S>(
	ctx: Pick<ExtensionCommandContext, "ui">,
	menu: Menu<S>,
	options: { getState(): S; signal?: AbortSignal; isCurrent(): boolean },
) {
	const signal = options.signal ?? new AbortController().signal;
	let screen = menu.start;
	while (!signal.aborted && options.isCurrent()) {
		const view = menu.screens[screen]({ state: options.getState() });
		const labels = view.items.map(
			(item, index) => `${index + 1}. ${item.label}`,
		);
		const selected = await ctx.ui.select(
			[view.title, ...(view.lines ?? [])].join("\n"),
			labels,
			{ signal },
		);
		if (signal.aborted || !options.isCurrent()) return;
		if (selected === undefined) {
			if (screen !== menu.start) {
				screen = menu.start;
				continue;
			}
			return;
		}
		const item = view.items[labels.indexOf(selected)];
		if (!item) return;
		if (view.kind === "browse") {
			ctx.ui.notify(
				[item.label, item.description, item.statusText, ...(item.details ?? [])]
					.filter(Boolean)
					.join("\n"),
				"info",
			);
			continue;
		}
		const action = item.action ?? view.action;
		if (!action || !menu.actions[action]) return;
		const result = await menu.actions[action]({ itemId: item.id, signal });
		if (result.kind === "close") return;
		if (result.kind === "to" && result.screen) screen = result.screen;
	}
}
