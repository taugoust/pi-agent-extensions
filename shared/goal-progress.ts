import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ActiveGoal } from "../workflows/goal/persistence.js";
import {
	currentProgressGoal,
	GOAL_PROGRESS_ENTRY_TYPE,
	readScopedProgress,
	validateProgressArguments,
	type ProgressStep,
} from "../progress/progress-state.js";

export const GOAL_PROGRESS_EVENT = "pi:goal-progress";
type Context = Pick<ExtensionContext, "sessionManager">;
type Goal = Pick<ActiveGoal, "id" | "progressId">;

export function readGoalTasks(ctx: Context, goal: Goal): ProgressStep[] {
	return readScopedProgress(
		ctx.sessionManager.getBranch(),
		goal.progressId ?? goal.id,
	);
}

/** One progress history, with a stable scope key; not a second task database. */
export function writeProgress(
	pi: ExtensionAPI,
	ctx: Context,
	steps: readonly ProgressStep[],
	goalId?: string | null,
	allowRemoval = false,
	notify = true,
) {
	const current = currentProgressGoal(ctx.sessionManager.getBranch());
	const selected = goalId === undefined ? (current?.id ?? null) : goalId;
	if (selected !== null && selected !== current?.id)
		throw new Error(
			"Goal changed; use its current goal_id or null for standalone progress",
		);
	const goalKey = selected === null ? null : current!.key;
	let next = validateProgressArguments({ steps }).steps;
	if (goalKey !== null) {
		if (new Set(next.map((step) => step.text)).size !== next.length)
			throw new Error("Goal tasks need distinct descriptions");
		const previous = readScopedProgress(ctx.sessionManager.getBranch(), goalKey);
		next = next.map(step => {
			const existing = previous.find(old => step.id ? old.id === step.id : old.text === step.text);
			if (step.id && !existing && !allowRemoval) throw new Error("Unknown goal task ID; use the current checklist or omit id for a new task");
			return { ...step, id: step.id ?? existing?.id ?? randomUUID() };
		});
		if (new Set(next.map(step => step.id)).size !== next.length) throw new Error("Each goal task ID must be unique");
		if (!allowRemoval) {
			const missing = previous.filter(
				(step) =>
					step.status !== "completed" &&
					!next.some((candidate) => step.id ? candidate.id === step.id : candidate.text === step.text),
			);
			if (missing.length)
				throw new Error(
					"Keep unfinished goal tasks in the checklist. Only an explicitly authorized goal scope change may remove them.",
				);
		}
	} else next = next.map(({ text, status }) => ({ text, status }));
	pi.appendEntry(GOAL_PROGRESS_ENTRY_TYPE, {
		version: 1,
		goalKey,
		steps: next,
	});
	if (notify)
		pi.events.emit(GOAL_PROGRESS_EVENT, {
			sessionId: ctx.sessionManager.getSessionId(),
		});
	return { steps: next, goalId: selected };
}

export function addGoalTask(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	goal: ActiveGoal,
	expectedGoalId: string,
	text: string,
) {
	if (
		goal.id !== expectedGoalId ||
		goal.status === "complete" ||
		goal.status === "active" ||
		!ctx.isIdle() ||
		ctx.hasPendingMessages()
	)
		throw new Error(
			"Pause the goal and wait for the current turn before adding a task",
		);
	const steps = readGoalTasks(ctx, goal);
	const normalized = text.trim();
	if (steps.some((step) => step.text === normalized))
		throw new Error("That task is already in this goal");
	return writeProgress(
		pi,
		ctx,
		[...steps, { text: normalized, status: "pending" }],
		expectedGoalId,
	);
}
