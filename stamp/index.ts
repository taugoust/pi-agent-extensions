import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import stamp, {
	STAMP_ENTRY_TYPE,
	isMessageStampData,
	isToolStampData,
} from "./stamp.js";
import { createStampSettingsRuntime } from './settings.js';
import { DEFAULT_STAMP_SETTINGS, type StampSettings } from './format.js';
import { registerObservation, displayText } from "../shared/observability.ts";

/** Project only supported display metadata, never diagnostics/response IDs or transcript text. */
export function stampRecords(entries: readonly any[], settings: Readonly<StampSettings> = DEFAULT_STAMP_SETTINGS) {
	return entries
		.filter((e) => e.type === "custom" && e.customType === STAMP_ENTRY_TYPE)
		.filter((e) => isMessageStampData(e.data) || (settings.toolStamps && isToolStampData(e.data)))
		.slice(-50)
		.map((e) => {
			const d = e.data;
			if (isToolStampData(d))
				return {
					id: e.id,
					role: "tool",
					timestamp: d.startedAt,
					completedAt: d.completedAt,
					tool: displayText(d.toolName),
					outcome: d.outcome,
				};
			const m = settings.assistantMetadata === 'off' ? undefined : d.metadata;
			return {
				id: e.id,
				role: d.role,
				timestamp: d.timestamp,
				...(d.completedAt === undefined || settings.responseTiming === 'off' ? {} : { completedAt: d.completedAt }),
				...(d.firstContentAt === undefined || settings.responseTiming !== 'detailed'
					? {}
					: { firstContentAt: d.firstContentAt }),
				...(m && settings.showThinkingLevel && d.thinkingLevel ? { thinking: d.thinkingLevel } : {}),
				...(m
					? {
							model: displayText(m.model),
							provider: displayText(m.provider),
							outcome: m.stopReason,
							...(m.usage ? { usage: { ...m.usage } } : {}),
						}
					: {}),
				...(d.costSinceUser === undefined || !settings.showCostSinceUser
					? {}
					: { costSinceUser: d.costSinceUser }),
				...(d.timeSinceUserMs === undefined || !settings.showTimeSinceUser
					? {}
					: { timeSinceUserMs: d.timeSinceUserMs }),
			};
		});
}
export default function (pi: ExtensionAPI) {
	const settingsRuntime = createStampSettingsRuntime();
	stamp(pi, {settingsRuntime});
	registerObservation(pi, "stamp", (ctx) => ({
		records: stampRecords(ctx.sessionManager.getBranch(), settingsRuntime.get().settings),
	}));
}
