import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/shared/subagent-worktrees.ts') && specifier !== '../subagent/tui-names.ts' && specifier !== './worktree-completion.ts' && !specifier.startsWith('node:')) {
    const code = specifier.includes('settings') ? 'export function loadWorktreeSettings(){}' : specifier.includes('/git.ts') ? 'export const addWorktree=0,currentWorktreePath=0,defaultWorktreePath=0,listWorktrees=0,pathEntryExists=0,resolveCommit=0,unresolvableSymlinkAncestor=0,validateBranch=0' : 'export function getAgentDir(){throw Error("live registry forbidden")}';
    return {url:`data:text/javascript,${encodeURIComponent(code)}`,shortCircuit:true};
  }
  return next(specifier,context);
}});
const { recordedWorktreeName, recordedWorktreeOwner } = await import('./subagent-worktrees.ts');
const owner = {ownerSessionId:'parent',taskId:`subagent-task-${'1'.repeat(24)}`,childId:`subagent-child-${'2'.repeat(24)}`,title:'Please implement everything',commonDir:'/repo/.git',physicalIdentity:{dev:'1',ino:'2',birthtimeMs:'3'}};
test('new explicit names use existing canonical policy, never instructions',()=>{
  assert.equal(recordedWorktreeName({displayName:'Parser Review'}),'Parser Review');
  assert.equal(recordedWorktreeName({name:'parser-review'}),'parser review');
  assert.equal(recordedWorktreeName({task:'Please implement everything'}),undefined);
  assert.throws(()=>recordedWorktreeName({displayName:'one two three four five'}));
});
test('legacy and malformed names omit name; resumed recorded child is exact',()=>{
  assert.deepEqual(recordedWorktreeOwner(owner),{ownerSessionId:owner.ownerSessionId,taskId:owner.taskId,childId:owner.childId});
  assert.equal(recordedWorktreeOwner({...owner,canonicalDisplayName:'one two three four five'}).canonicalDisplayName,undefined);
  const resumed={...owner,childId:`subagent-child-${'3'.repeat(24)}`,canonicalDisplayName:'Parser Review'};
  assert.equal(recordedWorktreeOwner(resumed).childId,resumed.childId);
  assert.equal(recordedWorktreeOwner(resumed).canonicalDisplayName,'Parser Review');
});
// Execute the actual inventory projection block with read-only identity seams.
const source=readFileSync(new URL('../workflows/service.ts',import.meta.url),'utf8');
const block=source.slice(source.indexOf('// Path/branch matches'),source.indexOf('\n\t\t\t\t\t\tconst worker =')).replace('let recordedOwner;','let recordedOwner;');
const project=new (Object.getPrototypeOf(async function(){}).constructor)('owned','validPhysicalIdentity','runGit','record','inventorySignal','pi','pathIdentity','samePhysicalIdentity','filesystemIdentity','recordedWorktreeOwner',`${block}\nreturn recordedOwner;`);
async function projection(owned, actual=owner.physicalIdentity, commonDir=owner.commonDir){return project(owned,x=>!!x,async(_pi,args)=>({stdout:args.includes('--git-common-dir')?commonDir:'/admin'}),{path:'/tree'},undefined,{},x=>x,(a,b)=>JSON.stringify(a)===JSON.stringify(b),async()=>actual,recordedWorktreeOwner);}
test('inventory requires physical identity and common directory; absent/legacy fail closed',async()=>{
  assert.deepEqual(await projection(owner),recordedWorktreeOwner(owner));
  assert.equal(await projection(undefined),undefined);
  assert.equal(await projection({...owner,physicalIdentity:undefined}),undefined);
  assert.equal(await projection(owner,{...owner.physicalIdentity,ino:'99'}),undefined);
  assert.equal(await projection(owner,owner.physicalIdentity,'/different'),undefined);
});
