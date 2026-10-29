/** Presentation-only DTO shared by Pi renderers and native transcript adapters.
 * Never substitute this for model-facing content or canonical Goal state.
 */
export const GOAL_MANAGE_ACTIONS = ["status", "create", "update", "pause", "resume", "clear", "complete"] as const;
export type GoalManageAction = typeof GOAL_MANAGE_ACTIONS[number];

export function goalManagePresentation(action: GoalManageAction, objective?: string) {
	return { version: 1 as const, tool: "goal_manage" as const, action, objective };
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

/** Unknown/partial arguments must not leak raw JSON into the call title. */
export function goalManageTitle(args: unknown): string {
	const action = record(args)?.action;
	return `Goal manage${GOAL_MANAGE_ACTIONS.includes(action as GoalManageAction) ? ` ${action}` : ""}`;
}

/** Use structured objective data, never regex-parse the machine contract.
 * Errors and missing objectives keep their original diagnostic text.
 */
export function normalizeGoalManageDisplay(result: {
	content?: readonly { type: string; text?: string }[];
	details?: unknown;
	isError?: boolean;
}, isError = false): { text: string; isError: boolean } {
	const details = record(result.details);
	const failed = isError || result.isError === true;
	const metadata = record(details?.presentation);
	const objective = metadata?.version === 1 && metadata.tool === "goal_manage"
		? metadata.objective
		: record(details?.goal)?.objective;
	if (!failed && typeof objective === "string" && objective.trim())
		return { text: `Objective: ${objective}`, isError: false };
	return {
		text: result.content?.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n") ?? "",
		isError: failed,
	};
}
