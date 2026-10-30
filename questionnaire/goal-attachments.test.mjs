import {registerHooks} from 'node:module';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
// Headless tool path only. Terminal rendering and schema declaration helpers are
// narrow seams; actual interaction validation, recorder, registry and file binder run.
registerHooks({resolve(specifier,context,next){
 if(context.parentURL?.endsWith('/questionnaire/index.ts')&&specifier==='./paseo.js')return{url:new URL('./paseo.ts',context.parentURL).href,shortCircuit:true};
 if(specifier==='@mariozechner/pi-tui')return{url:'data:text/javascript,'+encodeURIComponent('export class Editor{};export class Text{};export const Key={};export const matchesKey=()=>false;export const truncateToWidth=x=>x;'),shortCircuit:true};
 if(specifier==='@sinclair/typebox')return{url:'data:text/javascript,'+encodeURIComponent('export const Type={Object:properties=>({type:"object",properties}),String:options=>({type:"string",...options}),Boolean:options=>({type:"boolean",...options}),Optional:value=>value,Array:(items,options)=>({type:"array",items,...options})};'),shortCircuit:true};
 return next(specifier,context);
}});
const {default:questionnaire}=await import('./index.ts');
const {createWorkerGoalReview}=await import('../workflows/goal-review-worker.ts');
const {createGoalQuestions,GOAL_QUESTION_RECORDER_KEY}=await import('../workflows/goal-questions.ts');
const keys=['__paeGuidanceHumanV1','__paeWorkerInteractionsV1',GOAL_QUESTION_RECORDER_KEY];
const id='11111111-1111-4111-8111-111111111111';
async function fixture(){const root=await mkdtemp(join(tmpdir(),'questionnaire-attachments-'));await writeFile(join(root,'spec.md'),'Explicit source');const review=createWorkerGoalReview({entryId:id,child:{taskId:'task',childId:'child',jobId:'job',attempt:1},workerEpoch:'epoch',root,branch:[],persist(){},current:()=>({entryId:id,childGoalId:'g',childActivationId:'activation',revision:1,goal:{status:'active'}}),readEnabled:()=>true});const ref=await review.register({goal_id:'g',activation_id:'activation',expected_revision:1,request_id:'r',title:'Source',target:'spec.md',role:'source'},async()=>({}));const questions=createGoalQuestions(id,'epoch',[],()=>{},{bindAttachments:review.bindAttachments});let tool;questionnaire({registerTool:value=>tool=value});return{root,review,questions,tool,ref,context:{hasUI:false,sessionManager:{getSessionId:()=> 'worker'}},params:{questions:[{id:'q',label:'Scope',prompt:'Human preference',options:[{value:'approved',label:'Use approved'}],allowOther:false,attachmentIds:[ref.id]}]},close:async()=>{questions.dispose();review.dispose();await rm(root,{recursive:true,force:true});}};}
async function isolated(run){const before=Object.fromEntries(keys.map(key=>[key,globalThis[key]])),env=process.env.PI_SUBAGENT_GUIDANCE_V1;process.env.PI_SUBAGENT_GUIDANCE_V1='fixture-owner-capability';try{await run();}finally{for(const key of keys)before[key]===undefined?delete globalThis[key]:globalThis[key]=before[key];env===undefined?delete process.env.PI_SUBAGENT_GUIDANCE_V1:process.env.PI_SUBAGENT_GUIDANCE_V1=env;}}
test('actual questionnaire tool records goal attachments while honoring preferred owner-human route',async()=>isolated(async()=>{
 const f=await fixture();try{let forwarded=0;
 globalThis.__paeGuidanceHumanV1={protocol:1,mode:'headless',workerEpoch:'owner-epoch',isCurrentWorker:()=>true,request:async input=>{forwarded++;assert.equal(input.questions[0].attachmentIds,undefined);assert.deepEqual(f.questions.snapshot()[0].request.questions[0].attachmentIds,[f.ref.id]);assert.equal(f.questions.snapshot()[0].status,'pending');return{kind:'questionnaire',cancelled:false,answers:[{id:'q',value:'approved',wasCustom:false}]};}};
 globalThis.__paeWorkerInteractionsV1={protocol:1,mode:'headless',workerEpoch:'epoch',supportedKinds:['questionnaire'],request:()=>{throw Error('preferred owner route was bypassed');}};
 globalThis[GOAL_QUESTION_RECORDER_KEY]={protocol:1,sessionId:'worker',request:(input,signal,upstream)=>f.questions.request(input,signal,(request,forwardSignal)=>upstream.request(request,forwardSignal))};
 const result=await f.tool.execute('question',f.params,undefined,undefined,f.context);assert.equal(forwarded,1);assert.equal(result.details.cancelled,false);assert.equal(result.details.answers[0].value,'approved');const q=f.questions.snapshot()[0];assert.equal(q.status,'answered');assert.equal(f.review.snapshot().find(ref=>ref.id===q.attachmentIds[0]).questionId,q.id);
 }finally{await f.close();}
}));
test('goal attachment question reaches actual top-level questionnaire through owner broker without transferring file authority',{skip:process.platform!=='linux'},async()=>isolated(async()=>{
 const {GuidanceBroker,guidanceTarget,requestGuidance}=await import('../subagent/guidance.ts');const f=await fixture();let broker;const remoteKey='__piPaseoRemoteUiV1',priorRemote=globalThis[remoteKey];
 try{let notified;const notification=new Promise(done=>notified=done);broker=new GuidanceBroker('root-owner',join(f.root,'guidance'),notified);await broker.start();const binding=broker.bind({ownerSessionId:'root-owner',taskId:'task',childId:'child',attempt:1,workerEpoch:'epoch',goalId:id});
 globalThis.__paeGuidanceHumanV1={protocol:1,mode:'headless',workerEpoch:'epoch',isCurrentWorker:()=>true,request:async(input,signal)=>{const result=await requestGuidance(binding,'worker-runtime',{kind:'human',questionnaire:input},signal);return result.answer;}};
 globalThis[GOAL_QUESTION_RECORDER_KEY]={protocol:1,sessionId:'worker',request:(input,signal,upstream)=>f.questions.request(input,signal,(request,forwardSignal)=>upstream.request(request,forwardSignal))};
 const pending=f.tool.execute('worker-question',f.params,undefined,undefined,f.context);const record=await notification;
 await broker.askHuman(guidanceTarget(record),async input=>{
  assert.equal(input.questions[0].attachmentIds,undefined);let rootTool;questionnaire({registerTool:value=>rootTool=value});
  const saved=Object.fromEntries(keys.map(key=>[key,globalThis[key]])),env=process.env.PI_SUBAGENT_GUIDANCE_V1;for(const key of keys)delete globalThis[key];delete process.env.PI_SUBAGENT_GUIDANCE_V1;
  globalThis[remoteKey]={isConnected:()=>true,select:async()=> '1. Use approved'};
  try{const outcome=await rootTool.execute('root-human',{questions:input.questions},undefined,undefined,{hasUI:true,mode:'tui',ui:{custom:()=>new Promise(()=>{})},sessionManager:{getSessionId:()=> 'root-owner'}});assert.notEqual(outcome.isError,true);assert.equal(outcome.details.failure,undefined);return{kind:'questionnaire',cancelled:outcome.details.cancelled,answers:outcome.details.answers.map(({id,value,wasCustom})=>({id,value,wasCustom}))};}
  finally{for(const key of keys)saved[key]===undefined?delete globalThis[key]:globalThis[key]=saved[key];process.env.PI_SUBAGENT_GUIDANCE_V1=env;}
 });
 const result=await pending;assert.equal(result.details.answers[0].value,'approved');assert.equal(f.questions.snapshot()[0].status,'answered');assert.ok(f.questions.snapshot()[0].attachmentIds.length);
 }finally{priorRemote===undefined?delete globalThis[remoteKey]:globalThis[remoteKey]=priorRemote;await broker?.close();await f.close();}
}));

test('actual questionnaire refuses unowned attachment IDs before forwarding or reading',async()=>isolated(async()=>{
 const f=await fixture();try{let calls=0;delete globalThis[GOAL_QUESTION_RECORDER_KEY];globalThis.__paeGuidanceHumanV1={protocol:1,mode:'headless',workerEpoch:'owner',isCurrentWorker:()=>true,request:async()=>{calls++;throw Error('must not forward');}};const result=await f.tool.execute('unowned',f.params,undefined,undefined,f.context);assert.equal(result.isError,true);assert.equal(result.details.cancelledByHuman,undefined);assert.equal(result.details.failure?.code,'interaction_unavailable');assert.match(result.content[0].text,/exact dedicated goal recorder/);assert.equal(calls,0);assert.equal(f.questions.snapshot().length,0);
 }finally{await f.close();}
}));
test('forwarding service failure is never reported as genuine human cancellation',async()=>isolated(async()=>{
 const f=await fixture();try{globalThis.__paeGuidanceHumanV1={protocol:1,mode:'headless',workerEpoch:'owner',isCurrentWorker:()=>true,request:async()=>{throw Error('Owner transport failed');}};globalThis[GOAL_QUESTION_RECORDER_KEY]={protocol:1,sessionId:'worker',request:(input,signal,upstream)=>f.questions.request(input,signal,(request,forwardSignal)=>upstream.request(request,forwardSignal))};const result=await f.tool.execute('failed',f.params,undefined,undefined,f.context);assert.equal(result.isError,true);assert.equal(result.details.cancelledByHuman,undefined);assert.equal(result.details.failure?.code,'interaction_unavailable');assert.equal(f.questions.snapshot()[0].answer,undefined);
 }finally{await f.close();}
}));
