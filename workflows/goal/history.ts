import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readGoalTasks } from "../../shared/goal-progress.ts";
import type { ActiveGoal } from "./persistence.js";
import type { ProgressStep } from "../../progress/progress-state.js";

export const GOAL_HISTORY_ENTRY_TYPE = "goal-history";
const MAX_GOAL_HISTORY = 50;

export type GoalHistoryRecord = {
	id: string;
	text: string;
	status: "completed" | "cleared";
	endedAt: number;
	summary: string | null;
	tasks: ProgressStep[];
};

type GoalHistoryContext = Pick<ExtensionContext, "sessionManager">;

export function archiveGoal(
	pi: ExtensionAPI,
	goal: ActiveGoal,
	status: GoalHistoryRecord["status"],
	summary: string | null,
) {
	pi.appendEntry(GOAL_HISTORY_ENTRY_TYPE, {
		version: 1,
		id: goal.id,
		progressId: goal.progressId ?? goal.id,
		text: goal.text,
		status,
		endedAt: Date.now(),
		summary,
	});
}

/** Reads explicit archive entries and infers older clears from goal-state transitions. */
export function readGoalHistory(ctx: GoalHistoryContext): GoalHistoryRecord[] {
	const entries = ctx.sessionManager.getBranch() as unknown as unknown[];
	const records = new Map<
		string,
		Omit<GoalHistoryRecord, "tasks"> & { progressId: string }
	>();
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== GOAL_HISTORY_ENTRY_TYPE) continue;
		const data = isRecord(entry.data) ? entry.data : undefined;
		if (!validHistoryEntry(data)) continue;
		records.set(data.id, {
			id: data.id,
			progressId: typeof data.progressId === "string" ? data.progressId : data.id,
			text: data.text.slice(0, 4000),
			status: data.status,
			endedAt: data.endedAt,
			summary: data.summary?.slice(0, 4000) ?? null,
		});
	}

	let previous: Record<string, unknown> | undefined;
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== "goal-state") continue;
		const data = isRecord(entry.data) ? entry.data : undefined;
		if (!data || !Object.hasOwn(data, "goal")) continue;
		const next = data.goal;
		if (next === null) {
			if (previous) inferLegacyRecord(previous, index, entries, records);
			previous = undefined;
			continue;
		}
		if (!isGoalState(next)) continue;
		if (previous && progressKey(previous) !== progressKey(next))
			inferLegacyRecord(previous, index, entries, records);
		previous = next;
	}
	if (previous?.status === "complete") inferLegacyRecord(previous, entries.length, entries, records);

	return [...records.values()]
		.sort((left, right) => right.endedAt - left.endedAt)
		.slice(0, MAX_GOAL_HISTORY)
		.map((record) => ({
			id: record.id,
			text: record.text,
			status: record.status,
			endedAt: record.endedAt,
			summary: record.summary,
			tasks: readGoalTasks(ctx, { id: record.id, progressId: record.progressId }),
		}));
}

function inferLegacyRecord(
	goal: Record<string, unknown>,
	transitionIndex: number,
	entries: unknown[],
	records: Map<
		string,
		Omit<GoalHistoryRecord, "tasks"> & { progressId: string }
	>,
) {
	if (typeof goal.id !== "string" || records.has(goal.id)) return;
	const status = goal.status === "complete" ? "completed" : "cleared";
	const summary = status === "completed" ? completionSummary(entries, transitionIndex, goal.id) : null;
	const endedAt = typeof goal.updatedAt === "number" && Number.isFinite(goal.updatedAt)
		? goal.updatedAt
		: Date.now();
	records.set(goal.id, {
		id: goal.id,
		progressId: progressKey(goal),
		text: typeof goal.text === "string" ? goal.text.slice(0, 4000) : "Goal",
		status,
		endedAt,
		summary,
	});
}

function completionSummary(entries: unknown[], start: number, goalId: string): string | null {
	for (const entry of entries.slice(start)) {
		if (!isRecord(entry) || entry.type !== "message") continue;
		const message = isRecord(entry.message) ? entry.message : undefined;
		const details = isRecord(message?.details) ? message.details : undefined;
		if (
			message?.role === "toolResult" &&
			message.toolName === "goal_complete" &&
			!message.isError &&
			details?.goal_id === goalId &&
			typeof details.summary === "string" &&
			Array.isArray(message.content) &&
			message.content.some((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text.startsWith("Goal complete:"))
		)
			return details.summary.slice(0, 4000);
	}
	return null;
}

function isGoalState(value: unknown): value is Record<string, unknown> {
	return isRecord(value) && typeof value.id === "string" && typeof value.text === "string" && typeof value.status === "string";
}

function progressKey(goal: Record<string, unknown>): string {
	return typeof goal.progressId === "string" && goal.progressId ? goal.progressId : String(goal.id);
}

function validHistoryEntry(value: Record<string, unknown> | undefined): value is Record<string, any> {
	return Boolean(
		value &&
		value.version === 1 &&
		typeof value.id === "string" &&
		typeof value.text === "string" &&
		(value.status === "completed" || value.status === "cleared") &&
		typeof value.endedAt === "number" &&
		Number.isFinite(value.endedAt) &&
		(value.summary === null || typeof value.summary === "string"),
	);
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
