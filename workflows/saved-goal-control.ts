import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const SAVED_GOAL_ACTIONS = ["list", "status", "create", "update", "start", "resume", "pause", "clear", "complete"] as const;
export type SavedGoalControl = {
	action: string;
	scope?: string;
	offset?: number;
	goal_id?: string;
	/** Supplied by the tool (its tool call ID), not the model. */
	request_id?: string;
	objective?: string;
	steps?: { id?: string; text: string; status: string }[];
	start?: boolean;
	token_budget?: number;
	summary?: string;
	task_evidence?: { task_id: string; evidence: string }[];
	task_edits?: { id?: string; text?: string; before_task_id?: string | null }[];
	remove_task_ids?: string[];
};

/** The harness supplies the context; parameters cannot select another owner. */
export async function manageSavedGoal(params: SavedGoalControl, ctx: ExtensionContext, signal?: AbortSignal) {
	signal?.throwIfAborted();
	const service = (globalThis as any).__paeWorkflowsV1;
	if (service?.protocol !== 1 || service.sessionId !== ctx.sessionManager.getSessionId() || typeof service.manageSavedGoal !== "function")
		throw new Error("Saved-Goal tool controls unavailable for this session; reload the updated parent runtime");
	return service.manageSavedGoal(params, ctx, signal);
}

export function validateSavedGoalControl(params: SavedGoalControl): void {
	const create = params.action === "create";
	const fields = ["action", "scope", "request_id", ...(create
		? ["objective", "steps", "start", "token_budget"]
		: ["goal_id", "summary", "task_evidence", "offset", "task_edits", "remove_task_ids"])];
	if (Object.keys(params).some(key => !fields.includes(key))) throw new Error("Unsupported saved-Goal fields; use task_edits for saved checklist changes, not current-Goal activation or steps");
	if (params.scope !== "saved" || !SAVED_GOAL_ACTIONS.includes(params.action as any)) throw new Error("Unsupported saved-Goal action");
	const read = params.action === "list" || params.action === "status";
	if (params.offset !== undefined && (params.action !== "list" || !Number.isSafeInteger(params.offset) || params.offset < 0 || params.offset > 1000)) throw new Error("offset is saved-Goal list-only (0–1000)");
	if (!create && (params.action === "list" ? params.goal_id !== undefined : typeof params.goal_id !== "string" || !params.goal_id))
		throw new Error("List omits goal_id; other existing saved-Goal actions require its exact goal_id");
	if (params.action !== "update" && (params.task_edits !== undefined || params.remove_task_ids !== undefined)) throw new Error("task_edits and remove_task_ids are saved-Goal update-only");
	if (read) {
		if ([params.summary, params.task_evidence].some(value => value !== undefined)) throw new Error("Saved-Goal reads do not accept mutation fields");
		return;
	}
	if (typeof params.request_id !== "string" || !params.request_id.trim()) throw new Error("Saved-Goal mutations need the tool call ID as request_id");
	if (create) {
		if (typeof params.objective !== "string" || !params.objective.trim() || params.objective.length > 320) throw new Error("Saved-Goal creation requires a concise objective (maximum 320 characters)");
		if (params.start !== undefined && params.start !== false) throw new Error("Saved-Goal creation is paused metadata only; use a separate explicit start action");
		if (params.token_budget !== undefined && (!Number.isSafeInteger(params.token_budget) || params.token_budget < 1 || params.token_budget > 1_000_000)) throw new Error("Invalid token_budget");
		if (params.steps !== undefined && (!Array.isArray(params.steps) || params.steps.length > 50 || params.steps.some(step => !step || Object.keys(step).some(key => !["text", "status"].includes(key)) || step.status !== "pending" || typeof step.text !== "string" || !step.text.trim() || step.text.length > 503))) throw new Error("New saved-Goal steps require pending status and fresh server-allocated IDs (maximum 50)");
		return;
	}
	if (params.action !== "complete" && (params.summary !== undefined || params.task_evidence !== undefined)) throw new Error("Summary and task_evidence are saved-Goal complete-only");
}
