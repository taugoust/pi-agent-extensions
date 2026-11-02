import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const SAVED_GOAL_ACTIONS = ["list", "status", "start", "resume", "pause", "clear", "complete"] as const;
export type SavedGoalControl = {
	action: string;
	scope?: string;
	offset?: number;
	goal_id?: string;
	expected_revision?: number;
	request_id?: string;
	user_authorized?: boolean;
	summary?: string;
	task_evidence?: { task_id: string; evidence: string }[];
};

/** Model-tool entry point only; context is supplied by the harness, never by
 * parameters. The underlying service owns the registry and child executor.
 */
export async function manageSavedGoal(params: SavedGoalControl, ctx: ExtensionContext, signal?: AbortSignal) {
	signal?.throwIfAborted();
	const service = (globalThis as any).__paeWorkflowsV1;
	if (service?.protocol !== 1 || service.sessionId !== ctx.sessionManager.getSessionId() || typeof service.manageSavedGoal !== "function")
		throw new Error("Saved-Goal tool controls unavailable for this session; reload the updated parent runtime");
	return service.manageSavedGoal(params, ctx, signal);
}

export function validateSavedGoalControl(params: SavedGoalControl): void {
	const fields = ["action", "scope", "goal_id", "expected_revision", "request_id", "user_authorized", "summary", "task_evidence", "offset"];
	if (Object.keys(params).some(key => !fields.includes(key))) throw new Error("Unsupported saved-Goal fields; current-Goal activation and task controls cannot target saved Goals");
	if (params.scope !== "saved" || !SAVED_GOAL_ACTIONS.includes(params.action as any)) throw new Error("Unsupported saved-Goal action");
	const read = params.action === "list" || params.action === "status";
	if (params.offset !== undefined && (params.action !== "list" || !Number.isSafeInteger(params.offset) || params.offset < 0 || params.offset > 1000)) throw new Error("offset is saved-Goal list-only (0–1000)");
	if (params.action === "list" ? params.goal_id !== undefined : typeof params.goal_id !== "string" || !params.goal_id)
		throw new Error("List omits goal_id; every other saved-Goal action requires its exact goal_id");
	if (read) {
		if ([params.expected_revision, params.request_id, params.user_authorized, params.summary, params.task_evidence].some(value => value !== undefined)) throw new Error("Saved-Goal reads do not accept mutation fields");
		return;
	}
	if (params.user_authorized !== true) throw new Error("Saved-Goal lifecycle controls require fresh explicit user authorization");
	if (!Number.isSafeInteger(params.expected_revision) || params.expected_revision! < 1 || typeof params.request_id !== "string" || !params.request_id.trim() || params.request_id.length > 128)
		throw new Error("Saved-Goal mutations require exact expected_revision and a unique request_id");
	if (params.action !== "complete" && (params.summary !== undefined || params.task_evidence !== undefined)) throw new Error("Summary and task_evidence are saved-Goal complete-only");
}
