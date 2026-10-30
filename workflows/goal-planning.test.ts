import { test } from "node:test";
import assert from "node:assert/strict";
import { DelegatedGoalRegistry, type DelegatedGoalRequest } from "./delegated-goals.ts";
import { setGoalDependencies, validateGoalPlanning } from "./goal-planning.ts";
const tasks = [{id:"a",text:"First",status:"pending" as const},{id:"b",text:"Second",status:"pending" as const},{id:"c",text:"Third",status:"completed" as const}];
test("same-goal advisory dependencies reject cycles, self edges and foreign/duplicate task IDs",()=>{
 let planning=setGoalDependencies(undefined,tasks,"a",["b"]);planning=setGoalDependencies(planning,tasks,"b",["c"]);validateGoalPlanning(planning,tasks);
 for(const [id,waits] of [["a",["a"]],["a",["other-goal-task"]],["a",["b","b"]],["foreign",[]],["c",["a"]]] as Array<[string,string[]]>)assert.throws(()=>setGoalDependencies(planning,tasks,id,waits));
 assert.deepEqual(planning.dependencies,[{taskId:"a",waitsFor:["b"]},{taskId:"b",waitsFor:["c"]}]);
 assert.deepEqual(setGoalDependencies(planning,tasks,"a",[]).dependencies,[{taskId:"b",waitsFor:["c"]}]);
});
test("owner/revision/idempotency-bound planning never schedules or changes goal/task lifecycle; clearing preserves evidence",async()=>{
 let effects=0;const registry=new DelegatedGoalRegistry("owner",{async start(){effects++;throw Error("must not execute");},async resume(){effects++;throw Error("must not execute");},async pause(){effects++;throw Error("must not execute");}},()=>{});
 let state=await registry.mutate("owner",{action:"goals.create",requestId:"create",expectedGoalId:null,objective:"Planning"});const id=state.entries[0].id;
 for(const task of tasks)state=await registry.mutate("owner",{action:"goals.add_task",requestId:task.id,expectedGoalId:id,expectedEntryRevision:state.entries[0].revision,text:task.text});
 const ids=state.entries[0].tasks.map(task=>task.id), before=structuredClone(state.entries[0].tasks);
 const dependencies: DelegatedGoalRequest={action:"goals.dependencies",requestId:"deps",expectedGoalId:id,expectedEntryRevision:state.entries[0].revision,taskId:ids[0],waitsFor:[ids[1]]};
 state=await registry.mutate("owner",dependencies);assert.deepEqual(await registry.mutate("owner",dependencies),state);
 await assert.rejects(registry.mutate("foreign",{...dependencies,requestId:"foreign"}),/session/);
 await assert.rejects(registry.mutate("owner",{...dependencies,requestId:"stale"}),/revision/);
 await assert.rejects(registry.mutate("owner",{...dependencies,requestId:"cycle",expectedEntryRevision:state.entries[0].revision,taskId:ids[1],waitsFor:[ids[0]]}),/cycle/);
 state=await registry.mutate("owner",{action:"goals.blocker.add",requestId:"blocker",expectedGoalId:id,expectedEntryRevision:state.entries[0].revision,blockerReason:"External service",blockerEvidence:"Recorded request failed",blockerTaskId:ids[0]});
 const blocker=structuredClone(state.entries[0].planning!.blockers[0]);assert.equal(blocker.clearedAt,undefined);assert.equal(state.entries[0].status,"paused");assert.deepEqual(state.entries[0].tasks,before);
 await assert.rejects(registry.mutate("owner",{action:"goals.blocker.clear",requestId:"wrong-id",expectedGoalId:id,expectedEntryRevision:state.entries[0].revision,blockerId:"foreign-id"}),/missing/);
 state=await registry.mutate("owner",{action:"goals.blocker.clear",requestId:"clear",expectedGoalId:id,expectedEntryRevision:state.entries[0].revision,blockerId:blocker.id});
 const cleared=state.entries[0].planning!.blockers[0];assert.equal(cleared.reason,blocker.reason);assert.equal(cleared.evidence,blocker.evidence);assert.ok(cleared.clearedAt!>=blocker.at);assert.ok(state.entries[0].story?.timeline.some(event=>event.text.includes("Recorded blocker cleared")));assert.equal(effects,0);
});
test("real task removal prunes advisory edges without erasing historical blockers",async()=>{
 const id="11111111-1111-4111-8111-111111111111";const initial={version:1 as const,revision:1,entries:[{id,revision:1,status:"active" as const,text:"Observe",tasks,child:{taskId:"native-task",childId:"child",jobId:"job",attempt:1},tokenBudget:null,tokensUsed:0,automaticTurns:0,noProgressTurns:0,summary:null,waiting:null,planning:{dependencies:[{taskId:"a",waitsFor:["b"]}],blockers:[{id:"22222222-2222-4222-8222-222222222222",at:1,reason:"Recorded",evidence:"Evidence",taskId:"b"}]}}]};
 const registry=new DelegatedGoalRegistry("owner",{async start(){throw Error("no");},async resume(){throw Error("no");},async pause(){},async observe(){return {tasks:tasks.filter(task=>task.id!=="b")};}},()=>{},initial);
 await registry.refresh();const goal=registry.snapshot().entries[0];assert.deepEqual(goal.planning?.dependencies,[]);assert.equal(goal.planning?.blockers[0].taskId,"b");assert.equal(goal.status,"active");assert.ok(goal.story?.timeline.some(event=>event.text.includes("recorded task removal")));
});
