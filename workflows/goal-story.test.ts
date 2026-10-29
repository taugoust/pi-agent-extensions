import { test } from "node:test";
import assert from "node:assert/strict";
import { createGoalStoryRecorder, GOAL_STORY_ENTRY } from "./goal-story-recorder.ts";
import { createGoalQuestions, GOAL_QUESTIONS_ENTRY } from "./goal-questions.ts";
import { mergeGoalStory, emptyGoalStory } from "./goal-story.ts";
import { DelegatedGoalRegistry } from "./delegated-goals.ts";
import { workerInteractionsService, WORKER_INTERACTIONS_KEY } from "../shared/foreground-tasks.ts";

test("story records explicit state changes and updates, persists and deduplicates without invented history",()=>{
 const branch:any[]=[];
 const persist=(data:unknown)=>branch.push({type:"custom",customType:GOAL_STORY_ENTRY,data});
 const recorder=createGoalStoryRecorder("goal",branch,persist);
 assert.deepEqual(recorder.snapshot(),emptyGoalStory());
 recorder.baseline({status:"active",tasks:[{id:"t",text:"Check UI",status:"pending"}]});
 recorder.observe({status:"active",tasks:[{id:"t",text:"Check UI",status:"in_progress"}]},100);
 recorder.observe({status:"active",tasks:[{id:"t",text:"Check UI",status:"in_progress"}]},200);
 recorder.activity("tool-1","Phone checks passed",300);recorder.activity("tool-1","Phone checks passed",400);
 assert.equal(recorder.snapshot().timeline.length,1);assert.equal(recorder.snapshot().timeline[0].at,100);
 assert.equal(recorder.snapshot().activity.length,1);
 const restored=createGoalStoryRecorder("goal",branch,persist);assert.deepEqual(restored.snapshot(),recorder.snapshot());
 assert.deepEqual(mergeGoalStory(recorder.snapshot(),restored.snapshot()),recorder.snapshot());
 assert.deepEqual(createGoalStoryRecorder("other",branch,()=>{}).snapshot(),emptyGoalStory());
});

const input={kind:"questionnaire" as const,questions:[{id:"choice",prompt:"Which direction?",options:[{value:"a",label:"A"}],allowOther:false}]};
const answer={kind:"questionnaire" as const,cancelled:false,answers:[{id:"choice",value:"a",wasCustom:false}]};
test("goal questions require exact live epoch, revision and answer; retries settle one actual request",async()=>{
 const branch:any[]=[];const persist=(data:unknown)=>branch.push({type:"custom",customType:GOAL_QUESTIONS_ENTRY,data});
 const service=createGoalQuestions("goal","epoch",branch,persist);
 const pending=service.request(input);const q=service.snapshot()[0];
 const reply={questionId:q.id,questionRevision:q.revision,workerEpoch:"epoch",answer};
 assert.throws(()=>service.answer({...reply,workerEpoch:"foreign"},"r"),/Stale/);
 assert.throws(()=>service.answer({...reply,questionRevision:2},"r"),/changed/);
 assert.throws(()=>service.answer({...reply,answer:{...answer,answers:[{id:"choice",value:"wrong",wasCustom:false}]}},"r"),/invalid/);
 service.answer(reply,"r");service.answer(reply,"r");assert.deepEqual(await pending,answer);
 assert.equal(service.snapshot()[0].status,"answered");assert.equal(service.snapshot()[0].revision,2);
 assert.throws(()=>service.answer({...reply,answer:{kind:"questionnaire",cancelled:true,answers:[]}},"r"),/conflict/);
 const sameEpoch=createGoalQuestions("goal","epoch",branch,persist);sameEpoch.answer(reply,"r");sameEpoch.dispose();
 const restored=createGoalQuestions("goal","next",branch,persist);assert.equal(restored.snapshot()[0].status,"answered");
 assert.throws(()=>restored.answer(reply,"r"),/Stale/);
 service.dispose();restored.dispose();
});
test("question-only interaction service never captures permission approvals", async()=>{
 const prior=(globalThis as any)[WORKER_INTERACTIONS_KEY];
 const service=createGoalQuestions("goal","epoch",[],()=>{});
 try {
  (globalThis as any)[WORKER_INTERACTIONS_KEY]={protocol:1,mode:"headless",workerEpoch:"epoch",supportedKinds:["questionnaire"],request:service.request};
  assert.ok(workerInteractionsService("questionnaire"));assert.equal(workerInteractionsService("permission"),undefined);
  await assert.rejects(service.request({kind:"permission",title:"Approve?",options:["yes"]}),/unavailable/);
 }finally{(globalThis as any)[WORKER_INTERACTIONS_KEY]=prior;service.dispose();}
});

test("registry answers only the exact active goal question and preserves idempotent receipt",async()=>{
 let calls=0, refuse=false;
 const question={id:"q",revision:1,at:100,workerEpoch:"epoch",status:"pending" as const,request:input};
 const pendingStory={...emptyGoalStory(),questions:[question]};
 const registry=new DelegatedGoalRegistry("session",{
  async start(){return {taskId:"task",childId:"child",jobId:"job",attempt:1};},async resume(){throw Error("not used");},async pause(){},
  async observe(){return {story:pendingStory};},
  async answer(){if(refuse)throw Error("Question cancelled before delivery");calls++;return {story:{...pendingStory,questions:[{...question,revision:2,status:"answered",answer,answeredAt:200}]}};},
 },()=>{});
 let state=await registry.mutate("session",{action:"goals.create",requestId:"create",expectedGoalId:null,objective:"Answer safely"});
 const id=state.entries[0].id;
 await registry.mutate("session",{action:"goals.start",requestId:"start",expectedGoalId:id,expectedEntryRevision:1});
 await registry.refresh();state=registry.snapshot();
 const request={action:"goals.answer" as const,requestId:"answer",expectedGoalId:id,expectedEntryRevision:state.entries[0].revision,questionId:"q",questionRevision:1,workerEpoch:"epoch",answer};
 await assert.rejects(registry.mutate("session",{...request,requestId:"bad",workerEpoch:"other"}),/changed/);
 assert.equal(calls,0);assert.equal(registry.blockedReason(),null);
 refuse=true;await assert.rejects(registry.mutate("session",{...request,requestId:"cancel-race"}),/cancelled/);
 assert.equal(registry.blockedReason(),null);refuse=false;
 const answered=await registry.mutate("session",request);
 assert.equal(answered.entries[0].story?.questions?.[0].status,"answered");
 assert.deepEqual(await registry.mutate("session",request),answered);assert.equal(calls,1);
});

test("abort and restored pending questions cancel, never approve or replay",async()=>{
 const branch:any[]=[];const persist=(data:unknown)=>branch.push({type:"custom",customType:GOAL_QUESTIONS_ENTRY,data});
 const controller=new AbortController();const service=createGoalQuestions("goal","epoch",branch,persist);
 const pending=service.request(input,controller.signal);const rejection=assert.rejects(pending,/cancelled/);
 const restored=createGoalQuestions("goal","next",branch,persist);assert.equal(restored.snapshot()[0].status,"cancelled");
 controller.abort();await rejection;assert.equal(service.snapshot()[0].status,"cancelled");
 service.dispose();restored.dispose();
});
