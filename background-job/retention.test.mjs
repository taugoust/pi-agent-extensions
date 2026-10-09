import test from 'node:test';
import assert from 'node:assert/strict';
import { OUTPUT_RETENTION_MS, retrieveAndSchedule, reapExpiredRetrieved } from './retention.ts';

test('retrieval schedules cleanup, subsequent retrieval resets timer, unread and active jobs stay untouched', async () => {
 const calls=[]; let retrieved;
 const store={listIds:async()=>['owned','unread','active','adopted'],markRetrieved:async(_id,t)=>retrieved=t,readRetrieved:async id=>id==='owned'?retrieved:undefined};
 const base={result:{},launch:{},metadata:{infrastructure:false}};
 await retrieveAndSchedule({...base,metadata:{...base.metadata,id:'owned'}},store,100);
 assert.equal(retrieved,100);
 await retrieveAndSchedule({...base,metadata:{...base.metadata,id:'owned'}},store,200);
 assert.equal(retrieved,200);
 const manager={get:async id=> id==='active'?{...base,result:undefined,metadata:{...base.metadata,id}}:id==='adopted'?{...base,metadata:{...base.metadata,id,pane:{}}}:{...base,metadata:{...base.metadata,id}},reap:async id=>calls.push(id)};
 await reapExpiredRetrieved(manager,store,200+OUTPUT_RETENTION_MS-1); assert.deepEqual(calls,[]);
 await reapExpiredRetrieved(manager,store,200+OUTPUT_RETENTION_MS); assert.deepEqual(calls,['owned']);
});

test('wait-provided output schedules retrieval, status-only completion does not', async()=>{
 let at; const store={markRetrieved:async(_id,t)=>at=t}; const owned={result:{},launch:{},metadata:{id:'x'}};
 await retrieveAndSchedule(owned,store,500); assert.equal(at,500);
});
