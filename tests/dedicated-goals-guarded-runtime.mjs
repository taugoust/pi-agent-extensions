import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createConnection } from "node:net";
import { cp, mkdtemp, mkdir, writeFile, appendFile, readFile, rename, rm, realpath, readdir, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { requestGoalWorker } from "../subagent/goal-rpc.ts";

const raw = process.env.PI_GUARDED_TEST_PI, agentsh = process.env.PI_GUARDED_TEST_AGENTSH;
assert(raw?.startsWith("/nix/store/") && agentsh?.startsWith("/nix/store/"), "Set explicit immutable raw PI_GUARDED_TEST_PI and PI_GUARDED_TEST_AGENTSH");
const root = await mkdtemp(join(tmpdir(), "pi-goals-guarded-"));
const home=join(root,"home"), agent=join(home,".pi","agent"), cwd=join(root,"repo"), source=join(root,"candidate"), socketPath=join(root,"fixture.sock");
let proc, output="", keep=false, packagePath, frames="", parentInfo;
let cleanupVerified=false;
const uiDecisions=[];
// Cleanup is established before importing a store candidate or starting ANY process.
async function cleanup() {
  if(proc && proc.exitCode===null) {
    proc.stdin.end();
    await new Promise(resolve=>{const timer=setTimeout(()=>{proc.kill("SIGTERM");resolve();},15000);proc.once("close",()=>{clearTimeout(timer);resolve();});});
  }
  if(!keep) {
    const calls=(await readFile(join(root,"calls.jsonl"),"utf8")).trim().split("\n").map(JSON.parse);
    for(const owned of [...calls,parentInfo].filter(Boolean)) {
      try {
        const now=await readFile(`/proc/${owned.pid}/stat`,"utf8");
        assert.notEqual(now.slice(now.lastIndexOf(")")+2).split(" ")[19],owned.processStart,"owned fixture process must have exited");
      } catch(error) {if(error.code!=="ENOENT")throw error;}
    }
    await assert.rejects(stat(parentInfo.gateSocket),/ENOENT/,"one-shot real gate socket must be removed");
    assert.deepEqual(await readdir(join(root,"paseo")),[]);
    assert.deepEqual(await readdir(join(root,"tmux")),[]);
    await assert.rejects(stat(join(root,"topology-attempt")),/ENOENT/);
    cleanupVerified=true;
    await rm(root,{recursive:true,force:true});
    console.log("guarded fixture cleanup verified: owned processes exited; real gate socket removed; no Paseo/tmux invocation; temp root removed");
  }
}
const provider=String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { appendFileSync,readFileSync,existsSync } from "node:fs";
export default function provider(pi) {
  let ctx,calls=0;
  pi.on("session_start",async(_e,c)=>{ctx=c;});
  pi.registerProvider("harness-test",{api:"openai-responses",apiKey:"test-only",baseUrl:"http://127.0.0.1:1",
    models:[{id:"gpt-6.1-sol",name:"Guarded fake Sol",reasoning:false,input:["text"],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],
    streamSimple(model,_context,options) {
      calls++;
      const branch=ctx.sessionManager.getBranch(),goal=branch.findLast(e=>e.type==="custom"&&e.customType==="goal-state")?.data?.goal;
      const child=process.env.PI_DEDICATED_GOAL_CHILD==="1",base=process.env.TEST_FILES;
      const tools=pi.getActiveTools(),results=branch.filter(e=>e.type==="message"&&e.message?.role==="toolResult").map(e=>e.message);
      appendFileSync(process.env.TEST_CALLS,JSON.stringify({pid:process.pid,processStart:readFileSync('/proc/self/stat','utf8').slice(readFileSync('/proc/self/stat','utf8').lastIndexOf(')')+2).split(' ')[19],child,binding:process.env.PI_DEDICATED_GOAL_BINDING??null,model:model.id,provider:model.provider,sessionId:ctx.sessionManager.getSessionId(),goalId:goal?.id??null,tools,results})+"\n");
      const response={role:"assistant",api:"openai-responses",provider:model.provider,model:model.id,timestamp:Date.now(),stopReason:"stop",content:[{type:"text",text:"Fixture done"}],usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      let name,args;
      if(child) {
        if(!goal?.id)throw new Error("Dedicated call lacks real child goal");
        const sequence=[
          ["read",{path:base+"/denied-read.txt"}],
          ["write",{path:base+"/denied-write.txt",content:"BYPASSED_NATIVE_POLICY"}],
          ["parent_bash",{command:"sudo cat "+base+"/denied-read.txt"}],
          ["parent_bash",{command:"sudo sh -c 'printf DENIED > "+base+"/denied-write.txt'"}],
          ["parent_bash",{command:"cat "+base+"/allowed-read.txt"}],
          ["parent_bash",{command:"printf ALLOWED > "+base+"/allowed-write.txt"}],
          ["goal_complete",{goal_id:"stale-foreign-goal-id",summary:"Verified actual guarded fixture allow and deny outcomes"}],
          ["goal_complete",{goal_id:goal.id,summary:"Verified actual guarded fixture allow and deny outcomes"}],
        ];
        if(sequence[calls-1])[name,args]=sequence[calls-1];
      } else {
        if(process.env.PI_DEDICATED_GOAL_BINDING)throw new Error("Ordinary worker inherited dedicated binding");
        const sequence=[
          ["read",{path:base+"/allowed-read.txt"}],
          ["write",{path:base+"/ordinary-denied-write.txt",content:"BYPASS"}],
          ["task_outcome",{version:1,state:"delivered",summary:"Ordinary worker kept explicit read-only tools and no goal identity",acceptance:[{criterion:"Verify ordinary guarded worker isolation",status:"passed",evidence:"read allowed; write absent; dedicated env absent"}],artifacts:[],remaining:[]}],
        ];
        if(sequence[calls-1])[name,args]=sequence[calls-1];
      }
      if(name){response.stopReason="toolUse";response.content=[{type:"toolCall",id:"call-"+process.pid+"-"+calls,name,arguments:args}];}
      const stream=createAssistantMessageEventStream();let done=false;
      const finish=aborted=>{if(done)return;done=true;if(aborted){response.stopReason="aborted";response.errorMessage="fixture abort";stream.push({type:"error",reason:"aborted",error:response});}else{stream.push({type:"start",partial:response});stream.push({type:"done",reason:response.stopReason,message:response});}stream.end(response);};
      options.signal?.addEventListener("abort",()=>finish(true),{once:true});
      if(child&&calls===1)void(async()=>{while(!done&&!existsSync(process.env.TEST_RELEASE))await new Promise(r=>setTimeout(r,5));if(!done)finish(false);})();
      else queueMicrotask(()=>finish(false));return stream;
    }});
}
`;
const parent=String.raw`
import gate from "./permission-gate/index.ts";
import workflows from "./workflows/index.ts";
import subagent,{runSingleSubagent} from "./subagent/index.ts";
import progress from "./progress/index.ts";
import provider from "./fake-provider.ts";
import { currentSubagentPermissionAuthority } from "./shared/subagent-permission.ts";
import { createSubagentChildId,reserveSubagentChildren } from "./subagent/control.ts";
import { createTaskId } from "./subagent/resume.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
export default function fixture(pi) {
  provider(pi);gate(pi);progress(pi);workflows(pi);subagent(pi);
  let server,ctx,original;
  pi.on("session_start",async(_e,c)=>{
    ctx=c;original=pi.getActiveTools();
    server=createServer(socket=>{socket.setEncoding("utf8");let text="";socket.on("error",()=>{});
      socket.on("data",chunk=>{text+=chunk;if(!text.includes("\n"))return;const r=JSON.parse(text.slice(0,text.indexOf("\n")));
        void(async()=>{
          if(r.fixture==="info")return{pid:process.pid,processStart:readFileSync('/proc/self/stat','utf8').slice(readFileSync('/proc/self/stat','utf8').lastIndexOf(')')+2).split(' ')[19],gateSocket:globalThis.__paeAgentSHPermissionGateClaimV1?.rawSocket};
          if(r.fixture==="tools") {if(!r.tools.every(t=>original.includes(t)))throw new Error("Fixture may only narrow CLI tool ceiling");pi.setActiveTools(r.tools);return{};}
          if(r.fixture==="ordinary") {
            const oldMode=process.env.PI_DEDICATED_GOAL_CHILD,oldBinding=process.env.PI_DEDICATED_GOAL_BINDING;
            process.env.PI_DEDICATED_GOAL_CHILD="1";process.env.PI_DEDICATED_GOAL_BINDING="stale-parent-binding";
            try {
              const owner=ctx.sessionManager.getSessionId(),identity={child:1,childId:createSubagentChildId(),taskId:createTaskId(),label:"ordinary fixture",task:"Verify ordinary guarded worker isolation"};
              reserveSubagentChildren(owner,"native",[identity]);
              return await runSingleSubagent(ctx.cwd,{task:identity.task,model:"harness-test/gpt-6.1-sol",tools:["read"],acceptance:["Verify ordinary guarded worker isolation"]},identity,undefined,undefined,undefined,results=>({mode:"single",results}),currentSubagentPermissionAuthority(),owner,{agentDir:getAgentDir(),routingEnvironment:{}});
            } finally {if(oldMode===undefined)delete process.env.PI_DEDICATED_GOAL_CHILD;else process.env.PI_DEDICATED_GOAL_CHILD=oldMode;if(oldBinding===undefined)delete process.env.PI_DEDICATED_GOAL_BINDING;else process.env.PI_DEDICATED_GOAL_BINDING=oldBinding;}
          }
          const s=globalThis.__paeWorkflowsV1;return await s.handle({...r,sessionId:s.sessionId,serviceEpoch:s.serviceEpoch});
        })().then(result=>socket.end(JSON.stringify({ok:true,result})+"\n"),error=>socket.end(JSON.stringify({ok:false,error:error.message})+"\n"));
      });});
    await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(process.env.TEST_SOCKET,resolve);});
  });
  pi.on("session_shutdown",async()=>{server?.close();});
}
`;
async function request(input) {
  return await new Promise((resolve,reject)=>{const s=createConnection(socketPath);let text="";s.setEncoding("utf8");s.setTimeout(45000,()=>{s.destroy();reject(new Error("fixture timeout"));});s.on("error",reject);s.on("connect",()=>s.write(JSON.stringify(input)+"\n"));s.on("data",chunk=>{text+=chunk;if(!text.includes("\n"))return;s.destroy();const r=JSON.parse(text.slice(0,text.indexOf("\n")));r.ok?resolve(r.result):reject(new Error(r.error));});});
}
const snapshot=()=>request({operation:"snapshot"});
const mutate=(action,rest={})=>request({operation:"start",requestId:randomUUID(),action,...rest});
async function until(fn,label,timeout=45000){const end=Date.now()+timeout;let last;while(Date.now()<end){if(proc&&proc.exitCode!==null)throw new Error("guard wrapper exited: "+output);try{const value=await fn();if(value)return value;}catch(e){last=e;}await new Promise(r=>setTimeout(r,30));}throw new Error(label+": "+(last?.stack??"timeout")+"\n"+output);}
async function settle(state){const end=Date.now()+45000;while(state.operationId){if(Date.now()>end)throw new Error("operation timeout "+JSON.stringify(state));if(state.dialog)state=await request({operation:"send",requestId:randomUUID(),operationId:state.operationId,dialogId:state.dialog.id,value:true});else{await new Promise(r=>setTimeout(r,20));state=await snapshot();}}return state;}
try {
  await mkdir(agent,{recursive:true});await mkdir(cwd,{recursive:true});
  for(const dir of ["runtime","state","config","cache","paseo","tmux","bin"])await mkdir(join(root,dir),{recursive:true,mode:0o700});
  const shell=execFileSync("sh",["-c","command -v sh"],{encoding:"utf8"}).trim();
  for(const name of ["paseo","tmux"])await writeFile(join(root,"bin",name),`#!${shell}\nprintf topology-denied > '${join(root,"topology-attempt")}'\nexit 125\n`,{mode:0o700});
  await cp(resolve(dirname(fileURLToPath(import.meta.url)),".."),source,{recursive:true,filter:path=>!path.split("/").some(p=>[".git",".direnv","node_modules","plans"].includes(p))});
  if(process.env.PI_GUARDED_TEST_ACCOUNT_MODULES) {
    assert(process.env.PI_GUARDED_TEST_ACCOUNT_MODULES.startsWith("/nix/store/"),"Use existing immutable packaged account dependencies only");
    await symlink(process.env.PI_GUARDED_TEST_ACCOUNT_MODULES,join(source,"openai-accounts","node_modules"),"dir");
  }
  await writeFile(join(source,"fake-provider.ts"),provider);await writeFile(join(source,"guard-parent.ts"),parent);
  await appendFile(join(source,"subagent","index.ts"),"\nexport { runSingleSubagent };\n");
  await rename(join(source,"subagent","permission-proxy.ts"),join(source,"subagent","permission-proxy-real.ts"));
  await writeFile(join(source,"subagent","permission-proxy.ts"),'import provider from "../fake-provider.ts";import proxy from "./permission-proxy-real.ts";export default function(pi){provider(pi);proxy(pi);}\n');
  const importEnv={PATH:process.env.PATH,HOME:home,NIX_CONFIG:"experimental-features = nix-command flakes"};
  packagePath=execFileSync("nix",["store","add-path","--name","pi-guarded-goals-fixture",source],{env:importEnv,encoding:"utf8",timeout:60000}).trim();
  assert(packagePath.startsWith("/nix/store/"));assert.equal(await realpath(join(packagePath,"subagent","goal-worker.ts")),join(packagePath,"subagent","goal-worker.ts"));
  await writeFile(join(agent,"settings.json"),JSON.stringify({defaultProvider:"harness-test",defaultModel:"gpt-6.1-sol",compaction:{enabled:false},retry:{enabled:false}}));await writeFile(join(agent,"auth.json"),"{}");
  await writeFile(join(cwd,"denied-read.txt"),"DENIED_NATIVE_READ_SECRET");await writeFile(join(cwd,"denied-write.txt"),"UNTOUCHED");await writeFile(join(cwd,"ordinary-denied-write.txt"),"UNTOUCHED");await writeFile(join(cwd,"allowed-read.txt"),"ALLOWED_READ");
  // Whitelist only. No inherited routing/gate/session/topology/Paseo/tmux variables.
  const env={PATH:join(root,"bin")+":"+process.env.PATH,HOME:home,LANG:"C.UTF-8",TMPDIR:root,XDG_RUNTIME_DIR:join(root,"runtime"),XDG_STATE_HOME:join(root,"state"),XDG_CONFIG_HOME:join(root,"config"),XDG_CACHE_HOME:join(root,"cache"),PASEO_HOME:join(root,"paseo"),TMUX_TMPDIR:join(root,"tmux"),PI_CODING_AGENT_DIR:agent,PI_TUI_WORKER_LAUNCHER:raw,PI_PASEO_BRIDGE_NO_IMPORT:"1",TEST_SOCKET:socketPath,TEST_CALLS:join(root,"calls.jsonl"),TEST_FILES:cwd,TEST_RELEASE:join(root,"release-model")};
  proc=spawn(agentsh,["permission-gate","run","--audit-log",join(root,"gate-audit.jsonl"),"--",raw,"--mode","rpc","--no-extensions","--extension",join(packagePath,"guard-parent.ts"),"--provider","harness-test","--model","gpt-6.1-sol","--session",join(root,"parent.jsonl"),"--tools","read,bash,edit,write,goal_manage,goal_complete,goal_blocked,goal_wait,update_progress"],{cwd,env,stdio:["pipe","pipe","pipe"]});
  proc.stdin.on("error",()=>{});proc.stderr.on("data",c=>{output+=c.toString();});proc.stdout.on("data",c=>{frames+=c.toString();let end;while((end=frames.indexOf("\n"))>=0){const line=frames.slice(0,end);frames=frames.slice(end+1);try{const e=JSON.parse(line);if(e.type==="extension_ui_request"&&e.method==="select"){assert(e.options.includes("Deny"));uiDecisions.push(e);proc.stdin.write(JSON.stringify({type:"extension_ui_response",id:e.id,value:"Deny"})+"\n");}else if(e.success===false)output+=line+"\n";}catch(error){output+=line+"\n";}}});
  let state=await until(snapshot,"guard parent startup");parentInfo=await request({fixture:"info"});assert.equal(state.capabilities.delegatedGoalExecution,true,JSON.stringify(state));
  const controls=["goal_manage","goal_complete","goal_blocked","goal_wait","update_progress"];
  await request({fixture:"tools",tools:["bash",...controls.filter(t=>t!=="goal_complete")]});
  state=await settle(await mutate("goals.create",{expectedGoalId:null,expectedRegistryRevision:state.delegatedGoals.revision,objective:"Guarded restricted checks"}));
  let entry=state.delegatedGoals.entries[0];
  state=await settle(await mutate("goals.start",{expectedGoalId:entry.id,expectedEntryRevision:entry.revision}));assert.match(state.notice,/goal_complete/);assert.equal(state.delegatedGoals.entries[0].child,null);
  await assert.rejects(readFile(join(root,"calls.jsonl")),/ENOENT/);
  await request({fixture:"tools",tools:["bash",...controls]});
  state=await settle(await mutate("goals.start",{expectedGoalId:entry.id,expectedEntryRevision:entry.revision}));
  const firstCall=await until(async()=>{try{return JSON.parse((await readFile(join(root,"calls.jsonl"),"utf8")).trim().split("\n")[0]);}catch{return null;}},"held guarded child first call");
  const binding=JSON.parse(firstCall.binding);
  assert.equal(binding.entryId,entry.id);assert.equal(binding.identity.sessionId,state.sessionId);
  assert.equal(binding.identity.taskId,state.delegatedGoals.entries[0].child.taskId);
  assert.equal(binding.identity.childId,state.delegatedGoals.entries[0].child.childId);
  assert.equal(binding.identity.attempt,state.delegatedGoals.entries[0].child.attempt);
  for(const stale of [{...binding.identity,attempt:binding.identity.attempt+1},{...binding.identity,sessionId:"foreign-parent-session"},{...binding.identity,workerEpoch:"stale-epoch"}])
    await assert.rejects(requestGoalWorker(binding.path,{token:binding.token,identity:stale,request:{operation:"observe"}}),/Stale goal worker identity/);
  await assert.rejects(requestGoalWorker(binding.path,{token:binding.token,identity:binding.identity,request:{operation:"resume",entry:{...entry,id:"foreign-parent-entry"}}}),/matching parent metadata|parent goal identity/);
  await writeFile(join(root,"release-model"),"release fake response");
  state=await until(async()=>{const s=await snapshot();if(s.notice)output=s.notice+"\n"+output;return s.delegatedGoals.entries[0].status==="complete"?s:null;},"guarded child completes");
  entry=state.delegatedGoals.entries[0];assert(entry.child.taskId);
  const records=(await readFile(join(root,"calls.jsonl"),"utf8")).trim().split("\n").map(JSON.parse),last=records.at(-1);
  assert(records.every(r=>r.child&&r.provider==="harness-test"&&r.model==="gpt-6.1-sol"&&r.goalId));
  assert(records.every(r=>!r.tools.includes("read")&&!r.tools.includes("write")&&!r.tools.includes("bash")&&r.tools.includes("parent_bash")),"effective parent restriction must intersect child CLI tools");
  assert(!JSON.stringify(last.results).includes("DENIED_NATIVE_READ_SECRET"));
  assert.equal(await readFile(join(cwd,"denied-write.txt"),"utf8"),"UNTOUCHED");assert.equal(await readFile(join(cwd,"allowed-write.txt"),"utf8"),"ALLOWED");
  assert.equal(last.results.filter(r=>r.toolName==="parent_bash"&&JSON.stringify(r).includes("Blocked by parent AgentSH Permission Gate")).length,2,"both real read/write deny receipts must reach executed proxy");
  assert(last.results.some(r=>r.toolName==="parent_bash"&&JSON.stringify(r).includes("ALLOWED_READ")));
  assert(last.results.some(r=>r.toolName==="goal_complete"&&JSON.stringify(r).includes("Goal completion rejected")),"stale child contract cannot authorize completion");
  const audit=await readFile(join(root,"gate-audit.jsonl"),"utf8");assert.match(audit,/deny/);assert.match(audit,/allow/);assert.match(audit,/sudo cat/);assert.match(audit,/printf ALLOWED/);
  await request({fixture:"tools",tools:["read","bash",...controls]});
  const ordinary=await request({fixture:"ordinary"});assert.equal(ordinary.exitCode,0,JSON.stringify(ordinary));
  const all=(await readFile(join(root,"calls.jsonl"),"utf8")).trim().split("\n").map(JSON.parse),normal=all.filter(r=>!r.child);
  assert(normal.length);assert(normal.every(r=>r.binding===null&&r.goalId===null&&r.tools.includes("read")&&!r.tools.includes("write")&&!r.tools.includes("goal_complete")));
  assert.equal(await readFile(join(cwd,"ordinary-denied-write.txt"),"utf8"),"UNTOUCHED");
  // No topology command is invoked by this fixture; private homes must remain unpopulated.
  assert.equal(await readFile(join(cwd,"denied-read.txt"),"utf8"),"DENIED_NATIVE_READ_SECRET");
  console.log("actual immutable guarded Pi registry lifecycle passed",{packagePath,calls:all.length,childCalls:records.length,uiDenials:uiDecisions.length,auditBytes:audit.length});
} catch(error){keep=true;console.error(`Guard fixture retained: ${root}\nCandidate: ${packagePath}\n${output}`);throw error;}
finally{try{await cleanup();}catch(error){console.error(`Cleanup verification failed; owned fixture retained: ${root}`);throw error;}}
