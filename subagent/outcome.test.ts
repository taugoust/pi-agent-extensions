import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTaskOutcome, validateAcceptance, writeTaskOutcome, readTaskOutcome, outcomeSummary } from './outcome.js';
const complete={version:1,state:'delivered',summary:'Implemented and tested',acceptance:[{criterion:'test passes',status:'passed',evidence:'test.log'}],artifacts:[{path:'test.log'}],remaining:[]};
assert.equal(validateTaskOutcome(complete,['test passes']).state,'delivered');
assert.throws(()=>validateTaskOutcome(complete,['missing criterion']),/all acceptance/);
assert.throws(()=>validateTaskOutcome({...complete,remaining:['unfinished']}),/no remaining/);
assert.throws(()=>validateTaskOutcome({...complete,acceptance:[]}),/requires evidence/);
assert.throws(()=>validateTaskOutcome({...complete,state:'partial'}),/next_action/);
assert.throws(()=>validateTaskOutcome({...complete,extra:true}),/fields/);
assert.throws(()=>validateAcceptance([42]),/criterion/);
assert.equal(outcomeSummary(1,undefined).state,'unreported');
const root=mkdtempSync(join(tmpdir(),'outcome-test-'));
try {
 const file=join(root,'outcome.json');assert.equal(readTaskOutcome(file),undefined);
 writeTaskOutcome(file,complete);assert.equal(readTaskOutcome(file)?.state,'delivered');
 writeTaskOutcome(file,{...complete,state:'checkpointed',next_action:'continue from test.log'});assert.equal(readTaskOutcome(file)?.state,'checkpointed');
 const link=join(root,'link.json');symlinkSync(file,link);assert.throws(()=>readTaskOutcome(link));
 writeFileSync(file,'x'.repeat(16385));assert.throws(()=>readTaskOutcome(file),/16 KiB/);
} finally {rmSync(root,{recursive:true,force:true});}
console.log('structured task outcome checks passed');
