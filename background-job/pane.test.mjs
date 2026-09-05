import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BackgroundJobManager } from './manager.js';
import { JobStore } from './store.js';
import { TmuxBackend } from './tmux.js';
const exec=promisify(execFile),tmux=process.env.TEST_TMUX,runner=process.env.TEST_RUNNER;
if(!tmux||!runner)throw new Error('TEST_TMUX and TEST_RUNNER required');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'pane-adoption-'));
const socket=path.join(root,'external.sock'),state=path.join(root,'state'),runtime=path.join(root,'runtime');
const call=async(...args)=>(await exec(tmux,['-S',socket,...args],{timeout:5000})).stdout.trim();
try {
 const pane=await call('-f','/dev/null','new-session','-d','-P','-F','#{pane_id}','-s','existing','-c',root,process.execPath,'-e',"console.log('existing-work');setInterval(()=>{},1000)");
 await call('set-option','-g','remain-on-exit','on');await call('set-option','-g','remain-on-exit-format','');
 const untouched=await call('new-window','-d','-P','-F','#{pane_id}','-t','existing:','-c',root,process.execPath,'-e','setInterval(()=>{},1000)');
 const pid=await call('display-message','-p','-t',pane,'#{pane_pid}');
 const untouchedPid=await call('display-message','-p','-t',untouched,'#{pane_pid}');
 const makeController=session=>`
 import {BackgroundJobManager} from ${JSON.stringify(new URL('./manager.js',import.meta.url).href)};
 import {JobStore} from ${JSON.stringify(new URL('./store.js',import.meta.url).href)};
 import {TmuxBackend} from ${JSON.stringify(new URL('./tmux.js',import.meta.url).href)};
 const store=new JobStore(${JSON.stringify(state)},${JSON.stringify(runtime)});
 const manager=new BackgroundJobManager(store,new TmuxBackend(store,${JSON.stringify(tmux)},process.execPath,${JSON.stringify(runner)}));
 const r=await manager.adoptPane({paneId:${JSON.stringify(pane)},socket:${JSON.stringify(socket)},cwd:${JSON.stringify(root)},sessionId:${JSON.stringify(session)},name:'Existing build'});
 console.log(r.metadata.id);`;
 const first=await exec(process.execPath,['--input-type=module','-e',makeController('old-parent')],{timeout:15000});
 const originalId=first.stdout.trim();assert.match(originalId,/^job-[a-f0-9]{24}$/);
 assert.equal(await call('display-message','-p','-t',pane,'#{pane_pid}'),pid,'initial adoption restarted the pane');
 const store=new JobStore(state,runtime);const manager=new BackgroundJobManager(store,new TmuxBackend(store,tmux,process.execPath,runner));
 // A new parent has only the existing pane ID/socket, not any descriptor.
 const recovered=await manager.adoptPane({paneId:pane,socket,cwd:root,sessionId:'new-parent'});
 assert.equal(recovered.metadata.id,originalId,'restart registration duplicated the job');
 assert.equal(recovered.metadata.sessionId,'new-parent');
 assert.equal(await call('display-message','-p','-t',pane,'#{pane_pid}'),pid,'re-registration restarted the pane');
 assert.equal((await manager.adoptPane({paneId:pane,socket,cwd:root,sessionId:'new-parent'})).metadata.id,originalId);
 assert.match((await manager.output(originalId)).text,/existing-work/);
 assert.equal((await manager.wait(originalId,10)).timedOut,true);
 await assert.rejects(exec(process.execPath,['--input-type=module','-e',makeController('competing-parent')],{timeout:15000}),/another live Pi/);
 const cancelled=await manager.cancel(originalId);assert.equal(cancelled.status,'cancelled');
 assert.equal(await call('display-message','-p','-t',pane,'#{pane_pid}').catch(()=>''),'','cancel did not close the adopted pane');
 assert.match((await manager.output(originalId)).text,/existing-work/,'cancel lost captured output');
 assert.equal(await call('display-message','-p','-t',untouched,'#{pane_pid}'),untouchedPid,'cancel affected an unrelated pane');
 const signalJob=await manager.adoptPane({paneId:untouched,socket,cwd:root,sessionId:'new-parent'});
 await manager.signal(signalJob.metadata.id,'SIGTERM');
 const end=Date.now()+3000;let terminal;
 while(Date.now()<end){terminal=await manager.get(signalJob.metadata.id);if(terminal.result)break;await new Promise(r=>setTimeout(r,20));}
 assert(terminal.result,'signal did not reach the adopted pane process');
 const protectedPane=await call('new-window','-d','-P','-F','#{pane_id}','-t','existing:','-c',root,process.execPath,'-e','setInterval(()=>{},1000)');
 const protectedJob=await manager.adoptPane({paneId:protectedPane,socket,cwd:root,sessionId:'new-parent'});
 const protectedPid=await call('display-message','-p','-t',protectedPane,'#{pane_pid}');
 await call('set-option','-p','-t',protectedPane,'@pi_managed_job_token','00000000000000000000000000000000');
 assert.equal((await manager.cancel(protectedJob.metadata.id)).status,'lost');
 assert.equal(await call('display-message','-p','-t',protectedPane,'#{pane_pid}'),protectedPid,'identity mismatch cancelled replacement work');
 console.log('LIVE pane adoption: no restart, parent exit/re-registration, idempotence, output/wait, signal/cancel, identity guards and unrelated-pane preservation passed');
} finally {await exec(tmux,['-S',socket,'kill-server']).catch(()=>{});await exec(tmux,['-S',path.join(runtime,'tmux.sock'),'kill-server']).catch(()=>{});await fs.rm(root,{recursive:true,force:true});}
