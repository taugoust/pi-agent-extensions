import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { createHash } from 'node:crypto';

export type QuietUpdate = {
  kind:'job'|'subagent'|'watch'|'notification'; id:string; state?:string;
  child_id?:string; job_id?:string; message?:string; requires_guidance?:boolean;
  /** Producer-confirmed background execution terminal state, not task delivery. */
  completion?:boolean;
  /** New running generation, scoped by job_id + child_id (worker attempt). */
  activity?:boolean;
  outcomes?:Array<{child:number;task_id?:string;attempt?:number;state:string}>;
  through_sequence?:number; count?:number; overflow?:boolean;
};

type Item={key:string;revision:string;bytes:number;data:QuietUpdate;queuedAt:number};
export type QuietStateReceiptState='recorded'|'queued'|'delivered'|'consumed';
export type QuietStateReceipt={v:1;key:string;revision:string;state:QuietStateReceiptState;at:number;update:QuietUpdate};
type Stats={accepted:number;duplicate:number;dropped:number;routineRecorded:number;guidanceDelivered:number;guidanceBytes:number;schedulingAttempts:number;disabled:number;receiptFailed:number;circuitBreaks:number};
type Hub={pending:Map<string,Item>;inFlight:Map<string,Item>;receipts:Map<string,QuietStateReceipt>;writer?:symbol;pi?:ExtensionAPI;ctx?:ExtensionContext;timer?:ReturnType<typeof setTimeout>;completionTimer?:ReturnType<typeof setTimeout>;guidanceDisabled?:boolean;ui:boolean;compacting:boolean;lastGuidanceAt:number;localDisabled:boolean;quotaResetAt:number;deliveryFailures:number;stats:Stats};

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
const MAX_GUIDANCE_PER_SESSION=20;
const COMPLETION_PREFIX='Background subagent finished. Read its result, then reap it when follow-up is complete.\n';
const JOB_COMPLETION_PREFIX='Background job finished. Inspect its output, then reap it when no longer needed.\n';
const isCompletion=(data:QuietUpdate)=>(data.kind==='subagent'||data.kind==='job')&&data.completion===true;
const completionIdentity=(data:QuietUpdate)=>JSON.stringify([data.kind,data.job_id??data.id,data.child_id??data.id]);
const hasSequence=(data:QuietUpdate)=>Number.isSafeInteger(data.through_sequence)&&data.through_sequence!>=0;
function completionSuperseded(h:Hub,data:QuietUpdate):boolean{
  if(!isCompletion(data)||!hasSequence(data))return false;
  const identity=completionIdentity(data);
  return [...h.receipts.values()].some(r=>completionIdentity(r.update)===identity&&hasSequence(r.update)
    &&(r.update.activity===true&&r.state==='recorded'&&r.update.through_sequence!>data.through_sequence!
      ||isCompletion(r.update)&&(r.state==='consumed'||r.state==='delivered')&&r.update.through_sequence!>=data.through_sequence!));
}
function completionPrefix(updates:QuietUpdate[]):string{
  const children=updates.some(u=>u.kind==='subagent'),jobs=updates.some(u=>u.kind==='job');
  if(children&&jobs)return 'Background work finished. Read each job’s output or subagent’s result, then reap it when no longer needed.\n';
  return children?COMPLETION_PREFIX:JOB_COMPLETION_PREFIX;
}
const GUIDANCE_PREFIX='Subagent requests guidance. Reply using subagent operation=prompt with its child_id.\n';

function hubs():Map<string,Hub>{const root=globalThis as any;return root[KEY]??=(new Map<string,Hub>());}
function session(ctx:any):string{return ctx.sessionManager.getSessionId();}
function stats():Stats{return {accepted:0,duplicate:0,dropped:0,routineRecorded:0,guidanceDelivered:0,guidanceBytes:0,schedulingAttempts:0,disabled:0,receiptFailed:0,circuitBreaks:0};}
function hub(ctx:any):Hub{const id=session(ctx);let h=hubs().get(id);if(!h){h={pending:new Map(),inFlight:new Map(),receipts:new Map(),ui:false,compacting:false,lastGuidanceAt:0,localDisabled:false,quotaResetAt:0,deliveryFailures:0,stats:stats()};hubs().set(id,h);}return h;}
function revision(data:QuietUpdate):string{return createHash('sha256').update(JSON.stringify(data)).digest('hex');}
function bytes(text:string):number{return Buffer.byteLength(text,'utf8');}
function keyOf(data:Pick<QuietUpdate,'kind'|'id'>):string{return `${data.kind}:${data.id}`;}
function clone<T>(value:T):T{return JSON.parse(JSON.stringify(value));}
function envDisabled():boolean{return /^(1|true|yes|on)$/i.test(process.env.PAE_QUIET_STATE_DISABLED??process.env.PI_QUIET_STATE_DISABLED??'');}
function disabled(h?:Hub):boolean{return envDisabled()||h?.localDisabled===true||(h?.deliveryFailures??0)>=3;}
function validUpdate(data:any):data is QuietUpdate{return data&&['job','subagent','watch','notification'].includes(data.kind)&&typeof data.id==='string';}
function toItem(data:QuietUpdate,queuedAt=Date.now()):Item{const updateText=JSON.stringify(data);return {key:keyOf(data),revision:revision(data),bytes:bytes(updateText),data:clone(data),queuedAt};}
function clearTimer(h:Hub){if(h.timer)clearTimeout(h.timer);if(h.completionTimer)clearTimeout(h.completionTimer);h.timer=undefined;h.completionTimer=undefined;}
function receiptFrom(entry:any):QuietStateReceipt|undefined{
  if(entry?.type!=='custom'||entry.customType!==QUIET_STATE_RECEIPT_CUSTOM_TYPE)return undefined;
  const d=entry.data;
  if(d?.v!==1||typeof d.key!=='string'||typeof d.revision!=='string'||!['recorded','queued','delivered','consumed'].includes(d.state)||typeof d.at!=='number'||!validUpdate(d.update))return undefined;
  return d;
}
function appendReceipt(h:Hub,item:Item,state:QuietStateReceiptState):boolean{
  const receipt:QuietStateReceipt={v:1,key:item.key,revision:item.revision,state,at:Date.now(),update:clone(item.data)};
  if(bytes(JSON.stringify(receipt))>MAX_ITEM_BYTES||typeof h.pi?.appendEntry!=='function'){h.stats.receiptFailed++;h.deliveryFailures++;return false;}
  try{h.pi.appendEntry(QUIET_STATE_RECEIPT_CUSTOM_TYPE,receipt);}catch{h.stats.receiptFailed++;h.deliveryFailures++;return false;}
  h.receipts.set(item.key,receipt);
  return true;
}
function latestReceipt(h:Hub,key:string){return h.receipts.get(key);}
function isDone(h:Hub,key:string,rev:string){const r=latestReceipt(h,key);return r?.revision===rev&&(r.state==='recorded'||r.state==='delivered'||r.state==='consumed');}
function restore(h:Hub,ctx:any){
  const entries=ctx.sessionManager.getBranch?.()??ctx.sessionManager.getEntries?.()??[];
  h.receipts.clear();h.pending.clear();h.inFlight.clear();h.localDisabled=false;h.guidanceDisabled=false;h.quotaResetAt=0;h.lastGuidanceAt=0;h.stats.guidanceDelivered=0;h.stats.guidanceBytes=0;
  for(const entry of entries){
    if(entry?.type==='custom'&&entry.customType===CONTROL_CUSTOM&&entry.data?.v===1){if(typeof entry.data.disabled==='boolean'){if(['guidance-quota','compaction-pause'].includes(entry.data.reason))h.guidanceDisabled=entry.data.disabled;else {h.localDisabled=entry.data.disabled;if(!entry.data.disabled)h.guidanceDisabled=false;}}if(typeof entry.data.quotaResetAt==='number')h.quotaResetAt=entry.data.quotaResetAt;}
    const r=receiptFrom(entry);if(r){h.receipts.set(r.key,r);continue;}
    // Backward compatibility: pre-remediation hidden messages count as delivered and must never replay.
    if(entry?.type==='custom_message'&&entry.customType===MESSAGE_CUSTOM&&Array.isArray(entry.details?.updates))for(const data of entry.details.updates){if(validUpdate(data)){
      const item=toItem(data),prior=h.receipts.get(item.key);
      // A historical message is delivery evidence, not a new delivery now.
      // Preserve explicit receipts (including consumption), and never let an
      // older message acknowledge a newer revision of a queued request.
      if(prior&&(prior.state!=='queued'||prior.revision!==item.revision))continue;
      const timestamp=typeof entry.timestamp==='string'?Date.parse(entry.timestamp):entry.timestamp;
      const at=typeof timestamp==='number'&&Number.isFinite(timestamp)?timestamp:prior?.at??0;
      h.receipts.set(item.key,{v:1,key:item.key,revision:item.revision,state:'delivered',at,update:item.data});
    }}
  }
  for(const r of h.receipts.values()){if(r.state==='delivered'&&r.update.requires_guidance===true&&r.at>=h.quotaResetAt){h.stats.guidanceDelivered++;h.stats.guidanceBytes+=bytes(JSON.stringify(r.update));h.lastGuidanceAt=Math.max(h.lastGuidanceAt,r.at);}if(r.state==='queued'&&(r.update.requires_guidance===true||isCompletion(r.update)))h.pending.set(r.key,toItem(r.update,r.at));}
  // Report sequence, not receipt time, orders child turns. Consuming an older
  // result later must not suppress a newer unseen completion after reload.
  for(const [key,item]of h.pending)if(completionSuperseded(h,item.data))h.pending.delete(key);
  // Retained child notifications are operator-visible records. Routine notifications stay retained only; explicit guidance is re-queued until delivered/consumed.
  for(const entry of entries){
    const data=entry?.type==='custom'&&entry.customType===NOTIFICATION_CUSTOM?entry.data?.update:undefined;
    if(!validUpdate(data)||data.kind!=='notification')continue;
    const item=toItem(data,entry.data?.at??Date.now());
    if(isDone(h,item.key,item.revision)||h.pending.has(item.key)||h.pending.size>=MAX_PENDING)continue;
    if(data.requires_guidance===true)h.pending.set(item.key,item);
  }
}
function guidancePending(h:Hub){return [...h.pending.values()].some(i=>i.data.requires_guidance===true);}
function refreshStatus(h:Hub){const ctx=h.ctx;if(!ctx?.hasUI)return;const guidance=[...h.pending.values()].filter(i=>i.data.requires_guidance).length;const text=disabled(h)?'quiet off':h.compacting?'quiet compacting':h.guidanceDisabled?'quiet guidance paused':h.stats.guidanceDelivered>=MAX_GUIDANCE_PER_SESSION?'quiet guidance quota':guidance?`quiet guidance ${guidance}`:undefined;try{ctx.ui.setStatus('quiet-state',text);}catch{}}
function notificationEntries(ctx:any):QuietUpdate[]{return (ctx.sessionManager.getBranch?.()??ctx.sessionManager.getEntries?.()??[]).map((e:any)=>e?.type==='custom'&&e.customType===NOTIFICATION_CUSTOM?e.data?.update:undefined).filter(validUpdate);}
const commandApis:WeakSet<object>=new WeakSet();
function installCommands(pi:any){
  if(typeof pi.registerCommand!=='function'||commandApis.has(pi))return;commandApis.add(pi);
  pi.registerCommand('harness-state',{description:'Show quiet harness-state status/notifications or disable/enable quiet model wakeups',handler:async(args:string,ctx:any)=>{
    const current=hub(ctx);restore(current,ctx);const parts=(args||'status').trim().split(/\s+/);const mode=parts[0];
    if(mode==='show'){
      const notes=notificationEntries(ctx).slice(-25).map((u,i)=>`${i+1}. ${u.requires_guidance?'[guidance]':'[finding]'} ${u.child_id??u.id}: ${u.message??''}`);
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
    if(mode==='enable'||mode==='on'){current.localDisabled=false;current.guidanceDisabled=false;current.deliveryFailures=0;current.lastGuidanceAt=0;current.stats.guidanceDelivered=0;current.quotaResetAt=Date.now();pi.appendEntry(CONTROL_CUSTOM,{v:1,disabled:false,quotaResetAt:current.quotaResetAt,at:Date.now()});ctx.ui.notify('harness-state completion/guidance wakeups enabled for this session; guidance quota reset.','info');refreshStatus(current);schedule(current,0);return;}
    ctx.ui.notify(`harness-state: status=${disabled(current)?'disabled':current.guidanceDisabled?'guidance-paused':'active'} reason=${envDisabled()?'environment kill switch':current.localDisabled?'operator disable':current.deliveryFailures>=3?'delivery circuit breaker':current.guidanceDisabled?'persisted guidance pause':current.compacting?'compaction':current.stats.guidanceDelivered>=MAX_GUIDANCE_PER_SESSION?'guidance quota':'none'} pendingCompletions=${[...current.pending.values()].filter(i=>isCompletion(i.data)).length} pendingGuidance=${[...current.pending.values()].filter(i=>i.data.requires_guidance).length} receipts=${current.receipts.size} deliveredUpdates=${current.stats.guidanceDelivered}/${MAX_GUIDANCE_PER_SESSION} guidanceBytes=${current.stats.guidanceBytes} schedulingAttempts=${current.stats.schedulingAttempts} routineRecorded=${current.stats.routineRecorded} duplicates=${current.stats.duplicate} dropped=${current.stats.dropped} receiptFailed=${current.stats.receiptFailed} circuitBreaks=${current.stats.circuitBreaks} disabled=${disabled(current)} envKillSwitch=PAE_QUIET_STATE_DISABLED=1`,'info');
  }});
}
function batchBytes(updates:QuietUpdate[]):number{return bytes(GUIDANCE_PREFIX+JSON.stringify(updates))+bytes(JSON.stringify({updates}));}
function selectBatch(h:Hub){const out:Item[]=[];for(const item of [...h.pending.values()].filter(i=>i.data.requires_guidance).sort((a,b)=>a.queuedAt-b.queuedAt)){if(out.length>=MAX_BATCH_ITEMS)break;const next=[...out,item];if(batchBytes(next.map(i=>i.data))>MAX_BATCH_BYTES){if(out.length===0){h.pending.delete(item.key);h.stats.circuitBreaks++;appendReceipt(h,item,'consumed');}break;}out.push(item);}return out;}
function scheduleCompletions(h:Hub,delayMs:number){
  if(h.completionTimer||h.ui||h.compacting||!h.pi||!h.ctx||disabled(h))return;
  if(![...h.pending.values()].some(i=>isCompletion(i.data)))return;
  h.completionTimer=setTimeout(()=>{
    h.completionTimer=undefined;
    if(h.ui||h.compacting||!h.pi||!h.ctx||disabled(h))return;
    // Let existing queued messages drain; never abort or interrupt active tools.
    if(h.ctx.hasPendingMessages?.()||!h.ctx.isIdle()){scheduleCompletions(h,Math.max(delayMs,1000));return;}
    const latest=new Map<string,Item>();
    for(const [key,item]of h.pending)if(isCompletion(item.data)){
      if(completionSuperseded(h,item.data)){h.pending.delete(key);continue;}
      const identity=completionIdentity(item.data),prior=latest.get(identity);
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
    const updates=deliver.map(i=>i.data);
    try{
      h.pi.sendMessage({customType:MESSAGE_CUSTOM,display:false,content:completionPrefix(updates)+JSON.stringify(updates),details:{updates}},
        {deliverAs:'followUp',triggerTurn:true});
    }catch{h.deliveryFailures++;scheduleCompletions(h,Math.max(delayMs,1000));return;}
    h.deliveryFailures=0;
    for(const item of deliver){
      // Only acknowledge accepted sends. The persisted message also deduplicates
      // recovery if appending the receipt fails after sendMessage succeeds.
      if(!appendReceipt(h,item,'delivered'))h.receipts.set(item.key,{v:1,key:item.key,revision:item.revision,state:'delivered',at:Date.now(),update:item.data});
      if(h.pending.get(item.key)?.revision===item.revision)h.pending.delete(item.key);
    }
    scheduleCompletions(h,Math.max(delayMs,1000));
  },delayMs);h.completionTimer.unref?.();
}
function schedule(h:Hub,delayMs:number){
  scheduleCompletions(h,delayMs);
  refreshStatus(h);if(h.timer||h.ui||h.compacting||!h.pi||!h.ctx||disabled(h)||h.guidanceDisabled||!guidancePending(h)||h.ctx.hasPendingMessages?.())return;
  if(h.stats.guidanceDelivered>=MAX_GUIDANCE_PER_SESSION)return;
  const wait=Math.max(delayMs,MIN_GUIDANCE_INTERVAL_MS-(Date.now()-h.lastGuidanceAt),0);
  h.timer=setTimeout(()=>{h.timer=undefined;if(!h.pi||!h.ctx||h.ui||h.compacting||disabled(h)||!guidancePending(h)||h.ctx.hasPendingMessages?.())return;h.stats.schedulingAttempts++;const items=selectBatch(h);if(!items.length)return;const updates=items.map(i=>i.data);const content=GUIDANCE_PREFIX+JSON.stringify(updates);const reserved:Item[]=[];for(const item of items){if(!appendReceipt(h,item,'delivered'))break;reserved.push(item);if(h.pending.get(item.key)?.revision===item.revision)h.pending.delete(item.key);}if(reserved.length!==items.length){schedule(h,delayMs);return;}h.lastGuidanceAt=Date.now();h.stats.guidanceDelivered+=items.length;h.stats.guidanceBytes+=batchBytes(updates);try{h.pi.sendMessage({customType:MESSAGE_CUSTOM,display:false,content,details:{updates}},{deliverAs:h.ctx.isIdle()?'followUp':'steer',triggerTurn:true});h.deliveryFailures=0;}catch{h.deliveryFailures++;}schedule(h,delayMs);},wait);h.timer.unref?.();
}

/** Routine updates are receipts only; explicit guidance and background terminal completion may wake the model. */
export function installQuietState(pi:ExtensionAPI,delayMs=1000){
  const writer=Symbol('quiet-harness-writer');
  installCommands(pi);
  pi.on('session_start',async(_event,ctx)=>{const h=hub(ctx);clearTimer(h);h.writer=writer;h.pi=pi;h.ctx=ctx;h.ui=false;h.compacting=false;restore(h,ctx);schedule(h,delayMs);});
  pi.on('agent_settled',async(_event,ctx)=>{const h=hub(ctx);if(h.writer===writer){h.ctx=ctx;restore(h,ctx);schedule(h,delayMs);}});
  pi.on('session_before_compact',async(_event,ctx)=>{const h=hub(ctx);if(h.writer===writer){h.compacting=true;clearTimer(h);refreshStatus(h);}});
  pi.on('session_compact',async(_event,ctx)=>{const h=hub(ctx);if(h.writer===writer){h.compacting=false;restore(h,ctx);schedule(h,delayMs);}});
  pi.on('session_compact_failed',async(_event,ctx)=>{const h=hub(ctx);if(h.writer===writer){h.compacting=false;restore(h,ctx);schedule(h,delayMs);}});
  pi.on('ui_prompt_start',async(_event,ctx)=>{const h=hub(ctx);if(h.writer===writer){h.ui=true;clearTimer(h);refreshStatus(h);}});
  pi.on('ui_prompt_end',async(_event,ctx)=>{const h=hub(ctx);if(h.writer===writer){h.ui=false;schedule(h,delayMs);}});
  pi.on('session_shutdown',async(event,ctx)=>{const h=hub(ctx);if(h.writer!==writer)return;clearTimer(h);restore(h,ctx);h.writer=undefined;h.pi=undefined;h.ctx=undefined;if(event.reason!=='reload')hubs().delete(session(ctx));});
  return {
    enqueue(ctx:ExtensionContext,data:QuietUpdate):boolean{
      const h=hub(ctx);h.pi=pi;h.ctx=ctx;
      // Activity invalidation must persist even while delivery is disabled, and
      // never move backwards when an older async observation arrives late.
      if(data.activity===true){
        if(data.kind!=='subagent'||!data.job_id||!data.child_id||!hasSequence(data))throw new Error('Invalid worker activity identity');
        const item=toItem({...data,id:`${data.job_id}:${data.child_id}:activity`,completion:false,requires_guidance:false});
        const prior=latestReceipt(h,item.key);
        if(prior?.update.activity===true&&hasSequence(prior.update)&&prior.update.through_sequence!>=data.through_sequence!)return true;
        if(!appendReceipt(h,item,'recorded'))return false;
        for(const [key,pending]of h.pending)if(completionSuperseded(h,pending.data))h.pending.delete(key);
        return true;
      }
      if(disabled(h)){h.stats.disabled++;return false;}
      const item=toItem(data);if(item.bytes>MAX_UPDATE_BYTES||(isCompletion(data)&&bytes(completionPrefix([data])+JSON.stringify([data]))+bytes(JSON.stringify({updates:[data]}))>MAX_BATCH_BYTES))throw new Error('Quiet state update exceeds its metadata budget');
      const superseded=completionSuperseded(h,data);
      if(superseded||isDone(h,item.key,item.revision)||(isCompletion(data)&&['recorded','delivered','consumed'].includes(latestReceipt(h,item.key)?.state??''))||h.pending.get(item.key)?.revision===item.revision){h.stats.duplicate++;return true;}
      if(h.pending.size>=MAX_PENDING&&!h.pending.has(item.key)){h.stats.dropped++;return false;}
      h.stats.accepted++;
      if(data.requires_guidance===true||isCompletion(data)){if(!appendReceipt(h,item,'queued'))return false;h.pending.set(item.key,item);schedule(h,delayMs);return true;}
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
      refreshStatus(h);
    },
    consume(ctx:ExtensionContext,kind:QuietUpdate['kind'],id:string,through?:number){
      const h=hub(ctx);const key=`${kind}:${id}`;
      // Job callers consume only terminal reads/reap, never running status.
      // Persist a tombstone even before enqueue: an async notified check can lose
      // this race, and must not cause a delayed wake after the tool returned.
      const item=h.pending.get(key)??(kind==='job'&&!h.receipts.has(key)?toItem({kind,id,completion:true}):undefined);
      if(item&&(through===undefined||(item.data.through_sequence??0)<=through)&&appendReceipt(h,item,'consumed'))h.pending.delete(key);
      refreshStatus(h);
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
