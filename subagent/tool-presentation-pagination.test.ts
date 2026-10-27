import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {TuiWorkerStore} from './tui-worker-store.ts';
import {TuiWorkerServer} from './tui-worker-server.ts';
import {callTuiWorker} from './tui-worker-client.ts';
import {validateLiveEvents} from './live-conversation.ts';

test('typed live metadata paginates under complete page budget without changing attempt authentication',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'tool-presentation-pages-'));await chmod(directory,0o700);
 const manifest={protocol:1 as const,ownerSessionId:'fixture-parent',taskId:'fixture-task',runtimeId:'fixture-runtime',groupId:'subagent-job-'+'a'.repeat(24),childId:'subagent-child-'+'b'.repeat(24),attempt:1,workerEpoch:'c'.repeat(32),controlToken:'d'.repeat(64),controlSocket:join(directory,'control.sock'),sessionFile:join(directory,'session.jsonl'),placement:{socketPath:join(directory,'unused-tmux.sock'),serverEpoch:'123:456',sessionId:'$1',windowId:'@1',paneId:'%1',ownershipNonce:'e'.repeat(64)},presentation:'background' as const,launchMode:'none' as const};
 const store=new TuiWorkerStore(directory);store.writeManifest(manifest);let sends=0;
 const server=new TuiWorkerServer(store,{isIdle:()=>false,send(){sends++;throw new Error('Fixture cannot send agent messages')},abort(){},shutdown(){}});
 try{
  await server.start();server.running(true);
  for(let index=0;index<12;index++)server.conversationTool('end',{toolCallId:'call-'+index,name:'background_job',result:{content:[{type:'text',text:'Output '.repeat(300)}],details:{job_id:'job-'+'1'.repeat(24),status:'running',name:'n'.repeat(4000),command:'c'.repeat(4000)}}});
  const wrong=await callTuiWorker({...manifest,attempt:2},{operation:'events',afterSequence:0});assert.equal(wrong.ok,false,'display metadata must not weaken immutable attempt binding');
  let cursor=0,pages=0;const seen=new Set<string>();
  while(cursor<server.state.sequence){
   const response=await callTuiWorker(manifest,{operation:'events',afterSequence:cursor});
   const events=validateLiveEvents(response,manifest,cursor);assert.ok(events.length);
   assert.ok(Buffer.byteLength(JSON.stringify(response.data))<=96*1024);
   for(const event of events)if(event.kind==='conversation_tool_end'){
    const value=event.data as any;assert.ok(value.toolPresentation);assert.equal(value.toolPresentation.result.details.command.length,4000);seen.add(value.toolCallId);
   }
   const next=(response.data as any).nextSequence;assert.ok(next>cursor);cursor=next;pages++;
  }
  assert.ok(pages>=2);assert.equal(seen.size,12);assert.equal(sends,0);
 }finally{await server.close();await rm(directory,{recursive:true,force:true});}
});
