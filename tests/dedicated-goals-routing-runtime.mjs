import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { cp,mkdtemp,mkdir,writeFile,readFile,rename,rm,symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join,dirname,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
const raw=process.env.PI_DEDICATED_TEST_PI;
assert(raw?.startsWith("/nix/store/"),"Set explicit immutable PI_DEDICATED_TEST_PI");
const accountModules=process.env.PI_DEDICATED_TEST_ACCOUNT_MODULES;
assert(accountModules?.startsWith("/nix/store/"),"Set existing packaged PI_DEDICATED_TEST_ACCOUNT_MODULES (no dependency installation)");
const root=await mkdtemp(join(tmpdir(),"pi-goal-routing-")),home=join(root,"home"),agent=join(home,".pi","agent"),source=join(root,"source"),cwd=join(root,"repo"),sessionId=randomUUID();
let child,output="",keep=false;
const provider=String.raw`
import {createAssistantMessageEventStream} from "@earendil-works/pi-ai";
import {appendFileSync} from "node:fs";
export default function(pi){let ctx;pi.on("session_start",async(_e,c)=>{ctx=c;});
pi.registerProvider("openai",{api:"openai-responses",apiKey:"WRONG-provider-default",baseUrl:"http://127.0.0.1:1",models:[{id:"gpt-6.1-sol",name:"Offline routed Sol",reasoning:false,input:["text"],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],
streamSimple(model,_context,options){const goal=ctx.sessionManager.getBranch().findLast(e=>e.type==="custom"&&e.customType==="goal-state")?.data?.goal;
appendFileSync(process.env.TEST_CALLS,JSON.stringify({child:process.env.PI_DEDICATED_GOAL_CHILD==="1",selectedAccount:options.apiKey==="selected-alpha-key",wrongDefault:options.apiKey==="WRONG-provider-default"||options.apiKey==="store-default-beta-key",model:model.id,provider:model.provider,goalId:goal?.id})+"\n");
if(!goal?.id)throw new Error("Unexpected parent model execution");
const message={role:"assistant",api:"openai-responses",provider:model.provider,model:model.id,timestamp:Date.now(),stopReason:"toolUse",content:[{type:"toolCall",id:"complete-"+process.pid,name:"goal_complete",arguments:{goal_id:goal.id,activation_id:goal.activationId,summary:"Verified inherited selected named account offline"}}],usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
const stream=createAssistantMessageEventStream();queueMicrotask(()=>{stream.push({type:"start",partial:message});stream.push({type:"done",reason:"toolUse",message});stream.end(message);});return stream;}});}
`;
const parent=String.raw`
import provider from "./fake-provider.ts";
import accounts from "./openai-accounts/accounts.ts";
import workflows from "./workflows/index.ts";
import subagent from "./subagent/index.ts";
import progress from "./progress/index.ts";
import {getSessionRoutingProfile} from "./shared/session-routing.ts";
import {createServer} from "node:net";
export default function(pi){provider(pi);accounts(pi);progress(pi);workflows(pi);subagent(pi);let server;
pi.on("session_start",async(_e,ctx)=>{server=createServer(socket=>{socket.setEncoding("utf8");let text="";socket.on("error",()=>{});socket.on("data",chunk=>{text+=chunk;if(!text.includes("\n"))return;const r=JSON.parse(text.slice(0,text.indexOf("\n")));const service=globalThis.__paeWorkflowsV1;
const run=async()=>r.fixture==="route"?getSessionRoutingProfile(ctx):await service.handle({...r,sessionId:service.sessionId,serviceEpoch:service.serviceEpoch});
run().then(result=>socket.end(JSON.stringify({ok:true,result})+"\n"),error=>socket.end(JSON.stringify({ok:false,error:error.message})+"\n"));});});await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(process.env.TEST_SOCKET,resolve);});});pi.on("session_shutdown",async()=>server?.close());}
`;
async function rpc(r){return await new Promise((resolve,reject)=>{const s=createConnection(join(root,"fixture.sock"));let text="";s.setEncoding("utf8");s.setTimeout(30000,()=>{s.destroy();reject(new Error("request timeout"));});s.on("error",reject);s.on("connect",()=>s.write(JSON.stringify(r)+"\n"));s.on("data",chunk=>{text+=chunk;if(!text.includes("\n"))return;s.destroy();const result=JSON.parse(text.slice(0,text.indexOf("\n")));result.ok?resolve(result.result):reject(new Error(result.error));});});}
const snapshot=()=>rpc({operation:"snapshot"});
async function until(fn,label){const end=Date.now()+45000;let last;while(Date.now()<end){try{const result=await fn();if(result)return result;}catch(e){last=e;}await new Promise(r=>setTimeout(r,25));}throw new Error(label+": "+last?.message+"\n"+output);}
async function settle(s){const end=Date.now()+30000;while(s.operationId){if(Date.now()>end)throw new Error("operation timeout "+JSON.stringify(s));if(s.dialog)s=await rpc({operation:"send",requestId:randomUUID(),operationId:s.operationId,dialogId:s.dialog.id,value:true});else{await new Promise(r=>setTimeout(r,10));s=await snapshot();}}return s;}
try{
await mkdir(agent,{recursive:true});await mkdir(cwd,{recursive:true});
await cp(resolve(dirname(fileURLToPath(import.meta.url)),".."),source,{recursive:true,filter:p=>!p.split("/").some(x=>[".git",".direnv","node_modules","plans"].includes(x))});
await symlink(accountModules,join(source,"openai-accounts","node_modules"),"dir");
await writeFile(join(source,"fake-provider.ts"),provider);await writeFile(join(source,"routed-parent.ts"),parent);
await rename(join(source,"subagent","goal-worker.ts"),join(source,"subagent","goal-worker-real.ts"));await writeFile(join(source,"subagent","goal-worker.ts"),'import provider from "../fake-provider.ts";import worker from "./goal-worker-real.ts";export default function(pi){provider(pi);worker(pi);}\n');
await writeFile(join(agent,"settings.json"),JSON.stringify({defaultProvider:"openai",defaultModel:"gpt-6.1-sol",compaction:{enabled:false},retry:{enabled:false}}));await writeFile(join(agent,"auth.json"),"{}",{mode:0o600});
await writeFile(join(agent,"pi-accounts.json"),JSON.stringify({version:1,providers:{openai:{active:"beta",accounts:{alpha:{type:"api_key",key:"selected-alpha-key"},beta:{type:"api_key",key:"store-default-beta-key"}}}}}),{mode:0o600});
await writeFile(join(root,"parent.jsonl"),JSON.stringify({type:"session",version:3,id:sessionId,timestamp:new Date().toISOString(),cwd})+"\n"+JSON.stringify({type:"custom",id:"11111111",parentId:null,timestamp:new Date().toISOString(),customType:"pi-accounts-selection",data:{version:1,sessionId,providers:{openai:"alpha"}}})+"\n",{mode:0o600});
const env={PATH:process.env.PATH,HOME:home,LANG:"C.UTF-8",TMPDIR:root,XDG_STATE_HOME:join(root,"state"),XDG_CONFIG_HOME:join(root,"config"),XDG_CACHE_HOME:join(root,"cache"),PASEO_HOME:join(root,"paseo"),TMUX_TMPDIR:join(root,"tmux"),PI_CODING_AGENT_DIR:agent,PI_SUBAGENT_BIN:raw,PI_TUI_WORKER_LAUNCHER:raw,PI_PASEO_BRIDGE_NO_IMPORT:"1",TEST_SOCKET:join(root,"fixture.sock"),TEST_CALLS:join(root,"calls.jsonl")};
child=spawn(raw,["--mode","rpc","--no-extensions","--extension",join(source,"routed-parent.ts"),"--provider","openai","--model","gpt-6.1-sol","--session",join(root,"parent.jsonl"),"--tools","read,bash,edit,write,goal_manage,goal_complete,goal_blocked,goal_wait,update_progress"],{env,cwd,stdio:["pipe","pipe","pipe"]});child.stdin.on("error",()=>{});child.stdout.on("data",c=>{if(c.toString().includes('"success":false'))output+=c.toString();});child.stderr.on("data",c=>{output+=c.toString();});
let state=await until(snapshot,"routed parent startup");assert.equal((await rpc({fixture:"route"})).accountId,"alpha");
state=await settle(await rpc({operation:"start",requestId:randomUUID(),action:"goals.create",expectedGoalId:null,expectedRegistryRevision:state.delegatedGoals.revision,objective:"Verify routed named account offline"}));const entry=state.delegatedGoals.entries[0];
state=await settle(await rpc({operation:"start",requestId:randomUUID(),action:"goals.start",expectedGoalId:entry.id,expectedEntryRevision:entry.revision}));
state=await until(async()=>{const s=await snapshot();if(s.notice)output=s.notice+"\n"+output;return s.delegatedGoals.entries[0].status==="complete"?s:null;},"routed child completion");
const calls=(await readFile(join(root,"calls.jsonl"),"utf8")).trim().split("\n").map(JSON.parse);assert(calls.length);assert(calls.every(c=>c.child&&c.selectedAccount&&!c.wrongDefault&&c.model==="gpt-6.1-sol"&&c.provider==="openai"&&c.goalId));
console.log("actual unguarded dedicated selected-account routing passed",{calls:calls.length,selectedAccount:"alpha",differentStoreDefault:"beta"});
}catch(error){keep=true;console.error("Routing fixture retained: "+root+"\n"+output);throw error;}finally{if(child&&child.exitCode===null){child.stdin.end();await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill("SIGTERM");resolve();},15000);child.once("close",()=>{clearTimeout(timer);resolve();});});}if(!keep)await rm(root,{recursive:true,force:true});}
