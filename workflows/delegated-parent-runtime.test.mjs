// Actual installed Pi, offline provider, isolated state. No SDK stubs or child executor.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
if (process.env.PI_DELEGATED_PARENT_RUNTIME_TEST !== "1") {
  console.log("SKIP delegated parent runtime test (set PI_DELEGATED_PARENT_RUNTIME_TEST=1 and PI_TUI_TEST_PI to an immutable raw Pi executable)");
  process.exit(0);
}
const raw = process.env.PI_TUI_TEST_PI;
assert.ok(raw && /^\/nix\/store\/[^/]+\/.+/.test(raw), "PI_TUI_TEST_PI must explicitly name an immutable raw Pi executable under /nix/store");
const root = await mkdtemp(join(tmpdir(), "pi-busy-parent-"));
const source = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
let child, output = "", errors = "", passed = false;
try {
  for (const path of ["home", "agent", "sessions", "state", "repo"]) await mkdir(join(root, path));
  const fixture = join(root, "fixture.ts"), result = join(root, "evidence.json");
  await writeFile(fixture, `
import workflows from ${JSON.stringify(source)};
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function(pi) {
  workflows(pi);
  let calls = 0, starts = 0, tools = 0;
  pi.on("agent_start", () => { starts++; });
  pi.on("tool_execution_start", () => { tools++; });
  pi.registerProvider("harness-test", {
    api: "openai-responses", apiKey: "offline-test", baseUrl: "http://127.0.0.1:1",
    models: [{id:"gpt-6.1-sol", name:"Offline fixture", reasoning:false, input:["text"], contextWindow:128000, maxTokens:1024,
      cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        try {
          calls++; assert.equal(calls, 1);
          assert.equal(globalThis.__paeDelegatedGoalExecutorV1, undefined);
          const service = globalThis.__paeWorkflowsV1;
          const identity = {sessionId:service.sessionId, serviceEpoch:service.serviceEpoch};
          const snapshot = () => service.handle({...identity, operation:"snapshot"});
          const before = await snapshot();
          assert.equal(before.idle, false); assert.equal(before.goal, null);
          const create = { ...identity, operation:"start", action:"goals.create", requestId:randomUUID(), expectedGoalId:null, objective:"First independent paused goal" };
          const one = await service.handle(create);
          const replay = await service.handle(create);
          assert.deepEqual(replay.delegatedGoals, one.delegatedGoals);
          await assert.rejects(service.handle({...create, requestId:randomUUID(), serviceEpoch:randomUUID()}), /Stale/);
          await assert.rejects(service.handle({...create, requestId:randomUUID(), sessionId:randomUUID()}), /Stale/);
          await service.handle({...create, requestId:randomUUID(), objective:"Second independent paused goal"});
          const after = await snapshot();
          assert.equal(after.idle, false); assert.deepEqual(after.goal, before.goal);
          assert.equal(after.delegatedGoals.entries.length, 2);
          assert.notEqual(after.delegatedGoals.entries[0].id, after.delegatedGoals.entries[1].id);
          for (const entry of after.delegatedGoals.entries) { assert.equal(entry.status,"paused"); assert.equal(entry.child,null); }
          assert.equal(after.capabilities.delegatedGoalExecution,false);
          assert.equal(options.signal?.aborted, false); assert.equal(starts,1); assert.equal(tools,0);
          writeFileSync(${JSON.stringify(result)}, JSON.stringify({before,after,calls,starts,tools,executorAbsent:true,staleIdentityRejected:true,idempotencyVerified:true,aborted:false},null,2));
          const message = {role:"assistant",api:"openai-responses",provider:"harness-test",model:model.id,timestamp:Date.now(),stopReason:"stop",
            content:[{type:"text",text:"Offline busy-parent proof complete."}],usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
          stream.push({type:"start",partial:message}); stream.push({type:"done",reason:"stop",message}); stream.end(message);
        } catch(error) { writeFileSync(${JSON.stringify(result)}, JSON.stringify({error:String(error),stack:error.stack})); stream.end(); }
      })();
      return stream;
    }
  });
}
`);
  const env = {PATH:process.env.PATH, LANG:"C.UTF-8", HOME:join(root,"home"), TMPDIR:root,
    PI_CODING_AGENT_DIR:join(root,"agent"), PI_CODING_AGENT_SESSION_DIR:join(root,"sessions"),
    PI_DELEGATED_GOALS_STATE_ROOT:join(root,"state"), XDG_STATE_HOME:join(root,"state")};
  child = spawn(raw, ["--mode","rpc","--no-extensions","--extension",fixture,"--provider","harness-test","--model","gpt-6.1-sol","--session",join(root,"sessions","parent.jsonl")], {cwd:join(root,"repo"),env,stdio:["pipe","pipe","pipe"]});
  child.stderr.on("data", data => { errors += data; });
  await new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(new Error("Pi timed out\n"+output+errors)), 30000);
    child.on("error", error => {clearTimeout(timer);reject(error);});
    child.on("exit", code => {clearTimeout(timer);reject(new Error("Pi exited "+code+"\n"+output+errors));});
    let buffer = "";
    child.stdout.on("data", data => {
      output += data; buffer += data;
      while(buffer.includes("\n")) { const i=buffer.indexOf("\n"), line=buffer.slice(0,i);buffer=buffer.slice(i+1);
        try { if(JSON.parse(line).type === "agent_settled") { clearTimeout(timer);resolve(); } } catch {} }
    });
    child.stdin.write(JSON.stringify({id:"offline-parent",type:"prompt",message:"Run the local deterministic busy-parent fixture."})+"\n");
  });
  const evidence = JSON.parse(await readFile(result,"utf8"));
  assert.equal(evidence.error, undefined, JSON.stringify(evidence));
  assert.equal(evidence.after.idle,false);
  assert.equal(evidence.after.delegatedGoals.entries.length,2);
  const events = output.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.type === "agent_start").length,1);
  const messages = events.filter(event => event.type === "message_end").map(event => event.message);
  assert.equal(messages.filter(message => message.role === "user").length,1);
  assert.equal(messages.filter(message => message.role === "assistant").length,1);
  assert.equal(messages.find(message => message.role === "assistant").stopReason,"stop");
  passed = true;
  console.log(JSON.stringify({passed:true,runtime:raw,idle:evidence.after.idle,entries:evidence.after.delegatedGoals.entries.map(({id,status,child})=>({id,status,child})),parentGoal:evidence.after.goal,calls:evidence.calls,starts:evidence.starts,tools:evidence.tools,executorAbsent:true,staleIdentityRejected:true,idempotencyVerified:true,aborted:false},null,2));
} finally {
  if(child && child.exitCode === null) { child.kill("SIGTERM"); await new Promise(resolve => child.once("exit",resolve)); }
  if(passed) await rm(root,{recursive:true,force:true});
  else console.error("Isolated failure evidence retained at",root,"\n",output,errors);
}
