import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ProgressStep } from "./progress-state.js";
import {
	DEFAULT_PROGRESS_SETTINGS,
	type ProgressSettings,
} from "./settings.js";
import { displayText } from "../shared/observability.ts";
export const sanitizeProgressText = (text: string) => displayText(text, 4096);
export function renderProgressWidget(
	steps: readonly ProgressStep[],
	theme: Theme,
	width: number,
	options: { settings?: ProgressSettings; terminalRows?: number } = {},
): string[] {
	if (width <= 0) return [];
	const s = options.settings ?? DEFAULT_PROGRESS_SETTINGS;
	const done = steps.filter((x) => x.status === "completed").length;
	const heading = `Progress ${done}/${steps.length}${steps.some((x) => x.status === "blocked") ? " · blocked" : ""}`;
	if (s.displayMode === "collapsed") return [truncateToWidth(heading, width)];
	const rank = { in_progress: 0, blocked: 1, pending: 2, completed: 3 };
	const rows = Math.max(
		1,
		s.maxVisibleItems ??
			(s.displayMode === "expanded"
				? 50
				: Math.min(
						10,
						Math.max(2, Math.floor((options.terminalRows ?? 36) / 3) - 2),
					)),
	);
	const visible = steps
		.filter((x) => s.showCompleted || x.status !== "completed")
		.map((step, i) => ({ step, i }))
		.sort((a, b) => rank[a.step.status] - rank[b.step.status] || a.i - b.i);
	return [
		theme.fg("borderMuted", "─".repeat(width)),
		...(s.showProgress
			? [theme.fg("accent", truncateToWidth(heading, width))]
			: []),
		...visible
			.slice(0, rows)
			.map(({ step }) =>
				truncateToWidth(
					`${{ pending: "○", in_progress: "▶", blocked: "!", completed: "✓" }[step.status]} ${sanitizeProgressText(step.text)}`,
					width,
				),
			),
		...(visible.length > rows
			? [truncateToWidth(`… ${visible.length - rows} more steps`, width)]
			: []),
	];
}
export function renderCompletionSummary(
	total: number,
	theme: Theme,
	width: number,
): string[] {
	return width > 0
		? [
				theme.fg(
					"success",
					truncateToWidth(`Progress: ${total}/${total} complete`, width),
				),
			]
		: [];
}
