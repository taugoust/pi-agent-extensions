// Two real standalone Pi processes; no provider HTTP or user agent state.
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {createInterface} from "node:readline";
import {EventEmitter} from "node:events";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
const [binaryArg,fixtureArg]=process.argv.slice(2); const binary=resolve(binaryArg??"/nix/store/vjns3phzh830d4qyajb637z4fnk56n4n-pi-1.4.0/bin/pi"), fixture=resolve(fixtureArg??new URL("./session-routing-native-fixture.ts",import.meta.url).pathname);
const root=await mkdtemp(join(tmpdir(),"pi-routing-native-")), home=join(root,"home"), agent=join(home,"agent"), cwd=join(root,"work"), log=join(root,"dispatch.jsonl"); await mkdir(agent,{recursive:true}); await mkdir(cwd); await writeFile(join(agent,"settings.json"),JSON.stringify({retry:{enabled:false},compaction:{enabled:false}}));
const base={PATH:process.env.PATH??"",HOME:home,TMPDIR:root,XDG_CONFIG_HOME:join(home,"config"),XDG_CACHE_HOME:join(home,"cache"),PI_CODING_AGENT_DIR:agent,PI_OFFLINE:"1",PI_SKIP_VERSION_CHECK:"1",PI_TELEMETRY:"0",ROUTING_FIXTURE_LOG:log};
async function start(role,extra={}) { const child=spawn(binary,["--mode","rpc","--no-session","--no-extensions","--no-skills","--provider",role==="parent"?"idle-guard":"openai","--model",role==="parent"?"astra":"small-fixture","--extension",fixture],{cwd,env:{...base,...extra,ROUTING_FIXTURE_ROLE:role},stdio:["pipe","pipe","pipe"]});const events=[],errors=[],bus=new EventEmitter();let ended;const exitPromise=new Promise(resolve=>child.once("exit",(code,signal)=>{ended={code,signal};bus.emit("change");resolve(ended)}));const stdout=createInterface({input:child.stdout}),stderr=createInterface({input:child.stderr});stdout.on("line",line=>{try{events.push(JSON.parse(line))}catch{errors.push(line)}bus.emit("change")});stderr.on("line",line=>{errors.push(line);bus.emit("change")});const wait=(fn,label)=>new Promise((res,rej)=>{const t=setTimeout(()=>done(new Error(`Timeout ${label}: ${errors.join("\n")}`)),15000);function done(e,v){clearTimeout(t);bus.off("change",check);e?rej(e):res(v)}function check(){const v=fn();if(v)done(null,v);else if(ended)done(new Error(`Pi exited ${JSON.stringify(ended)}: ${errors.join("\n")}`))}bus.on("change",check);check()});let n=0;async function rpc(type,fields={}){const id=`native-${++n}`;child.stdin.write(JSON.stringify({id,type,...fields})+"\n");const r=await wait(()=>events.find(e=>e.type==="response"&&e.id===id),type);assert.equal(r.success,true,JSON.stringify(r));return r.data}await rpc("get_state");return{child,events,errors,rpc,wait,close:async()=>{child.stdin.end();if(!ended)child.kill("SIGTERM");await exitPromise;stdout.close();stderr.close()}}}
const readFileSyncLines=file=>readFileSync(file,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
let parent,child;
try{
 const personal=`${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({sub:"personal","https://api.openai.com/auth":{chatgpt_account_id:"personal"}})).toString("base64url")}.fixture`;
 await writeFile(join(agent,"auth.json"),JSON.stringify({openai:{type:"api_key",key:"fixture-default"},"openai-codex":{type:"oauth",access:personal,refresh:"fixture-personal-refresh",expires:Date.now()+86400000,accountId:"personal"}}),{mode:0o600});
 parent=await start("parent");await parent.rpc("prompt",{message:"warm"});await parent.wait(()=>parent.events.some(e=>e.type==="agent_settled"),"parent warm turn");const state=(await parent.rpc("get_state")).sessionId;const routingFile=join(agent,"state","session-routing-v1",`${createHash("sha256").update(state).digest("hex")}.json`);
 child=await start("child",{PI_SESSION_ROUTING_FILE:routingFile,PI_SESSION_ROUTING_OWNER_SESSION:state});const pid=child.child.pid;
 const childInitial=(await child.rpc("get_state")).model;assert.equal(childInitial.provider,"session-follow");assert.equal(childInitial.id,"small-fixture","native follower preserves child role model ID");
 const profile=JSON.parse(await readFile(routingFile,"utf8"));assert.equal(profile.providerId,"openai");assert.equal(JSON.stringify(profile).includes("fixture-"),false);
 for(const [providerId,accountId] of [["openai-codex","Work"],["openai-codex","default"],["openai","Alpha"]]){
  const priorControls=readFileSyncLines(log).filter(r=>r.role==="control").length;const eventStart=parent.events.length;
  await parent.rpc("prompt",{message:`/routing-switch ${providerId} ${accountId}`});
  await parent.wait(()=>parent.events.slice(eventStart).some(e=>e.type==="extension_ui_request"&&e.method==="notify"),"account control completion");
  assert.ok(readFileSyncLines(log).filter(r=>r.role==="control").length>priorControls,"account control service did not commit");
  const committed=readFileSyncLines(log).filter(r=>r.role==="control").at(-1);assert.equal(committed.providerId,providerId);assert.equal(committed.accountId,accountId);assert.equal(committed.result.ok,true,JSON.stringify(committed));
  const childBefore=child.events.filter(e=>e.type==="agent_settled").length;await child.rpc("prompt",{message:"offline fixture dispatch"});await child.wait(()=>child.events.filter(e=>e.type==="agent_settled").length>childBefore,"child fixture turn");
 }
 const rows=(await readFile(log,"utf8")).trim().split("\n").map(JSON.parse);if(process.env.ROUTING_DEBUG)console.error(rows);
 const workToken=`${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({sub:"work","https://api.openai.com/auth":{chatgpt_account_id:"work"}})).toString("base64url")}.fixture`;
 assert.deepEqual(rows.filter(r=>r.role==="child").map(r=>[r.provider,r.model,r.key]),[["openai-codex","small-fixture",workToken],["openai-codex","small-fixture",personal],["openai","small-fixture","fixture-alpha"]]);
 assert.equal(child.child.pid,pid);assert.equal((await child.rpc("get_state")).model.provider,"session-follow");assert.equal((await child.rpc("get_state")).model.id,"small-fixture");assert.equal((await parent.rpc("get_state")).model.provider,"idle-guard","parent guard alias remains selected");assert.equal(rows.filter(r=>r.role==="control").length,3);assert.equal(rows.some(r=>r.network),false,"all HTTP is blocked and none attempted");const finalProfile=await readFile(routingFile,"utf8");assert.doesNotMatch(finalProfile,/fixture-(?:default|alpha|personal|work)|eyJhbGci/,"routing descriptor stores no credentials");assert.equal(finalProfile.includes(personal),false);console.log("PASS native Pi standalone parent/retained-child routing: both provider directions, named/default account, parent guard stable, zero HTTP");
}finally{if(child)await child.close();if(parent)await parent.close();await rm(root,{recursive:true,force:true});}
