import { randomBytes, createHash } from 'node:crypto';
import { mkdir, realpath, stat, readdir, writeFile, readFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JobStore } from './store.js';
import { BackgroundJobManager, resolveExecutable } from './manager.js';
import { readWatch, saveWatch } from './watch-runner.mjs';

export type WatchRequest={log_path?:string;patterns:Array<{name:string;match:string}>;from?:'start'|'end';poll_ms?:number;watch_timeout_ms?:number;job_id?:string};
const validId=(id:string)=>{if(!/^watch-[0-9a-f]{24}$/.test(id))throw new Error('Invalid watch_id');return id;};
const quote=(s:string)=>`'${s.replaceAll("'", "'\\''")}'`;
export class WatchManager {
  readonly root:string;
  constructor(readonly jobs:BackgroundJobManager, readonly owner:string) {
    this.root=join(jobs.store.root,'watches',createHash('sha256').update(owner).digest('hex').slice(0,32));
  }
  private file(id:string){return join(this.root,validId(id)+'.json');}
  private load(id:string,childId?:string):any {
    const w=readWatch(this.file(id));
    if(w.version!==1||w.owner!==this.owner||(childId!==undefined&&w.childId!==childId))throw new Error('Watch belongs to another session or task');
    return w;
  }
  async create(cwd:string,p:WatchRequest,childId?:string):Promise<any> {
    if(!Array.isArray(p.patterns)||p.patterns.length<1||p.patterns.length>16||p.patterns.some(r=>!r||Object.keys(r).some(k=>!['name','match'].includes(k))||typeof r.name!=='string'||!r.name.trim()||Buffer.byteLength(r.name)>64||typeof r.match!=='string'||!r.match.trim()||Buffer.byteLength(r.match)>256))throw new Error('watch requires 1–16 bounded literal patterns');
    if(new Set(p.patterns.map(r=>r.name)).size!==p.patterns.length)throw new Error('Pattern names must be unique');
    const pollMs=p.poll_ms??2000;
    if(!Number.isSafeInteger(pollMs)||pollMs<250||pollMs>60000)throw new Error('poll_ms must be 250–60000');
    if(p.watch_timeout_ms!==undefined&&(!Number.isSafeInteger(p.watch_timeout_ms)||p.watch_timeout_ms<1000||p.watch_timeout_ms>7*86400000))throw new Error('watch_timeout_ms must be 1 second–7 days');
    if(p.from!==undefined&&!['start','end'].includes(p.from))throw new Error('Invalid from');
    const base=await realpath(cwd);
    let resultPath:string|undefined;let jobLog:string|undefined;
    if(p.job_id){const job=await this.jobs.get(p.job_id);if(job.metadata.sessionId!==this.owner||(childId!==undefined&&job.metadata.childId!==childId))throw new Error('Associated job belongs to another owner');resultPath=this.jobs.store.path(p.job_id,'result.json');jobLog=job.metadata.observed?.logPath??this.jobs.store.path(p.job_id,'output.log');}
    const file=await realpath(p.log_path??jobLog??'');const rel=relative(base,file);
    if(file!==jobLog&&(rel==='..'||rel.startsWith('../')||isAbsolute(rel)))throw new Error('Watched log must be within delegated cwd or belong to an owned job');
    const info=await stat(file);if(!info.isFile()||info.uid!==process.getuid?.())throw new Error('Watch requires a same-user regular log');
    await mkdir(this.root,{recursive:true,mode:0o700});
    const lock=new JobStore(join(this.root,'lock-state'));
    return await lock.withLock(async()=>{
      const all=await this.list();if(all.length>=256)throw new Error('Retained watch limit reached (256); archive old watch records before creating more');if(all.filter(w=>w.status==='running').length>=64)throw new Error('Watch limit reached');
      const id=`watch-${randomBytes(12).toString('hex')}`;
      const w={version:1,id,owner:this.owner,childId,path:file,cwd:base,patterns:p.patterns,pollMs,resultPath,
        status:'running',createdAt:new Date().toISOString(),deadline:p.watch_timeout_ms?Date.now()+p.watch_timeout_ms:undefined,
        device:info.dev,inode:info.ino,offset:p.from==='start'?0:info.size,pending:'',sequence:0,droppedThrough:0,events:[]};
      saveWatch(this.file(id),w);
      try{await this.ensureRunner();}catch(error){w.status='failed';saveWatch(this.file(id),w);throw error;}
      return this.summary(w);
    });
  }
  private summary(w:any){return {watch_id:w.id,status:w.status,log_path:w.path,sequence:w.sequence,dropped_through:w.droppedThrough,child_id:w.childId};}
  private async ensureRunner(){
    try{const id=(await readFile(join(this.root,'service'),'utf8')).trim();const r=await this.jobs.get(id);if(r.metadata.sessionId===this.owner&&['starting','running'].includes(r.status))return;}catch{}
    const node=await resolveExecutable('node');const runner=fileURLToPath(new URL('./watch-runner.mjs',import.meta.url));
    const job=await this.jobs.start({command:`${quote(node)} ${quote(runner)} ${quote(this.root)}`,cwd:this.root,sessionId:this.owner,name:'Persistent log watch service',infrastructure:true});
    await writeFile(join(this.root,'service'),job.metadata.id,{mode:0o600});
  }
  async list(childId?:string):Promise<any[]>{
    let names:string[];try{names=await readdir(this.root);}catch{return [];}
    const result=[];
    for(const name of names.filter(n=>/^watch-[0-9a-f]{24}\.json$/.test(n))){try{result.push(this.summary(this.load(name.slice(0,-5),childId)));}catch{}}
    return result;
  }
  async events(id:string,after?:number,childId?:string):Promise<any>{
    const w=this.load(id,childId);
    if(after===undefined){try{after=Number(await readFile(this.file(id)+'.ack','utf8'));}catch{after=0;}}
    if(!Number.isSafeInteger(after)||after!<0)throw new Error('Invalid event cursor');
    const events=w.events.filter((e:any)=>e.sequence>after!).slice(0,32);
    return {...this.summary(w),events,next_sequence:events.at(-1)?.sequence??after,overflow:after!<w.droppedThrough};
  }
  async ack(id:string,through:number,childId?:string){
    const w=this.load(id,childId);if(!Number.isSafeInteger(through)||through<0||through>w.sequence)throw new Error('Invalid acknowledgement cursor');
    const lock=new JobStore(join(this.root,'ack-lock'));
    await lock.withLock(async()=>{let previous=0;try{previous=Number(await readFile(this.file(id)+'.ack','utf8'));}catch{};await writeFile(this.file(id)+'.ack',String(Math.max(previous,through)),{mode:0o600});});
    return {watch_id:id,acknowledged_through:through};
  }
  async stop(id:string,childId?:string){this.load(id,childId);await writeFile(this.file(id)+'.stop','stop',{mode:0o600});return {watch_id:id,status:'stopping'};}
  async recover(){
    if((await this.list()).some(w=>w.status==='running')){const lock=new JobStore(join(this.root,'lock-state'));await lock.withLock(()=>this.ensureRunner());}
  }
}
