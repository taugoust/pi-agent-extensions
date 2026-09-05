import { constants, openSync, closeSync, readSync, writeFileSync, renameSync } from 'node:fs';
export type TaskOutcomeState='delivered'|'partial'|'blocked'|'checkpointed';
export type TaskOutcome={version:1;state:TaskOutcomeState;summary:string;acceptance:Array<{criterion:string;status:'passed'|'failed'|'not_run';evidence?:string}>;artifacts:Array<{path:string;sha256?:string}>;remaining:string[];next_action?:string};
export type TaskOutcomeSummary={child:number;child_id?:string;state:TaskOutcomeState|'unreported';reported:boolean;summary:string;next_action?:string};
function str(v:any,n:number,label:string){if(typeof v!=='string'||!v.trim()||v.includes('\0')||Buffer.byteLength(v)>n)throw new Error(`Invalid ${label}`);return v;}
export function validateAcceptance(value:unknown):string[]{if(value===undefined)return [];if(!Array.isArray(value)||value.length>16)throw new Error('acceptance must contain at most 16 criteria');return value.map(v=>str(v,500,'acceptance criterion'));}
export function validateTaskOutcome(v:any, expected:string[]=[]):TaskOutcome {
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['version','state','summary','acceptance','artifacts','remaining','next_action'].includes(k)))throw new Error('Invalid task outcome fields');
 if(v.version!==1||!['delivered','partial','blocked','checkpointed'].includes(v.state))throw new Error('Invalid task outcome state/version');
 str(v.summary,2000,'outcome summary');
 if(!Array.isArray(v.acceptance)||v.acceptance.length>16||!Array.isArray(v.artifacts)||v.artifacts.length>16||!Array.isArray(v.remaining)||v.remaining.length>16)throw new Error('Invalid task outcome arrays');
 for(const a of v.acceptance){if(!a||Object.keys(a).some(k=>!['criterion','status','evidence'].includes(k)))throw new Error('Invalid acceptance entry');str(a.criterion,500,'criterion');if(!['passed','failed','not_run'].includes(a.status))throw new Error('Invalid validation status');if(a.evidence!==undefined)str(a.evidence,1000,'evidence');}
 if(new Set(v.acceptance.map((a:any)=>a.criterion)).size!==v.acceptance.length)throw new Error('Duplicate acceptance criteria');
 for(const a of v.artifacts){if(!a||Object.keys(a).some(k=>!['path','sha256'].includes(k)))throw new Error('Invalid artifact');str(a.path,4096,'artifact reference');if(a.sha256!==undefined&&!/^[a-f0-9]{64}$/.test(a.sha256))throw new Error('Invalid artifact hash');}
 v.remaining.forEach((x:any)=>str(x,500,'remaining work'));if(v.next_action!==undefined)str(v.next_action,2000,'next action');
 if(v.state==='delivered'&&(!v.acceptance.length||v.remaining.length||v.acceptance.some((a:any)=>a.status!=='passed'||!a.evidence)||expected.some(c=>!v.acceptance.some((a:any)=>a.criterion===c&&a.status==='passed'))))throw new Error('delivered requires evidence for all acceptance criteria and no remaining work');
 if(['partial','blocked','checkpointed'].includes(v.state)&&!v.next_action)throw new Error('Incomplete outcomes require next_action');
 if(Buffer.byteLength(JSON.stringify(v))>16384)throw new Error('Outcome exceeds 16 KiB');
 return JSON.parse(JSON.stringify(v));
}
export function readTaskOutcome(file:string,expected:string[]=[]):TaskOutcome|undefined {
 let fd:number;try{fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(e){if((e as any).code==='ENOENT')return;throw e;}
 try{const data=Buffer.alloc(16385);const n=readSync(fd,data,0,data.length,0);if(n>16384)throw new Error('Outcome exceeds 16 KiB');return validateTaskOutcome(JSON.parse(data.subarray(0,n).toString('utf8')),expected);}finally{closeSync(fd);}
}
export function writeTaskOutcome(file:string,value:unknown):TaskOutcome {const outcome=validateTaskOutcome(value);const tmp=`${file}.${process.pid}.tmp`;writeFileSync(tmp,JSON.stringify(outcome),{mode:0o600,flag:'wx'});renameSync(tmp,file);return outcome;}
export function outcomeSummary(child:number,childId:string|undefined,outcome?:TaskOutcome,error?:string):TaskOutcomeSummary {
 return {child,child_id:childId,state:outcome?.state??'unreported',reported:Boolean(outcome),summary:(outcome?.summary??error??'No structured task outcome was reported. Execution success is not proof of delivery.').slice(0,1000),next_action:outcome?.next_action?.slice(0,1000)};
}
export function validateOutcomeSummaries(value:any):TaskOutcomeSummary[] {
 if(!Array.isArray(value)||value.length>8||new Set(value.map(v=>v?.child)).size!==value.length)throw new Error('Invalid task outcome summaries');
 return value.map(v=>{if(!v||!Number.isInteger(v.child)||v.child<1||v.child>8||!['delivered','partial','blocked','checkpointed','unreported'].includes(v.state)||typeof v.reported!=='boolean')throw new Error('Invalid task outcome summary');str(v.summary,4096,'summary');if(v.child_id!==undefined&&!/^subagent-child-[0-9a-f]{24}$/.test(v.child_id))throw new Error('Invalid outcome child identity');if(v.next_action!==undefined)str(v.next_action,4096,'next action');if(v.reported!==(v.state!=='unreported'))throw new Error('Invalid reported outcome flag');return {child:v.child,child_id:v.child_id,state:v.state,reported:v.reported,summary:v.summary,next_action:v.next_action};});
}
