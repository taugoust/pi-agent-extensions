import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TuiNativeManager } from './tui-native.ts';

test('native terminal snapshots: foreground silence, background failures, retry, distinct later turns', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-completion-'));
  const manager:any = new TuiNativeManager(root,()=> 'native',()=>true,16);
  const updates:any[]=[];
  manager.notify=(u:any)=>{updates.push(u);return true;};
  const group:any={id:'group',background:false};
  const child:any={childId:'child',state:'completed',report:'first-report',attempt:1};
  try {
    manager.notifyTerminal(group,child);
    assert.equal(updates.length,0);
    group.background=true;manager.notifyTerminal(group,child);
    assert.equal(updates.length,0,'promotion replayed already-returned foreground result');
    child.state='running';child.report=undefined;manager.notifyTerminal(group,child);
    assert.equal(updates.length,0);
    child.state='failed';child.report='second-report';manager.notifyTerminal(group,child);
    assert.equal(updates.length,1);assert.equal(updates[0].completion,true);
    manager.notifyTerminal(group,child);assert.equal(updates.length,1);
    const lost:any={childId:'lost',state:'lost',attempt:1};
    manager.notify=()=>false;manager.notifyTerminal(group,lost);
    assert.equal(lost.terminalNotification,undefined,'failed enqueue advanced durable cursor');
    manager.notify=(u:any)=>{updates.push(u);return true;};
    manager.notifyTerminal(group,lost);manager.notifyTerminal(group,lost);
    assert.equal(updates.length,2);assert.equal(updates[1].state,'lost');
    const failed:any={childId:'launch-failed',state:'failed',attempt:1};
    manager.notifyTerminal(group,failed);assert.equal(updates.length,3);
    failed.reaped=true;failed.report='new';manager.notifyTerminal(group,failed);assert.equal(updates.length,3);
  } finally {await manager.shutdown(false);await rm(root,{recursive:true,force:true});}
});
