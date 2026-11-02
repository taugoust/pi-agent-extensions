import assert from "node:assert/strict";
import { test } from "node:test";
import { managedGoalBinding, validateManagedGoalAssignment } from "./managed-goal.ts";
import { publicTuiWorkerManifest, type TuiWorkerManifest } from "../shared/tui-worker-protocol.ts";
const assignment = { entryId: "11111111-1111-4111-8111-111111111111", policy: { continuationLimits: { automaticTurns: null, noProgressTurns: null } }, goalTools: ["goal_manage", "goal_complete", "goal_blocked", "goal_wait", "update_progress"] };
test("Goal assignment derives its exact identity from an ordinary worker and never leaks its bearer", () => {
 const manifest = { protocol:1,ownerSessionId:"owner",taskId:"task",childId:"child",groupId:"group",attempt:2,runtimeId:"worker-runtime",workerEpoch:"epoch",controlToken:"private-control-bearer-not-public",controlSocket:"/tmp/worker/control.sock",sessionFile:"/tmp/worker/session.jsonl",assignedGoal:assignment } as TuiWorkerManifest;
 const binding=managedGoalBinding(manifest);
 assert.deepEqual(binding.identity,{sessionId:"owner",taskId:"task",childId:"child",jobId:"group",attempt:2,runtimeId:"worker-runtime",workerEpoch:"epoch"});
 assert.equal(binding.path,"/tmp/worker/goal.sock");assert.equal(binding.entryId,assignment.entryId);
 const visible=JSON.stringify(publicTuiWorkerManifest(manifest));assert.ok(!visible.includes(manifest.controlToken));assert.ok(!visible.includes("assignedGoal"));
});
test("Goal assignment is a narrow bootstrap policy, not a model/tool/provider authority override",()=>{
 for(const invalid of [{...assignment,model:"foreign"},{...assignment,goalTools:["read"]},{...assignment,goalTools:[...assignment.goalTools,"bash"]},{...assignment,questionnaireEnabled:true},{...assignment,policy:{continuationLimits:{automaticTurns:0,noProgressTurns:null}}}])assert.throws(()=>validateManagedGoalAssignment(invalid as any));
 assert.deepEqual(validateManagedGoalAssignment(assignment),assignment);
});
