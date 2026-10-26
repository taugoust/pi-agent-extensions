import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { JobStore } from './store.ts';
import { BackgroundJobManager } from './manager.ts';

const root = await mkdtemp(join(tmpdir(), 'bg-streams-'));
const runner = new URL('./runner.mjs', import.meta.url).pathname;
async function run(command, maximum = 65536, prepare = async () => {}) {
  const dir = await mkdtemp(join(root, 'job-'));
  const token = `linux-proc:${(await readFile(`/proc/${process.pid}/stat`, 'utf8')).slice((await readFile(`/proc/${process.pid}/stat`, 'utf8')).lastIndexOf(')') + 2).trim().split(/\\s+/)[19]}`;
  await writeFile(join(dir,'metadata.json'), JSON.stringify({ownerPid:process.pid,ownerToken:token}));
  await writeFile(join(dir,'command'), command);
  await writeFile(join(dir,'environment'), `PATH=${process.env.PATH}\0`);
  await writeFile(join(dir,'launch-ready'), '');
  const child=spawn(process.execPath,[runner,dir,'/bin/sh',String(maximum)],{stdio:'ignore'});
  while (!(await import('node:fs/promises')).stat(join(dir,'runner-ready')).catch(()=>null)) await new Promise(r=>setTimeout(r,5));
  await prepare(dir);
  const code=await new Promise(resolve=>child.once('close',resolve));
  const result=JSON.parse(await readFile(join(dir,'result.json'),'utf8'));
  return {dir,code,result};
}
try {
  let x=await run("printf 'one\\n'; sleep .05; printf 'err\\n' >&2; printf 'two\\n'");
  assert.equal(x.result.status,'completed');
  assert.equal(await readFile(join(x.dir,'stdout.log'),'utf8'),'one\ntwo\n');
  assert.equal(await readFile(join(x.dir,'stderr.log'),'utf8'),'err\n');
  assert.match(await readFile(join(x.dir,'output.log'),'utf8'),/one[\s\S]*err[\s\S]*two/);
  x=await run("printf only-out; exit 7");
  assert.equal(x.result.status,'failed'); assert.equal(await readFile(join(x.dir,'stdout.log'),'utf8'),'only-out');
  assert.equal(await readFile(join(x.dir,'stderr.log'),'utf8'),'');
  x=await run("printf only-err >&2"); assert.equal(x.result.status,'completed'); assert.equal(await readFile(join(x.dir,'stderr.log'),'utf8'),'only-err');
  x=await run("head -c 100000 /dev/zero | tr '\\\\0' x");
  for(const file of ['output.log','stdout.log','stderr.log']) assert((await stat(join(x.dir,file))).size<=65536);
  x=await run("sleep .2; printf finished",65536,async dir=>{await writeFile(join(dir,'cancel-requested'),'');});
  assert.equal(x.result.status,'cancelled');
  const failedDir=await mkdtemp(join(root,'logger-'));
  const tokenText=await readFile(`/proc/${process.pid}/stat`,'utf8');
  const fields=tokenText.slice(tokenText.lastIndexOf(')')+2).trim().split(/\\s+/);
  await writeFile(join(failedDir,'metadata.json'),JSON.stringify({ownerPid:process.pid,ownerToken:`linux-proc:${fields[19]}`}));
  await writeFile(join(failedDir,'command'),"printf output"); await writeFile(join(failedDir,'environment'),`PATH=${process.env.PATH}\\0`);
  await writeFile(join(failedDir,'launch-ready'),''); await mkdir(join(failedDir,'stdout.log'));
  const logger=spawn(process.execPath,[runner,failedDir,'/bin/sh','65536'],{stdio:'ignore'});
  await new Promise(resolve=>logger.once('close',resolve));
  const loggerResult=JSON.parse(await readFile(join(failedDir,'result.json'),'utf8'));
  assert.equal(loggerResult.status,'failed'); assert.match(loggerResult.reason,/logger failed/);

  const store=new JobStore(join(root,'state')); await store.initialize();
  const manager=new BackgroundJobManager(store,{async paneState(){return {exists:false,dead:true};}});
  const id='job-111111111111111111111111';
  await store.create({schemaVersion:1,id,command:'legacy',cwd:root,shell:'/bin/sh',createdAt:new Date().toISOString(),ownerPid:process.pid},'legacy',Buffer.alloc(0));
  await store.writeLaunch(id,{schemaVersion:1,windowId:'@1',paneId:'%1',panePid:process.pid,paneStartToken:'x',launchedAt:new Date().toISOString()});
  assert.deepEqual(await manager.streamOutput(id),{available:false,stdout:'',stderr:''});
  await writeFile(store.path(id,'stdout.log'),'x'.repeat(32768)+'stdout tail');
  await writeFile(store.path(id,'stderr.log'),'é'.repeat(20000)+'stderr tail');
  const bounded=await manager.streamOutput(id);
  assert.equal(bounded.available,true);
  assert.equal(bounded.stdout_truncated,true); assert.equal(bounded.stderr_truncated,true);
  assert(Buffer.byteLength(bounded.stdout)<=16384); assert(Buffer.byteLength(bounded.stderr)<=16384);
  assert(bounded.stdout.endsWith('stdout tail')); assert(bounded.stderr.endsWith('stderr tail'));
  assert(!bounded.stderr.includes('\ufffd'),'UTF-8 tail must not split code points');
  let reaped = 0;
  const retentionManager = new BackgroundJobManager(store,{async reap(){reaped++;},async paneState(){return {exists:false,dead:true};}});
  for (const verification of [true,false]) {
    const retained = verification ? 'job-222222222222222222222222' : 'job-333333333333333333333333';
    await store.create({schemaVersion:1,id:retained,command:'retention control',cwd:root,shell:'/bin/sh',createdAt:new Date().toISOString(),ownerPid:process.pid,...(verification?{verification:true}:{})},'control',Buffer.alloc(0));
    await store.writeLaunch(retained,{schemaVersion:1,windowId:'@2',paneId:'%2',panePid:process.pid,paneStartToken:'x',launchedAt:new Date().toISOString()});
    await store.publishResult(retained,{schemaVersion:1,status:'completed',exitCode:0,finishedAt:new Date().toISOString()});
    await store.markRetrieved(retained,1);
    await retentionManager.reapExpired(retained,1_000_000,300_000);
    if(verification) assert.equal((await store.readMetadata(retained)).verification,true,'verification evidence auto-expired before durable acceptance');
    else await assert.rejects(()=>store.readMetadata(retained),{code:'ENOENT'});
  }
  assert.equal(reaped,1,'verification pin changed ordinary job retention or reaped pinned evidence');
  console.log('stream capture, combined order, stdout-only failure, stderr-only success, per-stream bounds, legacy-unavailable and verification retention pin passed');
} finally { await rm(root,{recursive:true,force:true}); }
