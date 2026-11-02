import assert from "node:assert/strict";
import { test } from "node:test";
import { worktreeGoalProvenance } from "./worktree-goal-provenance.ts";
import type { JobAncestry } from "../shared/readonly-job-ancestry.ts";
const entries = [
	{ id: "goal-a", text: "Same title", child: { taskId: "coordinator-a", childId: "current-a", jobId: "job-a", attempt: 2 } },
	{ id: "goal-b", text: "Same title", child: { taskId: "coordinator-b", childId: "current-b", jobId: "job-b", attempt: 1 } },
];
const edge = (ownerSessionId: string, taskId: string, childId: string, sessionId: string) => ({ ownerSessionId, taskId, childId, sessionId });
const proof = (edges: JobAncestry["edges"]): JobAncestry => ({ owners: [{ sessionId: "root" }], edges, fingerprint: "test" });
const owner = (ownerSessionId: string, taskId = "worker", childId = "child") => ({ ownerSessionId, taskId, childId });
const expected = (id: string) => ({ goalScopeSessionId: "root", worktreeGoal: { sessionId: "root", id, text: "Same title" } });
test("exact coordinator and authenticated descendant identities, including retained resumed attempts, group by stable Goal ID", () => {
	const resolve = worktreeGoalProvenance("root", entries, proof([
		edge("root", "coordinator-a", "old-a", "session-a"),
		edge("session-a", "worker", "child", "nested"),
		edge("nested", "worker-2", "child-2", "grandchild"),
		edge("root", "coordinator-a", "current-a", "session-a"),
		edge("root", "coordinator-b", "current-b", "session-b"),
	]));
	assert.deepEqual(resolve(owner("root", "coordinator-a", "current-a")), expected("goal-a"));
	assert.deepEqual(resolve(owner("root", "coordinator-a", "old-a")), expected("goal-a"));
	for (const session of ["session-a", "nested", "grandchild"]) assert.deepEqual(resolve(owner(session)), expected("goal-a"));
	assert.deepEqual(resolve(owner("session-b")), expected("goal-b"));
	assert.deepEqual(resolve(owner("unrelated", "coordinator-a", "current-a")), {});
	assert.deepEqual(resolve(owner("root", "coordinator-a", "unverified-old-child")), { goalScopeSessionId: "root" });
	assert.deepEqual(resolve(undefined), {});
});
test("legacy/unavailable ancestry and ordinary workers remain Unassigned, never guessed from titles", () => {
	const resolve = worktreeGoalProvenance("root", entries);
	assert.deepEqual(resolve(owner("root", "Same title", "current-a")), { goalScopeSessionId: "root" });
	assert.deepEqual(resolve(owner("session-a")), {});
	assert.deepEqual(resolve(owner("root", "coordinator-a", "current-a")), expected("goal-a"));
	const ordinary = worktreeGoalProvenance("root", entries, proof([edge("root", "ordinary", "child", "non-goal"), edge("non-goal", "worker", "child", "nested")]));
	assert.deepEqual(ordinary(owner("nested")), { goalScopeSessionId: "root" });
});
test("conflicting ownership is Unassigned and invalidation propagates through descendants without assigning cycles to root", () => {
	const resolve = worktreeGoalProvenance("root", entries, proof([
		edge("root", "coordinator-a", "current-a", "session-a"),
		edge("session-a", "worker", "child", "nested"),
		edge("root", "coordinator-b", "current-b", "session-b"),
		edge("session-b", "worker", "child", "session-a"),
		edge("nested", "worker", "child", "root"),
	]));
	for (const session of ["session-a", "nested", "root"]) assert.deepEqual(resolve(owner(session)), { goalScopeSessionId: "root" });
	assert.deepEqual(resolve(owner("session-b")), expected("goal-b"));
});
