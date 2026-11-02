import { join, dirname } from "node:path";
import { dedicatedGoalPolicy, type DedicatedGoalPolicy } from "./goal-policy.ts";
import type { GoalWorkerIdentity } from "./goal-rpc.ts";
import type { TuiWorkerManifest } from "../shared/tui-worker-protocol.ts";

/** Optional assignment on an ordinary managed task, never a separate launcher.
 * Only the trusted manager accepts this internal parameter; model spawn input
 * cannot set it. The bearer remains in the private ordinary worker manifest. */
export const MANAGED_GOAL_ACCEPTANCE = "Complete the assigned Goal with an accepted goal_complete receipt and completed checklist.";
export type ManagedGoalAssignment = {
  entryId: string;
  policy: DedicatedGoalPolicy;
  goalTools: string[];
  questionnaireEnabled?: boolean;
  reviewEnabled?: boolean;
};
export function validateManagedGoalAssignment(value: ManagedGoalAssignment): ManagedGoalAssignment {
  if (!value || Object.keys(value).some(key => !["entryId", "policy", "goalTools", "questionnaireEnabled", "reviewEnabled"].includes(key)) || !/^[a-f0-9-]{36}$/i.test(value.entryId)
    || !Array.isArray(value.goalTools) || new Set(value.goalTools).size !== value.goalTools.length || value.goalTools.some(tool => !["goal_manage", "goal_complete", "goal_blocked", "goal_wait", "update_progress", "questionnaire", "goal_reference"].includes(tool))
    || [value.questionnaireEnabled, value.reviewEnabled].some(flag => flag !== undefined && typeof flag !== "boolean")) throw new Error("Invalid managed Goal assignment");
  if (["goal_complete", "goal_blocked", "goal_wait", "update_progress"].some(tool => !value.goalTools.includes(tool))
    || value.questionnaireEnabled === true && !value.goalTools.includes("questionnaire")
    || value.reviewEnabled === true && !value.goalTools.includes("goal_reference")) throw new Error("Incomplete managed Goal tool policy");
  return structuredClone({ ...value, policy: dedicatedGoalPolicy(value.policy) });
}
export function managedGoalBinding(manifest: TuiWorkerManifest) {
  if (!manifest.assignedGoal) throw new Error("Managed task has no Goal assignment");
  const assignment = validateManagedGoalAssignment(manifest.assignedGoal);
  const identity: GoalWorkerIdentity = { sessionId: manifest.ownerSessionId, runtimeId: manifest.runtimeId,
    taskId: manifest.taskId, childId: manifest.childId, jobId: manifest.groupId, attempt: manifest.attempt, workerEpoch: manifest.workerEpoch };
  return { path: join(dirname(manifest.controlSocket), "goal.sock"), token: manifest.controlToken,
    entryId: assignment.entryId, policy: assignment.policy, identity,
    questionnaireEnabled: assignment.questionnaireEnabled, reviewEnabled: assignment.reviewEnabled };
}
