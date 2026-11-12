import { readExtensionDefaults } from './extension-defaults.js';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createHash } from 'node:crypto';
import { admitHarnessWake } from './idle-admission.js';

export type QuietUpdate = {
  kind:'job'|'subagent'|'watch'|'notification'; id:string; state?:string;
  child_id?:string; job_id?:string; displayName?:string; message?:string; requires_guidance?:boolean;
  /** Authenticated broker identity; supplied only by the owning launch adapter. */
  guidance?:{ownerSessionId:string;ownerRuntimeEpoch:string;taskId:string;childId:string;attempt:number;workerEpoch:string;workerRuntimeEpoch:string;requestId:string;goalId?:string};
  /** Producer-confirmed background execution terminal state, not task delivery. */
  completion?:boolean;
  /** Owning-controller generated idle-decision request only, never model input. */
  admission_control?:{kind:'idle-decision'|'idle-decision-resolved';request_id:string;worker_epoch:string};
  /** New running generation, scoped by job_id + child_id (worker attempt). */
  activity?:boolean;
  outcomes?:Array<{child:number;task_id?:string;attempt?:number;state:string}>;
  through_sequence?:number; count?:number; overflow?:boolean;
};

type Item={key:string;revision:string;bytes:number;data:QuietUpdate;queuedAt:number};
export type QuietStateReceiptState='recorded'|'queued'|'dispatching'|'delivered'|'consumed';
export type QuietStateReceipt={v:1;key:string;revision:string;state:QuietStateReceiptState;at:number;update:QuietUpdate};
type Stats={accepted:number;duplicate:number;dropped:number;routineRecorded:number;guidanceDelivered:number;guidanceBytes:number;schedulingAttempts:number;disabled:number;receiptFailed:number;circuitBreaks:number};
type Diagnostic={cause:string;keys:string[];affected?:Array<{key:string;id:string;child_id?:string;guidance?:QuietUpdate['guidance']}>;at:number;nextRetryAt:number;attempt:number};
type Hub={unsent?:Map<string,Item>;brokerUpdates?:Map<string,QuietUpdate>;brokerReady?:boolean;brokerPending?:number;lastGuidanceChild?:string;ackTimer?:ReturnType<typeof setTimeout>;guidanceSource?:(ctx:any)=>QuietUpdate[]|undefined;diagnostic?:Diagnostic;retryAt?:number;dispatching?:boolean;wakeAdmission?:AbortController;wakeItems?:Map<string,string>;pending:Map<string,Item>;inFlight:Map<string,Item>;receipts:Map<string,QuietStateReceipt>;activityRetries?:Map<string,Item>;activityTimer?:ReturnType<typeof setTimeout>;writer?:symbol;pi?:ExtensionAPI;ctx?:ExtensionContext;timer?:ReturnType<typeof setTimeout>;completionTimer?:ReturnType<typeof setTimeout>;guidanceDisabled?:boolean;ui:boolean;compacting:boolean;lastGuidanceAt:number;localDisabled:boolean;deliveryFailures:number;stats:Stats};

const KEY='__paeQuietHarnessStateV2';
const MESSAGE_CUSTOM='harness-state';
const NOTIFICATION_CUSTOM='harness-child-notification';
const CONTROL_CUSTOM='harness-state-control';
export const QUIET_STATE_RECEIPT_CUSTOM_TYPE='harness-state-receipt';
const MAX_PENDING=512;
const MAX_ITEM_BYTES=4096;
const MAX_UPDATE_BYTES=3000;
const MAX_BATCH_BYTES=6000;
const MAX_BATCH_ITEMS=16;
const MIN_GUIDANCE_INTERVAL_MS=30_000;
const DIAGNOSTIC_CUSTOM='harness-state-delivery-diagnostic';
const MAX_RETRY_MS=300_000;
const ACK_TIMEOUT_MS=10_000;
const COMPLETION_PREFIX='Background subagent finished. Read its result, then reap it when follow-up is complete.\n';
const JOB_COMPLETION_PREFIX='Background job finished. Inspect its output, then reap it when no longer needed.\n';
const isCompletion=(data:QuietUpdate)=>(data.kind==='subagent'||data.kind==='job')&&data.completion===true;
const completionIdentity=(data:QuietUpdate)=>JSON.stringify([data.kind,data.job_id??data.id,data.child_id??data.id]);
const hasSequence=(data:QuietUpdate)=>Number.isSafeInteger(data.through_sequence)&&data.through_sequence!>=0;
function completionSuperseded(h:Hub,data:QuietUpdate):boolean{
  if(!isCompletion(data)||!hasSequence(data))return false;
  const identity=completionIdentity(data);
  // Failed persistence must not make an already-observed old generation live
  // again. The retry high-water mark survives same-process extension reload.
  if([...h.activityRetries?.values()??[]].some(item=>completionIdentity(item.data)===identity&&item.data.through_sequence!>data.through_sequence!))return true;
  return [...h.receipts.values()].some(r=>completionIdentity(r.update)===identity&&hasSequence(r.update)
    &&(r.update.activity===true&&r.state==='recorded'&&r.update.through_sequence!>data.through_sequence!
      ||isCompletion(r.update)&&(r.state==='consumed'||r.state==='delivered')&&r.update.through_sequence!>=data.through_sequence!));
}
function completionPrefix(updates:QuietUpdate[]):string{
  const children=updates.some(u=>u.kind==='subagent'),jobs=updates.some(u=>u.kind==='job');
  if(children&&jobs)return 'Background work finished. Read each job’s output or subagent’s result, then reap it when no longer needed.\n';
  return children?COMPLETION_PREFIX:JOB_COMPLETION_PREFIX;
}
const GUIDANCE_PREFIX='Worker guidance is pending. For structured requests use guidance list and reply to the exact authenticated target; subagent operation=prompt with child_id is only for legacy notices, not an awaited guidance answer or permission.\n';

function hubs():Map<string,Hub>{const root=globalThis as any;return root[KEY]??=(new Map<string,Hub>());}
function session(ctx:any):string{return ctx.sessionManager.getSessionId();}
function stats():Stats{return {accepted:0,duplicate:0,dropped:0,routineRecorded:0,guidanceDelivered:0,guidanceBytes:0,schedulingAttempts:0,disabled:0,receiptFailed:0,circuitBreaks:0};}
function hub(ctx:any):Hub{const id=session(ctx);let h=hubs().get(id);if(!h){h={pending:new Map(),inFlight:new Map(),receipts:new Map(),ui:false,compacting:false,lastGuidanceAt:0,localDisabled:defaultDisabled(),deliveryFailures:0,stats:stats()};hubs().set(id,h);}return h;}
function revision(data:unknown):string{return createHash('sha256').update(JSON.stringify(data)).digest('hex');}
function bytes(text:string):number{return Buffer.byteLength(text,'utf8');}
function keyOf(data:QuietUpdate):string{
  const g=data.guidance;
  return g?`guidance:${revision([g.ownerSessionId,g.ownerRuntimeEpoch,g.taskId,g.childId,g.attempt,g.workerEpoch,g.workerRuntimeEpoch,g.requestId,g.goalId??null])}`:`${data.kind}:${data.id}`;
}
function clone<T>(value:T):T{return JSON.parse(JSON.stringify(value));}
const quietStateDefaults=readExtensionDefaults('quiet-state');
if(quietStateDefaults.enabled!==undefined&&typeof quietStateDefaults.enabled!=='boolean')throw new Error('Invalid defaults/quiet-state.json enabled preference');
// Explicit environment values (including 0/false) override declarative defaults;
// a true kill switch still cannot be bypassed by session enable commands.
function quietStateEnvironment():string|undefined{return process.env.PAE_QUIET_STATE_DISABLED??process.env.PI_QUIET_STATE_DISABLED;}
function envDisabled():boolean{return /^(1|true|yes|on)$/i.test(quietStateEnvironment()??'');}
function defaultDisabled():boolean{return quietStateEnvironment()===undefined&&quietStateDefaults.enabled===false;}
function disabled(h?:Hub):boolean{return envDisabled()||h?.localDisabled===true;}
function validUpdate(data:any):data is QuietUpdate{return data&&['job','subagent','watch','notification'].includes(data.kind)&&typeof data.id==='string';}
function toItem(data:QuietUpdate,queuedAt=Date.now()):Item{const updateText=JSON.stringify(data);return {key:keyOf(data),revision:revision(data),bytes:bytes(updateText),data:clone(data),queuedAt};}
function controlUpdate(data:QuietUpdate):boolean{return data.kind==='notification'&&data.requires_guidance===true&&!!data.child_id&&/^subagent-child-[0-9a-f]{24}$/.test(data.child_id)&&data.admission_control?.kind==='idle-decision'&&/^idle:[0-9a-f]{32}$/.test(data.admission_control.request_id)&&/^[0-9a-f]{32}$/.test(data.admission_control.worker_epoch);}
function controlPending(h:Hub):boolean{return [...h.pending.values()].some(i=>controlUpdate(i.data));}
function controlResolved(h:Hub,data:QuietUpdate):boolean{return controlUpdate(data)&&[...h.receipts.values()].some(r=>r.update.kind==='notification'&&r.update.child_id===data.child_id&&r.update.admission_control?.kind==='idle-decision-resolved'&&r.update.admission_control.request_id===data.admission_control?.request_id&&r.update.admission_control.worker_epoch===data.admission_control?.worker_epoch);}
function revokeConsumedWake(h:Hub):void{if(h.wakeAdmission&&h.wakeItems&&![...h.wakeItems].some(([key,rev])=>h.pending.get(key)?.revision===rev))h.wakeAdmission.abort();}
/** Gate the existing durable notification queue, not a duplicate wake message.
 * Only batches made entirely of producer-confirmed terminal completions or
 * identity-bound idle-decision controls use automatic compaction admission. */
function trustedAutonomousUpdate(data:QuietUpdate):boolean{
  if(isCompletion(data)||controlUpdate(data))return true;
  if(data.requires_guidance!==true)return false;
  const validChild=typeof data.child_id==='string'&&/^subagent-child-[0-9a-f]{24}$/.test(data.child_id);
  const validJob=typeof (data.job_id??data.id)==='string'&&/^(?:job|subagent-job)-[0-9a-f]{24}$/.test(String(data.job_id??data.id));
  if(data.kind==='subagent')return validChild&&validJob;
  if(data.kind==='job')return validJob;
  return data.kind==='notification'&&validChild;
}
async function admitBatch(h:Hub,items:Item[]):Promise<boolean>{
  if(h.wakeAdmission||!h.ctx)return false;
  const controller=new AbortController(),writer=h.writer,ctx=h.ctx;
  h.wakeAdmission=controller;h.wakeItems=new Map(items.map(item=>[item.key,item.revision]));
  try{
    const decision=await admitHarnessWake(ctx,controller.signal,items.length>0&&items.every(item=>trustedAutonomousUpdate(item.data)));
    if(controller.signal.aborted||h.writer!==writer||!h.ctx||session(h.ctx)!==session(ctx))return false;
    if(decision==='continue')return true;
    // Explicit Cancel suppresses this exact wake revision, not retained history.
    for(const item of items)if(h.pending.get(item.key)?.revision===item.revision&&appendReceipt(h,item,'consumed'))h.pending.delete(item.key);
    return false;
  }catch{return false;}finally{if(h.wakeAdmission===controller){h.wakeAdmission=undefined;h.wakeItems=undefined;}}
}
function clearTimer(h:Hub){if(h.ackTimer)clearTimeout(h.ackTimer);h.ackTimer=undefined;if(h.timer)clearTimeout(h.timer);if(h.completionTimer)clearTimeout(h.completionTimer);if(h.activityTimer)clearTimeout(h.activityTimer);h.timer=undefined;h.completionTimer=undefined;h.activityTimer=undefined;}
function receiptFrom(entry:any):QuietStateReceipt|undefined{
  if(entry?.type!=='custom'||entry.customType!==QUIET_STATE_RECEIPT_CUSTOM_TYPE)return undefined;
  const d=entry.data;
  if(d?.v!==1||typeof d.key!=='string'||typeof d.revision!=='string'||!['recorded','queued','dispatching','delivered','consumed'].includes(d.state)||typeof d.at!=='number'||!validUpdate(d.update))return undefined;
  return d;
}
function appendReceipt(h:Hub,item:Item,state:QuietStateReceiptState):boolean{
  const receipt:QuietStateReceipt={v:1,key:item.key,revision:item.revision,state,at:Date.now(),update:clone(item.data)};
  // Activity has its own fail-closed retry path; transient storage failures
  // must not trip the unrelated delivery circuit permanently after recovery.
  const failed=()=>{h.stats.receiptFailed++;if(item.data.activity!==true)reportFailure(h,'Receipt persistence failed',[item.key],true,[item.data]);return false;};
  if(bytes(JSON.stringify(receipt))>MAX_ITEM_BYTES||typeof h.pi?.appendEntry!=='function')return failed();
  try{h.pi.appendEntry(QUIET_STATE_RECEIPT_CUSTOM_TYPE,receipt);}catch{return failed();}
  h.receipts.set(item.key,receipt);
  return true;
}
function retryActivity(h:Hub):void{
  for(const [key,item]of h.activityRetries??[]){
    const prior=h.receipts.get(key);
    if(prior?.update.activity===true&&hasSequence(prior.update)&&prior.update.through_sequence!>=item.data.through_sequence!
      ||appendReceipt(h,item,'recorded'))h.activityRetries!.delete(key);
  }
}
function scheduleActivity(h:Hub,delayMs:number):void{
  if(h.activityTimer||!h.activityRetries?.size||!h.pi||!h.ctx)return;
  h.activityTimer=setTimeout(()=>{
    h.activityTimer=undefined;
    if(!h.pi||!h.ctx)return;
    retryActivity(h);
    schedule(h,Math.max(delayMs,1000));
  },delayMs);h.activityTimer.unref?.();
}
function latestReceipt(h:Hub,key:string){return h.receipts.get(key);}
function isDone(h:Hub,key:string,rev:string){const r=latestReceipt(h,key);return !!r&&(key.startsWith('guidance:')||r.revision===rev)&&(r.state==='recorded'||r.state==='delivered'||r.state==='consumed');}
function messageUpdates(entry:any):QuietUpdate[]|undefined{
  const m=entry?.type==='message'?entry.message:entry;
  return (entry?.type==='custom_message'||m?.role==='custom')&&m.customType===MESSAGE_CUSTOM&&Array.isArray(m.details?.updates)?m.details.updates:undefined;
}
function guidanceGroup(data:QuietUpdate):string{return data.guidance?.childId??data.child_id??data.id;}
function fair<T>(items:T[],group:(item:T)=>string,after?:string):T[]{
  const groups=new Map<string,T[]>();for(const item of items){const key=group(item);if(!groups.has(key))groups.set(key,[]);groups.get(key)!.push(item);}
  const keys=[...groups.keys()],index=after?keys.indexOf(after):-1;
  if(index>=0)keys.push(...keys.splice(0,index+1));
  const result:T[]=[];while(result.length<items.length)for(const key of keys){const queue=groups.get(key)!;if(queue.length)result.push(queue.shift()!);}return result;
}
function restore(h:Hub,ctx:any){
  const entries=ctx.sessionManager.getBranch?.()??ctx.sessionManager.getEntries?.()??[];
  h.diagnostic=undefined;h.retryAt=0;
  h.receipts.clear();h.pending.clear();h.inFlight.clear();h.localDisabled=defaultDisabled();h.guidanceDisabled=false;h.lastGuidanceAt=0;h.lastGuidanceChild=undefined;h.stats.guidanceDelivered=0;h.stats.guidanceBytes=0;
  for(const entry of entries){
    if(entry?.type==='custom'&&entry.customType===DIAGNOSTIC_CUSTOM){h.diagnostic=entry.data?.cause?entry.data:undefined;h.retryAt=h.diagnostic?.nextRetryAt??0;}
    if(entry?.type==='custom'&&entry.customType===CONTROL_CUSTOM&&entry.data?.v===1){if(typeof entry.data.disabled==='boolean'){
      // Quota-only pauses are obsolete, not operator opt-outs. Preserve all other controls.
      if(entry.data.reason==='guidance-quota')continue;
      if(entry.data.reason==='compaction-pause')h.guidanceDisabled=entry.data.disabled;
      else {h.localDisabled=entry.data.disabled;if(!entry.data.disabled)h.guidanceDisabled=false;}
    }}
    const r=receiptFrom(entry);if(r){h.receipts.set(r.key,r);continue;}
    // Backward compatibility: pre-remediation hidden messages count as delivered and must never replay.
    if(messageUpdates(entry))for(const data of messageUpdates(entry)!){if(validUpdate(data)){
      const item=toItem(data),prior=h.receipts.get(item.key);
      // A historical message is delivery evidence, not a new delivery now.
      // Preserve explicit receipts (including consumption), and never let an
      // older message acknowledge a newer revision of a queued request.
      if(prior&&(!['queued','dispatching'].includes(prior.state)||prior.revision!==item.revision))continue;
      const timestamp=typeof entry.timestamp==='string'?Date.parse(entry.timestamp):entry.timestamp;
      const at=typeof timestamp==='number'&&Number.isFinite(timestamp)?timestamp:prior?.at??0;
      h.receipts.set(item.key,{v:1,key:item.key,revision:item.revision,state:'delivered',at,update:item.data});
    }}
  }
  for(const r of h.receipts.values()){
    if(r.update.requires_guidance===true&&!isCompletion(r.update)){
      if(r.state==='delivered'){h.stats.guidanceDelivered++;h.stats.guidanceBytes+=bytes(JSON.stringify(r.update));}
      // An unacknowledged intent may have dispatched. Preserve pacing on
      // restart without treating uncertainty as a delivered receipt.
      if((r.state==='delivered'||r.state==='dispatching')&&r.at>=h.lastGuidanceAt){h.lastGuidanceAt=Math.min(Date.now(),r.at);h.lastGuidanceChild=guidanceGroup(r.update);}
    }
    if((r.state==='queued'||r.state==='dispatching')&&(r.update.requires_guidance===true||isCompletion(r.update)))h.pending.set(r.key,toItem(r.update,r.at));
  }
  // Report sequence, not receipt time, orders child turns. Consuming an older
  // result later must not suppress a newer unseen completion after reload.
  for(const [key,item]of h.pending)if(completionSuperseded(h,item.data)||controlResolved(h,item.data))h.pending.delete(key);
  // Retained child notifications are operator-visible records. Routine notifications stay retained only; explicit guidance is re-queued until delivered/consumed.
  for(const entry of entries){
    const data=entry?.type==='custom'&&entry.customType===NOTIFICATION_CUSTOM?entry.data?.update:undefined;
    if(!validUpdate(data)||data.kind!=='notification')continue;
    const item=toItem(data,entry.data?.at??Date.now());
    if(isDone(h,item.key,item.revision)||h.pending.has(item.key)||h.pending.size>=MAX_PENDING)continue;
    if(data.requires_guidance===true)h.pending.set(item.key,item);
  }
  const uncertain=[...h.pending.values()].filter(item=>latestReceipt(h,item.key)?.state==='dispatching'&&!h.unsent?.has(item.key)).map(item=>item.key).slice(0,MAX_BATCH_ITEMS);
  if(uncertain.length&&(!h.diagnostic?.cause.startsWith('Uncertain guidance dispatch')||JSON.stringify(h.diagnostic.keys)!==JSON.stringify(uncertain)))reportFailure(h,'Uncertain guidance dispatch retained across restore; inspect actual message history',uncertain,false);
}
function reportFailure(h:Hub,cause:string,keys:string[],retry=true,updates:QuietUpdate[]=[]):void{
  cause=cause.replace(/[\x00-\x1f\x7f]/g,' ').slice(0,500);
  const attempt=(h.diagnostic?.cause===cause?h.diagnostic.attempt:0)+1;
  h.retryAt=retry?Date.now()+Math.min(MAX_RETRY_MS,1000*2**Math.min(attempt-1,9)):0;
  const affected=keys.slice(0,MAX_BATCH_ITEMS).flatMap(key=>{const data=updates.find(u=>keyOf(u)===key)??h.pending.get(key)?.data??h.receipts.get(key)?.update??h.brokerUpdates?.get(key);return data?[{key,id:data.id,child_id:data.child_id,guidance:data.guidance}]:[];});
  h.diagnostic={cause,keys:keys.slice(0,MAX_BATCH_ITEMS),affected,at:Date.now(),nextRetryAt:h.retryAt,attempt};
  try{h.pi?.appendEntry(DIAGNOSTIC_CUSTOM,h.diagnostic);}catch{h.diagnostic.cause=cause+'; diagnostic persistence failed';}
  if(h.ctx?.hasUI)try{h.ctx.ui.notify(`Harness delivery: ${h.diagnostic.cause}; ${h.pending.size} pending. Inspect /harness-state status. ${retry?'Automatic bounded backoff.':'Inspect guidance list and answer/dismiss, or retry-guidance with the exact key (may duplicate).'} `,'warning');}catch{}
  refreshStatus(h);
}
function clearFailure(h:Hub):void{h.diagnostic=undefined;h.retryAt=0;h.deliveryFailures=0;try{h.pi?.appendEntry(DIAGNOSTIC_CUSTOM,{at:Date.now(),resolved:true});}catch{reportFailure(h,'Recovery diagnostic persistence failed',[]);}}
function evidence(h:Hub,item:Item):boolean{
  const entries=h.ctx?.sessionManager.getBranch?.()??[];
  return entries.some((e:any)=>messageUpdates(e)?.some((u:QuietUpdate)=>validUpdate(u)&&keyOf(u)===item.key&&(item.data.guidance||revision(u)===item.revision)));
}
function requeueUnsent(h:Hub,item:Item):void{
  if(appendReceipt(h,item,'queued'))h.unsent?.delete(item.key);
  else (h.unsent??=new Map()).set(item.key,item);
}
function acknowledgeGuidance(h:Hub):void{
  for(const [key,item]of Date.now()>=(h.retryAt??0)?h.unsent??[]:[]){if(isDone(h,key,item.revision))h.unsent!.delete(key);else requeueUnsent(h,item);}
  for(const [key,item]of h.pending)if(latestReceipt(h,key)?.state==='dispatching'&&evidence(h,item)){
    // The message journal is independent delivery evidence if the receipt write fails.
    if(!appendReceipt(h,item,'delivered'))h.receipts.set(key,{v:1,key,revision:item.revision,state:'delivered',at:Date.now(),update:item.data});
    h.pending.delete(key);h.stats.guidanceDelivered++;
  }
  if(h.diagnostic&&h.diagnostic.keys.length&&h.diagnostic.keys.every(key=>['delivered','consumed','recorded'].includes(latestReceipt(h,key)?.state??'')))clearFailure(h);
  // Modal admission may cancel the acknowledgement timer. On the next safe
  // boundary, still surface expired intents instead of silently stranding them.
  if(!h.ui&&!h.compacting&&!h.dispatching&&Date.now()>=(h.retryAt??0)){
    const uncertain=[...h.pending.values()].filter(item=>latestReceipt(h,item.key)?.state==='dispatching'&&!h.unsent?.has(item.key)&&Date.now()-latestReceipt(h,item.key)!.at>=ACK_TIMEOUT_MS).map(item=>item.key).slice(0,MAX_BATCH_ITEMS);
    if(uncertain.length&&(!h.diagnostic?.cause.startsWith('Uncertain guidance dispatch')||JSON.stringify(h.diagnostic.keys)!==JSON.stringify(uncertain)))reportFailure(h,'Uncertain guidance dispatch: no persisted message acknowledgement',uncertain,false);
  }
}
function brokerGuidance(data:QuietUpdate):boolean{return !!data.guidance||data.kind==='notification'&&data.id.startsWith('guidance:');}
function reconcileGuidance(h:Hub):void{
  acknowledgeGuidance(h);
  h.brokerReady=false;
  if(!h.guidanceSource||!h.ctx)return;
  let updates:QuietUpdate[]|undefined;
  try{updates=h.guidanceSource(h.ctx);}catch(error){reportFailure(h,`Broker reconciliation failed: ${String(error)}`,[]);return;}
  if(!updates)return; // Startup/reload: never treat an unavailable snapshot as an empty broker.
  updates=updates.filter(u=>validUpdate(u)&&u.guidance?.ownerSessionId===session(h.ctx));
  if(updates.length>1024){reportFailure(h,'Broker snapshot exceeds bounded request inventory',[]);return;}
  h.brokerReady=true;h.brokerPending=updates.length;h.brokerUpdates=new Map(updates.map(u=>[keyOf(u),u]));
  updates=fair(updates,guidanceGroup,h.lastGuidanceChild);
  const live=new Set(updates.map(keyOf));
  for(const [key,item]of h.pending)if(brokerGuidance(item.data)&&!live.has(key)){
    const upgrade=!item.data.guidance&&updates.find(u=>u.guidance?.requestId===item.data.id&&u.child_id===item.data.child_id);
    if(upgrade){
      const replacement=toItem(upgrade,item.queuedAt);
      // Move a stranded legacy queue entry, not a delivery tombstone. Write
      // the replacement before consuming the old key so a crash cannot lose it.
      if(!isDone(h,replacement.key,replacement.revision)&&!h.pending.has(replacement.key)){
        if(!appendReceipt(h,replacement,latestReceipt(h,key)?.state==='dispatching'?'dispatching':'queued'))continue;
        h.pending.set(replacement.key,replacement);
      }
    }
    if(appendReceipt(h,item,'consumed'))h.pending.delete(key);
  }
  for(const data of updates){
    const item=toItem(data);
    if(isDone(h,item.key,item.revision)||h.pending.has(item.key))continue;
    // Upgrade old request-ID-only receipts without replaying historical deliveries.
    const legacy=h.receipts.get(`notification:${data.guidance!.requestId}`);
    if(legacy?.update.child_id===data.child_id&&['delivered','consumed'].includes(legacy.state)){
      appendReceipt(h,item,legacy.state);continue;
    }
    if(item.bytes>MAX_UPDATE_BYTES||batchBytes([data])>MAX_BATCH_BYTES){reportFailure(h,'Broker request exceeds notification payload bound',[item.key]);continue;}
    if(h.pending.size>=MAX_PENDING){reportFailure(h,'Notification queue full; broker waiter retained',[item.key]);break;}
    if(!appendReceipt(h,item,'queued'))break;
    h.pending.set(item.key,item);
  }
  if(h.diagnostic?.keys.length&&h.diagnostic.keys.every(key=>['delivered','consumed','recorded'].includes(latestReceipt(h,key)?.state??'')||key.startsWith('guidance:')&&!live.has(key)))clearFailure(h);
  revokeConsumedWake(h);
}
function guidancePending(h:Hub){return [...h.pending.values()].some(i=>i.data.requires_guidance===true&&!isCompletion(i.data));}
function refreshStatus(h:Hub){const ctx=h.ctx;if(!ctx?.hasUI)return;const guidance=[...h.pending.values()].filter(i=>i.data.requires_guidance).length;const text=disabled(h)?'quiet off':h.compacting?'quiet compacting':h.guidanceDisabled?'quiet guidance paused':h.diagnostic?`quiet delivery error (${guidance} pending): ${h.diagnostic.cause}`:guidance?`quiet guidance ${guidance}`:undefined;try{ctx.ui.setStatus('quiet-state',text);}catch{}}
/** Retained child findings on this branch. RPC children write a notification entry; native
 * children are only recorded as receipts. Both carry the same update, deduplicated by ID. */
function notificationEntries(ctx:any):QuietUpdate[]{
  const seen=new Set<string>(),out:QuietUpdate[]=[];
  for(const e of ctx.sessionManager.getBranch?.()??ctx.sessionManager.getEntries?.()??[]){
    if(e?.type!=='custom')continue;
    const update=e.customType===NOTIFICATION_CUSTOM?e.data?.update:e.customType===QUIET_STATE_RECEIPT_CUSTOM_TYPE?e.data?.update:undefined;
    if(!validUpdate(update)||update.kind!=='notification'||typeof update.message!=='string'||seen.has(update.id))continue;
    seen.add(update.id);out.push(update);
  }
  return out;
}
const commandApis:WeakSet<object>=new WeakSet();
function installCommands(pi:any){
  if(typeof pi.registerCommand!=='function'||commandApis.has(pi))return;commandApis.add(pi);
  pi.registerCommand('harness-state',{description:'Show quiet harness-state status/notifications or disable/enable quiet model wakeups',handler:async(args:string,ctx:any)=>{
    const current=hub(ctx);restore(current,ctx);if(Date.now()>=(current.retryAt??0))reconcileGuidance(current);const parts=(args||'status').trim().split(/\s+/);const mode=parts[0];
    if(mode==='show'){
      const notes=notificationEntries(ctx).slice(-25).map((u,i)=>`${i+1}. ${u.requires_guidance?'[guidance]':'[finding]'} ${u.displayName??'Subagent'}: ${u.message??''}`);
      const content=notes.length?notes.join('\n'):'No retained child notifications.';
      pi.sendMessage({customType:'harness-state-view',display:true,content,details:{count:notes.length}},{deliverAs:'nextTurn',triggerTurn:false});
      return;
    }
    if(mode==='dismiss-guidance'){
      const scope=parts[1];if(parts.length!==2||(scope!=='all'&&(!scope||!/^subagent-child-[0-9a-f]{24}$/.test(scope)))){ctx.ui.notify('Usage: /harness-state dismiss-guidance all|<exact child_id>','warning');return;}
      const targets=[...current.pending.values()].filter(i=>i.data.requires_guidance===true&&!isCompletion(i.data)&&(scope==='all'||i.data.child_id===scope));let consumed=0;
      for(const item of targets){if(appendReceipt(current,item,'consumed')){current.pending.delete(item.key);consumed++;}}
      ctx.ui.notify(`Dismissed ${consumed} pending guidance request(s)${scope==='all'?'':' for '+scope}; retained histories unchanged.`,'info');refreshStatus(current);return;
    }
    if(mode==='disable'||mode==='off'){current.localDisabled=true;current.pending.clear();clearTimer(current);pi.appendEntry(CONTROL_CUSTOM,{v:1,disabled:true,at:Date.now()});ctx.ui.notify('harness-state disabled for this session. Re-enable with /harness-state enable. Env kill switch: PAE_QUIET_STATE_DISABLED=1','warning');refreshStatus(current);return;}
    if(mode==='retry-guidance'){
      const item=current.pending.get(parts[1]);
      if(parts.length!==2||!item||latestReceipt(current,item.key)?.state!=='dispatching'){ctx.ui.notify('Usage: /harness-state retry-guidance <exact uncertain receipt key>; inspect status and message history first (may duplicate a wake).','warning');return;}
      if(appendReceipt(current,item,'queued')){clearFailure(current);schedule(current,0);}return;
    }
    if(mode==='enable'||mode==='on'){current.localDisabled=false;current.guidanceDisabled=false;current.lastGuidanceAt=0;pi.appendEntry(CONTROL_CUSTOM,{v:1,disabled:false,at:Date.now()});ctx.ui.notify('harness-state completion/guidance wakeups enabled for this session. Uncertain dispatches still require explicit recovery.','info');refreshStatus(current);schedule(current,0);return;}
    ctx.ui.notify(`harness-state: status=${disabled(current)?'disabled':current.guidanceDisabled?'guidance-paused':'active'} reason=${envDisabled()?'environment kill switch':current.localDisabled?'quiet-state preference/operator disable':current.diagnostic?.cause??(current.guidanceDisabled?'persisted guidance pause':current.compacting?'compaction':'none')} diagnostic=${JSON.stringify(current.diagnostic??null)} uncertain=${JSON.stringify([...current.pending.values()].filter(i=>latestReceipt(current,i.key)?.state==='dispatching').map(i=>({key:i.key,identity:i.data.guidance??i.data.id})))} recovery=inspect-guidance-list/answer-or-dismiss;retry-guidance-exact-key-may-duplicate pendingBroker=${current.brokerPending??'unavailable'} pendingCompletions=${[...current.pending.values()].filter(i=>isCompletion(i.data)).length} pendingGuidance=${[...current.pending.values()].filter(i=>i.data.requires_guidance).length} receipts=${current.receipts.size} deliveredUpdates=${current.stats.guidanceDelivered} guidanceBytes=${current.stats.guidanceBytes} schedulingAttempts=${current.stats.schedulingAttempts} routineRecorded=${current.stats.routineRecorded} duplicates=${current.stats.duplicate} dropped=${current.stats.dropped} receiptFailed=${current.stats.receiptFailed} circuitBreaks=${current.stats.circuitBreaks} disabled=${disabled(current)} envKillSwitch=PAE_QUIET_STATE_DISABLED=1`,'info');
  }});
}
function batchBytes(updates:QuietUpdate[]):number{return bytes(GUIDANCE_PREFIX+JSON.stringify(updates))+bytes(JSON.stringify({updates}));}
function selectBatch(h:Hub){const out:Item[]=[];const controls=controlPending(h);for(const item of fair([...h.pending.values()].filter(i=>i.data.requires_guidance&&!isCompletion(i.data)&&latestReceipt(h,i.key)?.state!=='dispatching'&&(controls?controlUpdate(i.data):!h.wakeAdmission)).sort((a,b)=>a.queuedAt-b.queuedAt),i=>guidanceGroup(i.data),h.lastGuidanceChild)){if(out.length>=MAX_BATCH_ITEMS)break;const next=[...out,item];if(batchBytes(next.map(i=>i.data))>MAX_BATCH_BYTES){if(!out.length)reportFailure(h,'Oversized guidance payload; inspect exact request and dismiss or answer it',[item.key]);continue;}out.push(item);}return out;}
function scheduleCompletions(h:Hub,delayMs:number){
  if(h.completionTimer||h.wakeAdmission||h.ui||h.compacting||!h.pi||!h.ctx||disabled(h))return;
  if(![...h.pending.values()].some(i=>isCompletion(i.data)))return;
  h.completionTimer=setTimeout(async()=>{
    h.completionTimer=undefined;
    if(h.ui||h.compacting||!h.pi||!h.ctx||disabled(h))return;
    // Let existing queued messages drain; never abort or interrupt active tools.
    if(h.ctx.hasPendingMessages?.()||!h.ctx.isIdle()){scheduleCompletions(h,Math.max(delayMs,1000));return;}
    const latest=new Map<string,Item>();
    for(const [key,item]of h.pending)if(isCompletion(item.data)){
      if(completionSuperseded(h,item.data)){h.pending.delete(key);continue;}
      const identity=completionIdentity(item.data);
      // Hold even a later completion for this worker until its invalidation is
      // durable. Other workers remain independently deliverable.
      if([...h.activityRetries?.values()??[]].some(retry=>completionIdentity(retry.data)===identity))continue;
      const prior=latest.get(identity);
      // Legacy reports have no sequence; retain their enqueue order. New
      // native reports are monotonic even when reads race scheduler polling.
      if(!prior||(hasSequence(prior.data)&&hasSequence(item.data)
        ?prior.data.through_sequence!<=item.data.through_sequence!:prior.queuedAt<=item.queuedAt))latest.set(identity,item);
    }
    const items:Item[]=[];
    for(const item of latest.values()){
      const updates=[...items,item].map(i=>i.data);
      if(items.length>=MAX_BATCH_ITEMS||bytes(completionPrefix(updates)+JSON.stringify(updates))+bytes(JSON.stringify({updates}))>MAX_BATCH_BYTES)break;
      items.push(item);
    }
    if(!items.length)return;
    // Supersede every older queued revision for a child before delivery.
    // Safe idle-only dispatch means no historical completion steers an active
    // long tool run; sent messages cannot be retracted.
    for(const [key,item] of h.pending){
      if(!isCompletion(item.data))continue;
      const current=latest.get(completionIdentity(item.data));
      if(current&&current.revision!==item.revision&&appendReceipt(h,item,'consumed'))h.pending.delete(key);
    }
    const deliver=items.filter(item=>h.pending.get(item.key)?.revision===item.revision);
    if(!deliver.length){scheduleCompletions(h,Math.max(delayMs,1000));return;}
    if(!await admitBatch(h,deliver)){schedule(h,Math.max(delayMs,1000));return;}
    if(!h.pi||!h.ctx||h.ui||h.compacting||disabled(h)||h.ctx.hasPendingMessages?.()||!h.ctx.isIdle()){schedule(h,Math.max(delayMs,1000));return;}
    // Result reads, new worker generations and reload may race the decision.
    const admitted=deliver.filter(item=>h.pending.get(item.key)?.revision===item.revision&&!completionSuperseded(h,item.data));
    if(!admitted.length){schedule(h,Math.max(delayMs,1000));return;}
    const updates=admitted.map(i=>i.data);
    try{
      h.pi.sendMessage({customType:MESSAGE_CUSTOM,display:false,content:completionPrefix(updates)+JSON.stringify(updates),details:{updates}},
        {deliverAs:'followUp',triggerTurn:true});
    }catch{h.deliveryFailures++;scheduleCompletions(h,Math.max(delayMs,1000));return;}
    h.deliveryFailures=0;
    for(const item of admitted){
      // Only acknowledge accepted sends. The persisted message also deduplicates
      // recovery if appending the receipt fails after sendMessage succeeds.
      if(!appendReceipt(h,item,'delivered'))h.receipts.set(item.key,{v:1,key:item.key,revision:item.revision,state:'delivered',at:Date.now(),update:item.data});
      if(h.pending.get(item.key)?.revision===item.revision)h.pending.delete(item.key);
    }
    scheduleCompletions(h,Math.max(delayMs,1000));
  },delayMs);h.completionTimer.unref?.();
}
function schedule(h:Hub,delayMs:number){
  if(!h.dispatching&&Date.now()>=(h.retryAt??0))reconcileGuidance(h);
  scheduleActivity(h,delayMs);
  scheduleCompletions(h,delayMs);
  refreshStatus(h);if(h.timer||h.dispatching||h.ui&&!controlPending(h)||h.compacting||!h.pi||!h.ctx||disabled(h)||h.guidanceDisabled&&!controlPending(h)||(!guidancePending(h)&&!h.retryAt)||h.wakeAdmission&&!controlPending(h))return;
  const wait=Math.max(controlPending(h)?delayMs:Math.max(delayMs,MIN_GUIDANCE_INTERVAL_MS-(Date.now()-h.lastGuidanceAt),0),(h.retryAt??0)-Date.now());
  h.timer=setTimeout(async()=>{
    h.timer=undefined;
    if(!h.pi||!h.ctx||h.ui&&!controlPending(h)||h.compacting||disabled(h))return;
    if(h.retryAt&&Date.now()<h.retryAt){schedule(h,Math.max(delayMs,h.retryAt-Date.now()));return;}
    if(h.retryAt)h.retryAt=0;
    reconcileGuidance(h);
    if(!h.ctx.isIdle()&&!controlPending(h)||h.ctx.hasPendingMessages?.()){schedule(h,Math.max(delayMs,1000));return;}
    if(!guidancePending(h)){refreshStatus(h);if(h.retryAt)schedule(h,1000);return;}
    h.stats.schedulingAttempts++;
    const items=selectBatch(h);if(!items.length)return;
    if(!await admitBatch(h,items)){schedule(h,Math.max(delayMs,1000));return;}
    if(!h.pi||!h.ctx||h.compacting||disabled(h)||!items.every(i=>controlUpdate(i.data))&&(!h.ctx.isIdle()||h.ctx.hasPendingMessages?.()||h.ui)){schedule(h,delayMs);return;}
    reconcileGuidance(h);
    const current=items.filter(item=>h.pending.get(item.key)?.revision===item.revision&&(!brokerGuidance(item.data)||h.brokerReady));
    if(!current.length){schedule(h,delayMs);return;}
    const updates=current.map(i=>i.data),content=GUIDANCE_PREFIX+JSON.stringify(updates);
    const prepared:Item[]=[];
    for(const item of current){
      if(!appendReceipt(h,item,'dispatching')){
        // No send has occurred. These intents can safely return to the queue.
        for(const prior of prepared)requeueUnsent(h,prior);
        schedule(h,1000);return;
      }
      prepared.push(item);
    }
    h.lastGuidanceAt=Date.now();h.lastGuidanceChild=guidanceGroup(current.at(-1)!.data);h.stats.guidanceBytes+=batchBytes(updates);h.dispatching=true;
    try{
      // sendMessage is void in Pi: its return is NOT a delivery acknowledgement.
      // Only the actual persisted custom message may acknowledge this intent.
      h.pi.sendMessage({customType:MESSAGE_CUSTOM,display:false,content,details:{updates}},{deliverAs:h.ctx.isIdle()?'followUp':'steer',triggerTurn:true});
    }catch(error){
      acknowledgeGuidance(h);
      if(current.some(i=>h.pending.has(i.key))){
        // Only an explicitly documented pre-acceptance rejection is retryable.
        const safe=(error as any)?.deliveryNotAccepted===true;
        if(safe)for(const item of current)requeueUnsent(h,item);
        reportFailure(h,`${safe?'Transport rejected before acceptance':'Uncertain guidance dispatch'}: ${String(error)}`,current.map(i=>i.key),safe);
      }
    }finally{h.dispatching=false;}
    acknowledgeGuidance(h);
    if(current.some(i=>latestReceipt(h,i.key)?.state==='dispatching')){
      if(h.ackTimer)clearTimeout(h.ackTimer);
      h.ackTimer=setTimeout(()=>{h.ackTimer=undefined;acknowledgeGuidance(h);const uncertain=current.filter(i=>h.pending.has(i.key));if(uncertain.length)reportFailure(h,'Uncertain guidance dispatch: no persisted message acknowledgement',uncertain.map(i=>i.key),false);schedule(h,delayMs);},ACK_TIMEOUT_MS);h.ackTimer.unref?.();
    }
    schedule(h,delayMs);
  },wait);h.timer.unref?.();
}

/** Routine updates are receipts only; explicit guidance and background terminal completion may wake the model. */
export function installQuietState(pi:ExtensionAPI,delayMs=1000){
  const writer=Symbol('quiet-harness-writer');
  let source:Hub['guidanceSource'];
  installCommands(pi);
  pi.on('session_start',async(_event,ctx)=>{const h=hub(ctx);h.wakeAdmission?.abort();h.wakeAdmission=undefined;clearTimer(h);h.writer=writer;h.pi=pi;h.ctx=ctx;h.guidanceSource=source??h.guidanceSource;h.dispatching=false;h.ui=false;h.compacting=false;restore(h,ctx);schedule(h,delayMs);});
  pi.on('agent_settled',async(_event,ctx)=>{const h=hub(ctx);if(h.writer===writer){h.ctx=ctx;restore(h,ctx);schedule(h,delayMs);}});
  pi.on('session_before_compact',async(_event,ctx)=>{const h=hub(ctx);if(h.writer===writer){h.compacting=true;clearTimer(h);refreshStatus(h);}});
  pi.on('session_compact',async(_event,ctx)=>{const h=hub(ctx);if(h.writer===writer){h.compacting=false;restore(h,ctx);schedule(h,delayMs);}});
  pi.on('session_compact_failed',async(_event,ctx)=>{const h=hub(ctx);if(h.writer===writer){h.compacting=false;restore(h,ctx);schedule(h,delayMs);}});
  pi.on('ui_prompt_start',async(_event,ctx)=>{const h=hub(ctx);if(h.writer===writer){h.ui=true;clearTimer(h);refreshStatus(h);}});
  pi.on('ui_prompt_end',async(_event,ctx)=>{const h=hub(ctx);if(h.writer===writer){h.ui=false;schedule(h,delayMs);}});
  pi.on('session_shutdown',async(event,ctx)=>{const h=hub(ctx);if(h.writer!==writer)return;h.wakeAdmission?.abort();h.wakeAdmission=undefined;clearTimer(h);restore(h,ctx);h.writer=undefined;h.pi=undefined;h.ctx=undefined;if(event.reason!=='reload')hubs().delete(session(ctx));});
  pi.on('message_end',async(event:any,ctx)=>{const h=hub(ctx);if(h.writer===writer&&event.message?.role==='custom'&&event.message.customType===MESSAGE_CUSTOM){acknowledgeGuidance(h);if(!h.dispatching)schedule(h,delayMs);}});
  return {
    setGuidanceSource(value:NonNullable<Hub['guidanceSource']>){source=value;},
    reconcile(ctx:ExtensionContext){const h=hub(ctx);h.guidanceSource=source;schedule(h,delayMs);},
    enqueue(ctx:ExtensionContext,data:QuietUpdate):boolean{
      const h=hub(ctx);h.pi=pi;h.ctx=ctx;
      if(data.guidance&&data.guidance.ownerSessionId!==session(ctx))throw new Error('Foreign guidance notification owner');
      // Parent control resolution consumes only the exact authenticated child /
      // epoch / request. It is a retained record, never another model wake.
      if(data.kind==='notification'&&data.child_id&&data.admission_control?.kind==='idle-decision-resolved'){
        const resolved=data.admission_control;
        for(const [key,item]of h.pending)if(controlUpdate(item.data)&&item.data.child_id===data.child_id&&item.data.admission_control?.request_id===resolved.request_id&&item.data.admission_control.worker_epoch===resolved.worker_epoch){if(appendReceipt(h,item,'consumed'))h.pending.delete(key);}
        revokeConsumedWake(h);
        const persisted=appendReceipt(h,toItem({...data,requires_guidance:false,completion:false}),'recorded');
        if(persisted)h.stats.routineRecorded++;schedule(h,delayMs);return persisted;
      }
      // Activity invalidation must persist even while delivery is disabled, and
      // never move backwards when an older async observation arrives late.
      if(data.activity===true){
        if(data.kind!=='subagent'||!data.job_id||!data.child_id||!hasSequence(data))throw new Error('Invalid worker activity identity');
        let item=toItem({...data,id:`${data.job_id}:${data.child_id}:activity`,completion:false,requires_guidance:false});
        const retries=h.activityRetries??=new Map();
        const retry=retries.get(item.key);
        if(retry&&retry.data.through_sequence!>item.data.through_sequence!)item=retry;
        const prior=latestReceipt(h,item.key);
        if(prior?.update.activity===true&&hasSequence(prior.update)&&prior.update.through_sequence!>=item.data.through_sequence!){retries.delete(item.key);return true;}
        // Reserve suppression before attempting the durable write, not after.
        retries.set(item.key,item);
        const persisted=appendReceipt(h,item,'recorded');
        if(persisted)retries.delete(item.key);
        for(const [key,pending]of h.pending)if(completionSuperseded(h,pending.data))h.pending.delete(key);
        revokeConsumedWake(h);schedule(h,delayMs);
        return persisted;
      }
      if(controlResolved(h,data)){h.stats.duplicate++;return true;}
      if(disabled(h)){h.stats.disabled++;return false;}
      const item=toItem(data);if(item.bytes>MAX_UPDATE_BYTES||(isCompletion(data)&&bytes(completionPrefix([data])+JSON.stringify([data]))+bytes(JSON.stringify({updates:[data]}))>MAX_BATCH_BYTES))throw new Error('Quiet state update exceeds its metadata budget');
      const superseded=completionSuperseded(h,data);
      if(superseded||isDone(h,item.key,item.revision)||(isCompletion(data)&&['recorded','delivered','consumed'].includes(latestReceipt(h,item.key)?.state??''))||(data.guidance?h.pending.has(item.key):h.pending.get(item.key)?.revision===item.revision)){h.stats.duplicate++;return true;}
      if(h.pending.size>=MAX_PENDING&&!h.pending.has(item.key)){h.stats.dropped++;reportFailure(h,'Notification queue full; producer must retain and retry',[item.key]);schedule(h,delayMs);return false;}
      h.stats.accepted++;
      if(data.requires_guidance===true||isCompletion(data)){if(!appendReceipt(h,item,'queued')){schedule(h,delayMs);return false;}h.pending.set(item.key,item);schedule(h,delayMs);return true;}
      h.pending.delete(item.key);if(!appendReceipt(h,item,'recorded'))return false;h.stats.routineRecorded++;refreshStatus(h);return true;
    },
    consumeCompletion(ctx:ExtensionContext,jobId:string,childId?:string,terminalId?:string,throughSequence?:number){
      const h=hub(ctx);if(!childId||!terminalId)return;
      const data:QuietUpdate={kind:'subagent',id:`${jobId}:${childId}:terminal:${terminalId}`,job_id:jobId,child_id:childId,completion:true,through_sequence:throughSequence};
      const key=keyOf(data),existing=h.pending.get(key);
      const target=toItem({...existing?.data,...data,through_sequence:throughSequence??existing?.data.through_sequence});
      // Persist even when the direct result read wins the race with polling.
      // Unknown/legacy sequence numbers authorize consuming only this exact ID.
      if(!appendReceipt(h,target,'consumed'))return;
      for(const [pendingKey,item]of h.pending)if(pendingKey===key||completionSuperseded(h,item.data))h.pending.delete(pendingKey);
      revokeConsumedWake(h);refreshStatus(h);
    },
    consume(ctx:ExtensionContext,kind:QuietUpdate['kind'],id:string,through?:number){
      const h=hub(ctx);const key=`${kind}:${id}`;
      // Job callers consume only terminal reads/reap, never running status.
      // Persist a tombstone even before enqueue: an async notified check can lose
      // this race, and must not cause a delayed wake after the tool returned.
      const item=h.pending.get(key)??(kind==='job'&&!h.receipts.has(key)?toItem({kind,id,completion:true}):undefined);
      if(item&&(through===undefined||(item.data.through_sequence??0)<=through)&&appendReceipt(h,item,'consumed'))h.pending.delete(key);
      revokeConsumedWake(h);refreshStatus(h);
    },
  };
}

/** Identity is supplied by the owning RPC launch, never by child parameters. */
export function notifyParent(ownerSessionId:string,childId:string,toolCallId:string,params:any){
  if(!params||Object.keys(params).some(key=>!['message','requires_guidance'].includes(key))||typeof params.message!=='string'||!params.message.trim()||params.message.length>1000||Buffer.byteLength(params.message)>2000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(params.message)||(params.requires_guidance!==undefined&&typeof params.requires_guidance!=='boolean'))throw new Error('Invalid parent notification: concise message (1000 characters/2000 bytes) and optional requires_guidance boolean only');
  if(!/^subagent-child-[0-9a-f]{24}$/.test(childId)||!toolCallId||toolCallId.length>256)throw new Error('Invalid notification identity');
  const h=hubs().get(ownerSessionId);if(!h?.pi||!h.ctx||session(h.ctx)!==ownerSessionId||disabled(h))throw new Error('Parent notification service is unavailable; preserve the finding for your final report');
  const id=createHash('sha256').update(childId+'\0'+toolCallId).digest('hex').slice(0,24);const data:QuietUpdate={kind:'notification',id,child_id:childId,message:params.message.trim(),requires_guidance:params.requires_guidance===true};
  const entries=(h.ctx.sessionManager.getBranch?.()??[]).filter((e:any)=>e.type==='custom'&&e.customType===NOTIFICATION_CUSTOM);const previous=entries.find((e:any)=>e.data?.update?.id===id);
  if(previous?.type==='custom'&&revision((previous.data as {update:QuietUpdate}).update)!==revision(data))throw new Error('Notification ID was reused with different contents');
  if(!previous){if(h.pending.size>=MAX_PENDING)throw new Error('Parent notification queue is full; retain the finding and retry later');if(entries.filter((e:any)=>e.data?.update?.child_id===childId&&e.data.at>Date.now()-60000).length>=5)throw new Error('Notification rate limit: at most five per minute per child; batch findings');h.pi.appendEntry(NOTIFICATION_CUSTOM,{at:Date.now(),update:data});const item=toItem(data);if(data.requires_guidance===true){if(!appendReceipt(h,item,'queued'))throw new Error('Parent notification receipt could not be persisted; preserve the finding for your final report');h.pending.set(item.key,item);}else if(!appendReceipt(h,item,'recorded'))throw new Error('Parent notification receipt could not be persisted; preserve the finding for your final report');}
  schedule(h,1000);return {content:[{type:'text',text:'Queued for the parent; no reply yet.'}],details:{notification_id:id,accepted:true,requires_guidance:data.requires_guidance}};
}
