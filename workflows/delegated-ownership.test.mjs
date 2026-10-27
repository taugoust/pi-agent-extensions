import { registerHooks } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
const seams = {
  "./goal/goal.js": `export default function goal(pi){
    const fixture=globalThis.__ownershipFixture;
    pi.registerTool({name:'goal_manage',async execute(id,params){
      if(params.action==='status') return structuredClone(fixture.state);
      fixture.state={...fixture.state,id:'rotated',text:params.objective??'mutated',status:params.action};
      return structuredClone(fixture.state);
    }});
    pi.registerCommand('goal',{async handler(args){if(args.trim()!=='status')fixture.state={...fixture.state,id:'command-rotated',text:args}}});
    return {runtime:{get activeGoal(){return fixture.state}},commands:{}};
  }`,
  "./worktree/worktree.js": "export default function worktree(){}",
  "./worktree/settings.js": "export function createWorktreeSettingsRuntime(){return {}};export const settingsFilePath='unused'",
  "./service.js": "export function createWorkflowService(){throw Error('not started in isolated registration test')}",
  "./delegated-child.ts": "export function createDelegatedChildGoalService(){throw Error('not started in isolated registration test')}",
};
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/workflows/index.ts') && seams[specifier]) return {url:`data:text/javascript,${encodeURIComponent(seams[specifier])}`,shortCircuit:true};
  return next(specifier,context);
} });
const { default: workflows } = await import('./index.ts');
function fixture(delegatedChild) {
  const tools=new Map(),commands=new Map(),notices=[];
  const state={id:'owned-goal',progressId:'stable-lineage',text:'owned scope',status:'active',tokensUsed:23};
  const data={state:structuredClone(state)};
  globalThis.__ownershipFixture=data;
  workflows({registerTool:d=>tools.set(d.name,d),registerCommand:(name,d)=>commands.set(name,d),on(){}},{delegatedChild});
  return {data,state,tools,commands,ctx:{hasUI:true,ui:{notify:text=>notices.push(text)}},notices};
}

test('dedicated registration rejects every model management mutation before goal state or lineage changes',async()=>{
  const f=fixture(true);
  try{
    const manage=f.tools.get('goal_manage');
    assert.deepEqual(await manage.execute('status',{action:'status'}),f.state);
    for(const action of ['create','update','pause','resume','clear']){
      await assert.rejects(manage.execute('mutate',{action,goal_id:f.state.id,objective:'replace scope'}),/authenticated parent/);
      assert.deepEqual(f.data.state,f.state);
    }
    for(const args of ['', 'new objective', 'edit replacement', 'pause','resume','clear','limits']){
      await f.commands.get('goal').handler(args,f.ctx);
      assert.deepEqual(f.data.state,f.state);
    }
    await f.commands.get('goal').handler('status',f.ctx);
    assert.deepEqual(f.data.state,f.state);assert.equal(f.notices.length,7);
  }finally{delete globalThis.__ownershipFixture}
});

test('normal/root registration retains model update and public command behavior unchanged',async()=>{
  const f=fixture(false);
  try{
    await f.tools.get('goal_manage').execute('update',{action:'update',objective:'normal update'});
    assert.equal(f.data.state.id,'rotated');assert.equal(f.data.state.text,'normal update');
    await f.commands.get('goal').handler('normal command',f.ctx);
    assert.equal(f.data.state.id,'command-rotated');assert.equal(f.notices.length,0);
  }finally{delete globalThis.__ownershipFixture}
});
