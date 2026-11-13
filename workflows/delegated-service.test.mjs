import { registerHooks } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Real service and registry; narrow dependency seams isolate filesystem inventories,
// legacy goal commands and SDK types. No Pi process, provider or child is launched.
const seams = {
  "./worktree/repositories.js": "export async function workspaceRepositories(...args){return globalThis.__testRepositoryDiscovery ? globalThis.__testRepositoryDiscovery(...args) : {roots:[],active:null,container:true}}",
  "../shared/subagent-worktrees.ts": "export function recordedWorktreeOwner(){}; export async function ownedWorktrees(...args){return globalThis.__testOwnershipDiscovery ? globalThis.__testOwnershipDiscovery(...args) : []}; export async function worktreeGit(){return {stdout:''}}",
  "../shared/harness-readonly.ts": "export function harnessReadOnlyRegistry(){return {}}",
  "../shared/goal-progress.ts": "export function readGoalTasks(){return []};export function addGoalTask(){throw Error('legacy mutation forbidden')}",
  "./goal/history.js": "export function readGoalHistory(){return []}",
  "./worktree/command.js": "export function addFlow(){};export function removeFlow(){};export function pruneFlow(){}",
  "./worktree/git.js": "export function currentWorktreePath(){};export async function listWorktrees(){return []};export function runGit(){};export const pathsEqual=(a,b)=>a===b;export const pathIdentity=x=>x;export const stripTerminalControls=x=>x",
  "./goal/runtime.js": "export function createGoal(){throw Error('parent execution forbidden')};export function transitionGoal(){throw Error('parent execution forbidden')}",
  "./goal/accounting.js": "export function currentTokenTotal(){return 0}",
};
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith("/workflows/delegated-child.ts") && specifier === "../shared/goal-progress.ts") return { url: `data:text/javascript,${encodeURIComponent("export function readGoalTasks(ctx,goal){return goal.testTasks??[]};export function writeProgress(pi,ctx,tasks,id){pi.appendEntry('progress-fixture',{tasks,id})}")}`, shortCircuit: true };
  if (context.parentURL?.endsWith("/workflows/service.ts") && seams[specifier]) return { url: `data:text/javascript,${encodeURIComponent(seams[specifier])}`, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { createWorkflowService } = await import("./service.ts");

const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function bounded(promise) {
 let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Goal control blocked by discovery')),4000);})]);}finally{clearTimeout(timer);}
}
function discoveryFixture(t, busy = true) {
 const root=mkdtempSync(join(tmpdir(),'workflow-discovery-')),prior=process.env.PI_DELEGATED_GOALS_STATE_ROOT;
 process.env.PI_DELEGATED_GOALS_STATE_ROOT=root;const sessionId=randomUUID();let starts=0;
 const runtime={activeGoal:undefined,snapshotSettingsApplicationState:()=>({}),settings:{continuationLimits:{automaticTurns:null,noProgressTurns:null}}};
 const ctx={cwd:root,isIdle:()=>false,hasPendingMessages:()=>true,sessionManager:{getSessionId:()=>sessionId,getLeafId:()=>null,getBranch:()=>[],getEntries:()=>[]},ui:{setStatus(){}},model:null};
 globalThis.__paeDelegatedGoalExecutorV1={protocol:1,sessionId,executionAvailable:()=>true,async start(e){starts++;return {taskId:'task:'+e.id,childId:'child:'+e.id,jobId:'job:'+e.id,attempt:1};},async pause(){},async resume(){}};
 const service=createWorkflowService({appendEntry(){throw Error('No parent message');}},ctx,runtime,{}, {get:()=>({})},()=>busy);
 const identity={sessionId,serviceEpoch:service.serviceEpoch};
 t.after(()=>{service.dispose();delete globalThis.__testOwnershipDiscovery;delete globalThis.__testRepositoryDiscovery;delete globalThis.__paeDelegatedGoalExecutorV1;if(prior===undefined)delete process.env.PI_DELEGATED_GOALS_STATE_ROOT;else process.env.PI_DELEGATED_GOALS_STATE_ROOT=prior;rmSync(root,{recursive:true,force:true});});
 return {service,ctx,runtime,root,starts:()=>starts,snapshot:()=>bounded(service.handle({...identity,operation:'snapshot'})),send:r=>bounded(service.handle({...identity,operation:'start',requestId:randomUUID(),...r})),reply:r=>bounded(service.handle({...identity,operation:'send',requestId:randomUUID(),...r}))};
}

test('direct saved create atomically allocates paused Goal/checklist IDs without a model turn or parent activation',async t=>{
 const f=discoveryFixture(t,false);const parent={id:'parent-kept',status:'paused'};f.runtime.activeGoal=parent;
 const before=await f.service.manageSavedGoal({scope:'saved',action:'list'},f.ctx);
 const p={scope:'saved',action:'create',objective:'Fix ordinary coordinator lifecycle integration',steps:[{text:'Preserve bindings and history',status:'pending'},{text:'Validate ordinary agent lifecycle',status:'pending'}],request_id:'create-direct'};
 const created=await f.service.manageSavedGoal(p,f.ctx);assert.equal(created.goal.status,'paused');assert.equal(created.goal.child,null);assert.equal(created.goal.tasks.length,2);assert.ok(created.goal.tasks.every(task=>task.status==='pending'&&task.id));assert.notEqual(created.goal.tasks[0].id,created.goal.tasks[1].id);
 assert.equal((await f.service.manageSavedGoal({scope:'saved',action:'list'},f.ctx)).goals.length,1);assert.equal(f.starts(),0);assert.equal(f.runtime.activeGoal,parent);
 const active=await f.service.manageSavedGoal({scope:'saved',action:'start',goal_id:created.goal.id,request_id:'start-created'},f.ctx);assert.equal(active.goal.id,created.goal.id);assert.equal(active.goal.status,'active');assert.equal(f.starts(),1);assert.deepEqual(active.goal.tasks,created.goal.tasks);
});

test('a reloaded registry keeps the saved draft and its checklist IDs',async t=>{
 const f=discoveryFixture(t,false);const before=await f.service.manageSavedGoal({scope:'saved',action:'list'},f.ctx);
 const p={scope:'saved',action:'create',objective:'Durable paused draft',steps:[{text:'Keep this ID',status:'pending'}],request_id:'create-reload'};
 const created=await f.service.manageSavedGoal(p,f.ctx);f.service.dispose();
 const reloaded=createWorkflowService({},f.ctx,f.runtime,{},{get:()=>({})},()=>false);t.after(()=>reloaded.dispose());
 const list=await reloaded.manageSavedGoal({scope:'saved',action:'list'},f.ctx);assert.equal(list.goals.length,1);assert.equal(list.goals[0].id,created.goal.id);
 const status=await reloaded.manageSavedGoal({scope:'saved',action:'status',goal_id:created.goal.id},f.ctx);assert.deepEqual(status.goal.tasks,created.goal.tasks);assert.equal(f.starts(),0);
});

test('saved create rejects activation, task identity/status injection and invalid/duplicate checklists atomically',async t=>{
 const f=discoveryFixture(t,false);const before=await f.service.manageSavedGoal({scope:'saved',action:'list'},f.ctx);
 const p={scope:'saved',action:'create',objective:'New paused Goal',request_id:'safe-create'};
 const bad=[{start:true},{goal_id:'foreign'},{expected_revision:1},{expected_registry_revision:undefined},{activation_id:'foreign'},{user_authorized:false},{steps:[{id:'foreign',text:'Step',status:'pending'}]},{steps:[{text:'Claimed complete',status:'completed'}]},{steps:[{text:'Same',status:'pending'},{text:' Same ',status:'pending'}]}];
 for(let i=0;i<bad.length;i++)await assert.rejects(f.service.manageSavedGoal({...p,request_id:`invalid-${i}`,...bad[i]},f.ctx));
 const after=await f.service.manageSavedGoal({scope:'saved',action:'list'},f.ctx);assert.deepEqual(after,before);assert.equal(f.starts(),0);assert.equal(f.runtime.activeGoal,undefined);
 delete globalThis.__paeDelegatedGoalExecutorV1;const result=await f.service.manageSavedGoal(p,f.ctx);assert.equal(result.goal.status,'paused','Metadata creation needs no execution capability');
});

test('direct saved-Goal controls start two existing IDs independently and retain exact child identity on resume',async t=>{
 const f=discoveryFixture(t,false);const parent={id:'unrelated-current',status:'paused',text:'Retain parent Goal'};f.runtime.activeGoal=parent;
 let s=await f.send({action:'goals.create',expectedGoalId:null,objective:'Saved one'});
 s=await f.send({action:'goals.create',expectedGoalId:null,objective:'Saved two'});const [a,b]=s.delegatedGoals.entries;
 const control=p=>f.service.manageSavedGoal({scope:'saved',...p},f.ctx);
 const list=await control({action:'list'});assert.equal(list.goals.length,2);assert.equal(list.goals[0].id,a.id);
 const first={action:'start',goal_id:a.id,request_id:'direct-first'};
 const started=await control(first);await assert.rejects(control({...first,request_id:'direct-first-again'}));assert.equal(f.starts(),1,'Starting again must not launch another child');
 const second=await control({action:'start',goal_id:b.id,request_id:'direct-second'});
 assert.equal(f.starts(),2);assert.notEqual(started.goal.child.taskId,second.goal.child.taskId);assert.equal(started.goal.id,a.id);assert.equal(second.goal.id,b.id);
 const paused=await control({action:'pause',goal_id:a.id,request_id:'pause-first'});assert.equal(paused.goal.status,'paused');
 globalThis.__paeDelegatedGoalExecutorV1.resume=async e=>({...e.child,childId:'new-child',jobId:'new-job',attempt:e.child.attempt+1});
 const resumed=await control({action:'resume',goal_id:a.id,request_id:'resume-first'});
 assert.equal(resumed.goal.child.taskId,started.goal.child.taskId);assert.equal(resumed.goal.child.attempt,2);assert.equal(resumed.goal.status,'active');
 assert.equal(f.runtime.activeGoal,parent);assert.equal(f.runtime.activeGoal.status,'paused');
});

test('direct saved-Goal controls preserve user, automatic-run, owner, revision and field fences',async t=>{
 const f=discoveryFixture(t,false);const s=await f.send({action:'goals.create',expectedGoalId:null,objective:'Existing saved outcome'}),e=s.delegatedGoals.entries[0];
 const p={scope:'saved',action:'start',goal_id:e.id,request_id:'guard'};
 for(const bad of [{...p,user_authorized:false},{...p,request_id:undefined},{...p,activation_id:'foreign-current'},{...p,steps:[]},{...p,expected_revision:99}])await assert.rejects(f.service.manageSavedGoal(bad,f.ctx),/authorization|request_id|fields|revision/);
 f.runtime.agentRunOrigin='automatic';await assert.rejects(f.service.manageSavedGoal(p,f.ctx),/automatic/);f.runtime.agentRunOrigin='manual';
 await assert.rejects(f.service.manageSavedGoal(p,{...f.ctx,sessionManager:{getSessionId:()=> 'foreign'}}),/owner/);
 await assert.rejects(f.service.manageSavedGoal({...p,action:'create'},f.ctx),/Unsupported/);
 const abort=new AbortController();abort.abort();await assert.rejects(f.service.manageSavedGoal(p,f.ctx,abort.signal));assert.equal(f.starts(),0);
 assert.equal((await f.service.manageSavedGoal({scope:'saved',action:'status',goal_id:e.id},f.ctx)).goal.status,'paused');
});

test('direct saved checklist updates preserve identities, task statuses and unrelated Goal lifecycle without executing',async t=>{
 const f=discoveryFixture(t,false);f.runtime.activeGoal={id:'unrelated-current',status:'active',text:'Keep parent running'};const parent=structuredClone(f.runtime.activeGoal);
 let s=await f.send({action:'goals.create',expectedGoalId:null,objective:'Publish implementation and wait for confirmed merge'}),e=s.delegatedGoals.entries[0];
 for(const text of ['Implement safe checklist editing','Open only the nix-config pin MR','Wait for explicit user confirmation that the MR merged']){
  s=await f.send({action:'goals.add_task',expectedGoalId:e.id,expectedEntryRevision:e.revision,text});e=s.delegatedGoals.entries[0];
 }
 const original=structuredClone(e),[implementation,mr,confirmation]=e.tasks;
 s=await f.send({action:'goals.create',expectedGoalId:null,objective:'Independent saved Goal'});const unrelated=structuredClone(s.delegatedGoals.entries[1]);
 const control=p=>f.service.manageSavedGoal({scope:'saved',...p},f.ctx);
 const edit={action:'update',goal_id:e.id,request_id:'checklist-edit',task_edits:[
  {id:implementation.id,text:'Implement and verify safe checklist editing'},
  {text:'Create dedicated worktrees and branches before edits',before_task_id:implementation.id},
  {id:confirmation.id,before_task_id:mr.id},
 ]};
 const result=await control(edit),updated=result.goal;
 assert.equal(updated.id,e.id);assert.equal(updated.status,'paused');assert.equal(updated.child,null);assert.equal(updated.revision,e.revision+1);assert.equal(updated.policyRevision,e.policyRevision);
 assert.equal(updated.tasks.length,4);assert.equal(updated.tasks[0].text,'Create dedicated worktrees and branches before edits');assert.equal(updated.tasks[0].status,'pending');assert.ok(!e.tasks.some(task=>task.id===updated.tasks[0].id));
 assert.equal(updated.tasks[1].id,implementation.id);assert.equal(updated.tasks[1].status,implementation.status);assert.deepEqual(updated.tasks.slice(2),[confirmation,mr]);
 assert.deepEqual((await control({action:'status',goal_id:unrelated.id})).goal.tasks,unrelated.tasks);assert.deepEqual(f.runtime.activeGoal,parent);assert.equal(f.starts(),0);
 await assert.rejects(control({...edit,task_edits:[{text:'Duplicate replay insertion'}]}),/conflict/);
 const invalid=[{task_edits:[{id:'foreign',text:'Wrong task'}]},{task_edits:[{id:mr.id,status:'completed'}]},{task_edits:[{id:mr.id,before_task_id:mr.id}]},{task_edits:[{id:mr.id},{id:mr.id}]},{task_edits:[{id:mr.id}],remove_task_ids:[mr.id]}];
 for(const [i,bad]of invalid.entries())await assert.rejects(control({...edit,request_id:'invalid-'+i,...bad}));
 assert.deepEqual((await control({action:'status',goal_id:e.id})).goal,updated);
 const removal=await control({action:'update',goal_id:e.id,request_id:'explicit-scope-removal',remove_task_ids:[updated.tasks[0].id]});
 assert.deepEqual(removal.goal.tasks.map(task=>task.id),[implementation.id,confirmation.id,mr.id]);assert.equal(removal.goal.status,original.status);assert.equal(f.starts(),0);
 // A change the model hasn't seen rejects its next call; the rejection shows the change, so a retry goes through.
 await f.send({action:'goals.add_task',expectedGoalId:e.id,expectedEntryRevision:removal.goal.revision,text:'Added by the user'});
 await assert.rejects(control({action:'update',goal_id:e.id,request_id:'unseen-edit',task_edits:[{text:'Model edit'}]}),/changed since you last saw it/);
 const retried=await control({action:'update',goal_id:e.id,request_id:'seen-edit',task_edits:[{text:'Model edit'}]});
 assert.deepEqual(retried.goal.tasks.map(task=>task.text).slice(-2),['Added by the user','Model edit']);
});

test('saved checklist controls retain owner, fresh authorization, automatic-run, busy and field fences',async t=>{
 const f=discoveryFixture(t,false);const s=await f.send({action:'goals.create',expectedGoalId:null,objective:'Saved edit guards'}),e=s.delegatedGoals.entries[0];
 const p={scope:'saved',action:'update',goal_id:e.id,request_id:'update-guards',task_edits:[{text:'Planned work'}]};
 for(const bad of [{...p,user_authorized:false},{...p,request_id:undefined},{...p,activation_id:'current'},{...p,steps:[]},{...p,objective:'Scope change'},{...p,summary:'Completion'},{...p,expected_revision:99}])await assert.rejects(f.service.manageSavedGoal(bad,f.ctx));
 for(const action of ['status','start','complete'])await assert.rejects(f.service.manageSavedGoal({...p,action},f.ctx),/update-only/);
 f.runtime.agentRunOrigin='automatic';await assert.rejects(f.service.manageSavedGoal(p,f.ctx),/automatic/);f.runtime.agentRunOrigin='manual';
 await assert.rejects(f.service.manageSavedGoal(p,{...f.ctx,cwd:join(f.root,'foreign')}),/owner/);
 await assert.rejects(f.service.manageSavedGoal(p,{...f.ctx,sessionManager:{getSessionId:()=> 'foreign'}}),/owner/);
 const abort=new AbortController();abort.abort();await assert.rejects(f.service.manageSavedGoal(p,f.ctx,abort.signal));
 assert.deepEqual((await f.service.manageSavedGoal({scope:'saved',action:'status',goal_id:e.id},f.ctx)).goal.tasks,[]);assert.equal(f.starts(),0);
 const busy=discoveryFixture(t,true);const bs=await busy.send({action:'goals.create',expectedGoalId:null,objective:'Busy owner'}),be=bs.delegatedGoals.entries[0];
 await assert.rejects(busy.service.manageSavedGoal({...p,goal_id:be.id},busy.ctx),/pending/);
});

test('authenticated checklist protocol action uses the same metadata-only registry lane',async t=>{
 const f=discoveryFixture(t);let s=await f.send({action:'goals.create',expectedGoalId:null,objective:'Protocol checklist'}),e=s.delegatedGoals.entries[0];
 s=await f.send({action:'goals.tasks',expectedGoalId:e.id,expectedEntryRevision:e.revision,taskEdits:[{text:'Fixture prerequisite'}]});e=s.delegatedGoals.entries[0];
 assert.equal(e.tasks[0].text,'Fixture prerequisite');assert.equal(e.status,'paused');assert.equal(e.child,null);assert.equal(f.starts(),0);
});

test('direct saved completion uses the existing evidence and stopped-child guards rather than root Goal completion',async t=>{
 const f=discoveryFixture(t,false);let s=await f.send({action:'goals.create',expectedGoalId:null,objective:'Verified parent delivery'}),e=s.delegatedGoals.entries[0];
 s=await f.send({action:'goals.add_task',expectedGoalId:e.id,expectedEntryRevision:e.revision,text:'Verify output'});e=s.delegatedGoals.entries[0];
 const p={scope:'saved',action:'complete',goal_id:e.id,request_id:'finish-direct',summary:'Verified passing output tests.'};
 await assert.rejects(f.service.manageSavedGoal(p,f.ctx),/evidence|unfinished|completed/);
 const result=await f.service.manageSavedGoal({...p,request_id:'finish-evidence',task_evidence:[{task_id:e.tasks[0].id,evidence:'Inspected passing output tests.'}]},f.ctx);
 assert.equal(result.goal.status,'complete');assert.equal(result.goal.tasks[0].status,'completed');assert.equal(f.runtime.activeGoal,undefined);assert.equal(f.starts(),0);
 s=await f.send({action:'goals.create',expectedGoalId:null,objective:'Linked stopped proof'});e=s.delegatedGoals.entries.at(-1);
 const linked=await f.service.manageSavedGoal({scope:'saved',action:'start',goal_id:e.id,request_id:'linked-start'},f.ctx);
 const paused=await f.service.manageSavedGoal({scope:'saved',action:'pause',goal_id:e.id,request_id:'linked-pause'},f.ctx);
 const complete={scope:'saved',action:'complete',goal_id:e.id,request_id:'linked-unproven',summary:'Verified linked outcome.'};
 await assert.rejects(f.service.manageSavedGoal(complete,f.ctx),/stop|verification/i);
 globalThis.__paeDelegatedGoalExecutorV1.verifyStopped=async entry=>{assert.deepEqual(entry.child,linked.goal.child);};
 const verified=await f.service.manageSavedGoal({...complete,request_id:'linked-proven'},f.ctx);assert.equal(verified.goal.status,'complete');assert.deepEqual(verified.goal.child,linked.goal.child);
});

test('direct saved-Goal reads reject pagination/identity confusion and a stale launch revision never changes either goal',async t=>{
 const f=discoveryFixture(t,false);let s=await f.send({action:'goals.create',expectedGoalId:null,objective:'First saved'}),e=s.delegatedGoals.entries[0];
 await assert.rejects(f.service.manageSavedGoal({scope:'saved',action:'list',goal_id:e.id},f.ctx),/List omits/);
 await assert.rejects(f.service.manageSavedGoal({scope:'saved',action:'status',goal_id:e.id,offset:1},f.ctx),/list-only/);
 await assert.rejects(f.service.manageSavedGoal({scope:'saved',action:'status',goal_id:'foreign'},f.ctx),/not found/);
 const page=await f.service.manageSavedGoal({scope:'saved',action:'list',offset:50},f.ctx);assert.deepEqual(page.goals,[]);assert.equal(page.next_offset,null);
});

test('cold stalled ownership never delays Goal snapshots or confirmed child startup; reads are single-flight',async t=>{
 const f=discoveryFixture(t),gate=deferred();let reads=0;
 globalThis.__testOwnershipDiscovery=()=>{reads++;return gate.promise;};
 const initial=await f.snapshot();assert.equal(reads,0,'No inventory work on the foreground snapshot');assert.equal(initial.worktreeLoading,true);
 await turn();assert.equal(reads,1);
 let s=await f.send({action:'goals.create',expectedGoalId:null,objective:'Independent Goal'}),e=s.delegatedGoals.entries[0];
 s=await f.send({action:'goals.start',expectedGoalId:e.id,expectedEntryRevision:e.revision});assert.equal(s.dialog.kind,'confirm');
 await f.reply({operationId:s.operationId,dialogId:s.dialog.id,value:true});
 for(let i=0;i<20;i++){s=await f.snapshot();if(s.delegatedGoals.entries[0].child)break;}
 assert.equal(f.starts(),1);assert.equal(s.delegatedGoals.entries[0].status,'active');assert.equal(reads,1);
 f.service.dispose();gate.resolve([]);await turn();
});

test('cold repository discovery leaves cached status responsive and publishes only after it finishes',async t=>{
 const f=discoveryFixture(t),entered=deferred(),gate=deferred();let scans=0;
 globalThis.__testRepositoryDiscovery=()=>{scans++;entered.resolve();return gate.promise;};
 const first=await f.snapshot();assert.equal(scans,0);assert.equal(first.worktreeLoading,true);
 await bounded(entered.promise);
 for(let i=0;i<10;i++)assert.equal((await f.snapshot()).worktreeLoading,true);
 assert.equal(scans,1);gate.resolve({roots:[],active:null,warnings:[],limited:false});await turn();await turn();
 assert.equal((await f.snapshot()).worktreeLoading,false);assert.equal(scans,1);
});

test('discovery deadline reports partial state; late ignored-cancellation results cannot replace it',async t=>{
 const f=discoveryFixture(t),entered=deferred(),gate=deferred();
 globalThis.__testRepositoryDiscovery=(_pi,_cwd,signal)=>{entered.resolve(signal);return gate.promise;};
 await f.snapshot();const signal=await bounded(entered.promise);
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('No discovery deadline')),3000);signal.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true});});
 const s=await f.snapshot();assert.equal(s.worktreeLoading,false);assert.match(s.worktreeError,/timed out/);
 gate.resolve({roots:['/unverified-late-result'],active:null,warnings:[],limited:false});await turn();
 assert.deepEqual((await f.snapshot()).worktrees,[]);assert.match((await f.snapshot()).worktreeError,/timed out/);
});

test('context changes abort old discovery and cannot publish old cache into the new workspace',async t=>{
 const f=discoveryFixture(t),entered=deferred(),gate=deferred();let calls=0;
 globalThis.__testRepositoryDiscovery=(_pi,cwd,signal)=>{calls++;if(calls===1){entered.resolve(signal);return gate.promise;}return {roots:[],active:null,warnings:[],limited:false};};
 await f.snapshot();const signal=await bounded(entered.promise);
 f.service.refreshContext({...f.ctx,cwd:join(f.root,'new-workspace')});assert.equal(signal.aborted,true);
 gate.resolve({roots:['/old-workspace'],active:null,warnings:[],limited:false});await turn();
 await f.snapshot();await turn();await turn();const s=await f.snapshot();assert.equal(s.cwd,join(f.root,'new-workspace'));assert.deepEqual(s.worktrees,[]);
});

test('authenticated parent completion is a metadata-only service action while parent work remains untouched',async()=>{
 const root=mkdtempSync(join(tmpdir(),'delegated-parent-complete-')),previous=process.env.PI_DELEGATED_GOALS_STATE_ROOT;process.env.PI_DELEGATED_GOALS_STATE_ROOT=root;let service;
 try{
  const sessionId=randomUUID(),runtime={activeGoal:{id:'unrelated',status:'active',text:'Unrelated parent work'},snapshotSettingsApplicationState:()=>({}),settings:{continuationLimits:{automaticTurns:null,noProgressTurns:null}}},before=structuredClone(runtime.activeGoal);
  const ctx={cwd:root,isIdle:()=>false,hasPendingMessages:()=>true,sessionManager:{getSessionId:()=>sessionId,getLeafId:()=> 'leaf',getBranch:()=>[],getEntries:()=>[]},ui:{setStatus(){}},model:null};
  globalThis.__paeDelegatedGoalExecutorV1={protocol:1,sessionId,executionAvailable:()=>false,start(){throw Error('No child execution');},resume(){throw Error('No child execution');},pause(){throw Error('No child execution');}};
  service=createWorkflowService({appendEntry(){throw Error('No parent message mutation');}},ctx,runtime,{}, {get:()=>({})},()=>false);
  const identity={sessionId,serviceEpoch:service.serviceEpoch},send=r=>service.handle({...identity,operation:'start',requestId:randomUUID(),...r});
  let s=await send({action:'goals.create',expectedGoalId:null,objective:'Output already verified directly'});let e=s.delegatedGoals.entries[0];
  s=await send({action:'goals.add_task',expectedGoalId:e.id,expectedEntryRevision:e.revision,text:'Inspect direct verification evidence'});e=s.delegatedGoals.entries[0];
  s=await send({action:'goals.complete',expectedGoalId:e.id,expectedEntryRevision:e.revision,user_authorized:true,summary:'Verified direct delivery using inspected tests and artifacts.',taskEvidence:[{taskId:e.tasks[0].id,evidence:'Inspected passing tests and artifact hashes.'}]});
  assert.deepEqual(Object.keys(s.capabilities).sort(),['createPausedGoal','delegatedGoalExecution','delegatedGoals','goalLimitEditing','goalPlanning','goalReview','ownedWorktreeCompletion'].sort());assert.equal(s.delegatedGoals.entries[0].status,'complete');assert.equal(s.delegatedGoals.entries[0].tasks[0].status,'completed');assert.equal(s.operationAction,null);assert.deepEqual(runtime.activeGoal,before);
 }finally{service?.dispose();delete globalThis.__paeDelegatedGoalExecutorV1;if(previous===undefined)delete process.env.PI_DELEGATED_GOALS_STATE_ROOT;else process.env.PI_DELEGATED_GOALS_STATE_ROOT=previous;rmSync(root,{recursive:true,force:true});}
});

test("actual service permits busy parent metadata create and fences independent confirmed child actions", async () => {
  const root = mkdtempSync(join(tmpdir(), "delegated-service-"));
  const previous = process.env.PI_DELEGATED_GOALS_STATE_ROOT;
  process.env.PI_DELEGATED_GOALS_STATE_ROOT = root;
  let service;
  try {
    const calls = [], sessionId = randomUUID();
    const runtime = { activeGoal: { id: "legacy", text: "legacy untouched", status: "active", tokensUsed: 0 },
      snapshotSettingsApplicationState: () => ({}), settings: { continuationLimits: { automaticTurns: null, noProgressTurns: null } } };
    const originalGoal = structuredClone(runtime.activeGoal);
    const ctx = { cwd: root, isIdle: () => false, hasPendingMessages: () => true,
      sessionManager: { getSessionId: () => sessionId, getLeafId: () => "leaf", getBranch: () => [], getEntries: () => [] },
      ui: { setStatus() {} }, model: null };
    const pi = { appendEntry() { throw Error("Parent session mutation forbidden"); }, exec: async () => ({ code: 0, stdout: "", stderr: "" }) };
    globalThis.__paeDelegatedGoalExecutorV1 = { protocol: 1, sessionId,
      executionAvailable: () => true,
      async reviewRoot() { return root; },
      executionUnavailableReason: () => "Required child lifecycle tools denied by effective allowlist",
      async start(entry) { calls.push(`start:${entry.id}`); return { taskId: `task:${entry.id}`, childId: `child:${entry.id}:1`, jobId: `job:${entry.id}:1`, attempt: 1 }; },
      async pause(entry) { calls.push(`pause:${entry.id}`); },
      async resume(entry) { calls.push(`resume:${entry.id}`); return { ...entry.child, childId: `child:${entry.id}:2`, jobId: `job:${entry.id}:2`, attempt: 2 }; },
    };
    service = createWorkflowService(pi, ctx, runtime, {}, { get: () => ({}) }, () => true);
    const identity = { sessionId, serviceEpoch: service.serviceEpoch };
    const request = data => service.handle({ ...identity, requestId: randomUUID(), operation: "start", ...data });
    const snap = () => service.handle({ ...identity, operation: "snapshot" });
    let snapshot = await request({ action: "goals.create", expectedGoalId: null, expectedRegistryRevision: 0, objective: "first" });
    snapshot = await request({ action: "goals.create", expectedGoalId: null, expectedRegistryRevision: 1, objective: "second" });
    assert.equal(snapshot.delegatedGoals.entries.length, 2); assert.deepEqual(calls, []);
    assert.deepEqual(runtime.activeGoal, originalGoal); assert.equal(snapshot.idle, false);
    assert.deepEqual(snapshot.limits, { automaticTurns: null, noProgressTurns: null });
    let first = snapshot.delegatedGoals.entries[0];
    const second = snapshot.delegatedGoals.entries[1];
    snapshot = await request({ action: "goals.add_task", expectedGoalId: second.id, expectedEntryRevision: second.revision, text: "  keep exact task  " });
    const afterAdd = structuredClone(snapshot.delegatedGoals);
    const duplicate = { ...identity, requestId: randomUUID(), operation: "start", action: "goals.add_task", expectedGoalId: second.id, expectedEntryRevision: snapshot.delegatedGoals.entries[1].revision, text: "keep exact task" };
    await assert.rejects(service.handle(duplicate), /distinct descriptions/);
    await assert.rejects(service.handle(duplicate), /distinct descriptions/); // replay must retain rejection, never snapshot-as-success
    const staleEdit = { ...identity, requestId: randomUUID(), operation: "start", action: "goals.edit", expectedGoalId: first.id, expectedEntryRevision: first.revision + 99, objective: "must not apply" };
    await assert.rejects(service.handle(staleEdit), /revision/);
    await assert.rejects(service.handle(staleEdit), /revision/);
    snapshot = await snap(); assert.deepEqual(snapshot.delegatedGoals, afterAdd);
    snapshot = await request({action:"goals.add_task",expectedGoalId:second.id,expectedEntryRevision:snapshot.delegatedGoals.entries[1].revision,text:"Second planned task"});
    const plannedTasks=snapshot.delegatedGoals.entries[1].tasks;
    snapshot = await request({action:"goals.dependencies",expectedGoalId:second.id,expectedEntryRevision:snapshot.delegatedGoals.entries[1].revision,taskId:plannedTasks[1].id,waitsFor:[plannedTasks[0].id]});
    assert.equal(snapshot.capabilities.goalPlanning,true);assert.deepEqual(snapshot.delegatedGoals.entries[1].planning.dependencies,[{taskId:plannedTasks[1].id,waitsFor:[plannedTasks[0].id]}]);
    snapshot = await request({action:"goals.blocker.add",expectedGoalId:second.id,expectedEntryRevision:snapshot.delegatedGoals.entries[1].revision,blockerReason:"External service",blockerEvidence:"Recorded service failure"});
    const recorded=snapshot.delegatedGoals.entries[1].planning.blockers[0];
    snapshot = await request({action:"goals.blocker.clear",expectedGoalId:second.id,expectedEntryRevision:snapshot.delegatedGoals.entries[1].revision,blockerId:recorded.id});
    assert.equal(snapshot.delegatedGoals.entries[1].planning.blockers[0].evidence,"Recorded service failure");assert.ok(snapshot.delegatedGoals.entries[1].planning.blockers[0].clearedAt);assert.equal(snapshot.delegatedGoals.entries[1].status,"paused");assert.deepEqual(snapshot.delegatedGoals.entries[1].tasks,plannedTasks);
    assert.equal(snapshot.operationId, null); assert.equal(snapshot.notice, null); assert.deepEqual(calls, []);
    assert.ok(!readdirSync(root).some(name => name.endsWith(".intent")));
    globalThis.__paeDelegatedGoalExecutorV1.executionAvailable = () => false;
    snapshot = await snap();
    assert.equal(snapshot.capabilities.delegatedGoalExecution, false);
    assert.match(snapshot.notice, /tools denied/);
    snapshot = await request({ action: "goals.start", expectedGoalId: first.id, expectedEntryRevision: first.revision });
    assert.equal(snapshot.dialog, null); assert.deepEqual(calls, []);
    globalThis.__paeDelegatedGoalExecutorV1.executionAvailable = () => true;
    snapshot = await request({ action: "goals.start", expectedGoalId: first.id, expectedEntryRevision: first.revision });
    assert.equal(snapshot.dialog.kind, "confirm");
    assert.match(snapshot.dialog.message, /gpt-6\.1-sol/); assert.match(snapshot.dialog.message, /Workspace:/);
    assert.match(snapshot.dialog.message, /Dedicated automatic limit: unlimited/); assert.match(snapshot.dialog.message, /Dedicated no-progress limit: unlimited/);
    assert.deepEqual(calls, []);
    await service.handle({ ...identity, requestId: randomUUID(), operation: "send", operationId: snapshot.operationId, dialogId: snapshot.dialog.id, value: true });
    // Microtask-only deterministic drain: no polling timers or model calls.
    for (let i = 0; i < 20 && (await snap()).operationId; i++) await Promise.resolve();
    snapshot = await snap(); first = snapshot.delegatedGoals.entries[0];
    assert.equal(first.status, "active"); assert.equal(calls.length, 1);
    assert.equal(snapshot.delegatedGoals.entries[1].status, "paused");
    writeFileSync(join(root,"spec.md"),"Explicit registered source");
    snapshot = await request({ action: "goals.reference", expectedGoalId: first.id, expectedEntryRevision: first.revision, reviewTitle: "Spec", reviewTarget: "spec.md", reviewRole: "source" });
    first = snapshot.delegatedGoals.entries[0];
    const previewRequest = { ...identity, operation: "review", expectedGoalId: first.id, expectedEntryRevision: first.revision, referenceId: first.review[0].id };
    assert.deepEqual((await service.handle(previewRequest)).preview,{kind:"text",text:"Explicit registered source"});
    await assert.rejects(service.handle({...previewRequest,path:"/etc/passwd"}),/fields/);
    await assert.rejects(service.handle({...previewRequest,expectedEntryRevision:first.revision-1}),/changed/);
    await assert.rejects(service.handle({...previewRequest,referenceId:randomUUID()}),/unavailable/);
    writeFileSync(join(root,"spec.md"),"Changed source");await assert.rejects(service.handle(previewRequest),/changed/);
    writeFileSync(join(root,"spec.md"),"Explicit registered source");
    const questionId=randomUUID(),attachment={...first.review[0],id:randomUUID(),workerEpoch:"attachment-epoch",questionId};
    const question={id:questionId,revision:1,at:1,workerEpoch:"attachment-epoch",status:"pending",attachmentIds:[attachment.id],request:{kind:"questionnaire",questions:[{id:"q",prompt:"Review registered source",options:[{value:"yes",label:"Yes"}],allowOther:false}]}};
    globalThis.__paeDelegatedGoalExecutorV1.observe=async()=>({story:{version:1,timeline:[],activity:[],questions:[question]},review:[attachment]});
    snapshot=await snap();first=snapshot.delegatedGoals.entries[0];
    const attachmentRequest={...previewRequest,expectedEntryRevision:first.revision,referenceId:attachment.id,question:{questionId,questionRevision:1,workerEpoch:"attachment-epoch"}};
    assert.equal((await service.handle(attachmentRequest)).preview.text,"Explicit registered source");
    await assert.rejects(service.handle({...attachmentRequest,question:undefined}),/ownership/);
    await assert.rejects(service.handle({...attachmentRequest,question:{...attachmentRequest.question,questionRevision:2}}),/revision/);
    await assert.rejects(service.handle({...attachmentRequest,question:{...attachmentRequest.question,permission:true}}),/target/);
    assert.equal(calls.length,1,"review must not launch, resume, prompt or pause execution");
    await assert.rejects(service.handle({ ...identity, serviceEpoch: randomUUID(), operation: "snapshot" }), /Stale/);
    await assert.rejects(request({ action: "goals.pause", expectedGoalId: first.id, expectedEntryRevision: 0 }), /revision/);
    await assert.rejects(request({ action: "goal.start", expectedGoalId: "legacy", objective: "forbidden" }), /busy|read-only/);
    assert.deepEqual(runtime.activeGoal, originalGoal);
    await request({ action: "goals.pause", expectedGoalId: first.id, expectedEntryRevision: first.revision });
    for (let i = 0; i < 20 && (await snap()).operationId; i++) await Promise.resolve();
    snapshot = await snap(); const paused = snapshot.delegatedGoals.entries[0];
    assert.equal(paused.status, "paused");
    const unverifiableClear = { ...identity, requestId: randomUUID(), operation: "start", action: "goals.clear", expectedGoalId: paused.id, expectedEntryRevision: paused.revision };
    await assert.rejects(service.handle(unverifiableClear), /stop verification is unavailable/);
    await assert.rejects(service.handle(unverifiableClear), /stop verification is unavailable/);
    assert.equal((await snap()).delegatedGoals.entries[0].status, "paused");
    const clearSecond = snapshot.delegatedGoals.entries[1];
    snapshot = await request({ action: "goals.clear", expectedGoalId: clearSecond.id, expectedEntryRevision: clearSecond.revision });
    assert.equal(snapshot.delegatedGoals.entries[1].status, "cleared"); assert.equal(snapshot.operationId, null);
    assert.ok(!readdirSync(root).some(name => name.endsWith(".intent")));
    service.dispose(); service = createWorkflowService(pi, ctx, runtime, {}, { get: () => ({}) }, () => true);
    const restored = await service.handle({ operation: "snapshot", sessionId, serviceEpoch: service.serviceEpoch });
    assert.equal(restored.delegatedGoals.entries.length, 2); assert.equal(restored.delegatedGoals.entries[0].child.taskId, first.child.taskId);
  } finally {
    service?.dispose(); delete globalThis.__paeDelegatedGoalExecutorV1;
    if (previous === undefined) delete process.env.PI_DELEGATED_GOALS_STATE_ROOT; else process.env.PI_DELEGATED_GOALS_STATE_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("assigned limits API is available while busy and fences identity, revision, extra fields and replays", async () => {
  const root = mkdtempSync(join(tmpdir(), "assigned-limit-service-")), previous = process.env.PI_DELEGATED_GOALS_STATE_ROOT;
  process.env.PI_DELEGATED_GOALS_STATE_ROOT = root;
  let service;
  try {
    const sessionId = randomUUID(), calls = [];
    const runtime = { activeGoal: { id: "assigned", activationId: "assigned-activation", revision: 7, text: "Keep objective", status: "active", tokensUsed: 50 }, policyRevision: 4,
      continuationLimits: { automaticTurns: 8, noProgressTurns: 3 }, settings: { continuationLimits: { automaticTurns: null, noProgressTurns: null } },
      snapshotSettingsApplicationState: () => ({}),
      updateGoalLimits(ctx, id, revision, budget, limits) {
        if (id !== this.activeGoal.id || revision !== this.policyRevision) throw Error("Goal identity or policy revision changed");
        calls.push({ id, revision, budget, limits }); this.policyRevision++;
      } };
    const ctx = { cwd: root, isIdle: () => false, hasPendingMessages: () => true, ui: { setStatus() {} }, model: null,
      sessionManager: { getSessionId: () => sessionId, getBranch: () => [], getEntries: () => [], getLeafId: () => "leaf" } };
    service = createWorkflowService({ appendEntry() { throw Error("No direct session mutation"); }, exec: async () => ({ code: 0, stdout: "" }) }, ctx, runtime, {}, { get: () => ({}) }, () => true);
    const request = { operation: "start", sessionId, serviceEpoch: service.serviceEpoch, requestId: randomUUID(), action: "goal.limits",
      expectedGoalId: "assigned", expectedActivationId: "assigned-activation", expectedPolicyRevision: 4, tokenBudget: null, continuationLimits: { automaticTurns: 5, noProgressTurns: null } };
    await assert.rejects(service.handle({ ...request, serviceEpoch: randomUUID() }), /Stale/);
    await assert.rejects(service.handle({ ...request, objective: "not allowed" }), /Invalid/);
    await assert.rejects(service.handle({ ...request, expectedActivationId: "stale" }), /activation changed/);
    await assert.rejects(service.handle({ ...request, expectedPolicyRevision: 3 }), /revision changed/);
    const snapshot = await service.handle(request);
    assert.equal(snapshot.capabilities.goalLimitEditing, true); assert.equal(snapshot.goal.policyRevision, 5);
    assert.deepEqual(snapshot.goal.effectiveLimits, runtime.continuationLimits);
    assert.equal(calls.length, 1); assert.equal(calls[0].budget, null);
    await service.handle(request); assert.equal(calls.length, 1);
    await assert.rejects(service.handle({ ...request, requestId: randomUUID() }), /revision changed/);
    await assert.rejects(service.handle({ ...request, tokenBudget: 100 }), /Request ID conflict/);
  } finally {
    service?.dispose();
    if (previous === undefined) delete process.env.PI_DELEGATED_GOALS_STATE_ROOT; else process.env.PI_DELEGATED_GOALS_STATE_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
