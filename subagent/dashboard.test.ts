import assert from 'node:assert/strict';
import { registerTaskDashboard, readableTaskReport } from './dashboard.js';
import { taskLabel, taskListText, watchDeliveryCursors, watchResultText } from '../shared/task-presentation.js';

assert.equal(taskLabel({state:'idle',outcome:'partial'}),'Needs continuation');
assert.equal(taskLabel({state:'running',outcome:'delivered'}),'Working');
assert.equal(taskLabel({state:'idle',outcome:'delivered'}),'Reported delivered');
assert.equal(taskLabel({state:'idle',execution:'aborted'}),'Cancelled');
const taskId='subagent-task-111111111111111111111111';
const watchId='watch-222222222222222222222222';
assert(!taskListText([{task_id:taskId,title:'Task',attempt:1,state:'idle',outcome:'partial'}],false).includes(taskId));
assert.equal(watchDeliveryCursors([
 {type:'custom_message',customType:'background-job-watch',details:{watch_id:watchId,through_sequence:2}},
 {type:'custom_message',customType:'background-job-watch',details:{watch_id:watchId,through_sequence:5}},
]).get(watchId),5);
assert.match(watchResultText('unwatch',{watch_id:watchId}),/NOT been cancelled/);
assert.match(readableTaskReport('Task outcome (model-reported): {"state":"partial","summary":"Still needs work","acceptance":[],"remaining":["test"],"next_action":"run tests"}\nRPC diagnostics: {"rawExit":{"code":0}}'),/Remaining: test/);

const commands=new Map<string,any>();const messages:any[]=[];const requests:any[]=[];
const task:any={task_id:taskId,title:'Fix timing',attempt:1,state:'idle',outcome:'partial',can_resume:true,next_action:'Verify output'};
let watching=true;let resumed=0;let shown=0;
const decisions=[
 'first','Review alerts','first','View unread alerts','Acknowledge displayed alerts through #2',
 'Stop watching — keep build running','Stop watching',undefined,'Resume saved task','Resume saved task',
 'Open build output','first','Close',
];
const oldBridge=(globalThis as any).__piPaseoRemoteUiV1;
(globalThis as any).__piPaseoRemoteUiV1={isConnected:()=>true,async selectMirrored(_title:string,options:string[]){
 const choice=decisions.shift();shown++;
 if(choice==='first')return options[0];
 if(choice!==undefined)assert(options.includes(choice),`missing action ${choice}`);
 return choice;
}};
const pi:any={registerCommand(name:string,value:any){commands.set(name,value);},sendMessage(message:any,options:any){messages.push({message,options});}};
const ctx:any={hasUI:true,mode:'tui',isIdle:()=>true,ui:{select(){throw new Error('remote user was stranded in terminal UI');},editor(){throw new Error('remote user was stranded in terminal editor');},notify(){}}};
registerTaskDashboard(pi,{
 async list(){return [task];},async record(){return {spec:{cwd:'/workspace'},childId:'child',attempt:task.attempt,history:[]};},async report(){return 'report';},
 async resume(){resumed++;task.attempt++;task.state='running';task.can_resume=false;return {};},
 async jobs(_ctx,id,params){
  assert.equal(id,taskId);requests.push(params);
  if(params.action==='watches')return {details:{watches:[{watch_id:watchId,status:watching?'running':'stopped',label:'build.log'}]}};
  if(params.action==='events')return {details:{watch_id:watchId,log_path:'build.log',next_sequence:2,events:[{sequence:1,kind:'match',text:'stage one'},{sequence:2,kind:'match',text:'stage two'}]}};
  if(params.action==='ack'){assert.equal(params.through_sequence,2);return {};}
  if(params.action==='unwatch'){watching=false;return {};}
  if(params.action==='list')return {details:{jobs:[{job_id:'job',name:'Synthesis',status:'running'}]}};
  if(params.action==='output')return {content:[{type:'text',text:'build output'}]};
  throw new Error(`Unexpected/destructive action ${params.action}`);
 }
});
try {
 await commands.get('tasks').handler('',ctx);
 assert.equal(resumed,1);assert.equal(watching,false);assert.equal(decisions.length,0);assert(shown>10);
 assert(requests.every(r=>!['start','cancel','signal'].includes(r.action)));
 assert(messages.every(m=>m.options.triggerTurn===false));
 assert(messages.some(m=>m.message.content.includes('build is still running')));
 console.log('task dashboard UX checks passed');
} finally {(globalThis as any).__piPaseoRemoteUiV1=oldBridge;}
