import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TuiNativeManager } from './tui-native.ts';
import { TuiWorkerStore } from './tui-worker-store.ts';
import { TuiWorkerServer } from './tui-worker-server.ts';
import { installQuietState } from '../shared/quiet-state.ts';

for (const start of ['prompt', 'human'] as const) test(`pending completion is invalidated by ${start} activity across reload, later completion still wakes`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-generation-')), directory = join(root, 'w');
  const store = new TuiWorkerStore(directory, true);
  const m:any = { protocol:1,ownerSessionId:'parent',taskId:'task',runtimeId:'runtime',groupId:`subagent-job-${'a'.repeat(24)}`,
    childId:`subagent-child-${'b'.repeat(24)}`,attempt:1,workerEpoch:'c'.repeat(32),controlToken:'d'.repeat(64),
    controlSocket:join(directory,'control.sock'),sessionFile:join(directory,'session.jsonl'),launchMode:'none',presentation:'background',
    placement:{socketPath:'/tmp/not-real',serverEpoch:'1:2',sessionId:'$1',windowId:'@1',paneId:'%1',ownershipNonce:'e'.repeat(64)}};
  store.writeManifest(m);
  const manager:any = new TuiNativeManager(root, () => 'native', () => true, 16);
  let idle = true;
  const worker = new TuiWorkerServer(store, { isIdle: () => idle, send() { idle = false; }, abort() {}, shutdown() {} });
  const child:any = { childId:m.childId,taskId:m.taskId,directory,state:'running',spec:{task:'review'},started:true,notifiedSequence:0 };
  const group:any = { id:m.groupId,owner:'parent',background:true,mode:'single',launchMode:'none',caller:m.placement,children:[child] };
  manager.owner='parent'; manager.groups.set(group.id,group); manager.tmux.inspect=async()=>({dead:false});
  const entries:any[]=[], messages:any[]=[], handlers=new Map<string,Function[]>();
  const ctx:any={hasUI:false,isIdle:()=>true,hasPendingMessages:()=>false,sessionManager:{getSessionId:()=>`generation-${start}-${process.pid}`,getBranch:()=>entries}};
  const pi:any={on(name:string,fn:Function){handlers.set(name,[...handlers.get(name)??[],fn]);},
    appendEntry(customType:string,data:any){entries.push({type:'custom',customType,data});},sendMessage(message:any){messages.push(message);}};
  const quiet=installQuietState(pi,5); manager.notify=(u:any)=>quiet.enqueue(ctx,u);
  const emit=async(name:string,event:any={})=>{for(const fn of handlers.get(name)??[])await fn(event,ctx);};
  try {
    await emit('session_start'); await emit('ui_prompt_start');
    await worker.start(); worker.running(true); worker.settled({assistant:{stopReason:'error',content:[]}});
    await manager.refresh('parent');
    const oldSequence=worker.state.sequence;
    assert.ok(entries.some(e=>e.data.state==='queued'));
    if(start==='prompt') await manager.operation({operation:'prompt',child_id:child.childId,message:'continue'},'parent');
    else { idle=false; worker.running(true); await manager.refresh('parent'); }
    assert.equal(child.state,'running');
    // Prompt acceptance alone must invalidate; do not refresh first.
    await emit('session_shutdown',{reason:'reload'}); await emit('session_start');
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(messages.length,0,`stale completion ${oldSequence} woke after newer activity`);
    // Delayed old observations cannot move the high-water mark backwards.
    quiet.enqueue(ctx,{kind:'subagent',id:'ignored',job_id:group.id,child_id:child.childId,activity:true,through_sequence:0});
    quiet.enqueue(ctx,{kind:'subagent',id:'late-old',job_id:group.id,child_id:child.childId,completion:true,through_sequence:oldSequence});
    idle=true; worker.settled({assistant:{stopReason:'stop',content:[]}});
    await manager.refresh('parent'); await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(messages.length,1);
    assert.ok(messages[0].details.updates[0].through_sequence>oldSequence);
  } finally { await emit('session_shutdown',{reason:'exit'}); await worker.close(); await manager.shutdown(false); await rm(root,{recursive:true,force:true}); }
});

test('native terminal snapshots: foreground silence, background failures, retry, distinct later turns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-completion-'));
  const manager:any = new TuiNativeManager(root,()=> 'native',()=>true,16);
  const updates:any[]=[];
  manager.notify=(u:any)=>{updates.push(u);return true;};
  const group:any={id:'group',background:false};
  const child:any={childId:'child',state:'completed',report:'first-report',attempt:1};
  try {
    manager.notifyTerminal(group,child);
    assert.equal(updates.length,0);
    group.background=true;manager.notifyTerminal(group,child);
    assert.equal(updates.length,0,'promotion replayed already-returned foreground result');
    child.state='running';child.report=undefined;manager.notifyTerminal(group,child);
    assert.equal(updates.length,0);
    child.state='failed';child.report='second-report';manager.notifyTerminal(group,child);
    assert.equal(updates.length,1);assert.equal(updates[0].completion,true);
    manager.notifyTerminal(group,child);assert.equal(updates.length,1);
    const lost:any={childId:'lost',state:'lost',attempt:1};
    manager.notify=()=>false;manager.notifyTerminal(group,lost);
    assert.equal(lost.terminalNotification,undefined,'failed enqueue advanced durable cursor');
    manager.notify=(u:any)=>{updates.push(u);return true;};
    manager.notifyTerminal(group,lost);manager.notifyTerminal(group,lost);
    assert.equal(updates.length,2);assert.equal(updates[1].state,'lost');
    const failed:any={childId:'launch-failed',state:'failed',attempt:1};
    manager.notifyTerminal(group,failed);assert.equal(updates.length,3);
    failed.reaped=true;failed.report='new';manager.notifyTerminal(group,failed);assert.equal(updates.length,3);
  } finally {await manager.shutdown(false);await rm(root,{recursive:true,force:true});}
});
