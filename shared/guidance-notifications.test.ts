import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installQuietState,QUIET_STATE_RECEIPT_CUSTOM_TYPE,type QuietUpdate} from './quiet-state.js';
let serial=0;
function fixture(t:any,retained:any[]=[]){
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1800000000000});
 const entries=retained,handlers=new Map<string,any[]>(),commands=new Map<string,any>(),messages:any[]=[],notices:string[]=[];
 let idle=true,pending=false,live:QuietUpdate[]|undefined=[],receiptFailure:boolean|((data:any)=>boolean)=false,transport:'ok'|'reject'|'ambiguous'|'unacknowledged'='ok';
 let receiptAttempts=0;
 const id=`guidance-deterministic-${++serial}`;
 const ctx:any={hasUI:true,isIdle:()=>idle,hasPendingMessages:()=>pending,sessionManager:{getSessionId:()=>id,getBranch:()=>entries},ui:{setStatus(){},notify(text:string){notices.push(text);}}};
 const persist=(message:any)=>entries.push({type:'message',message:{role:'custom',...message},timestamp:new Date().toISOString()});
 const pi:any={on(name:string,fn:any){handlers.set(name,[...(handlers.get(name)??[]),fn]);},registerCommand(name:string,def:any){commands.set(name,def);},appendEntry(customType:string,data:any){if(customType===QUIET_STATE_RECEIPT_CUSTOM_TYPE)receiptAttempts++;if(customType===QUIET_STATE_RECEIPT_CUSTOM_TYPE&&(typeof receiptFailure==='function'?receiptFailure(data):receiptFailure))throw Error('receipt unavailable');entries.push({type:'custom',customType,data:structuredClone(data)});},sendMessage(message:any,options:any){if(transport==='reject')throw Object.assign(Error('not accepted'),{deliveryNotAccepted:true});if(transport==='ambiguous')throw Error('unknown acceptance');messages.push({message:structuredClone(message),options,at:Date.now()});if(transport==='ok')persist(message);}};
 const quiet=installQuietState(pi,5);quiet.setGuidanceSource(()=>live);
 const emit=async(name:string,event:any={})=>{for(const fn of handlers.get(name)??[])await fn(event,ctx);};
 const advance=async(ms:number)=>{t.mock.timers.tick(ms);for(let n=0;n<16;n++)await Promise.resolve();};
 const request=(n:number,child=0):QuietUpdate=>{const hex=(v:number)=>v.toString(16).padStart(24,'0'),childId='subagent-child-'+hex(child);return {kind:'notification',id:'guidance:'+hex(n),child_id:childId,requires_guidance:true,message:'Same request text 🧪',guidance:{ownerSessionId:id,ownerRuntimeEpoch:'a'.repeat(32),taskId:'subagent-task-'+hex(child),childId,attempt:1,workerEpoch:'b'.repeat(32),workerRuntimeEpoch:'c'.repeat(32),requestId:'guidance:'+hex(n)}};};
 let stopped=false;const stop=async()=>{if(stopped)return;stopped=true;await emit('session_shutdown',{reason:'exit'});t.mock.timers.reset();};t.after(stop);
 return {get receiptAttempts(){return receiptAttempts;},id,ctx,pi,quiet,entries,messages,notices,request,emit,advance,stop,persist,commands,setLive(v:QuietUpdate[]|undefined){live=v;},setBusy(v:boolean){idle=!v;},setPending(v:boolean){pending=v;},failReceipts(v:boolean|((data:any)=>boolean)){receiptFailure=v;},transport(v:typeof transport){transport=v;}};
}
test('128 distinct authenticated requests drain fairly without a lifetime quota, bounded UTF-8 batches and stable ID dedup',async t=>{
 const f=fixture(t);const requests=Array.from({length:128},(_,n)=>f.request(n,n<100?1:2));f.setLive(requests);await f.emit('session_start');
 for(let n=0;n<128;n++)await f.advance(n?30000:5);
 const updates=f.messages.flatMap(m=>m.message.details.updates);assert.equal(updates.length,128);assert.equal(new Set(updates.map(u=>u.id)).size,128);
 assert.ok(f.messages[0].message.details.updates.some((u:QuietUpdate)=>u.guidance!.childId===requests[127].guidance!.childId),'second child starved behind first backlog');
 for(let n=0;n<f.messages.length;n++){const m=f.messages[n];assert.ok(m.message.details.updates.length<=16);assert.ok(Buffer.byteLength(m.message.content)+Buffer.byteLength(JSON.stringify(m.message.details))<=6000);if(n)assert.ok(m.at-f.messages[n-1].at>=30000);}
 for(const r of requests)f.quiet.enqueue(f.ctx,{...r,message:'Changed presentation, same stable identity'});
 await f.advance(60000);assert.equal(f.messages.flatMap(m=>m.message.details.updates).length,128);
 await f.emit('session_start');await f.advance(60000);assert.equal(f.messages.flatMap(m=>m.message.details.updates).length,128,'reload replayed delivered IDs');await f.stop();
});
test('busy, queued input, modal UI and compaction defer rather than discard requests',async t=>{
 const f=fixture(t);f.setLive([f.request(1)]);f.setBusy(true);await f.emit('session_start');await f.advance(5000);assert.equal(f.messages.length,0);
 f.setBusy(false);f.setPending(true);await f.advance(5000);assert.equal(f.messages.length,0);
 f.setPending(false);await f.emit('ui_prompt_start');await f.advance(5000);assert.equal(f.messages.length,0);
 await f.emit('ui_prompt_end');await f.emit('session_before_compact');await f.advance(5000);assert.equal(f.messages.length,0);
 await f.emit('session_compact_failed');await f.advance(5);assert.equal(f.messages.length,1);await f.stop();
});
test('38 legacy receipts and quota-only pause migrate without replay; stale, foreign and resolved broker requests do not wake',async t=>{
 const f=fixture(t);const prior=Array.from({length:38},(_,n)=>f.request(n));
 for(const data of prior)f.entries.push({type:'custom',customType:QUIET_STATE_RECEIPT_CUSTOM_TYPE,data:{v:1,key:'notification:'+data.id,revision:'legacy',state:'delivered',at:Date.now()-60000,update:{...data,guidance:undefined}}});
 f.entries.push({type:'custom',customType:'harness-state-control',data:{v:1,disabled:true,reason:'guidance-quota'}});
 const stranded=f.request(40);f.entries.push({type:'custom',customType:QUIET_STATE_RECEIPT_CUSTOM_TYPE,data:{v:1,key:'notification:'+stranded.id,revision:'legacy-queued',state:'queued',at:Date.now()-60000,update:{...stranded,guidance:undefined}}});
 const resolved=f.request(80),foreign=f.request(81);foreign.guidance!.ownerSessionId='foreign';
 f.setLive([...prior,f.request(39),stranded,foreign]);await f.emit('session_start');f.quiet.enqueue(f.ctx,resolved);await f.advance(5);
 assert.deepEqual(new Set(f.messages.flatMap(m=>m.message.details.updates).map(u=>u.id)),new Set([f.request(39).id,stranded.id]));
 assert.throws(()=>f.quiet.enqueue(f.ctx,foreign),/Foreign/);await f.stop();
});
test('operator and environment disables survive quota migration and cannot be silently re-enabled',async t=>{
 const f=fixture(t);f.entries.push({type:'custom',customType:'harness-state-control',data:{v:1,disabled:true}});f.setLive([f.request(1)]);await f.emit('session_start');await f.advance(60000);assert.equal(f.messages.length,0);
 await f.commands.get('harness-state').handler('enable',f.ctx);await f.advance(5);assert.equal(f.messages.length,1);
 const old=process.env.PAE_QUIET_STATE_DISABLED;process.env.PAE_QUIET_STATE_DISABLED='1';try{f.setLive([f.request(2)]);f.quiet.reconcile(f.ctx);await f.commands.get('harness-state').handler('enable',f.ctx);await f.advance(60000);assert.equal(f.messages.length,1);}finally{if(old===undefined)delete process.env.PAE_QUIET_STATE_DISABLED;else process.env.PAE_QUIET_STATE_DISABLED=old;await f.stop();}
});
test('certified pre-acceptance rejection retries with backoff and receipt persistence recovers without losing broker waiters',async t=>{
 const f=fixture(t);f.transport('reject');f.setLive([f.request(1)]);await f.emit('session_start');await f.advance(5);assert.equal(f.messages.length,0);assert.ok(f.notices.some(n=>n.includes('rejected before acceptance')));
 f.transport('ok');await f.advance(30000);assert.equal(f.messages.length,1);
 f.failReceipts(true);f.setLive([f.request(2)]);f.quiet.reconcile(f.ctx);await f.advance(30000);assert.equal(f.messages.length,1);
 f.failReceipts(false);await f.advance(300000);assert.equal(f.messages.length,2);await f.stop();
});
test('receipt failure uses exponential deadlines, including after restore, rather than tight retry loops',async t=>{
 const f=fixture(t);f.failReceipts(true);f.setLive([f.request(1)]);await f.emit('session_start');assert.equal(f.receiptAttempts,1);
 await f.advance(999);assert.equal(f.receiptAttempts,1);await f.advance(1);assert.equal(f.receiptAttempts,2);
 await f.advance(1999);assert.equal(f.receiptAttempts,2);await f.advance(1);assert.equal(f.receiptAttempts,3);
 await f.emit('session_start');await f.advance(3999);assert.equal(f.receiptAttempts,3);
 f.failReceipts(false);await f.advance(1);assert.equal(f.messages.length,1);await f.stop();
});

test('partial batch preparation and failed rollback recover automatically while known unsent',async t=>{
 const f=fixture(t);f.setLive([f.request(1),f.request(2)]);await f.emit('session_start');let prepared=0,blocked=false;
 f.failReceipts(data=>{if(data.state==='dispatching'&&++prepared===2)blocked=true;return blocked;});await f.advance(5);assert.equal(f.messages.length,0);
 f.failReceipts(false);await f.advance(300000);assert.equal(f.messages.flatMap(m=>m.message.details.updates).length,2);await f.stop();
});

test('unknown acceptance never blindly replays after restart; exact uncertain recovery is explicit',async t=>{
 const f=fixture(t);f.transport('ambiguous');f.setLive([f.request(1)]);await f.emit('session_start');await f.advance(5);assert.equal(f.messages.length,0);
 f.transport('ok');await f.emit('session_start');await f.advance(300000);assert.equal(f.messages.length,0,'ambiguous dispatch was blindly retried');
 const receipt=f.entries.findLast(e=>e.customType===QUIET_STATE_RECEIPT_CUSTOM_TYPE&&e.data.state==='dispatching');assert.ok(receipt);
 await f.commands.get('harness-state').handler('retry-guidance '+receipt.data.key,f.ctx);await f.advance(30000);assert.equal(f.messages.length,1);await f.stop();
});
test('asynchronous real custom-message journal acknowledges dispatch; missing acknowledgement stays visibly uncertain',async t=>{
 const f=fixture(t);f.transport('unacknowledged');f.setLive([f.request(1)]);await f.emit('session_start');await f.advance(5);assert.equal(f.messages.length,1);
 await f.advance(10000);assert.ok(f.notices.some(n=>n.includes('Uncertain guidance dispatch')));await f.advance(60000);assert.equal(f.messages.length,1);
 f.persist(f.messages[0].message);await f.emit('message_end',{message:{role:'custom',customType:'harness-state'}});await f.emit('session_start');await f.advance(60000);assert.equal(f.messages.length,1);await f.stop();
});
test('bounded queue retains overflow in broker, admits multiple children fairly and eventually drains all 600 requests',async t=>{
 const f=fixture(t);f.setBusy(true);f.setLive(Array.from({length:600},(_,n)=>f.request(n,n===599?2:1)));await f.emit('session_start');
 const hub=(globalThis as any).__paeQuietHarnessStateV2.get(f.id);assert.equal(hub.pending.size,512);assert.equal(hub.brokerPending,600);assert.ok(f.notices.some(n=>n.includes('queue full')));
 f.setBusy(false);for(let n=0;n<600;n++)await f.advance(300000);
 const updates=f.messages.flatMap(m=>m.message.details.updates);assert.equal(updates.length,600);assert.equal(new Set(updates.map(u=>u.id)).size,600);assert.ok(f.messages[0].message.details.updates.some((u:QuietUpdate)=>u.guidance!.childId===f.request(599,2).guidance!.childId));await f.stop();
});
test('multiple extension writers preserve the owning broker source and do not alter completion delivery',async t=>{
 const f=fixture(t);installQuietState(f.pi,5);f.setLive([f.request(1)]);await f.emit('session_start');
 f.quiet.enqueue(f.ctx,{kind:'job',id:'terminal-job',completion:true});await f.advance(5);await f.advance(1000);
 assert.ok(f.messages.some(m=>m.message.details.updates.some((u:QuietUpdate)=>u.completion)));
 await f.advance(30000);assert.equal(f.messages.flatMap(m=>m.message.details.updates).filter(u=>u.guidance).length,1);
 await f.stop();
});

test('unavailable broker snapshot cannot replay retained requests; ready empty snapshot consumes stale waiters',async t=>{
 const f=fixture(t);f.setBusy(true);f.setLive([f.request(1)]);await f.emit('session_start');f.setLive(undefined);f.setBusy(false);await f.emit('session_start');await f.advance(60000);assert.equal(f.messages.length,0);
 f.setLive([]);f.quiet.reconcile(f.ctx);await f.advance(60000);assert.equal(f.messages.length,0);assert.equal((globalThis as any).__paeQuietHarnessStateV2.get(f.id).pending.size,0);await f.stop();
});
