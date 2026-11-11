import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const MAX_EVENTS = 128;
export function readWatch(file) {
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try { const s=fs.fstatSync(fd); if(!s.isFile()||s.uid!==process.getuid?.()||s.size>128*1024) throw new Error('Invalid watch record'); return JSON.parse(fs.readFileSync(fd,'utf8')); }
  finally { fs.closeSync(fd); }
}
export function saveWatch(file,value) {
  const data=JSON.stringify(value); if(Buffer.byteLength(data)>128*1024) throw new Error('Watch record bound exceeded');
  const tmp=file+'.'+process.pid+'.tmp'; fs.writeFileSync(tmp,data,{mode:0o600});fs.renameSync(tmp,file);
}
export function scanWatch(file, now=Date.now()) {
  const w=readWatch(file); if(w.version!==1||w.status!=='running') return w;
  const emit=(kind,detail={})=>{
    w.sequence++;w.events.push({sequence:w.sequence,time:new Date(now).toISOString(),kind,...detail});
    while(w.events.length>MAX_EVENTS){w.droppedThrough=w.events.shift().sequence;}
  };
  if(fs.existsSync(file+'.stop')){w.status='stopped';emit('stopped');saveWatch(file,w);return w;}
  if(w.deadline && now>=w.deadline){w.status='expired';emit('expired');saveWatch(file,w);return w;}
  if(w.nextPoll && now<w.nextPoll) return w;
  w.nextPoll=now+w.pollMs;
  try {
    const fd=openLog(w);
    if(fd!==undefined) try {
      const s=fs.fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid?.())throw new Error('Watched path is no longer a same-user regular file');
      // Job logs are rewritten as a bounded tail; w.offset counts the job's
      // whole output and `start` is where this copy of the tail begins.
      let start=0;
      if(w.jobOutput){
        const position=readJobOutputPosition(w.jobOutput.position,s);
        if(!position)return finish(w,file,emit);
        start=position.start;
        if(w.offset<start){emit('dropped',{bytes:start-w.offset});w.offset=start;w.pending='';}
      } else if(s.dev!==w.device||s.ino!==w.inode||s.size<w.offset){emit(s.ino!==w.inode||s.dev!==w.device?'rotated':'truncated');w.offset=0;w.pending='';w.device=s.dev;w.inode=s.ino;}
      const bytes=Buffer.alloc(Math.min(65536,Math.max(0,start+s.size-w.offset)));
      const n=fs.readSync(fd,bytes,0,bytes.length,w.offset-start);w.offset+=n;
      const data=Buffer.concat([Buffer.from(w.pending||'','base64'),bytes.subarray(0,n)]);
      let begin=0;
      for(let i=0;i<data.length;i++)if(data[i]===10){
        const line=data.subarray(begin,i).toString('utf8').replace(/\r$/,'');
        for(const rule of w.patterns)if(line.includes(rule.match))emit('match',{rule:rule.name,offset:w.offset-(data.length-i-1),text:line.slice(0,512)});
        if(i-begin>4096)emit('line-truncated',{offset:w.offset-(data.length-i-1)});
        begin=i+1;
      }
      const pending=data.subarray(begin);
      if(pending.length>4096){if(!w.longLine)emit('line-truncated',{offset:w.offset});w.longLine=true;w.pending=pending.subarray(pending.length-4096).toString('base64');}
      else{w.pending=pending.toString('base64');w.longLine=false;}
    } finally {fs.closeSync(fd);}
    if(w.lastError){emit('recovered');delete w.lastError;}
  } catch(error){
    const message=String(error.message).slice(0,256);
    if(w.lastError!==message){w.lastError=message;emit('read-error',{text:message});}
  }
  return finish(w,file,emit);
}
function finish(w,file,emit){
  if(w.resultPath && fs.existsSync(w.resultPath)) {
    try{const r=readWatch(w.resultPath);if(['completed','failed','cancelled','lost'].includes(r.status)){emit('terminal',{status:r.status,exit_code:r.exitCode??null});w.status='completed';}}catch{}
  }
  saveWatch(file,w);return w;
}
/** Open the watched log; a job that has not created its log yet has no output. */
function openLog(w){
  try{return fs.openSync(w.path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);}
  catch(error){if(w.jobOutput&&error.code==='ENOENT')return undefined;throw error;}
}
/**
 * Position of an open job log within the job's whole output, or undefined
 * while the runner is between rewriting the log and publishing its position.
 * Runners without a position file never drop output before their 1 MiB bound,
 * so their log starts at the beginning.
 */
export function readJobOutputPosition(positionPath,stat){
  let position;
  try{position=JSON.parse(fs.readFileSync(positionPath,'utf8'));}
  catch(error){if(error.code==='ENOENT')return {start:0};throw error;}
  if(position?.schemaVersion!==1||!Number.isSafeInteger(position.start)||position.start<0)throw new Error('Invalid job output position');
  return position.inode===stat.ino&&position.size===stat.size?position:undefined;
}
/** Bytes the job has written so far, for watches that start at the end. */
export function jobOutputEnd(logPath,positionPath){
  for(let attempt=0;attempt<20;attempt++){
    let fd;
    try{fd=fs.openSync(logPath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);}
    catch(error){if(error.code==='ENOENT')return 0;throw error;}
    try{const s=fs.fstatSync(fd);const position=readJobOutputPosition(positionPath,s);if(position)return position.start+s.size;}
    finally{fs.closeSync(fd);}
  }
  throw new Error('Job output kept changing while locating its end');
}
async function main(root) {
  let emptySince;
  for(;;){
    let active=0;
    for(const name of fs.readdirSync(root).filter(n=>/^watch-[0-9a-f]{24}\.json$/.test(n))){
      try{const w=scanWatch(path.join(root,name));if(w.status==='running')active++;}catch(e){console.error('watch record error:',name,String(e.message).slice(0,256));}
    }
    if(active){emptySince=undefined;}else{emptySince??=Date.now();if(Date.now()-emptySince>15000)return;}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
}
function isEntrypoint() {
  try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; } // Importing from embedded runtimes has no filesystem argv[1].
}
if(isEntrypoint()) {
  main(process.argv[2]).catch(error=>{console.error(String(error));process.exitCode=1;});
}
