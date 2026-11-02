import type { JobAncestry } from "../shared/readonly-job-ancestry.ts";
import type { DelegatedGoalEntry } from "./delegated-goals.ts";

type Owner = { ownerSessionId: string; taskId: string; childId: string };
type Goal = { sessionId: string; id: string; text: string };
/** Observation only. Call ONLY for a physically verified recorded owner.
 * Stable coordinator task IDs bind resumed attempts to the same registry Goal.
 * Missing or conflicting ancestry never acquires Goal attribution or mutation authority.
 */
export function worktreeGoalProvenance(sessionId: string, entries: Pick<DelegatedGoalEntry, "id" | "text" | "child">[], ancestry?: JobAncestry) {
	const goals = new Map<string, Goal>();
	for (const entry of entries) if (entry.child) goals.set(entry.child.taskId, { sessionId, id: entry.id, text: entry.text });
	const edges = ancestry?.edges ?? [];
	const children = new Map<string, typeof edges>();
	for (const edge of edges) {
		const list = children.get(edge.ownerSessionId) ?? [];
		list.push(edge); children.set(edge.ownerSessionId, list);
	}
	const sessions = new Map<string, string | null>([[sessionId, null]]), queue = [sessionId];
	// Each session is visited at most twice (attributed, then ambiguous). Cycles
	// cannot assign the root or restore an ambiguous session's attribution.
	for (let i = 0; i < queue.length; i++) {
		const parent = queue[i]!;
		for (const edge of children.get(parent) ?? []) {
			if (edge.sessionId === sessionId) continue;
			const goal = parent === sessionId ? goals.get(edge.taskId)?.id ?? null : sessions.get(parent) ?? null;
			if (!sessions.has(edge.sessionId)) { sessions.set(edge.sessionId, goal); queue.push(edge.sessionId); }
			else if (sessions.get(edge.sessionId) !== goal && sessions.get(edge.sessionId) !== null) { sessions.set(edge.sessionId, null); queue.push(edge.sessionId); }
		}
	}
	return (owner: Owner | undefined): { goalScopeSessionId?: string; worktreeGoal?: Goal } => {
		if (!owner || !sessions.has(owner.ownerSessionId)) return {};
		let goal: Goal | undefined;
		if (owner.ownerSessionId === sessionId) {
			const entry = entries.find(entry => entry.child?.taskId === owner.taskId &&
				(entry.child.childId === owner.childId || edges.some(edge => edge.ownerSessionId === sessionId && edge.taskId === owner.taskId && edge.childId === owner.childId)));
			if (entry) goal = goals.get(owner.taskId);
		} else {
			const id = sessions.get(owner.ownerSessionId);
			if (id) goal = [...goals.values()].find(goal => goal.id === id);
		}
		return { goalScopeSessionId: sessionId, ...(goal ? { worktreeGoal: goal } : {}) };
	};
}
