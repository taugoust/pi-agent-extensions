import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createWorkerGoalReview,GOAL_REVIEW_ENTRY,GOAL_REVIEW_WORKER_KEY} from "./goal-review-worker.ts";
import {createGoalQuestions,GOAL_QUESTIONS_ENTRY} from "./goal-questions.ts";
import {previewGoalReview,mergeGoalReview} from "./goal-review.ts";
import {emptyGoalStory} from "./goal-story.ts";
import {registerGoalReferenceTool} from "./goal-reference-tool.ts";
const entryId="11111111-1111-4111-8111-111111111111",child={taskId:"task",childId:"child",jobId:"job",attempt:1};
const request={goal_id:"goal",activation_id:"activation",expected_revision:1,request_id:"reference",title:"Spec",target:"spec.md",role:"source" as const};
async function fixture(){const root=await mkdtemp(join(tmpdir(),"goal-worker-review-"));await writeFile(join(root,"spec.md"),"Explicit spec evidence");const branch:any[]=[];const state={entryId,childGoalId:"goal",childActivationId:"activation",revision:1,goal:{status:"active"}};let allowed=true;const options={entryId,child,workerEpoch:"epoch",root,branch,persist:(data:unknown)=>branch.push({type:"custom",customType:GOAL_REVIEW_ENTRY,data}),current:()=>state,readEnabled:()=>allowed};return{root,branch,state,options,review:createWorkerGoalReview(options),setAllowed:(value:boolean)=>allowed=value,close:()=>rm(root,{recursive:true,force:true})};}
test("explicit worker registration uses inherited read authorization, exact goal activation/revision and durable idempotent receipts",async()=>{
 const f=await fixture();try{let reads=0;
 await assert.rejects(f.review.register(request,async()=>{reads++;return{isError:true};}),/authorized/);assert.equal(f.review.snapshot().length,0);assert.equal(f.branch.length,0);
 const ref=await f.review.register(request,async path=>{assert.equal(path,join(f.root,"spec.md"));reads++;return{};});assert.equal(ref.workerEpoch,"epoch");assert.equal(f.branch.at(-1).data.receipts[0][0],request.request_id);
 assert.deepEqual(await f.review.register(request,async()=>{throw Error("replay must not read");}),ref);assert.equal(reads,2);
 f.state.revision=2;assert.deepEqual(await f.review.register(request,async()=>{throw Error("retained receipt survives unrelated task revisions");}),ref);f.state.revision=1;
 await assert.rejects(f.review.register({...request,title:"Changed"},async()=>({})),/conflict/);
 for(const changed of [{goal_id:"foreign"},{activation_id:"old"},{expected_revision:0},{target:"../secret",request_id:"escape"},{target:"/etc/passwd",request_id:"absolute"},{approve:true,request_id:"approval"}])await assert.rejects(f.review.register({...request,...changed} as any,async()=>{throw Error("invalid input reached read");}));
 const restored=createWorkerGoalReview(f.options);assert.deepEqual(await restored.register(request,async()=>{throw Error("no replayed read");}),ref);restored.dispose();f.setAllowed(false);await assert.rejects(f.review.register({...request,request_id:"denied"},async()=>({})),/capability/);
 }finally{f.review.dispose();await f.close();}
});
test("a file changed between nested read authorization and registration is not snapshotted",async()=>{
 const f=await fixture();try{await assert.rejects(f.review.register(request,async()=>{await writeFile(join(f.root,"spec.md"),"Changed after authorized read");return{};}),/changed after read authorization/);assert.equal(f.review.snapshot().length,0);assert.equal(f.branch.length,0);
 }finally{f.review.dispose();await f.close();}
});

test("uncertain reference receipt persistence fences retries until authoritative restore",async()=>{
 const f=await fixture();try{let reads=0;const uncertain=createWorkerGoalReview({...f.options,persist:data=>{f.options.persist(data);throw Error("durability uncertain");}});
 await assert.rejects(uncertain.register(request,async()=>{reads++;return{};}),/uncertain/);
 await assert.rejects(uncertain.register(request,async()=>{reads++;return{};}),/reload required/);assert.equal(reads,1);assert.equal(uncertain.snapshot().length,0);
 const restored=createWorkerGoalReview(f.options);const ref=await restored.register(request,async()=>{throw Error("retained receipt must not reread");});assert.equal(ref.title,"Spec");assert.equal(restored.snapshot().length,1);uncertain.dispose();restored.dispose();
 }finally{f.review.dispose();await f.close();}
});

test("tool wrapper invokes actual nested read hook and rejects absent read/runtime/session authority",async()=>{
 const f=await fixture();const prior=(globalThis as any)[GOAL_REVIEW_WORKER_KEY];try{
 let tool:any,reads=0;const active=["read","goal_reference"];
 registerGoalReferenceTool({registerTool:(value:any)=>tool=value,getActiveTools:()=>active} as any);
 (globalThis as any)[GOAL_REVIEW_WORKER_KEY]={protocol:1,sessionId:"worker-session",register:f.review.register};
 const ctx={sessionManager:{getSessionId:()=>"worker-session"},executeTool:async(name:string,args:any)=>{assert.equal(name,"read");assert.equal(args.path,join(f.root,"spec.md"));reads++;return{};}};
 const result=await tool.execute("call",request,undefined,undefined,ctx);assert.equal(result.details.reference_id,f.review.snapshot()[0].id);assert.equal(reads,1);
 await assert.rejects(tool.execute("foreign",request,undefined,undefined,{...ctx,sessionManager:{getSessionId:()=>"other"}}),/exact dedicated/);
 await assert.rejects(tool.execute("old-runtime",request,undefined,undefined,{...ctx,executeTool:undefined}),/nested read/);
 active.splice(0,1);await assert.rejects(tool.execute("denied",request,undefined,undefined,ctx),/read capability/);
 }finally{(globalThis as any)[GOAL_REVIEW_WORKER_KEY]=prior;f.review.dispose();await f.close();}
});
test("question attachments bind registered IDs to exact question and worker attempt, never raw paths",async()=>{
 const f=await fixture();try{
 const ref=await f.review.register(request,async()=>({}));const questions=createGoalQuestions(entryId,"epoch",[],()=>{},{bindAttachments:f.review.bindAttachments});
 const input={kind:"questionnaire" as const,questions:[{id:"pick",prompt:"Review the evidence",options:[{value:"yes",label:"Accept"}],allowOther:false,attachmentIds:[ref.id]}]};
 const promise=questions.request(input),rejected=assert.rejects(promise,/cancelled/);const q=questions.snapshot()[0];assert.equal(q.attachmentIds?.length,1);assert.notEqual(q.attachmentIds?.[0],ref.id);
 const attached=f.review.snapshot().find(ref=>ref.id===q.attachmentIds![0])!;assert.equal(attached.questionId,q.id);assert.equal(attached.workerEpoch,"epoch");
 const entry={id:entryId,child,review:f.review.snapshot(),story:{...emptyGoalStory(),questions:[q]}} as any;
 const target={questionId:q.id,questionRevision:q.revision,workerEpoch:q.workerEpoch};assert.equal((await previewGoalReview(f.root,entry,attached.id,target)).kind,"text");
 await assert.rejects(previewGoalReview(f.root,entry,attached.id),/ownership/);
 for(const changed of [{questionId:"other"},{questionRevision:2},{workerEpoch:"other"}])await assert.rejects(previewGoalReview(f.root,entry,attached.id,{...target,...changed}),/ownership/);
 assert.throws(()=>f.review.bindAttachments("different-question",{...input,questions:[{...input.questions[0],attachmentIds:[attached.id]}]}),/another goal, question or attempt/);
 assert.throws(()=>f.review.bindAttachments("different-question",{...input,questions:[{...input.questions[0],attachmentIds:["/etc/passwd"]}]}),/another/);
 const other=createWorkerGoalReview({...f.options,workerEpoch:"new-epoch",child:{...child,attempt:2,childId:"new-child"}});assert.throws(()=>other.bindAttachments("new-question",input),/another/);other.dispose();questions.dispose();await rejected;
 }finally{f.review.dispose();await f.close();}
});
test("owner-human forwarding retains one goal waiter and records real receipt before resolving; races abort forwarding",async()=>{
 const branch:any[]=[];const persist=(data:unknown)=>branch.push({type:"custom",customType:GOAL_QUESTIONS_ENTRY,data});const questions=createGoalQuestions(entryId,"epoch",branch,persist);
 const input={kind:"questionnaire" as const,questions:[{id:"q",prompt:"Explicit human choice",options:[{value:"yes",label:"Yes"}],allowOther:false}]};
 let resolve!: (value:any)=>void,forwardSignal:AbortSignal|undefined;
 const pending=questions.request(input,undefined,async(request,signal)=>{assert.deepEqual(request,input);assert.equal(branch.at(-1).data.questions[0].status,"pending");forwardSignal=signal;return new Promise(done=>resolve=done);});
 const answer={kind:"questionnaire" as const,cancelled:false,answers:[{id:"q",value:"yes",wasCustom:false}]};resolve(answer);assert.deepEqual(await pending,answer);assert.equal(branch.at(-1).data.questions[0].status,"answered");assert.equal(branch.at(-1).data.receipts[0][0],`forward:${questions.snapshot()[0].id}`);assert.equal(forwardSignal?.aborted,true);
 let late!: (value:any)=>void,lateSignal:AbortSignal|undefined;const race=questions.request(input,undefined,async(_request,signal)=>{lateSignal=signal;return new Promise(done=>late=done);});const q=questions.snapshot().at(-1)!;questions.answer({questionId:q.id,questionRevision:1,workerEpoch:"epoch",answer},"authenticated-human");assert.deepEqual(await race,answer);assert.equal(lateSignal?.aborted,true);late({kind:"permission",cancelled:false,value:"Allow"});await new Promise(done=>setImmediate(done));assert.equal(questions.snapshot().at(-1)?.status,"answered");assert.equal(questions.snapshot().at(-1)?.answer?.kind,"questionnaire");
 await assert.rejects(questions.request({kind:"permission",title:"Approve",options:["Allow"]},undefined,async()=>answer),/invalid/);questions.dispose();
});
test("goal question recorder retains scoped attachments while owner-human transport receives no file authority",{skip:process.platform!=="linux"},async()=>{
 const {GuidanceBroker,guidanceTarget,requestGuidance}=await import("../subagent/guidance.ts");
 const f=await fixture();let broker:any,questions:ReturnType<typeof createGoalQuestions>|undefined;
 try{
  const ref=await f.review.register(request,async()=>({}));let notified!:(value:any)=>void;const notification=new Promise<any>(done=>notified=done);
  broker=new GuidanceBroker("owner",join(f.root,"guidance"),notified);await broker.start();const binding=broker.bind({ownerSessionId:"owner",taskId:child.taskId,childId:child.childId,attempt:child.attempt,workerEpoch:"epoch",goalId:entryId});
  questions=createGoalQuestions(entryId,"epoch",[],()=>{},{bindAttachments:f.review.bindAttachments});
  const input={kind:"questionnaire" as const,questions:[{id:"q",prompt:"Human preference",options:[{value:"yes",label:"Yes"}],allowOther:false,attachmentIds:[ref.id]}]};
  const pending=questions.request(input,undefined,async(questionnaire,signal)=>{const result=await requestGuidance(binding,"worker-runtime",{kind:"human",questionnaire},signal);if(result.kind!=="human")throw Error("not a human receipt");return result.answer;});
  const record=await notification;assert.equal(record.input.questionnaire.questions[0].attachmentIds,undefined);assert.deepEqual(questions.snapshot()[0].request.questions[0].attachmentIds,[ref.id]);assert.equal(questions.snapshot()[0].status,"pending");assert.ok(questions.snapshot()[0].attachmentIds?.length);
  assert.throws(()=>broker.reply(guidanceTarget(record),"model",{kind:"guidance",guidance:"choose yes"}),/Human decision/);
  const answer={kind:"questionnaire" as const,cancelled:false,answers:[{id:"q",value:"yes",wasCustom:false}]};await broker.askHuman(guidanceTarget(record),async(actual:any)=>{assert.deepEqual(actual,{...input,questions:input.questions.map(({attachmentIds,...question})=>question)});return answer;});
  assert.deepEqual(await pending,answer);assert.equal(questions.snapshot()[0].status,"answered");assert.equal(broker.list()[0].receipt.answer.kind,"human");
 }finally{questions?.dispose();await broker?.close();f.review.dispose();await f.close();}
});

test("review merge reports bounded eviction and rejects reference identity rewrites",()=>{
 const refs=Array.from({length:20},(_,i)=>({id:`00000000-0000-4000-8000-${String(i).padStart(12,"0")}`,goalId:entryId,taskId:"task",childId:"child",attempt:1,title:`Ref ${i}`,role:"source" as const,kind:"link" as const,at:i,target:`https://example.test/${i}`}));
 const merged=mergeGoalReview(refs.slice(0,16),refs.slice(16));assert.equal(merged.refs.length,16);assert.equal(merged.truncated,true);assert.equal(merged.refs[0].at,4);const protectedMerge=mergeGoalReview(refs.slice(0,16),refs.slice(16),[refs[0].id]);assert.ok(protectedMerge.refs.some(ref=>ref.id===refs[0].id));assert.equal(protectedMerge.refs.length,16);assert.throws(()=>mergeGoalReview([refs[0]],[{...refs[0],target:"https://other.test"}]),/identity/);
});
