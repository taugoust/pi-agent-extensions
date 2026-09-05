import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeTaskStore, createTaskId } from './resume.js';
const root=mkdtempSync(join(tmpdir(),'native-task-test-'));
const child=(n:string)=>`subagent-child-${n.repeat(24)}`;
try {
 const store=new NativeTaskStore(join(root,'tasks'));const id=createTaskId();
 const original=await store.create('owner',id,{task:'Keep this context',cwd:root,tools:['read'],acceptance:['tested']},child('1'));
 await assert.rejects(store.beginResume('foreign',id,child('2')),/another parent/);
 await assert.rejects(store.beginResume('owner',id,child('2')),/still running/);
 writeFileSync(store.sessionPath(id),readFileSync(store.sessionPath(id),'utf8')+JSON.stringify({type:'message',id:'m1',message:{role:'user',content:'saved context'}})+'\n');
 await store.finish('owner',id,child('1'),{outcome:'checkpointed',nextAction:'Finish validation',contextTokens:250000,contextWindow:272000});
 const attempts=await Promise.allSettled([store.beginResume('owner',id,child('2')),store.beginResume('owner',id,child('3'))]);
 assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);
 const current=store.get('owner',id);assert.equal(current.attempt,2);assert.equal(current.sessionId,original.sessionId);assert.equal(current.checkpointed,true);assert.deepEqual(current.spec.tools,['read']);
 assert.match(readFileSync(store.sessionPath(id),'utf8'),/saved context/);
 await store.finish('owner',id,current.childId,{outcome:'partial'});
 const session=store.sessionPath(id);const text=readFileSync(session,'utf8');unlinkSync(session);const other=join(root,'other');writeFileSync(other,text);symlinkSync(other,session);
 await assert.rejects(store.beginResume('owner',id,child('4')));unlinkSync(session);writeFileSync(session,text,{mode:0o600});
 const state=join(root,'tasks',id,'state.json');const interrupted=JSON.parse(readFileSync(state,'utf8'));
 interrupted.state='running';interrupted.ownerPid=99999999;interrupted.ownerToken='dead';interrupted.recoveryAfter=Date.now()-1;writeFileSync(state,JSON.stringify(interrupted));
 assert.equal((await store.beginResume('owner',id,child('4'))).attempt,3);
 assert.equal(store.list('foreign').length,0);assert.equal(store.list('owner')[0].task_id,id);
 assert.throws(()=>store.get('owner','../outside'));
 console.log('native task resume checks passed');
} finally {rmSync(root,{recursive:true,force:true});}
