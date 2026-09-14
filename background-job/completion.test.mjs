import assert from 'node:assert/strict';
import backgroundJob from './index.js';
import { BackgroundJobManager } from './manager.js';
import { JobStore } from './store.js';
import { WatchManager } from './watch.js';

// Exercise the actual producer and tool consumption path without starting processes.
const pause = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
let records = [], notified = new Set(), poll, deferNotified;
JobStore.prototype.initialize = async () => {};
JobStore.prototype.isNotified = async function(id) {
  const value = notified.has(id);
  if (deferNotified) { const wait = deferNotified; deferNotified = undefined; await wait; }
  return value;
};
JobStore.prototype.markNotified = async id => { notified.add(id); return true; };
BackgroundJobManager.prototype.list = async () => records;
BackgroundJobManager.prototype.get = async id => records.find(r => r.metadata.id === id);
BackgroundJobManager.prototype.output = async () => ({text:'verified output',source:'log',truncated:false});
BackgroundJobManager.prototype.wait = async () => ({timedOut:false});
BackgroundJobManager.prototype.cancel = async function(id) { return this.get(id); };
BackgroundJobManager.prototype.reap = async id => { records = records.filter(r => r.metadata.id !== id); };
WatchManager.prototype.recover = async () => {};
WatchManager.prototype.list = async () => [{watch_id:'watch-fixture'}];
WatchManager.prototype.events = async () => ({events:[{}],status:'completed',next_sequence:1,sequence:1,acknowledged_through:0});
const originalInterval = globalThis.setInterval;
globalThis.setInterval = callback => { poll = callback; return {unref(){}}; };
const originalClearInterval = globalThis.clearInterval;
globalThis.clearInterval = () => {};
let entries = [], idle = true, queued = false, session = 'completion-owner';
const ctx = {cwd:process.cwd(),hasUI:false,isIdle:()=>idle,hasPendingMessages:()=>queued,
  sessionManager:{getSessionId:()=>session,getBranch:()=>entries}};
function harness(failSends = 0) {
  const handlers = new Map(), messages = []; let tool;
  backgroundJob({
    registerTool(value){tool=value;},registerCommand(){},
    on(name,handler){handlers.set(name,[...(handlers.get(name)??[]),handler]);},
    appendEntry(customType,data){entries.push({type:'custom',customType,data});},
    sendMessage(message,options){if(failSends-->0)throw Error('send failed');messages.push({message,options});entries.push({type:'custom_message',...message});},
  });
  return {messages,call:params=>tool.execute('test',params,undefined,undefined,ctx),
    async emit(name,event={}){for(const handler of handlers.get(name)??[])await handler(event,ctx);}};
}
let counter = 0;
function record(status='completed', extra={}) {
  return {status,metadata:{id:`job-${(++counter).toString(16).padStart(24,'0')}`,sessionId:session,createdAt:new Date().toISOString(),command:':',cwd:ctx.cwd,...extra},
    result: status==='running'?undefined:{status,exitCode:status==='completed'?0:null}};
}
try {
  let h = harness(); await h.emit('session_start'); await pause();
  records = ['completed','failed','cancelled','lost'].map(status=>record(status));
  records.push(record('failed',{infrastructure:true}),record('completed',{sessionId:'foreign'}),record('running'));
  poll(); await pause(1150);
  assert.equal(h.messages.length,1);
  assert.deepEqual(h.messages[0].options,{deliverAs:'followUp',triggerTurn:true});
  assert.deepEqual(h.messages[0].message.details.updates.map(u=>u.state),['completed','failed','cancelled','lost']);
  assert.match(h.messages[0].message.content,/background_job action=status and action=output/);
  assert.doesNotMatch(h.messages[0].message.content,/subagent operation=result/);
  poll(); await pause(1150); assert.equal(h.messages.length,1,'repeated polling replayed completion');
  idle=false; records.push(record()); poll(); await pause(1150);
  assert.deepEqual(h.messages[1].options,{deliverAs:'steer',triggerTurn:true});
  // Each existing consuming tool must remove a queued completion before it wakes.
  for(const action of ['status','output','wait','cancel','list','reap']) {
    const r=record(); records.push(r); poll(); await pause();
    await h.call(action==='list'?{action,limit:50}:{action,job_id:r.metadata.id});
    await pause(1100); assert.equal(h.messages.length,2,`${action} left a delayed wake`);
  }
  // Poll's async notified read began before a tool persisted consumption.
  const raced=record(); records.push(raced);
  let release; deferNotified=new Promise(resolve=>{release=resolve;});
  // Isolate the target so it is the first awaited notification check.
  records=[raced]; poll(); await pause();
  await h.call({action:'status',job_id:raced.metadata.id}); release(); await pause(1150);
  assert.equal(h.messages.length,2,'late notified snapshot bypassed consumption tombstone');
  // Reading a running job is not terminal consumption and must not suppress its finish.
  const running=record('running'); records=[running];
  await h.call({action:'status',job_id:running.metadata.id});
  running.status='completed'; running.result={status:'completed',exitCode:0};
  poll(); await pause(1150); assert.equal(h.messages.length,3,'running status suppressed completion');
  records.push(raced);
  await h.emit('session_shutdown',{reason:'reload'});
  h=harness(); await h.emit('session_start'); await pause(1150);
  assert.equal(h.messages.length,0,'consumed completion replayed on reload');
  // Queued delivery retries survive reload; successful delivery deduplicates thereafter.
  await h.emit('session_shutdown',{reason:'reload'});
  records=[record()]; h=harness(1); await h.emit('session_start'); await pause(1150);
  assert.equal(h.messages.length,0);
  await h.emit('session_shutdown',{reason:'reload'});
  h=harness(); await h.emit('session_start'); await pause(1150);
  assert.equal(h.messages.length,1,'failed send lost on reload');
  await h.emit('session_shutdown',{reason:'reload'});
  h=harness(); await h.emit('session_start'); await pause(1150);
  assert.equal(h.messages.length,0,'delivered completion replayed on reload');
  await h.emit('session_shutdown',{reason:'quit'});
  console.log('background-job completion producer tests passed');
} finally {
  globalThis.setInterval=originalInterval; globalThis.clearInterval=originalClearInterval;
}
