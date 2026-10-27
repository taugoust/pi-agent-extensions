import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {cp,mkdtemp,mkdir,writeFile,readFile,readdir,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve,dirname} from "node:path";
import {fileURLToPath} from "node:url";
const raw=process.env.PI_DEDICATED_TEST_PI;
assert(raw?.startsWith("/nix/store/"),"Set explicit immutable PI_DEDICATED_TEST_PI");
const root=await mkdtemp(join(tmpdir(),"pi-subagent-narrow-")),repo=resolve(dirname(fileURLToPath(import.meta.url)),".."),bundle=join(root,"bundle"),agent=join(root,"agent"),home=join(root,"home");
let child,output="",keep=false;
try {
  await mkdir(agent,{recursive:true});await mkdir(home,{recursive:true});
  // Exact subagent-only runtime layout from nix/mk-extension-bundle.nix and
  // registry dependency closure: no workflows/progress extension auto-enabled.
  for(const name of ["subagent","subagent-finalizer","shared"])await cp(join(repo,name),join(bundle,name),{recursive:true});
  await mkdir(join(bundle,"workflows","worktree"),{recursive:true});
  for(const name of ["git.ts","settings.ts"])await cp(join(repo,"workflows","worktree",name),join(bundle,"workflows","worktree",name));
  if(process.env.PI_NARROW_TEST_WITH_WORKFLOWS==="1")await cp(join(repo,"workflows"),join(bundle,"workflows"),{recursive:true});
  await writeFile(join(bundle,"package.json"),JSON.stringify({type:"module",pi:{extensions:["subagent","subagent-finalizer"]}}));
  await mkdir(join(root,"registry-control","workflows"),{recursive:true});
  await mkdir(join(root,"registry-control","shared"),{recursive:true});
  await cp(join(repo,"workflows","delegated-goals.ts"),join(root,"registry-control","workflows","delegated-goals.ts"));
  await cp(join(repo,"shared","delegated-goal-policy.ts"),join(root,"registry-control","shared","delegated-goal-policy.ts"));
  const fixture=String.raw`
import {Type} from "@sinclair/typebox";
import {writeFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {DelegatedGoalRegistry} from "./registry-control/workflows/delegated-goals.ts";
export default function(pi) {
  pi.registerProvider("harness-test",{api:"openai-responses",apiKey:"test-only",baseUrl:"http://127.0.0.1:1",models:[{id:"gpt-6.1-sol",name:"Narrow fake Sol",reasoning:false,input:["text"],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],streamSimple(){throw new Error("Narrow smoke must not invoke a model");}});
  // Test-only capability names avoid masking a missing-source error with a
  // missing-tool error. These do not install any Goal/progress implementation.
  for(const name of ["goal_manage","goal_complete","goal_blocked","goal_wait","update_progress"])pi.registerTool({name,label:name,description:"Fixture capability name only",parameters:Type.Object({}),async execute(){throw new Error("Fixture must not execute a tool");}});
  pi.on("session_start",async(_event,ctx)=>{
    const executor=globalThis.__paeDelegatedGoalExecutorV1;
    const reason=executor.executionUnavailableReason();let rejected;
    try{await executor.start({id:"narrow-unstarted",text:"must never launch",child:null});}catch(error){rejected=error.message;}
    let journalWrites=0,registryRejected;
    const owner=ctx.sessionManager.getSessionId();
    const registry=new DelegatedGoalRegistry(owner,executor,()=>{},undefined,{save:()=>{journalWrites++;}});
    const created=await registry.mutate(owner,{action:"goals.create",requestId:randomUUID(),expectedGoalId:null,objective:"Narrow preflight only"});
    const entry=created.entries[0];
    try{await registry.mutate(owner,{action:"goals.start",requestId:randomUUID(),expectedGoalId:entry.id,expectedEntryRevision:entry.revision});}catch(error){registryRejected=error.message;}
    writeFileSync(process.env.TEST_RESULT,JSON.stringify({available:executor.executionAvailable(),reason,rejected,registryRejected,journalWrites,linkedChild:registry.snapshot().entries[0].child,workflowsRegistered:!!globalThis.__paeWorkflowsV1,childRegistered:!!globalThis.__paeDelegatedChildGoalV1}));
  });
}
`;
  await writeFile(join(root,"fixture.ts"),fixture);
  await writeFile(join(agent,"settings.json"),JSON.stringify({defaultProvider:"harness-test",defaultModel:"gpt-6.1-sol"}));
  const env={PATH:process.env.PATH,HOME:home,LANG:"C.UTF-8",TMPDIR:root,PI_CODING_AGENT_DIR:agent,PI_TUI_WORKER_LAUNCHER:raw,PI_PASEO_BRIDGE_NO_IMPORT:"1",PASEO_HOME:join(root,"paseo"),TMUX_TMPDIR:join(root,"tmux"),TEST_RESULT:join(root,"result.json")};
  child=spawn(raw,["--mode","rpc","--no-extensions","--extension",join(bundle,"subagent","index.ts"),"--extension",join(root,"fixture.ts"),"--provider","harness-test","--model","gpt-6.1-sol","--session",join(root,"session.jsonl"),"--tools","read,bash,edit,write,goal_manage,goal_complete,goal_blocked,goal_wait,update_progress"],{cwd:root,env,stdio:["pipe","pipe","pipe"]});
  child.stdin.on("error",()=>{});child.stdout.on("data",c=>{if(c.toString().includes('"success":false'))output+=c.toString();});child.stderr.on("data",c=>{output+=c.toString();});
  let result;const deadline=Date.now()+45000;
  while(Date.now()<deadline){try{result=JSON.parse(await readFile(env.TEST_RESULT,"utf8"));break;}catch{}await new Promise(resolve=>setTimeout(resolve,25));}
  assert(result,"subagent-only module did not import: "+output);
  const missing=process.env.PI_NARROW_TEST_WITH_WORKFLOWS==="1"?"progress/index":"workflows/index";
  assert.equal(result.available,false);assert(result.reason.includes(missing)&&result.reason.includes("missing"),result.reason);assert.equal(result.rejected,result.reason);
  assert.equal(result.workflowsRegistered,false);assert.equal(result.childRegistered,false);
  assert.equal(result.registryRejected,result.reason);assert.equal(result.journalWrites,0,"missing Goal implementation must fail before registry intent journal");assert.equal(result.linkedChild,null);
  const tasks=await readdir(join(agent,"state","native-tasks-v1")).catch(error=>{if(error.code==="ENOENT")return[];throw error;});assert.deepEqual(tasks,[]);
  assert.deepEqual(JSON.parse(await readFile(join(bundle,"package.json"),"utf8")).pi.extensions,["subagent","subagent-finalizer"]);
  console.log("actual subagent-only narrow bundle import passed; preflight refused without launch/auto-registration",{missing});
}catch(error){keep=true;console.error("Narrow fixture retained: "+root+"\n"+output);throw error;}
finally{if(child&&child.exitCode===null){child.stdin.end();await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill("SIGTERM");resolve();},10000);child.once("close",()=>{clearTimeout(timer);resolve();});});}if(!keep)await rm(root,{recursive:true,force:true});}
