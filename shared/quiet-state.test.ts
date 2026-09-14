import assert from 'node:assert/strict';
import { installQuietState, notifyParent, QUIET_STATE_RECEIPT_CUSTOM_TYPE } from './quiet-state.js';

const pause=(ms=30)=>new Promise(resolve=>setTimeout(resolve,ms));
let entries:any[]=[];let idle=false;let pending=false;let sessionName=`quiet-test-${process.pid}`;
const ctx:any={
  hasUI:true,
  isIdle:()=>idle,
  hasPendingMessages:()=>pending,
  ui:{
    theme:{fg:(_name:string,text:string)=>text},
    status:new Map<string,string|undefined>(),
    notices:[] as string[],
    setStatus(key:string,value:string|undefined){this.status.set(key,value);},
    notify(text:string){this.notices.push(text);},
  },
  sessionManager:{getSessionId:()=>sessionName,getBranch:()=>entries,getEntries:()=>entries},
};
function fixture(failReceipt=false,failSends=0){
 const handlers=new Map<string,any[]>();const messages:any[]=[];const commands=new Map<string,any>();
 const pi:any={
   appendEntry(customType:string,data:any){if(failReceipt&&customType===QUIET_STATE_RECEIPT_CUSTOM_TYPE)throw new Error('persist failed');entries.push({type:'custom',customType,data});},
   on(name:string,handler:any){handlers.set(name,[...(handlers.get(name)??[]),handler]);},
   registerCommand(name:string,value:any){commands.set(name,value);},
   sendMessage(message:any,options:any){if(failSends-->0)throw new Error('send failed');messages.push({message,options});entries.push({type:'custom_message',customType:message.customType,details:message.details});},
 };
 return {pi,messages,commands,async emit(name:string,event:any={}){for(const h of handlers.get(name)??[])await h(event,ctx);}};
}

// Thousands of routine producer updates are persisted as custom receipts and never wake the model.
entries=[];idle=true;sessionName=`quiet-thousand-${process.pid}`;
const first=fixture();const quiet=installQuietState(first.pi,5);await first.emit('session_start');
for(let i=0;i<1000;i++)quiet.enqueue(ctx,{kind:'job',id:`job-${i}`,state:'completed'});
for(let i=0;i<1000;i++)quiet.enqueue(ctx,{kind:'subagent',id:`sub-${i}`,state:'completed',outcomes:[{child:i,state:'delivered'}]});
await pause(80);
assert.equal(first.messages.length,0,'routine receipts must not call the model');
assert.equal(entries.filter(e=>e.customType===QUIET_STATE_RECEIPT_CUSTOM_TYPE).length,2000);
assert.equal(entries.find(e=>e.customType===QUIET_STATE_RECEIPT_CUSTOM_TYPE).data.state,'recorded');
assert.equal(entries.find(e=>e.customType===QUIET_STATE_RECEIPT_CUSTOM_TYPE).data.revision.length,64);
assert.ok(Buffer.byteLength(JSON.stringify(entries.find(e=>e.customType===QUIET_STATE_RECEIPT_CUSTOM_TYPE).data),'utf8')<=4096);

// Polling historical state after reload dedups from durable receipts, not a bounded in-memory seen set.
await first.emit('session_shutdown',{reason:'reload'});
const reload=fixture();const quietReload=installQuietState(reload.pi,5);await reload.emit('session_start',{reason:'reload'});
// Old producers recorded terminal jobs without completion:true. Upgrading must not replay them.
for(let i=0;i<1000;i++)quietReload.enqueue(ctx,{kind:'job',id:`job-${i}`,state:'completed',completion:true});
await pause(80);
assert.equal(reload.messages.length,0,'restored routine receipts replayed into model');
assert.equal(entries.filter(e=>e.customType===QUIET_STATE_RECEIPT_CUSTOM_TYPE).length,2000,'duplicate routine receipts appended on reload');

// Watch cursor coalesces while queued; partial consume cannot hide newer events.
quietReload.enqueue(ctx,{kind:'watch',id:'watch-one',through_sequence:8,count:8,requires_guidance:true});
quietReload.consume(ctx,'watch','watch-one',4);await pause(80);
assert.equal(reload.messages.length,1,'partial consume hid newer guidance events');
quietReload.consume(ctx,'watch','watch-one',8);await pause(40);
assert.equal(reload.messages.length,1,'consumed guidance generated another wake');
assert.equal(entries.filter(e=>e.customType===QUIET_STATE_RECEIPT_CUSTOM_TYPE).at(-1).data.state,'delivered');

// Explicit guidance retains its separate quota and is coalesced.
entries=[];sessionName=`quiet-guidance-${process.pid}`;const guidance=fixture();const quietGuidance=installQuietState(guidance.pi,5);await guidance.emit('session_start');
quietGuidance.enqueue(ctx,{kind:'job',id:'needs-help',state:'failed',requires_guidance:true});
quietGuidance.enqueue(ctx,{kind:'subagent',id:'needs-help-2',state:'partial',requires_guidance:true});
await pause(80);
assert.equal(guidance.messages.length,1,'guidance did not wake the model');
assert.equal(guidance.messages[0].options.triggerTurn,true);
assert.equal(guidance.messages[0].message.details.updates.length,2);
assert.equal(guidance.messages[0].message.details.updates.every((u:any)=>u.requires_guidance),true);
assert.match(guidance.messages[0].message.content,/guidance request only/);
assert.match(guidance.messages[0].message.content,/Do not recap/);
await guidance.emit('session_shutdown',{reason:'reload'});
const rateReload=fixture();const quietRateReload=installQuietState(rateReload.pi,5);await rateReload.emit('session_start',{reason:'reload'});
quietRateReload.enqueue(ctx,{kind:'job',id:'rate-persisted',requires_guidance:true});await pause(80);
assert.equal(rateReload.messages.length,0,'guidance rate limit did not persist across reload');

// Retained notifications are available to operators without model delivery.
entries=[];sessionName=`quiet-notes-${process.pid}`;const notesFixture=fixture();const quietNotes=installQuietState(notesFixture.pi,5);await notesFixture.emit('session_start');
const child='subagent-child-'+'a'.repeat(24);const owner=ctx.sessionManager.getSessionId();
notifyParent(owner,child,'finding',{message:'A concise discovery'});
assert.equal(notesFixture.messages.length,0,'routine child finding woke the model');
await notesFixture.commands.get('harness-state').handler('show',ctx);
assert.equal(notesFixture.messages.length,1);
assert.equal(notesFixture.messages[0].options.triggerTurn,false);
assert.match(notesFixture.messages[0].message.content,/A concise discovery/);

// Runtime disable persists across reload and suppresses guidance.
await notesFixture.commands.get('harness-state').handler('disable',ctx);
quietNotes.enqueue(ctx,{kind:'job',id:'disabled-help',requires_guidance:true});await pause(80);
assert.equal(notesFixture.messages.length,1,'disabled session woke the model');
await notesFixture.emit('session_shutdown',{reason:'reload'});
const disabledReload=fixture();const quietDisabled=installQuietState(disabledReload.pi,5);await disabledReload.emit('session_start',{reason:'reload'});
quietDisabled.enqueue(ctx,{kind:'job',id:'still-disabled',requires_guidance:true});await pause(80);
assert.equal(disabledReload.messages.length,0,'persistent disable was not restored');
await disabledReload.commands.get('harness-state').handler('enable',ctx);
quietDisabled.enqueue(ctx,{kind:'job',id:'enabled-help',requires_guidance:true});await pause(1200);
assert.equal(disabledReload.messages.length,1,'enabled guidance did not deliver');
await disabledReload.commands.get('harness-state').handler('status',ctx);
assert.match(ctx.ui.notices.at(-1),/guidanceBytes=\d+/);
assert.match(ctx.ui.notices.at(-1),/schedulingAttempts=\d+/);

// Compaction pauses and leaves the kill switch set until explicit enable.
quietDisabled.enqueue(ctx,{kind:'job',id:'compact-help',requires_guidance:true});
await disabledReload.emit('session_before_compact');await pause(80);
assert.equal(disabledReload.messages.length,1,'compaction pause failed');
await disabledReload.emit('session_compact');
quietDisabled.enqueue(ctx,{kind:'job',id:'after-compact',requires_guidance:true});await pause(1200);
assert.equal(disabledReload.messages.length,1,'compaction cleared the kill switch without explicit enable');

// Receipt persistence failure fails closed: no successful enqueue/dedup claim and no wakeup.
entries=[];sessionName=`quiet-fail-${process.pid}`;const fail=fixture(true);const quietFail=installQuietState(fail.pi,5);await fail.emit('session_start');
assert.equal(quietFail.enqueue(ctx,{kind:'job',id:'no-receipt',state:'completed'}),false);
assert.equal(quietFail.enqueue(ctx,{kind:'job',id:'no-receipt-guidance',requires_guidance:true}),false);
await pause(1200);assert.equal(fail.messages.length,0);

await fail.emit('session_shutdown',{reason:'quit'});

// Terminal execution explicitly opts in: idle wake, batch, stable identity,
// result consumption, active tool-safe delivery, and restart deduplication.
entries=[];idle=true;sessionName=`quiet-completion-${process.pid}`;
const terminal=fixture();const terminalQuiet=installQuietState(terminal.pi,5);await terminal.emit('session_start');
terminalQuiet.enqueue(ctx,{kind:'subagent',id:'done',state:'completed',completion:true});
terminalQuiet.enqueue(ctx,{kind:'subagent',id:'failed',state:'failed',completion:true});
await pause(80);
assert.equal(terminal.messages.length,1);
assert.deepEqual(terminal.messages[0].options,{deliverAs:'followUp',triggerTurn:true});
assert.equal(terminal.messages[0].message.details.updates.length,2);
assert.equal(terminal.messages[0].message.details.updates.some((u:any)=>u.requires_guidance),false);
assert.match(terminal.messages[0].message.content,/child completion/);
terminalQuiet.enqueue(ctx,{kind:'subagent',id:'done',state:'completed',completion:true,outcomes:[{child:1,state:'delivered'}]});
await pause(80);assert.equal(terminal.messages.length,1,'metadata changes replayed completion');
idle=false;
terminalQuiet.enqueue(ctx,{kind:'subagent',id:'busy-done',state:'lost',completion:true});
await pause(80);assert.deepEqual(terminal.messages[1].options,{deliverAs:'steer',triggerTurn:true});
terminalQuiet.enqueue(ctx,{kind:'subagent',id:'read-first',job_id:'group',child_id:'child',completion:true});
terminalQuiet.consumeCompletion(ctx,'group','child');await pause(80);
assert.equal(terminal.messages.length,2,'result consumed before delivery still woke parent');
await terminal.emit('session_shutdown',{reason:'reload'});
const terminalReload=fixture();const terminalReloadQuiet=installQuietState(terminalReload.pi,5);await terminalReload.emit('session_start');
terminalReloadQuiet.enqueue(ctx,{kind:'subagent',id:'done',state:'completed',completion:true});await pause(80);
assert.equal(terminalReload.messages.length,0,'delivered completion replayed on reload');
// Guidance exhaustion and compaction must not silently disable completions.
for(let i=0;i<20;i++)entries.push({type:'custom',customType:QUIET_STATE_RECEIPT_CUSTOM_TYPE,data:{v:1,key:`job:quota-${i}`,revision:'rev',state:'delivered',at:Date.now(),update:{kind:'job',id:`quota-${i}`,requires_guidance:true}}});
await terminalReload.emit('agent_settled');
terminalReloadQuiet.enqueue(ctx,{kind:'job',id:'quota-blocked',requires_guidance:true});
terminalReloadQuiet.enqueue(ctx,{kind:'subagent',id:'quota-completion',completion:true});await pause(80);
assert.equal(terminalReload.messages.length,1,'guidance quota blocked completion');
await terminalReload.emit('session_before_compact');
terminalReloadQuiet.enqueue(ctx,{kind:'subagent',id:'compact-completion',completion:true});await pause(80);
assert.equal(terminalReload.messages.length,1);
await terminalReload.emit('session_compact');await pause(80);
assert.equal(terminalReload.messages.length,2,'completion failed to resume after compaction');
await terminalReload.emit('session_shutdown',{reason:'quit'});

// A failed send stays queued durably and can retry after restart.
entries=[];idle=true;sessionName=`quiet-send-fail-${process.pid}`;
const sendFail=fixture(false,1);const sendQuiet=installQuietState(sendFail.pi,5);await sendFail.emit('session_start');
sendQuiet.enqueue(ctx,{kind:'subagent',id:'retry',completion:true});await pause(80);
assert.equal(sendFail.messages.length,0);
assert.equal(entries.at(-1).data.state,'queued','failed send prematurely acknowledged');
await sendFail.emit('session_shutdown',{reason:'reload'});
const retry=fixture();installQuietState(retry.pi,5);await retry.emit('session_start');await pause(80);
assert.equal(retry.messages.length,1,'failed send was lost on reload');
await retry.emit('session_shutdown',{reason:'quit'});

entries=[];sessionName=`quiet-many-completions-${process.pid}`;
const many=fixture();const manyQuiet=installQuietState(many.pi,5);await many.emit('session_start');
for(let i=0;i<25;i++){
  manyQuiet.enqueue(ctx,{kind:'subagent',id:`terminal-${i}`,completion:true});
  await pause(15);
}
assert.equal(many.messages.length,25,'completion inherited guidance throttle/quota');
pending=true;manyQuiet.enqueue(ctx,{kind:'subagent',id:'pending-messages',completion:true});await pause(30);
assert.equal(many.messages.length,25);
pending=false;await pause(1100);assert.equal(many.messages.length,26,'pending messages stalled completion permanently');
await many.emit('ui_prompt_start');manyQuiet.enqueue(ctx,{kind:'subagent',id:'ui-wait',completion:true});await pause(30);
assert.equal(many.messages.length,26);await many.emit('ui_prompt_end');await pause(30);assert.equal(many.messages.length,27);
await many.commands.get('harness-state').handler('disable',ctx);
assert.equal(manyQuiet.enqueue(ctx,{kind:'subagent',id:'disabled-completion',completion:true}),false);
await pause(30);assert.equal(many.messages.length,27,'explicit disable did not suppress completion');
await many.emit('session_shutdown',{reason:'quit'});
// Shell completion uses the same safe delivery path, but backend-specific instructions.
entries=[];idle=true;pending=false;sessionName=`quiet-shell-${process.pid}`;
const shell=fixture();const shellQuiet=installQuietState(shell.pi,5);await shell.emit('session_start');
shellQuiet.consume(ctx,'job','read-before-enqueue');
shellQuiet.enqueue(ctx,{kind:'job',id:'read-before-enqueue',state:'completed',completion:true});
shellQuiet.enqueue(ctx,{kind:'watch',id:'terminal-watch',state:'completed',completion:true});
await pause(30);assert.equal(shell.messages.length,0);
await shell.emit('ui_prompt_start');
shellQuiet.enqueue(ctx,{kind:'job',id:'shell-ui',state:'failed',completion:true});
await pause(30);assert.equal(shell.messages.length,0);
await shell.emit('ui_prompt_end');await pause(30);
assert.equal(shell.messages.length,1);
assert.match(shell.messages[0].message.content,/background_job action=status and action=output/);
assert.match(shell.messages[0].message.content,/reap only when authorized/);
assert.doesNotMatch(shell.messages[0].message.content,/subagent operation=result/);
pending=true;shellQuiet.enqueue(ctx,{kind:'job',id:'shell-pending',state:'cancelled',completion:true});
await pause(30);assert.equal(shell.messages.length,1);
pending=false;await pause(1100);assert.equal(shell.messages.length,2);
await shell.emit('session_before_compact');
shellQuiet.enqueue(ctx,{kind:'job',id:'shell-compact',state:'lost',completion:true});
await pause(30);assert.equal(shell.messages.length,2);
await shell.emit('session_compact');await pause(30);assert.equal(shell.messages.length,3);
// Mixed batches retain both backend routes, never tell shell jobs to use subagent result.
shellQuiet.enqueue(ctx,{kind:'job',id:'shell-mixed',completion:true});
shellQuiet.enqueue(ctx,{kind:'subagent',id:'child-mixed',completion:true});
await pause(30);assert.match(shell.messages[3].message.content,/subagent operation=result/);
assert.match(shell.messages[3].message.content,/background_job action=status/);
await shell.emit('session_shutdown',{reason:'quit'});
console.log('quiet-state remediation tests passed');
