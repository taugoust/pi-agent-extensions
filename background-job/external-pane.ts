import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { processStartToken, stripTmuxExitFooter } from './tmux.js';
const exec=promisify(execFile);
export type PaneIdentity={socket:string;serverPid:number;serverToken:string;paneId:string;panePid:number;paneToken?:string;created:string;controlToken?:string};
export type PaneObservation={identity:PaneIdentity;dead:boolean;exitCode?:number;cwd:string;owner?:string;piPid?:number};
export class PaneGoneError extends Error {}
export function validatePaneIdentity(v:any):PaneIdentity {
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['socket','serverPid','serverToken','paneId','panePid','paneToken','created','controlToken'].includes(k)))throw new Error('Invalid tmux identity fields');
  for(const k of ['serverPid','panePid'])if(!Number.isSafeInteger(v[k])||v[k]<1)throw new Error('Invalid tmux process identity');
  if(typeof v.socket!=='string'||!isAbsolute(v.socket)||v.socket.includes('\0')||Buffer.byteLength(v.socket)>4096||!/^%[0-9]+$/.test(v.paneId))throw new Error('Invalid tmux socket/pane identity');
  for(const k of ['serverToken','created'])if(typeof v[k]!=='string'||v[k].length>256||(k==='serverToken'&&!v[k]))throw new Error('Invalid tmux identity token');
  if(v.paneToken!==undefined&&(typeof v.paneToken!=='string'||!v.paneToken||v.paneToken.length>256))throw new Error('Invalid pane process token');
  if(v.controlToken!==undefined&&!/^[a-f0-9]{32}$/.test(v.controlToken))throw new Error('Invalid pane management token');
  return {...v};
}
async function run(tmux:string,args:string[],socket?:string):Promise<string>{
  try {
    const result=await exec(tmux,[...(socket?['-S',socket]:[]),...args],{timeout:5000,maxBuffer:256*1024,env:{...process.env,TMUX:socket?undefined:process.env.TMUX,TMUX_PANE:undefined} as NodeJS.ProcessEnv});
    return result.stdout;
  } catch(error) {
    const e=error as any;const message=String(e.stderr||e.message).slice(0,800);
    if(/can't find pane|no server running|no sessions|error connecting .*No such file/i.test(message))throw new PaneGoneError(message);
    throw new Error(`Could not inspect tmux: ${message}`);
  }
}
export async function inspectPane(tmux:string,paneId:string,socket?:string):Promise<PaneObservation>{
  if(!/^%[0-9]+$/.test(paneId))throw new Error('pane_id must be an exact %number, not a tmux command or target expression');
  const supplied=socket??(await run(tmux,['display-message','-p','#{socket_path}'])).trim();
  if(!isAbsolute(supplied)||supplied.includes('\0')||Buffer.byteLength(supplied)>4096)throw new Error('Invalid tmux_socket');
  let canonical:string;
  try {canonical=await realpath(supplied);}catch(error){if((error as any).code==='ENOENT')throw new PaneGoneError('Saved tmux socket no longer exists');throw error;}
  const info=await lstat(canonical);
  if(!info.isSocket()||info.uid!==process.getuid?.())throw new Error('tmux_socket must be a same-user Unix socket');
  const format='#{pid}\t#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{pane_dead_status}\t#{pane_created}\t#{pane_current_path}\t#{@pi_managed_job_token}\t#{@pi_managed_job_owner}\t#{@paseo_pi_agent_pid}';
  const fields=(await run(tmux,['display-message','-p','-t',paneId,format],canonical)).replace(/\n$/,'').split('\t');
  if(fields.every(field=>!field))throw new PaneGoneError('Tmux pane no longer exists');
  if(fields.length!==10||fields[1]!==paneId||!['0','1'].includes(fields[3]))throw new Error('Malformed tmux pane response');
  const serverPid=Number(fields[0]),panePid=Number(fields[2]);
  if(!Number.isSafeInteger(serverPid)||serverPid<1||!Number.isSafeInteger(panePid)||panePid<1)throw new Error('Invalid tmux process IDs');
  if(process.platform==='linux'&&(await lstat(`/proc/${serverPid}`)).uid!==process.getuid?.())throw new Error('Tmux server belongs to another user');
  const dead=fields[3]==='1';
  const identity:PaneIdentity={socket:canonical,serverPid,serverToken:await processStartToken(serverPid),paneId,panePid,created:fields[5],...(fields[7]?{controlToken:fields[7]}:{}),...(dead?{}:{paneToken:await processStartToken(panePid)})};
  return {identity:validatePaneIdentity(identity),dead,cwd:fields[6],owner:fields[8]||undefined,piPid:/^[0-9]+$/.test(fields[9])?Number(fields[9]):undefined,...(dead&&/^[0-9]+$/.test(fields[4])?{exitCode:Number(fields[4])}:{})};
}
export function requireSamePane(expected:PaneIdentity,actual:PaneObservation):void {
  validatePaneIdentity(expected);
  const got=actual.identity;
  if(['socket','serverPid','serverToken','paneId','panePid','created'].some(k=>(expected as any)[k]!== (got as any)[k])||(!actual.dead&&expected.paneToken!==undefined&&expected.paneToken!==got.paneToken)||(expected.controlToken!==undefined&&expected.controlToken!==got.controlToken)) {
    throw new PaneGoneError('Saved tmux server/pane identity changed; refusing to target replacement work.');
  }
}
export async function capturePane(tmux:string,identity:PaneIdentity):Promise<string>{
  const before=await inspectPane(tmux,identity.paneId,identity.socket);requireSamePane(identity,before);
  const output=await run(tmux,['capture-pane','-p','-J','-S','-2000','-t',identity.paneId],identity.socket);
  requireSamePane(identity,await inspectPane(tmux,identity.paneId,identity.socket));
  return before.dead?stripTmuxExitFooter(output):output;
}
export async function requireAvailablePane(pane:PaneObservation):Promise<void>{
  if(pane.piPid){try{await processStartToken(pane.piPid);throw new Error('Cannot adopt a pane hosting a live Pi controller');}catch(error){if(String(error).includes('live Pi controller'))throw error;}}
  if(pane.owner){
    const match=/^([0-9]+):([a-f0-9]{64})$/.exec(pane.owner);
    if(!match)throw new Error('Pane has an unrecognized management owner');
    let current:string|undefined;try{current=await processStartToken(Number(match[1]));}catch{}
    if(Number(match[1])!==process.pid&&current&&createHash('sha256').update(current).digest('hex')===match[2])throw new Error('Pane is managed by another live Pi process; it was not interrupted');
  }else if(pane.identity.controlToken)throw new Error('Pane management metadata is incomplete');
}
async function guardedPaneCommand(tmux:string,id:PaneIdentity,command:string):Promise<void>{
  const eq=(name:string,value:string|number)=>`#{==:#{${name}},${value}}`;
  const and=(left:string,right:string)=>`#{&&:${left},${right}}`;
  const guard=and(eq('pid',id.serverPid),and(eq('pane_pid',id.panePid),eq('@pi_managed_job_token',id.controlToken??'')));
  const output=await run(tmux,['if-shell','-F','-t',id.paneId,guard,command,'display-message -p pi-job-identity-mismatch'],id.socket);
  if(output.includes('pi-job-identity-mismatch'))throw new PaneGoneError('Pane management identity changed; command was not sent');
}
export async function claimPane(tmux:string,pane:PaneObservation,controlToken:string):Promise<PaneIdentity>{
  if(!/^[a-f0-9]{32}$/.test(controlToken))throw new Error('Invalid pane claim token');
  const owner=`${process.pid}:${createHash('sha256').update(await processStartToken(process.pid)).digest('hex')}`;
  await guardedPaneCommand(tmux,pane.identity,`set-option -p -t ${pane.identity.paneId} @pi_managed_job_owner ${owner} ; set-option -p -t ${pane.identity.paneId} @pi_managed_job_token ${controlToken}`);
  const claimed={...pane.identity,controlToken};
  requireSamePane(claimed,await inspectPane(tmux,claimed.paneId,claimed.socket));
  return claimed;
}
export async function cancelPane(tmux:string,id:PaneIdentity):Promise<void>{
  if(!id.controlToken)throw new Error('Pane has no management claim');
  requireSamePane(id,await inspectPane(tmux,id.paneId,id.socket));
  await guardedPaneCommand(tmux,id,`kill-pane -t ${id.paneId}`);
}
export async function signalPane(tmux:string,id:PaneIdentity,signal:'SIGINT'|'SIGTERM'):Promise<void>{
  const pane=await inspectPane(tmux,id.paneId,id.socket);requireSamePane(id,pane);
  if(pane.dead)throw new Error('Pane has already finished');
  if(signal==='SIGINT')await guardedPaneCommand(tmux,id,`send-keys -t ${id.paneId} C-c`);
  else {if(!id.paneToken||await processStartToken(id.panePid)!==id.paneToken)throw new Error('Pane root process identity changed');process.kill(id.panePid,'SIGTERM');}
}

