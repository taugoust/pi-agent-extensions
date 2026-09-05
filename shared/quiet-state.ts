import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';

export type QuietUpdate = {
  kind:'job'|'subagent'|'watch'; id:string; state?:string;
  outcomes?:Array<{child:number;task_id?:string;attempt?:number;state:string}>;
  through_sequence?:number; count?:number; overflow?:boolean;
};
type Item={key:string;revision:string;data:QuietUpdate};
type Hub={pending:Map<string,Item>;inFlight:Map<string,Item>;seen:Map<string,string>;writer?:symbol;pi?:ExtensionAPI;ctx?:ExtensionContext;timer?:ReturnType<typeof setTimeout>;busy:boolean;ui:boolean};
const KEY='__paeQuietHarnessStateV1';
const CUSTOM='harness-state';
function hubs():Map<string,Hub>{const root=globalThis as any;return root[KEY]??=(new Map<string,Hub>());}
function session(ctx:any):string{return ctx.sessionManager.getSessionId();}
function hub(ctx:any):Hub {const id=session(ctx);let value=hubs().get(id);if(!value){value={pending:new Map(),inFlight:new Map(),seen:new Map(),busy:false,ui:false};hubs().set(id,value);}return value;}
function revision(data:QuietUpdate):string{return JSON.stringify(data);}
function clearTimer(h:Hub){if(h.timer)clearTimeout(h.timer);h.timer=undefined;}
function restore(h:Hub,ctx:any){
  const entries=ctx.sessionManager.getBranch?.()??[];
  for(const entry of entries){
    if(entry?.type!=='custom_message'||entry.customType!==CUSTOM||!Array.isArray(entry.details?.updates))continue;
    for(const data of entry.details.updates){
      if(!data||!['job','subagent','watch'].includes(data.kind)||typeof data.id!=='string')continue;
      const key=`${data.kind}:${data.id}`;h.seen.set(key,revision(data));
    }
  }
  for(const [key,item] of h.inFlight){if(h.seen.get(key)!==item.revision&&!h.pending.has(key))h.pending.set(key,item);}
  h.inFlight.clear();
  for(const [key,item] of h.pending)if(h.seen.get(key)===item.revision)h.pending.delete(key);
  while(h.seen.size>512)h.seen.delete(h.seen.keys().next().value!);
}
function schedule(h:Hub,delayMs:number){
  if(h.timer||h.busy||h.ui||!h.ctx||!h.pi||!h.pending.size||!h.ctx.isIdle()||h.ctx.hasPendingMessages?.())return;
  h.timer=setTimeout(()=>{
    h.timer=undefined;
    if(!h.ctx||!h.pi||h.busy||h.ui||!h.ctx.isIdle()||h.ctx.hasPendingMessages?.())return;
    const items:Item[]=[];let bytes=0;
    for(const item of h.pending.values()){
      if(items.length>=32||bytes+item.revision.length>6000)break;
      items.push(item);bytes+=item.revision.length;
    }
    if(!items.length)return;
    const updates=items.map(item=>item.data);
    try {
      h.pi.sendMessage({customType:CUSTOM,display:false,
        content:'Internal harness state changes, not a user request. Continue supervision if action is needed. Do not post a routine status recap or repeat worker reports. Fetch reports/output only when needed.\n'+JSON.stringify(updates),
        details:{updates}}, {deliverAs:'followUp',triggerTurn:true});
      for(const item of items){if(h.pending.get(item.key)?.revision===item.revision)h.pending.delete(item.key);h.inFlight.set(item.key,item);}
    } catch { /* Keep pending data; a later boundary or enqueue retries it. */ }
  },delayMs);
  h.timer.unref?.();
}

/** One bounded hidden state batch across producers, only after the parent settles. */
export function installQuietState(pi:ExtensionAPI,delayMs=1000){
  const writer=Symbol('quiet-harness-writer');
  pi.on('session_start',async(_event,ctx)=>{
    const h=hub(ctx);clearTimer(h);h.writer=writer;h.pi=pi;h.ctx=ctx;h.busy=false;h.ui=false;restore(h,ctx);schedule(h,delayMs);
  });
  pi.on('before_agent_start',async(_event,ctx)=>{const h=hub(ctx);if(h.writer===writer){h.busy=true;clearTimer(h);}});
  pi.on('agent_settled',async(_event,ctx)=>{const h=hub(ctx);if(h.writer===writer){h.busy=false;h.ctx=ctx;restore(h,ctx);schedule(h,delayMs);}});
  pi.on('ui_prompt_start',async(_event,ctx)=>{const h=hub(ctx);if(h.writer===writer){h.ui=true;clearTimer(h);}});
  pi.on('ui_prompt_end',async(_event,ctx)=>{const h=hub(ctx);if(h.writer===writer){h.ui=false;schedule(h,delayMs);}});
  pi.on('session_shutdown',async(event,ctx)=>{
    const h=hub(ctx);if(h.writer!==writer)return;clearTimer(h);restore(h,ctx);h.writer=undefined;h.pi=undefined;h.ctx=undefined;
    if(event.reason!=='reload')hubs().delete(session(ctx));
  });
  return {
    enqueue(ctx:ExtensionContext,data:QuietUpdate):boolean {
      const text=revision(data);
      if(text.length>4096)throw new Error('Quiet state update exceeds its metadata budget');
      const h=hub(ctx);const key=`${data.kind}:${data.id}`;
      if(h.seen.get(key)===text||h.inFlight.get(key)?.revision===text)return true;
      if(h.pending.size>=256&&!h.pending.has(key))return false;
      h.pending.set(key,{key,revision:text,data:JSON.parse(text)});schedule(h,delayMs);return true;
    },
    consume(ctx:ExtensionContext,kind:QuietUpdate['kind'],id:string,through?:number){
      const h=hub(ctx);const key=`${kind}:${id}`;const item=h.pending.get(key);
      if(item&&(through===undefined||(item.data.through_sequence??0)<=through))h.pending.delete(key);
    },
  };
}
