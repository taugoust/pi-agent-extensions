import { randomBytes, randomUUID } from 'node:crypto';
import { constants, mkdirSync, lstatSync, openSync, readSync, closeSync, writeFileSync, renameSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';

export const TASK_ID_PATTERN=/^subagent-task-[0-9a-f]{24}$/;
export const createTaskId=()=>`subagent-task-${randomBytes(12).toString('hex')}`;
export type NativeTaskSpec={task:string;cwd:string;model?:string;tools?:string[];systemPrompt?:string;acceptance?:string[]};
export type NativeTaskRecord={version:1;taskId:string;ownerSessionId:string;sessionId:string;spec:NativeTaskSpec;state:'running'|'idle';attempt:number;childId:string;ownerPid:number;ownerToken:string;childPid?:number;childToken?:string;createdAt:string;updatedAt:string;contextTokens?:number;contextWindow?:number;checkpointed?:boolean;requiresCompaction?:boolean;nextAction?:string;recoveryAfter?:number;history:Array<{attempt:number;childId:string;finishedAt:string;outcome?:string}>};
function token(pid:number):string|undefined {
 try {
  if(process.platform==='linux'){const s=readFileSync(`/proc/${pid}/stat`,'utf8');return s.slice(s.lastIndexOf(')')+2).split(' ')[19];}
  return execFileSync('ps',['-o','lstart=','-p',String(pid)],{encoding:'utf8',timeout:2000,stdio:['ignore','pipe','ignore']}).trim()||undefined;
 } catch{return undefined;}
}
function boundedJson(file:string,max=128*1024):any {
 const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try {const info=lstatSync(file);if(!info.isFile()||info.uid!==process.getuid?.())throw new Error('Invalid task state ownership');const b=Buffer.alloc(max+1);const n=readSync(fd,b,0,b.length,0);if(n>max)throw new Error('Task state is oversized');return JSON.parse(b.subarray(0,n).toString('utf8'));}finally{closeSync(fd);}
}
function validateSpec(s:NativeTaskSpec){
 if(!s||typeof s.task!=='string'||!s.task.trim()||Buffer.byteLength(s.task)>32768||typeof s.cwd!=='string'||!isAbsolute(s.cwd)||s.cwd.includes('\0')||s.cwd.length>4096)throw new Error('Invalid task specification');
 if(s.model!==undefined&&(typeof s.model!=='string'||!s.model||s.model.length>256))throw new Error('Invalid retained model');
 if(s.tools!==undefined&&(!Array.isArray(s.tools)||s.tools.length>32||s.tools.some(t=>typeof t!=='string'||!/^[-a-zA-Z0-9_.]{1,64}$/.test(t))))throw new Error('Invalid retained tools');
 if(s.systemPrompt!==undefined&&(typeof s.systemPrompt!=='string'||Buffer.byteLength(s.systemPrompt)>32768))throw new Error('Invalid retained system prompt');
 if(s.acceptance!==undefined&&(!Array.isArray(s.acceptance)||s.acceptance.length>16||s.acceptance.some(c=>typeof c!=='string'||!c||Buffer.byteLength(c)>500)))throw new Error('Invalid retained acceptance criteria');
}
export class NativeTaskStore {
 readonly root:string;
 constructor(root:string){this.root=resolve(root);mkdirSync(this.root,{recursive:true,mode:0o700});const s=lstatSync(this.root);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077))throw new Error('Native task root must be a private owned directory');}
 private dir(id:string){if(!TASK_ID_PATTERN.test(id))throw new Error('Invalid task_id');return join(this.root,id);}
 sessionPath(id:string){return join(this.dir(id),'session.jsonl');}
 private save(r:NativeTaskRecord){const text=JSON.stringify(r);if(Buffer.byteLength(text)>128*1024)throw new Error('Native task state exceeds 128 KiB');const file=join(this.dir(r.taskId),'state.json');writeFileSync(file+'.tmp',text,{mode:0o600});renameSync(file+'.tmp',file);}
 private async lock<T>(id:string,fn:()=>T):Promise<T>{
  const file=join(this.dir(id),'.lock');const deadline=Date.now()+5000;
  for(;;){try{writeFileSync(file,JSON.stringify({pid:process.pid,token:token(process.pid)}),{flag:'wx',mode:0o600});break;}catch(e){if((e as any).code!=='EEXIST')throw e;try{const holder=boundedJson(file,4096);if(token(holder.pid)!==holder.token){rmSync(file);continue;}}catch{}if(Date.now()>deadline)throw new Error('Native task is locked');await new Promise(resolve=>setTimeout(resolve,20));}}
  try{return fn();}finally{rmSync(file,{force:true});}
 }
 get(owner:string,id:string):NativeTaskRecord {
  const r=boundedJson(join(this.dir(id),'state.json')) as NativeTaskRecord;
  if(r.version!==1||r.taskId!==id||r.ownerSessionId!==owner)throw new Error('Task belongs to another parent session or has invalid state');
  if(!['running','idle'].includes(r.state)||!Number.isSafeInteger(r.attempt)||r.attempt<1||!/^subagent-child-[0-9a-f]{24}$/.test(r.childId)||typeof r.spec?.task!=='string'||typeof r.spec?.cwd!=='string'||!Array.isArray(r.history)||r.history.length>32)throw new Error('Invalid native task record');
  validateSpec(r.spec);
  if(!Number.isSafeInteger(r.ownerPid)||r.ownerPid<1||typeof r.ownerToken!=='string'||!r.ownerToken||typeof r.sessionId!=='string'||!/^[a-f0-9-]{36}$/.test(r.sessionId))throw new Error('Invalid task process/session identity');
  return r;
 }
 list(owner:string,limit=50){
  if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw new Error('Invalid task list limit');
  return readdirSync(this.root).filter(id=>TASK_ID_PATTERN.test(id)).flatMap(id=>{try{const r=this.get(owner,id);return [{task_id:id,child_id:r.childId,attempt:r.attempt,state:r.state==='running'&&token(r.ownerPid)!==r.ownerToken?'interrupted':r.state,checkpointed:r.checkpointed??false,requires_compaction:r.requiresCompaction??false,next_action:r.nextAction,updated_at:r.updatedAt}];}catch{return [];}}).sort((a,b)=>b.updated_at.localeCompare(a.updated_at)).slice(0,limit);
 }
 async create(owner:string,id:string,spec:NativeTaskSpec,childId:string):Promise<NativeTaskRecord>{
  if(!owner||Buffer.byteLength(owner)>512||!/^subagent-child-[0-9a-f]{24}$/.test(childId)||!spec.task.trim()||Buffer.byteLength(JSON.stringify(spec))>96*1024)throw new Error('Invalid retained task specification');
  validateSpec(spec);
  mkdirSync(this.dir(id),{mode:0o700});
  const now=new Date().toISOString();const r:NativeTaskRecord={version:1,taskId:id,ownerSessionId:owner,sessionId:randomUUID(),spec:JSON.parse(JSON.stringify(spec)),state:'running',attempt:1,childId,ownerPid:process.pid,ownerToken:token(process.pid)??'',createdAt:now,updatedAt:now,history:[]};
  writeFileSync(this.sessionPath(id),JSON.stringify({type:'session',version:3,id:r.sessionId,timestamp:now,cwd:spec.cwd})+'\n',{flag:'wx',mode:0o600});this.save(r);return r;
 }
 private verifySession(r:NativeTaskRecord){
  const file=this.sessionPath(r.taskId);const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const b=Buffer.alloc(8192);const n=readSync(fd,b,0,b.length,0);const line=b.subarray(0,n).toString('utf8').split('\n')[0];const h=JSON.parse(line);if(h.type!=='session'||h.id!==r.sessionId||h.cwd!==r.spec.cwd)throw new Error('Retained session header does not belong to this task');}finally{closeSync(fd);}
 }
 async beginResume(owner:string,id:string,childId:string):Promise<NativeTaskRecord>{
  if(!/^subagent-child-[0-9a-f]{24}$/.test(childId))throw new Error('Invalid successor child identity');
  return await this.lock(id,()=>{
   const r=this.get(owner,id);this.verifySession(r);
   if(r.childPid && (!r.childToken || token(r.childPid)===r.childToken)) {
    try { process.kill(r.childPid,0); throw new Error('Previous child process is still alive; resume refused'); }
    catch(error) { if((error as any).code!=='ESRCH') throw error; }
   }
   if(r.state==='running'){
    if(token(r.ownerPid)===r.ownerToken)throw new Error('Task is still running; resume never starts a concurrent writer');
    // Allow the dead parent's process-group anchor to finish cleanup before
    // recovery when the parent died during the spawn/identity-write window.
    if(!r.recoveryAfter){r.recoveryAfter=Date.now()+10000;this.save(r);throw new Error('Prior owner exited; retry resume after the 10-second cleanup grace');}
    if(Date.now()<r.recoveryAfter)throw new Error('Prior owner cleanup grace has not elapsed');
   }
   r.attempt++;r.childId=childId;r.state='running';r.ownerPid=process.pid;r.ownerToken=token(process.pid)??'';r.updatedAt=new Date().toISOString();delete r.childPid;delete r.childToken;delete r.recoveryAfter;this.save(r);return r;
  });
 }
 async bindChild(owner:string,id:string,childId:string,pid:number){await this.lock(id,()=>{const r=this.get(owner,id);if(r.state!=='running'||r.childId!==childId)throw new Error('Task attempt ownership changed');r.childPid=pid;r.childToken=token(pid);this.save(r);});}
 async finish(owner:string,id:string,childId:string,info:{outcome?:string;contextTokens?:number;contextWindow?:number;nextAction?:string}={}){
  await this.lock(id,()=>{const r=this.get(owner,id);if(r.childId!==childId)return;r.state='idle';r.updatedAt=new Date().toISOString();
   if(Number.isSafeInteger(info.contextTokens)&&info.contextTokens!>=0)r.contextTokens=info.contextTokens;if(info.contextWindow)r.contextWindow=info.contextWindow;
   r.requiresCompaction=Boolean(r.contextWindow&&r.contextTokens!>=r.contextWindow*.8);r.checkpointed=info.outcome==='checkpointed'||r.requiresCompaction;r.nextAction=info.nextAction?.slice(0,2000);
   r.history.push({attempt:r.attempt,childId,finishedAt:r.updatedAt,outcome:info.outcome});r.history=r.history.slice(-32);this.save(r);
  });
 }
}
