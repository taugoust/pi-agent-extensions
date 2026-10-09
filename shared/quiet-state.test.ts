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
function fixture(failReceipt:boolean|(()=>boolean)=false,failSends=0){
 const handlers=new Map<string,any[]>();const messages:any[]=[];const commands=new Map<string,any>();
 const pi:any={
   appendEntry(customType:string,data:any){if((typeof failReceipt==='function'?failReceipt():failReceipt)&&customType===QUIET_STATE_RECEIPT_CUSTOM_TYPE)throw new Error('persist failed');entries.push({type:'custom',customType,data});},
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
assert.match(guidance.messages[0].message.content,/operation=prompt/);
assert.match(guidance.messages[0].message.content,/child_id/);
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

// Dismissal requires an explicit scope and consumes only pending guidance, durably.
const childA='subagent-child-'+'b'.repeat(24),childB='subagent-child-'+'c'.repeat(24);
await notesFixture.emit('ui_prompt_start');
quietNotes.enqueue(ctx,{kind:'notification',id:'guide-a',child_id:childA,requires_guidance:true,message:'help A'});
quietNotes.enqueue(ctx,{kind:'notification',id:'guide-b',child_id:childB,requires_guidance:true,message:'help B'});
quietNotes.enqueue(ctx,{kind:'job',id:'mixed-completion',child_id:childA,requires_guidance:true,completion:true});
await notesFixture.commands.get('harness-state').handler('dismiss-guidance',ctx);
assert.match(ctx.ui.notices.at(-1),/Usage:/,'dismiss without scope must refuse');
await notesFixture.commands.get('harness-state').handler(`dismiss-guidance ${childA}`,ctx);
assert.equal(entries.filter(e=>e.customType===QUIET_STATE_RECEIPT_CUSTOM_TYPE&&e.data.state==='consumed').length,1);
await notesFixture.emit('session_shutdown',{reason:'reload'});
const dismissReload=fixture();installQuietState(dismissReload.pi,5);await dismissReload.emit('session_start');await dismissReload.emit('ui_prompt_start');await pause(80);
const reloadHub=(globalThis as any).__paeQuietHarnessStateV2.get(sessionName);
assert.equal(reloadHub.pending.has('notification:guide-a'),false,'exact dismissal replayed after reload');
assert.equal([...reloadHub.pending.keys()].some(k=>k.includes('guide-b')),true,'exact dismissal consumed unmatched guidance');
assert.equal(reloadHub.pending.has('job:mixed-completion'),true,'guidance dismissal consumed completion-marked update');
await dismissReload.commands.get('harness-state').handler('dismiss-guidance all',ctx);
assert.equal(reloadHub.pending.has('notification:guide-b'),false);
assert.equal(reloadHub.pending.has('job:mixed-completion'),true);
await dismissReload.emit('ui_prompt_end');

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
assert.equal(disabledReload.messages.length>=1,true,'enabled guidance did not deliver');
await disabledReload.commands.get('harness-state').handler('status',ctx);
assert.match(ctx.ui.notices.at(-1),/guidanceBytes=\d+/);
assert.match(ctx.ui.notices.at(-1),/schedulingAttempts=\d+/);

// Compaction pauses at runtime only and resumes automatically on both outcomes.
entries=[];sessionName=`quiet-compact-${process.pid}`;const compactFx=fixture();const compactQuiet=installQuietState(compactFx.pi,5);await compactFx.emit('session_start');
compactQuiet.enqueue(ctx,{kind:'job',id:'compact-first',requires_guidance:true});
await compactFx.emit('session_before_compact');await compactFx.commands.get('harness-state').handler('status',ctx);
assert.match(ctx.ui.notices.at(-1),/reason=compaction/);
await compactFx.emit('session_compact');compactQuiet.enqueue(ctx,{kind:'job',id:'compact-success',requires_guidance:true});await pause(1200);
assert.equal(compactFx.messages.length,1,'successful compaction did not resume automatically');
assert.equal((globalThis as any).__paeQuietHarnessStateV2.get(sessionName).stats.guidanceDelivered,2,'compaction reset or miscounted guidance quota');
await compactFx.emit('session_before_compact');await compactFx.emit('session_compact_failed');
compactQuiet.enqueue(ctx,{kind:'job',id:'compact-failure',requires_guidance:true});await pause(80);
const compactHub=(globalThis as any).__paeQuietHarnessStateV2.get(sessionName);
assert.equal(compactHub.compacting,false,'failed compaction left runtime pause latched');
assert.equal(compactHub.pending.has('job:compact-failure'),true,'failed compaction lost queued guidance');
await compactFx.commands.get('harness-state').handler('status',ctx);assert.match(ctx.ui.notices.at(-1),/reason=guidance quota|reason=none/);
await compactFx.emit('session_shutdown',{reason:'reload'});
// Legacy persisted pauses stay disabled until explicit enable.
entries.push({type:'custom',customType:'harness-state-control',data:{v:1,disabled:true,reason:'compaction-pause'}});
const legacyFx=fixture();const legacyQuiet=installQuietState(legacyFx.pi,5);await legacyFx.emit('session_start');
legacyQuiet.enqueue(ctx,{kind:'job',id:'legacy-paused',requires_guidance:true});await pause(80);assert.equal(legacyFx.messages.length,0);
await legacyFx.commands.get('harness-state').handler('status',ctx);assert.match(ctx.ui.notices.at(-1),/reason=persisted guidance pause/);
await legacyFx.commands.get('harness-state').handler('enable',ctx);await pause(1200);assert.equal(legacyFx.messages.length,1);
await legacyFx.emit('session_shutdown',{reason:'quit'});

// Legacy messages keep their original delivery time, not each restore's time.
entries=[{type:'custom_message',customType:'harness-state',timestamp:'2020-01-01T00:00:00.000Z',details:{updates:[{kind:'notification',id:'historic-help',requires_guidance:true,message:'old'}]}}];
sessionName=`quiet-historic-quota-${process.pid}`;
const historic=fixture();const historicQuiet=installQuietState(historic.pi,5);await historic.emit('session_start');
await historic.commands.get('harness-state').handler('enable',ctx);
await historic.emit('agent_settled');
const historicHub=(globalThis as any).__paeQuietHarnessStateV2.get(sessionName);
assert.equal(historicHub.stats.guidanceDelivered,0,'restoring historical messages re-exhausted the reset quota');
historicQuiet.enqueue(ctx,{kind:'notification',id:'current-help',requires_guidance:true,message:'current'});await pause(80);
assert.equal(historic.messages.length,1);
const deliveryTime=historicHub.receipts.get('notification:current-help').at;
await historic.emit('agent_settled');
assert.equal(historicHub.stats.guidanceDelivered,1);
assert.equal(historicHub.receipts.get('notification:current-help').at,deliveryTime,'message restore replaced an explicit receipt timestamp');
await historic.emit('session_shutdown',{reason:'quit'});

// Receipt persistence failure fails closed: no successful enqueue/dedup claim and no wakeup.
entries=[];sessionName=`quiet-fail-${process.pid}`;const fail=fixture(true);const quietFail=installQuietState(fail.pi,5);await fail.emit('session_start');
assert.equal(quietFail.enqueue(ctx,{kind:'job',id:'no-receipt',state:'completed'}),false);
assert.equal(quietFail.enqueue(ctx,{kind:'job',id:'no-receipt-guidance',requires_guidance:true}),false);
await pause(1200);assert.equal(fail.messages.length,0);

await fail.emit('session_shutdown',{reason:'quit'});

// Terminal execution explicitly opts in: idle wake, batch, stable identity,
// result consumption, busy-parent deferral, and restart deduplication.
entries=[];idle=true;sessionName=`quiet-completion-${process.pid}`;
const terminal=fixture();const terminalQuiet=installQuietState(terminal.pi,5);await terminal.emit('session_start');
terminalQuiet.enqueue(ctx,{kind:'subagent',id:'done',state:'completed',completion:true,job_id:'group-done',child_id:'child-done'});
terminalQuiet.enqueue(ctx,{kind:'subagent',id:'failed',state:'failed',completion:true,job_id:'group-failed',child_id:'child-failed'});
await pause(80);
assert.equal(terminal.messages.length,1);
assert.deepEqual(terminal.messages[0].options,{deliverAs:'followUp',triggerTurn:true});
assert.equal(terminal.messages[0].message.details.updates.length,2);
assert.equal(terminal.messages[0].message.details.updates.some((u:any)=>u.requires_guidance),false);
assert.match(terminal.messages[0].message.content,/result/i);
assert.match(terminal.messages[0].message.content,/reap/i);
terminalQuiet.enqueue(ctx,{kind:'subagent',id:'done',state:'completed',completion:true,job_id:'group-done',child_id:'child-done',outcomes:[{child:1,state:'delivered'}]});
await pause(80);assert.equal(terminal.messages.length,1,'metadata changes replayed completion');
idle=false;
terminalQuiet.enqueue(ctx,{kind:'subagent',id:'busy-done',state:'lost',completion:true});
await pause(80);assert.equal(terminal.messages.length,1,'busy parent received a completion steer');
idle=true;await pause(1100);assert.deepEqual(terminal.messages[1].options,{deliverAs:'followUp',triggerTurn:true});
terminalQuiet.enqueue(ctx,{kind:'subagent',id:'read-first',job_id:'group',child_id:'child',completion:true,through_sequence:5});
terminalQuiet.consumeCompletion(ctx,'group','child','different-report',4);
assert.equal([...((globalThis as any).__paeQuietHarnessStateV2.get(sessionName).pending.values())].some((i:any)=>i.data.id==='read-first'),true,'consumption of a different report hid this completion');
terminalQuiet.consumeCompletion(ctx,'group','child','read-first',5);await pause(80);
assert.equal(terminal.messages.length,2,'result consumed before delivery still woke parent');
// A newer terminal snapshot supersedes the stale pending completion for the same child.
terminalQuiet.enqueue(ctx,{kind:'subagent',id:'old-report',job_id:'coalesce-group',child_id:'coalesce-child',completion:true});
terminalQuiet.enqueue(ctx,{kind:'subagent',id:'new-report',job_id:'coalesce-group',child_id:'coalesce-child',completion:true,state:'completed'});
await pause(80);
assert.equal(terminal.messages.length,3);
assert.deepEqual(terminal.messages[2].message.details.updates.map((u:any)=>u.id),['new-report']);
// A result consumed before its completion event is enqueued leaves a durable sequence tombstone.
terminalQuiet.consumeCompletion(ctx,'race-group','race-child','race-terminal',10);
terminalQuiet.enqueue(ctx,{kind:'subagent',id:'race-group:race-child:terminal:race-terminal',job_id:'race-group',child_id:'race-child',completion:true,through_sequence:10});
assert.equal([...((globalThis as any).__paeQuietHarnessStateV2.get(sessionName).pending.values())].some((i:any)=>i.data.child_id==='race-child'),false);
// Consuming sequence 10 removes older wakes but leaves a later unseen sequence intact.
terminalQuiet.enqueue(ctx,{kind:'subagent',id:'seq-9',job_id:'seq-group',child_id:'seq-child',completion:true,through_sequence:9});
terminalQuiet.enqueue(ctx,{kind:'subagent',id:'seq-11',job_id:'seq-group',child_id:'seq-child',completion:true,through_sequence:11});
terminalQuiet.consumeCompletion(ctx,'seq-group','seq-child','seq-10',10);
const seqPending=[...((globalThis as any).__paeQuietHarnessStateV2.get(sessionName).pending.values())].filter((i:any)=>i.data.child_id==='seq-child');
assert.deepEqual(seqPending.map((i:any)=>i.data.through_sequence),[11]);
await terminal.emit('session_shutdown',{reason:'reload'});
const terminalReload=fixture();const terminalReloadQuiet=installQuietState(terminalReload.pi,5);await terminalReload.emit('session_start');
terminalReloadQuiet.enqueue(ctx,{kind:'subagent',id:'done',state:'completed',completion:true,job_id:'group-done',child_id:'child-done'});await pause(80);
assert.equal(terminalReload.messages.length,1,'reload must deliver the newer unseen report only');
assert.deepEqual(terminalReload.messages[0].message.details.updates.map((u:any)=>u.id),['seq-11']);
// Delayed older events must not replay after a newer report was delivered.
terminalReloadQuiet.enqueue(ctx,{kind:'subagent',id:'delayed-seq-8',job_id:'seq-group',child_id:'seq-child',completion:true,through_sequence:8});
terminalReloadQuiet.enqueue(ctx,{kind:'subagent',id:'race-group:race-child:terminal:race-terminal',job_id:'race-group',child_id:'race-child',completion:true,through_sequence:10});
await pause(80);assert.equal(terminalReload.messages.length,1,'consumed or superseded reports replayed after reload');
// Guidance exhaustion and compaction must not silently disable completions.
for(let i=0;i<20;i++)entries.push({type:'custom',customType:QUIET_STATE_RECEIPT_CUSTOM_TYPE,data:{v:1,key:`job:quota-${i}`,revision:'rev',state:'delivered',at:Date.now(),update:{kind:'job',id:`quota-${i}`,requires_guidance:true}}});
await terminalReload.emit('agent_settled');
terminalReloadQuiet.enqueue(ctx,{kind:'job',id:'quota-blocked',requires_guidance:true});
terminalReloadQuiet.enqueue(ctx,{kind:'subagent',id:'quota-completion',completion:true});await pause(80);
assert.equal(terminalReload.messages.length,2,'guidance quota blocked completion');
await terminalReload.emit('session_before_compact');
terminalReloadQuiet.enqueue(ctx,{kind:'subagent',id:'compact-completion',completion:true});await pause(80);
assert.equal(terminalReload.messages.length,2);
await terminalReload.emit('session_compact');await pause(80);
assert.equal(terminalReload.messages.length,3,'completion failed to resume after compaction');
await terminalReload.emit('session_shutdown',{reason:'quit'});

// Report order survives out-of-order polling, consumed older results, and reload.
entries=[];idle=false;sessionName=`quiet-order-${process.pid}`;
const ordered=fixture();const orderedQuiet=installQuietState(ordered.pi,5);await ordered.emit('session_start');
const completion=(sequence:number)=>({kind:'subagent' as const,id:`ordered:child:terminal:r${sequence}`,job_id:'ordered',child_id:'child',completion:true,through_sequence:sequence});
orderedQuiet.enqueue(ctx,completion(20));orderedQuiet.enqueue(ctx,completion(19));
await pause(80);assert.equal(ordered.messages.length,0,'busy parent must not accumulate Pi steering messages');
orderedQuiet.consumeCompletion(ctx,'ordered','child','r18',18);
await ordered.emit('session_shutdown',{reason:'reload'});
const orderedReload=fixture();const orderedReloadQuiet=installQuietState(orderedReload.pi,5);await orderedReload.emit('session_start');
idle=true;await pause(80);
assert.deepEqual(orderedReload.messages.flatMap(m=>m.message.details.updates.map((u:any)=>u.through_sequence)),[20]);
await orderedReload.emit('agent_settled');await pause(80);
assert.equal(orderedReload.messages.length,1,'consumed older report won by receipt timestamp');
orderedReloadQuiet.enqueue(ctx,completion(21));await pause(80);
assert.equal(orderedReload.messages.length,2,'a genuine later completion failed to wake');
orderedReloadQuiet.consumeCompletion(ctx,'ordered','child','r22',22);
orderedReloadQuiet.enqueue(ctx,completion(22));await pause(80);
assert.equal(orderedReload.messages.length,2,'read-before-enqueue race replayed completion');
// Sequence-free legacy reports cannot consume an unrelated later turn.
orderedReloadQuiet.consumeCompletion(ctx,'legacy','child','first');
orderedReloadQuiet.enqueue(ctx,{kind:'subagent',id:'legacy:child:terminal:first',job_id:'legacy',child_id:'child',completion:true});
orderedReloadQuiet.enqueue(ctx,{kind:'subagent',id:'legacy:child:terminal:second',job_id:'legacy',child_id:'child',completion:true});
await pause(80);assert.deepEqual(orderedReload.messages[2].message.details.updates.map((u:any)=>u.id),['legacy:child:terminal:second']);
await orderedReload.emit('session_shutdown',{reason:'quit'});

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
assert.match(shell.messages[0].message.content,/output/i);
assert.match(shell.messages[0].message.content,/reap/i);
assert.equal(shell.messages[0].message.details.updates[0].kind,'job');
pending=true;shellQuiet.enqueue(ctx,{kind:'job',id:'shell-pending',state:'cancelled',completion:true});
await pause(30);assert.equal(shell.messages.length,1);
pending=false;await pause(1100);assert.equal(shell.messages.length,2);
await shell.emit('session_before_compact');
shellQuiet.enqueue(ctx,{kind:'job',id:'shell-compact',state:'lost',completion:true});
await pause(30);assert.equal(shell.messages.length,2);
await shell.emit('session_compact');await pause(30);assert.equal(shell.messages.length,3);
// Mixed batches retain both kinds and their result/output handling.
shellQuiet.enqueue(ctx,{kind:'job',id:'shell-mixed',completion:true});
shellQuiet.enqueue(ctx,{kind:'subagent',id:'child-mixed',completion:true});
await pause(30);
assert.deepEqual(shell.messages[3].message.details.updates.map((u:any)=>u.kind),['job','subagent']);
assert.match(shell.messages[3].message.content,/output/i);
assert.match(shell.messages[3].message.content,/result/i);
assert.match(shell.messages[3].message.content,/reap/i);
await shell.emit('session_shutdown',{reason:'quit'});
// Activity invalidates only earlier completions of the same worker attempt,
// including while delivery is disabled; a later completion remains eligible.
entries=[];idle=true;pending=false;sessionName=`quiet-activity-${process.pid}`;
const activityFx=fixture(),activityQuiet=installQuietState(activityFx.pi,5);await activityFx.emit('session_start');
await activityFx.emit('ui_prompt_start');
const activityCompletion=(seq:number,child='worker-a')=>({kind:'subagent' as const,id:`activity:${child}:${seq}`,job_id:'activity-group',child_id:child,completion:true,through_sequence:seq});
activityQuiet.enqueue(ctx,activityCompletion(3));
activityQuiet.enqueue(ctx,activityCompletion(3,'worker-b'));
activityQuiet.enqueue(ctx,{kind:'subagent',id:'arbitrary',job_id:'activity-group',child_id:'worker-a',activity:true,through_sequence:4});
await activityFx.emit('session_shutdown',{reason:'reload'});
const activityReload=fixture(),activityReloadQuiet=installQuietState(activityReload.pi,5);await activityReload.emit('session_start');await pause(40);
assert.equal(activityReload.messages.length,1);
assert.deepEqual(activityReload.messages[0].message.details.updates.map((u:any)=>u.child_id),['worker-b']);
activityReloadQuiet.enqueue(ctx,activityCompletion(5));await pause(40);
assert.equal(activityReload.messages.length,2,'activity suppressed genuine later completion');
await activityReload.commands.get('harness-state').handler('disable',ctx);
activityReloadQuiet.enqueue(ctx,{kind:'subagent',id:'arbitrary',job_id:'activity-group',child_id:'worker-a',activity:true,through_sequence:8});
await activityReload.commands.get('harness-state').handler('enable',ctx);
activityReloadQuiet.enqueue(ctx,activityCompletion(7));await pause(40);
assert.equal(activityReload.messages.length,2,'disabled delivery lost activity invalidation');
await activityReload.emit('session_shutdown',{reason:'exit'});

// Failed activity receipts suppress immediately, remain retryable across reload,
// and recover without a new observation or a permanent delivery circuit break.
entries=[];idle=true;sessionName=`quiet-activity-failure-${process.pid}`;
let rejectActivityReceipt=false;
const activityFailure=fixture(()=>rejectActivityReceipt),failureQuiet=installQuietState(activityFailure.pi,5);
await activityFailure.emit('session_start');await activityFailure.emit('ui_prompt_start');
const failureCompletion=(seq:number,child='worker')=>({kind:'subagent' as const,id:`retry:${child}:${seq}`,job_id:'retry-group',child_id:child,completion:true,through_sequence:seq});
failureQuiet.enqueue(ctx,failureCompletion(3));
failureQuiet.enqueue(ctx,failureCompletion(3,'other'));
const failedActivity={kind:'subagent' as const,id:'retry-activity',job_id:'retry-group',child_id:'worker',activity:true,through_sequence:4};
rejectActivityReceipt=true;
for(let i=0;i<4;i++)assert.equal(failureQuiet.enqueue(ctx,failedActivity),false,'failed persistence was reported as durable');
await activityFailure.emit('session_shutdown',{reason:'reload'});
// The next writer can persist other receipts, but the activity write still fails.
const failureReload=fixture(),originalAppend=failureReload.pi.appendEntry;
failureReload.pi.appendEntry=(type:string,data:any)=>{if(rejectActivityReceipt&&data.update?.activity)throw new Error('activity still unavailable');originalAppend(type,data);};
const failureReloadQuiet=installQuietState(failureReload.pi,5);await failureReload.emit('session_start');
failureReloadQuiet.enqueue(ctx,failureCompletion(5));
await pause(40);
assert.equal(failureReload.messages.length,1,'unrelated worker was blocked by another worker’s failed invalidation');
assert.deepEqual(failureReload.messages[0].message.details.updates.map((u:any)=>u.child_id),['other']);
assert.equal(failureReloadQuiet.enqueue(ctx,{...failedActivity,through_sequence:2}),false,'older observation bypassed pending high-water persistence');
rejectActivityReceipt=false;
await pause(1100);
assert.ok(entries.some(e=>e.data?.update?.activity&&e.data.update.through_sequence===4),'retry high-water was lost across reload');
assert.equal(failureReload.messages.length,2,'later completion did not resume automatically after storage recovery');
assert.equal(failureReload.messages[1].message.details.updates[0].through_sequence,5);
await failureReload.emit('session_shutdown',{reason:'exit'});
// Now discard even the global hub, as on a process restart: durable receipts suffice.
const durableReload=fixture();installQuietState(durableReload.pi,5);await durableReload.emit('session_start');await pause(40);
assert.equal(durableReload.messages.length,0,'old completion reappeared after retry persisted and memory was discarded');
await durableReload.emit('session_shutdown',{reason:'exit'});

console.log('quiet-state remediation tests passed');
