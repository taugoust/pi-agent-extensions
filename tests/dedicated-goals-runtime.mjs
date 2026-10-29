import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { cp, mkdtemp, mkdir, writeFile, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const raw = process.env.PI_DEDICATED_TEST_PI;
assert.ok(raw && /^\/nix\/store\/[^/]+\/.+/.test(raw), "Set PI_DEDICATED_TEST_PI to an immutable raw Pi executable under /nix/store (not an AgentSH wrapper)");
const root = await mkdtemp(join(tmpdir(), "pi-goals-runtime-"));
const copied = join(root, "source"), home = join(root, "home"), agent = join(home, ".pi", "agent"), cwd = join(root, "repo");
let child, output = "", keep = false, lastSnapshot;
const confirmations = [];
const provider = String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { appendFileSync, existsSync } from "node:fs";
export default function fakeProvider(pi) {
  let ctx, calls = 0;
  pi.on("session_start", async (_event, next) => { ctx = next; });
  pi.registerProvider("harness-test", {
    api: "openai-responses", apiKey: "test-only", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "gpt-6.1-sol", name: "Isolated fake Sol", reasoning: false, input: ["text"],
      contextWindow: 128000, maxTokens: 4096, cost: { input:0, output:0, cacheRead:0, cacheWrite:0 } }],
    streamSimple(model, context, options) {
      calls++;
      const isChild = process.env.PI_DEDICATED_GOAL_CHILD === "1";
      const goal = ctx?.sessionManager.getBranch().findLast(e => e.type === "custom" && e.customType === "goal-state")?.data?.goal;
      appendFileSync(process.env.TEST_CALLS, JSON.stringify({ pid: process.pid, isChild, model: model.id, provider: model.provider,
        goalId: goal?.id ?? null, activationId: goal?.activationId ?? null, goalText: goal?.text ?? null, calls, activated:globalThis.__fixtureActivation===true, limits:globalThis.__paeDelegatedChildGoalV1?.snapshot().limits, sessionId: ctx?.sessionManager.getSessionId() }) + "\n");
      if(isChild && globalThis.__fixtureActivation!==true) throw new Error("Automatic child model call before explicit structured activation");
      const stream = createAssistantMessageEventStream();
      const response = { role:"assistant", api:"openai-responses", provider:"harness-test", model:model.id,
        timestamp:Date.now(), stopReason:"stop", content:[{type:"text", text:"Fixture waiting."}],
        usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}} };
      let finished = false;
      const finish = aborted => {
        if (finished) return; finished = true;
        if (aborted) { response.stopReason = "aborted"; response.errorMessage = "isolated fixture aborted";
          stream.push({type:"error",reason:"aborted",error:response}); }
        else { stream.push({type:"start",partial:response}); stream.push({type:"done",reason:response.stopReason,message:response}); }
        stream.end(response);
      };
      options.signal?.addEventListener("abort", () => finish(true), {once:true});
      if (isChild) {
        if (!goal?.id) throw new Error("Child model call lacks actual active Goal identity");
        if (goal.text.includes("Question workflow")) {
          response.stopReason="toolUse";
          if(calls===1) response.content=[{type:"toolCall",id:"question-"+process.pid,name:"questionnaire",arguments:{questions:[{id:"direction",prompt:"Use the tested design?",options:[{value:"yes",label:"Yes"},{value:"no",label:"No"}],allowOther:false}]}}];
          else if(calls===2) response.content=[{type:"toolCall",id:"activity-"+process.pid,name:"notify_parent",arguments:{message:"Explicit fixture activity after the user's answer"}}];
          else response.content=[{type:"toolCall",id:"question-complete-"+process.pid,name:"goal_complete",arguments:{goal_id:goal.id,activation_id:goal.activationId,summary:"Verified authenticated goal question answer"}}];
        } else if (goal.text.includes("pause-race") && calls === 1) {
          response.stopReason="toolUse";response.content=[{type:"toolCall",id:"race-"+process.pid,name:"goal_complete",arguments:{goal_id:goal.id,activation_id:goal.activationId,summary:"Verified owned pause/completion race"}}];
        } else if (goal.text.includes("independent") && calls <= 2) {
          response.stopReason="toolUse"; response.content=[{type:"toolCall",id:"complete-"+process.pid+"-"+calls,name:"goal_complete",arguments:{goal_id:calls===1?"stale-foreign-goal-id":goal.id,activation_id:goal.activationId,summary:"Verified isolated deterministic child completion"}}];
        } else if (!goal.text.includes("independent") && calls === 1) {
          response.stopReason="toolUse"; response.content=[{type:"toolCall",id:"wait-"+process.pid,name:"goal_wait",arguments:{goal_id:goal.id,activation_id:goal.activationId,reason:"isolated test explicit wake"}}];
        }
        if(goal.text.includes("pause-race")&&calls===1)void(async()=>{while(!finished&&!existsSync(process.env.TEST_PAUSE_RELEASE))await new Promise(resolve=>setTimeout(resolve,5));if(!finished)finish(false);})();
        else queueMicrotask(() => finish(false));
      }
      return stream;
    },
  });
}
`;
const parent = String.raw`
import workflows from "./workflows/index.ts";
import subagent from "./subagent/index.ts";
import progress from "./progress/index.ts";
import questionnaire from "./questionnaire/index.ts";
import provider from "./fake-provider.ts";
import { createServer } from "node:net";
export default function fixture(pi) {
  provider(pi); progress(pi); questionnaire(pi); workflows(pi); subagent(pi);
  let server, allowedTools;
  pi.on("session_start", async () => {
    allowedTools = pi.getActiveTools();
    server = createServer(socket => {
      socket.setEncoding("utf8"); let data="";
      socket.on("error",()=>{});
      socket.on("data", chunk => { data+=chunk; if (!data.includes("\n")) return;
        const input=JSON.parse(data.slice(0,data.indexOf("\n")));
        if(input.fixture === "deny-goal-complete") { pi.setActiveTools(allowedTools.filter(name=>name!=="goal_complete")); socket.end(JSON.stringify({ok:true,result:{}})+"\n");return; }
        if(input.fixture === "hide-completion") {
          const executor=globalThis.__paeDelegatedGoalExecutorV1, observe=executor.observe;
          executor.observe=entry=>entry.text.includes("independent second")?Promise.resolve(null):observe(entry);
          socket.end(JSON.stringify({ok:true,result:{}})+"\n");return;
        }
        if(input.fixture === "restore-tools") { pi.setActiveTools(allowedTools); socket.end(JSON.stringify({ok:true,result:{}})+"\n");return; }
        const service=globalThis.__paeWorkflowsV1;
        const request={...input,sessionId:service.sessionId,serviceEpoch:service.serviceEpoch};
        Promise.resolve(service.handle(request)).then(result=>socket.end(JSON.stringify({ok:true,result})+"\n"),error=>socket.end(JSON.stringify({ok:false,error:error.message})+"\n"));
      });
    });
    await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(process.env.TEST_SOCKET,resolve);});
  });
  pi.on("session_shutdown",async()=>{server?.close();});
}
`;
async function rpc(input) {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(join(root,"fixture.sock")); let data="";
    socket.setEncoding("utf8"); socket.setTimeout(30_000,()=>{socket.destroy();reject(new Error("fixture request timed out"));});
    socket.on("connect",()=>socket.write(JSON.stringify(input)+"\n")); socket.on("error",reject);
    socket.on("data",chunk=>{data+=chunk;if(!data.includes("\n"))return;socket.destroy();const value=JSON.parse(data.slice(0,data.indexOf("\n")));if(value.ok){lastSnapshot=value.result;resolve({...value.result,goals:value.result.delegatedGoals});}else reject(new Error(value.error));});
  });
}
async function stopParent() {
  if(!child || child.exitCode!==null)return;
  child.stdin.write(JSON.stringify({id:"abort-parent",type:"abort"})+"\n");
  child.stdin.end();
  await new Promise(resolve=>{
    const timer=setTimeout(()=>{child.kill("SIGTERM");},10_000);
    child.once("close",()=>{clearTimeout(timer);resolve();});
  });
}
async function until(fn, description, timeout=30_000) {
  const deadline=Date.now()+timeout; let last;
  while(Date.now()<deadline) { if(child?.exitCode!==null&&child?.exitCode!==undefined)throw new Error(`Pi exited: ${output}`);
    try { const value=await fn();if(value)return value; } catch(error){last=error;}
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw new Error(`${description}: ${last?.message??"timeout"}\n${JSON.stringify(lastSnapshot)}\n${output.slice(-5000)}`);
}
const snapshot=()=>rpc({operation:"snapshot"});
const mutate=(action,fields={})=>rpc({operation:"start",requestId:randomUUID(),action,...fields});
async function settle(snapshotValue) {
  let next=snapshotValue;
  const deadline=Date.now()+30_000;
  while(next.operationId) {
    if(Date.now()>deadline)throw new Error(`Workflow did not settle: ${JSON.stringify(next)}`);
    if(next.dialog) {
      confirmations.push(next.dialog.message);
      next=await rpc({operation:"send",requestId:randomUUID(),operationId:next.operationId,dialogId:next.dialog.id,value:true});
    }
    else { await new Promise(resolve=>setTimeout(resolve,20));next=await snapshot(); }
  }
  return next;
}
try {
  await mkdir(agent,{recursive:true}); await mkdir(cwd,{recursive:true});
  await cp(source,copied,{recursive:true,filter:path=>!path.split("/").some(part=>[".git",".direnv",".dev","node_modules","plans"].includes(part))});
  await writeFile(join(copied,"fake-provider.ts"),provider);
  await writeFile(join(copied,"runtime-parent.ts"),parent);
  await rename(join(copied,"subagent","goal-worker.ts"),join(copied,"subagent","goal-worker-real.ts"));
  await writeFile(join(copied,"subagent","goal-worker.ts"),String.raw`
import provider from "../fake-provider.ts";
import worker from "./goal-worker-real.ts";
import { appendFileSync, writeFileSync } from "node:fs";
export default async function(pi) {
  globalThis.__fixtureActivation=false;
  provider(pi); await worker(pi);
  pi.on("session_start",async()=>{
    const service=globalThis.__paeDelegatedChildGoalV1;
    for(const name of ["bootstrap","resume"]) {
      const original=service[name].bind(service);
      service[name]=async(...args)=>{
        globalThis.__fixtureActivation=true;
        if(name==="bootstrap")globalThis.__fixturePauseRace=args[0]?.text?.includes("pause-race");
        const result=await original(...args);
        if(name==="bootstrap" && args[0]?.text?.includes("independent")) {
          const deadline=Date.now()+10000;
          while(Date.now()<deadline) {
            const terminal=service.snapshot();
            if(terminal.goal?.status==="complete") {
              appendFileSync(process.env.TEST_RECEIPTS,JSON.stringify({operation:name,status:"complete",childGoalId:terminal.childGoalId})+"\n");
              return terminal;
            }
            await new Promise(resolve=>setTimeout(resolve,5));
          }
          throw new Error("Fixture expected child completion before Start reply");
        }
        return result;
      };
    }
    const pause=service.pause.bind(service);
    service.pause=async(...args)=>{
      if(globalThis.__fixturePauseRace) {
        writeFileSync(process.env.TEST_PAUSE_RELEASE,"release already-owned completion response");
        const deadline=Date.now()+10000;
        while(service.snapshot().goal?.status!=="complete") {
          if(Date.now()>deadline)throw new Error("Fixture completion did not win Pause race");
          await new Promise(resolve=>setTimeout(resolve,5));
        }
      }
      return await pause(...args);
    };
  });
}
`);
  await writeFile(join(agent,"settings.json"),JSON.stringify({defaultProvider:"harness-test",defaultModel:"gpt-6.1-sol",compaction:{enabled:false},retry:{enabled:false}}));
  await writeFile(join(agent,"auth.json"),"{}");
  await writeFile(join(agent,"pi-goal.json"),JSON.stringify({rpc:{enabled:false},continuationLimits:{automaticTurns:7,noProgressTurns:5}}));
  const env={PATH:process.env.PATH,HOME:home,LANG:"C.UTF-8",TMPDIR:root,PI_CODING_AGENT_DIR:agent,
    PI_SUBAGENT_BIN:raw,PI_TUI_WORKER_LAUNCHER:raw,PI_AGENTSH_MODE:"none",TEST_SOCKET:join(root,"fixture.sock"),TEST_CALLS:join(root,"calls.jsonl"),TEST_RECEIPTS:join(root,"receipts.jsonl"),TEST_PAUSE_RELEASE:join(root,"pause-release")};
  const launchParent=()=>{
    child=spawn(raw,["--mode","rpc","--no-extensions","--extension",join(copied,"runtime-parent.ts"),"--provider","harness-test","--model","gpt-6.1-sol","--session",join(root,"parent.jsonl"),"--tools","read,bash,edit,write,goal_manage,goal_complete,goal_blocked,goal_wait,update_progress,questionnaire"],{cwd,env,stdio:["pipe","pipe","pipe"]});
    child.stdin.on("error",()=>{});
    child.stdout.on("data",chunk=>{ const text=chunk.toString(); if(text.includes('"success":false')||text.includes('"type":"extension_error"'))output+=text; });
    child.stderr.on("data",chunk=>{output+=chunk.toString();});
  };
  launchParent();
  const stateView = value => ({ ...value, goals: value.delegatedGoals });
  const runtimeSnapshot = snapshot;
  let state=stateView(await until(runtimeSnapshot,"parent fixture startup"));
  assert.equal(state.capabilities.delegatedGoalExecution,true,JSON.stringify(state));
  assert.deepEqual(JSON.parse(await readFile(join(agent,"pi-goal.json"),"utf8")).continuationLimits,{automaticTurns:7,noProgressTurns:5},"fixture parent config uses non-default legacy limits");
  assert.deepEqual(state.limits,{automaticTurns:7,noProgressTurns:5},"registry advertises configured inherited limits");
  child.stdin.write(JSON.stringify({id:"hold-parent",type:"prompt",message:"Hold this isolated parent fake-provider turn; do not start any goal."})+"\n");
  await until(async()=>{try{return(await readFile(join(root,"calls.jsonl"),"utf8")).includes('"isChild":false');}catch{return false;}},"parent fake call");
  for(const text of ["Isolated first goal","Isolated independent second goal"]) {
    state=await settle(await mutate("goals.create",{expectedGoalId:null,expectedRegistryRevision:state.goals.revision,objective:text,...(text.includes("independent second")?{continuationLimits:{automaticTurns:11,noProgressTurns:6}}:{})}));
  }
  assert.equal(state.goals.entries.length,2);
  assert(state.goals.entries.every(e=>e.status==="paused"&&e.child===null));
  let calls=(await readFile(join(root,"calls.jsonl"),"utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.length,1,"paused creates cannot launch or prompt child/parent");
  let first=state.goals.entries[0],second=state.goals.entries[1];
  await rpc({fixture:"deny-goal-complete"});
  assert.equal((await snapshot()).capabilities.delegatedGoalExecution,false);
  state=await settle(await mutate("goals.start",{expectedGoalId:first.id,expectedEntryRevision:first.revision}));
  assert.match(state.notice,/goal_complete/);
  assert.equal(state.goals.entries[0].child,null);
  assert.equal((await readFile(join(root,"calls.jsonl"),"utf8")).trim().split("\n").length,1);
  await rpc({fixture:"restore-tools"});
  assert.equal((await snapshot()).capabilities.delegatedGoalExecution,true);
  state=await settle(await mutate("goals.start",{expectedGoalId:first.id,expectedEntryRevision:first.revision}));
  state=await until(async()=>{const s=await snapshot();return s.goals.entries[0].status==="active"&&s.goals.entries[0].waiting?s:null;},"first child waiting");
  first=state.goals.entries[0];second=state.goals.entries[1];
  assert(first.child?.taskId);assert.equal(second.child,null);assert.equal(second.status,"paused");
  let original=structuredClone(first.child);
  // Start the independent goal while the first Goal child is still active and
  // waiting. This exercises concurrent goal ownership, not just sequential runs.
  await rpc({fixture:"hide-completion"});
  state=await settle(await mutate("goals.start",{expectedGoalId:second.id,expectedEntryRevision:second.revision}));
  const staleSecond=structuredClone(state.goals.entries[1]);
  assert.equal(staleSecond.status,"active");
  await until(async()=>{
    const session=await readFile(join(agent,"state","native-tasks-v1",staleSecond.child.taskId,"session.jsonl"),"utf8");
    return session.includes('Goal complete: Verified isolated deterministic child completion');
  },"child completion persisted while parent registry remains stale");
  await stopParent();
  await rm(join(root,"fixture.sock"),{force:true});
  const callsBeforeReload=(await readFile(join(root,"calls.jsonl"),"utf8")).trim().split("\n").length;
  launchParent();
  state=await until(async()=>{const s=await snapshot();return s.goals.entries[1].status==="complete"?s:null;},"independent completion while first child remains active");
  assert.equal((await readFile(join(root,"calls.jsonl"),"utf8")).trim().split("\n").length,callsBeforeReload,"completion reconciliation cannot issue a model turn");
  assert.deepEqual(state.goals.entries[1].child,staleSecond.child,"completion reconciliation cannot create an attempt");
  assert.equal(state.goals.entries[0].status,"paused");
  first=state.goals.entries[0];
  state=await settle(await mutate("goals.resume",{expectedGoalId:first.id,expectedEntryRevision:first.revision}));
  state=await until(async()=>{const s=await snapshot();return s.goals.entries[0].status==="active"&&s.goals.entries[0].waiting?s:null;},"restore concurrent first child after ordering test");
  original=structuredClone(state.goals.entries[0].child);
  assert.deepEqual(state.goals.entries[0].child,original);
  assert.notEqual(state.goals.entries[1].child.taskId,original.taskId);
  // Preserve the executor's in-memory binding across Pause/Resume. The engine
  // rotates its activation token while goal/task/session identity stays stable.
  first=state.goals.entries[0];
  state=await settle(await mutate("goals.pause",{expectedGoalId:first.id,expectedEntryRevision:first.revision}));
  first=state.goals.entries[0];
  state=await settle(await mutate("goals.resume",{expectedGoalId:first.id,expectedEntryRevision:first.revision}));
  state=await until(async()=>{const s=await snapshot();return s.goals.entries[0].status==="active"&&s.goals.entries[0].waiting?s:null;},"same-parent retained-binding Resume");
  first=state.goals.entries[0];
  assert.equal(first.child.taskId,original.taskId);assert.equal(first.child.attempt,original.attempt+1);assert.notEqual(first.child.childId,original.childId);
  const sameParentTask=JSON.parse(await readFile(join(agent,"state","native-tasks-v1",original.taskId,"state.json"),"utf8"));
  const sameParentCalls=(await readFile(join(root,"calls.jsonl"),"utf8")).trim().split("\n").map(JSON.parse).filter(call=>call.sessionId===sameParentTask.sessionId);
  assert.equal(sameParentCalls.length,3);assert.equal(sameParentCalls[0].goalId,sameParentCalls[1].goalId);
  assert.ok(sameParentCalls[0].activationId);assert.notEqual(sameParentCalls[0].activationId,sameParentCalls[1].activationId);
  original=structuredClone(first.child);
  await stopParent();
  launchParent();
  state=await until(async()=>{const s=await snapshot();return s.goals.entries[0].status==="paused"?s:null;},"normal parent reload reconciles exact stopped child");
  first=state.goals.entries[0];assert.equal(first.status,"paused");
  assert.deepEqual(first.child,original);
  assert.equal((await readFile(join(root,"calls.jsonl"),"utf8")).trim().split("\n").length,6,"parent reload must not implicitly spawn or prompt any model");
  state=await settle(await mutate("goals.edit",{expectedGoalId:first.id,expectedEntryRevision:first.revision,objective:"Isolated first goal edited",tokenBudget:2000}));
  first=state.goals.entries[0];
  assert.equal(first.text,"Isolated first goal edited");
  state=await settle(await mutate("goals.add_task",{expectedGoalId:first.id,expectedEntryRevision:first.revision,text:"Verify paused metadata synchronization"}));
  first=state.goals.entries[0];
  assert.equal(first.tasks.length,1);assert.deepEqual(first.child,original);
  assert.equal((await readFile(join(root,"calls.jsonl"),"utf8")).trim().split("\n").length,6,"paused edits cannot launch children");
  // Simulate a prior crash with an overdue active wait in the stopped child's
  // retained session. A new worker must restore paused before any timer fires.
  const retainedPath=join(agent,"state","native-tasks-v1",original.taskId,"session.jsonl");
  const retainedLines=(await readFile(retainedPath,"utf8")).trim().split("\n").map(JSON.parse);
  const retainedGoal=retainedLines.findLast(e=>e.type==="custom"&&e.customType==="goal-state").data.goal;
  retainedGoal.status="active";retainedGoal.waiting={reason:"overdue crash-restored wait",resumeAt:Date.now()-1000};
  await writeFile(retainedPath,retainedLines.map(JSON.stringify).join("\n")+"\n");
  state=await settle(await mutate("goals.resume",{expectedGoalId:first.id,expectedEntryRevision:first.revision}));
  state=await until(async()=>{const s=await snapshot();return s.goals.entries[0].status==="active"&&s.goals.entries[0].waiting?s:null;},"resumed child waiting");
  first=state.goals.entries[0];assert.equal(first.text,"Isolated first goal edited");assert.equal(first.tasks.length,1);
  const sessionLines=(await readFile(join(agent,"state","native-tasks-v1",original.taskId,"session.jsonl"),"utf8")).trim().split("\n").map(JSON.parse);
  const resumedGoal=sessionLines.findLast(e=>e.type==="custom"&&e.customType==="goal-state")?.data?.goal;
  assert.equal(resumedGoal.text,"Isolated first goal edited");assert.equal(resumedGoal.tokenBudget,2000);
  assert.equal(first.child.taskId,original.taskId);assert.equal(first.child.attempt,original.attempt+1);assert.notEqual(first.child.childId,original.childId);
  state=await settle(await mutate("goals.pause",{expectedGoalId:first.id,expectedEntryRevision:first.revision}));first=state.goals.entries[0];
  for(const stoppedStatus of ["blocked","usage_limited","budget_limited"]) {
    const stoppedLines=(await readFile(retainedPath,"utf8")).trim().split("\n").map(JSON.parse);
    const stopped=stoppedLines.findLast(e=>e.type==="custom"&&e.customType==="goal-state").data.goal;
    stopped.status=stoppedStatus;delete stopped.waiting;
    if(stoppedStatus==="budget_limited") { stopped.tokenBudget=stopped.tokensUsed;stopped.tokenBudgetExplicit=true; }
    const previousId=stopped.id,previousActivation=stopped.activationId,previousAttempt=first.child.attempt,previousUsed=stopped.tokensUsed;
    await writeFile(retainedPath,stoppedLines.map(JSON.stringify).join("\n")+"\n");
    state=await settle(await mutate("goals.resume",{expectedGoalId:first.id,expectedEntryRevision:first.revision}));
    state=await until(async()=>{const s=await snapshot();return s.goals.entries[0].status==="active"&&s.goals.entries[0].waiting?s:null;},`explicit Resume of ${stoppedStatus}`);
    first=state.goals.entries[0];assert.equal(first.child.taskId,original.taskId);assert.equal(first.child.attempt,previousAttempt+1);
    const activated=(await readFile(retainedPath,"utf8")).trim().split("\n").map(JSON.parse).findLast(e=>e.type==="custom"&&e.customType==="goal-state").data.goal;
    assert.equal(activated.id,previousId);assert.notEqual(activated.activationId,previousActivation);assert(activated.tokensUsed>=previousUsed);
    assert.equal(activated.tokenBudget,2000,"budget-limited resume uses explicitly authorized increased metadata budget, never resets usage");
    state=await settle(await mutate("goals.pause",{expectedGoalId:first.id,expectedEntryRevision:first.revision}));first=state.goals.entries[0];
  }
  state=await settle(await mutate("goals.clear",{expectedGoalId:first.id,expectedEntryRevision:first.revision}));
  assert.equal(state.goals.entries[0].status,"cleared");assert.equal(state.goals.entries[1].status,"complete");
  second=state.goals.entries[1];
  assert.notEqual(second.child.taskId,original.taskId);assert.equal(state.goals.entries[0].status,"cleared");
  assert.match(second.summary,/Verified isolated deterministic child completion/);
  const earlyReplies=(await readFile(join(root,"receipts.jsonl"),"utf8")).trim().split("\n").map(JSON.parse);
  assert(earlyReplies.some(reply=>reply.operation==="bootstrap"&&reply.status==="complete"),"verified completion must precede actual Start RPC reply without losing child linkage");
  const secondHistory=await readFile(join(agent,"state","native-tasks-v1",second.child.taskId,"session.jsonl"),"utf8");
  assert.match(secondHistory,/Goal completion rejected/);assert.match(secondHistory,/stale-foreign-goal-id/);
  const completedTask=JSON.parse(await readFile(join(agent,"state","native-tasks-v1",second.child.taskId,"state.json"),"utf8"));
  assert.equal(completedTask.state,"idle");
  assert.match(completedTask.spec.model,/^harness-test\/gpt-6\.1-sol(?::[a-z]+)?$/,"retained model selector must stay on owning provider's explicit Sol model");
  assert.equal(completedTask.history.at(-1).outcome,"delivered");
  assert.equal(completedTask.history.at(-1).execution,"completed");
  const pausedTask=JSON.parse(await readFile(join(agent,"state","native-tasks-v1",original.taskId,"state.json"),"utf8"));
  assert(pausedTask.history.every(attempt=>attempt.outcome!=="delivered"),"ordinary pause/reload stop must never become successful completion");
  state=await settle(await mutate("goals.create",{expectedGoalId:null,expectedRegistryRevision:state.goals.revision,objective:"Isolated crash-exit goal"}));
  let crashed=state.goals.entries[2];
  state=await settle(await mutate("goals.start",{expectedGoalId:crashed.id,expectedEntryRevision:crashed.revision}));
  state=await until(async()=>{const s=await snapshot();return s.goals.entries[2].status==="active"&&s.goals.entries[2].waiting?s:null;},"owned exit fixture waiting");
  crashed=state.goals.entries[2];
  const crashRecord=JSON.parse(await readFile(join(agent,"state","native-tasks-v1",crashed.child.taskId,"state.json"),"utf8"));
  const stat=await readFile(`/proc/${crashRecord.childPid}/stat`,"utf8");
  assert.equal(stat.slice(stat.lastIndexOf(")")+2).split(" ")[19],crashRecord.childToken,"signal only this fixture's exact owned process");
  process.kill(crashRecord.childPid,"SIGTERM");
  const callsAtExit=(await readFile(join(root,"calls.jsonl"),"utf8")).trim().split("\n").length;
  state=await until(async()=>{const s=await snapshot();return s.goals.entries[2].status==="paused"?s:null;},"owned process exit authoritatively becomes paused");
  crashed=state.goals.entries[2];assert.match(crashed.summary,/execution exited/);
  assert.equal((await readFile(join(root,"calls.jsonl"),"utf8")).trim().split("\n").length,callsAtExit,"owned exit observation must never relaunch or prompt");
  state=await settle(await mutate("goals.clear",{expectedGoalId:crashed.id,expectedEntryRevision:crashed.revision}));
  assert.equal(state.goals.entries[2].status,"cleared");
  state=await settle(await mutate("goals.create",{expectedGoalId:null,expectedRegistryRevision:state.goals.revision,objective:"Isolated pause-race goal"}));
  let racing=state.goals.entries[3];
  state=await settle(await mutate("goals.start",{expectedGoalId:racing.id,expectedEntryRevision:racing.revision}));racing=state.goals.entries[3];
  state=await settle(await mutate("goals.pause",{expectedGoalId:racing.id,expectedEntryRevision:racing.revision}));racing=state.goals.entries[3];
  assert.equal(racing.status,"complete","exact owned completion wins Pause race, never downgrades to paused");
  const raceTask=JSON.parse(await readFile(join(agent,"state","native-tasks-v1",racing.child.taskId,"state.json"),"utf8"));
  assert.equal(raceTask.history.at(-1).outcome,"delivered");assert.equal(raceTask.history.at(-1).execution,"completed");
  state=await settle(await mutate("goals.create",{expectedGoalId:null,expectedRegistryRevision:state.goals.revision,objective:"Question workflow"}));
  let questioning=state.goals.entries.at(-1);
  state=await settle(await mutate("goals.start",{expectedGoalId:questioning.id,expectedEntryRevision:questioning.revision}));
  state=await until(async()=>{const s=await snapshot();return s.goals.entries.at(-1).story?.questions?.some(q=>q.status==="pending")?s:null;},"actual child questionnaire reaches goal story");
  const questionEvidence=structuredClone(state);
  questioning=state.goals.entries.at(-1);const question=questioning.story.questions.find(q=>q.status==="pending");
  await assert.rejects(mutate("goals.answer",{expectedGoalId:questioning.id,expectedEntryRevision:questioning.revision,questionId:question.id,questionRevision:question.revision,workerEpoch:"foreign",answer:{kind:"questionnaire",cancelled:false,answers:[{id:"direction",value:"yes",wasCustom:false}]}}));
  state=await settle(await mutate("goals.answer",{expectedGoalId:questioning.id,expectedEntryRevision:questioning.revision,questionId:question.id,questionRevision:question.revision,workerEpoch:question.workerEpoch,answer:{kind:"questionnaire",cancelled:false,answers:[{id:"direction",value:"yes",wasCustom:false}]}}));
  state=await until(async()=>{const s=await snapshot();return s.goals.entries.at(-1).status==="complete"?s:null;},"answered child completes without parent prompt");
  const story=state.goals.entries.at(-1).story;
  assert.equal(story.questions.find(q=>q.id===question.id).status,"answered");
  assert(story.activity.some(event=>event.text==="Explicit fixture activity after the user's answer"));
  assert(story.timeline.some(event=>event.kind==="completed"));
  if(process.env.PI_GOAL_STORY_EVIDENCE){
    const plain=value=>Object.fromEntries(Object.entries(value).filter(([key])=>key!=="goals"));
    await writeFile(process.env.PI_GOAL_STORY_EVIDENCE,JSON.stringify({pending:plain(questionEvidence),completed:plain(state)}),{mode:0o600});
  }
  calls=(await readFile(join(root,"calls.jsonl"),"utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(calls.filter(c=>!c.isChild).length,1,"registry never dispatches parent goal prompts");
  assert(calls.filter(c=>c.isChild).every(c=>c.model==="gpt-6.1-sol"&&c.provider==="harness-test"&&c.goalId&&c.activated));
  for(const call of calls.filter(c=>c.isChild)) assert.deepEqual(call.limits,call.goalText?.includes("independent second")?{automaticTurns:11,noProgressTurns:6}:{automaticTurns:7,noProgressTurns:5},"effective child limits must match confirmed per-goal override or parent defaults");
  assert(confirmations.length>=3);
  for(const message of confirmations) {
    assert.match(message,message.includes("independent second")?/Dedicated automatic limit: 11 responses/:/Dedicated automatic limit: 7 responses/);
    assert.match(message,message.includes("independent second")?/Dedicated no-progress limit: 6 repeated runs/:/Dedicated no-progress limit: 5 repeated runs/);
    assert.match(message,/Unset limits inherit the configured defaults/);
  }
  console.log("isolated actual-Pi dedicated-goal runtime integration passed",{calls:calls.length,childCalls:calls.filter(c=>c.isChild).length,concurrentGoalOwnership:true});
} catch(error) { keep=true; console.error(`Fixture retained: ${root}\n${output}`); throw error; }
finally { await stopParent(); if(!keep)await rm(root,{recursive:true,force:true}); }
