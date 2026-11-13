import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const SAVED_GOAL_ACTIONS = [
	"list", "status", "create", "update", "start", "resume", "pause", "clear", "complete",
] as const;
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
export async function manageSavedGoal(
	params: SavedGoalControl, ctx: ExtensionContext, signal?: AbortSignal,
) {
	signal?.throwIfAborted();
	const service = (globalThis as any).__paeWorkflowsV1;
	const available = service?.protocol === 1
		&& service.sessionId === ctx.sessionManager.getSessionId()
		&& typeof service.manageSavedGoal === "function";
	if (!available) {
		throw new Error(
			"Saved-Goal tool controls unavailable for this session; reload the updated parent runtime",
		);
	}
	return service.manageSavedGoal(params, ctx, signal);
}

const CREATE_FIELDS = ["objective", "steps", "start", "token_budget"];
const EXISTING_GOAL_FIELDS = [
	"goal_id", "summary", "task_evidence", "offset", "task_edits", "remove_task_ids",
];
const MAX_NEW_STEPS = 50;
const MAX_STEP_LENGTH = 503;
const MAX_OBJECTIVE_LENGTH = 320;
const MAX_LIST_OFFSET = 1000;
const MAX_TOKEN_BUDGET = 1_000_000;

const isIntegerIn = (value: unknown, min: number, max: number) =>
	Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;

/** New saved-goal steps are pending and get their IDs from the registry. */
function validNewSteps(steps: unknown) {
	if (!Array.isArray(steps) || steps.length > MAX_NEW_STEPS) return false;
	return steps.every(step => step
		&& Object.keys(step).every(key => key === "text" || key === "status")
		&& step.status === "pending"
		&& typeof step.text === "string" && step.text.trim()
		&& step.text.length <= MAX_STEP_LENGTH);
}

export function validateSavedGoalControl(params: SavedGoalControl): void {
	const { action } = params;
	const create = action === "create";
	const actionFields = create ? CREATE_FIELDS : EXISTING_GOAL_FIELDS;
	const allowed = ["action", "scope", "request_id", ...actionFields];
	if (Object.keys(params).some(key => !allowed.includes(key))) {
		throw new Error("Unsupported saved-Goal fields; use task_edits for saved checklist changes, "
			+ "not current-Goal activation or steps");
	}
	if (params.scope !== "saved" || !SAVED_GOAL_ACTIONS.includes(action as any)) {
		throw new Error("Unsupported saved-Goal action");
	}

	const validOffset = action === "list" && isIntegerIn(params.offset, 0, MAX_LIST_OFFSET);
	if (params.offset !== undefined && !validOffset) {
		throw new Error("offset is saved-Goal list-only (0–1000)");
	}
	const hasGoalId = typeof params.goal_id === "string" && params.goal_id !== "";
	const validGoalId = action === "list" ? params.goal_id === undefined : hasGoalId;
	if (!create && !validGoalId) {
		throw new Error(
			"List omits goal_id; other existing saved-Goal actions require its exact goal_id",
		);
	}
	const editsTasks = params.task_edits !== undefined || params.remove_task_ids !== undefined;
	if (action !== "update" && editsTasks) {
		throw new Error("task_edits and remove_task_ids are saved-Goal update-only");
	}

	const completes = params.summary !== undefined || params.task_evidence !== undefined;
	if (action === "list" || action === "status") {
		if (completes) throw new Error("Saved-Goal reads do not accept mutation fields");
		return;
	}
	if (typeof params.request_id !== "string" || !params.request_id.trim()) {
		throw new Error("Saved-Goal mutations need the tool call ID as request_id");
	}

	if (create) {
		validateCreate(params);
		return;
	}
	if (action !== "complete" && completes) {
		throw new Error("Summary and task_evidence are saved-Goal complete-only");
	}
}

function validateCreate(params: SavedGoalControl): void {
	const { objective } = params;
	const validObjective = typeof objective === "string" && objective.trim()
		&& objective.length <= MAX_OBJECTIVE_LENGTH;
	if (!validObjective) {
		throw new Error("Saved-Goal creation requires a concise objective (maximum 320 characters)");
	}
	if (params.start !== undefined && params.start !== false) {
		throw new Error(
			"Saved-Goal creation is paused metadata only; use a separate explicit start action",
		);
	}
	const validBudget = isIntegerIn(params.token_budget, 1, MAX_TOKEN_BUDGET);
	if (params.token_budget !== undefined && !validBudget) throw new Error("Invalid token_budget");
	if (params.steps !== undefined && !validNewSteps(params.steps)) {
		throw new Error("New saved-Goal steps require pending status "
			+ "and fresh server-allocated IDs (maximum 50)");
	}
}
