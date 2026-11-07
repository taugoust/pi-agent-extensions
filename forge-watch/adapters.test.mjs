import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync,writeFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
const cliPath=fileURLToPath(new URL("./check-approval.mjs",import.meta.url));
const packageRoot=process.env.PI_MCP_PACKAGE_ROOT;
if(packageRoot){const manifest=JSON.parse(await (await import("node:fs/promises")).readFile(join(packageRoot,"package.json"),"utf8"));registerHooks({resolve(specifier,context,nextResolve){const sub=specifier==="@earendil-works/pi-mcp"?".":specifier.startsWith("@earendil-works/pi-mcp/")?specifier.slice("@earendil-works/pi-mcp/".length):undefined;const entry=sub?manifest.exports[sub==="."?".":`./${sub}`]?.import:undefined;return entry?nextResolve(pathToFileURL(join(packageRoot,entry)).href,context):nextResolve(specifier,context);}});}
const {createForgeAdapter}=await import("./adapters.ts");
const {checkApproval}=await import("./approval.ts");
const target={provider:"github",host:"github.com",project:"earendil-works/pi",number:11910,url:"https://github.com/earendil-works/pi/pull/11910"};
const config={servers:[{provider:"github",host:"github.com",url:"https://api.githubcopilot.com/mcp/readonly"}]};
const iso=(day)=>`2026-01-${String(day).padStart(2,"0")}T12:00:00Z`;
function factory(responses){const calls=[];return {calls,make:()=>({maxPages:10,async call(_tool,args,signal){calls.push({args,signal});if(args.method==="get")return responses.get.shift();if(args.method==="get_review_comments")return responses.reviewComments.shift();return responses[args.method].shift();},async close(){}})};}
const item=(id,extra={})=>({id,user:{login:"actor"},body:"comment",...extra});
const thread=(id,permalink,{resolved=false,outdated=false,comments=1}={})=>({id,is_resolved:resolved,is_outdated:outdated,is_collapsed:false,total_count:comments,comments:Array.from({length:comments},(_,i)=>({body:"thread note",path:"file.ts",original_line:1,author:"reviewer",created_at:"2026-01-01T00:00:00Z",updated_at:"2026-01-01T00:00:00Z",html_url:comments===1?permalink:`${permalink}-${i}`}))});
function pollFixture(resolved=false){return {get:[{head:{sha:"abc"},state:"open"},{head:{sha:"abc"},state:"open"},{head:{sha:"abc"},state:"open"}],get_comments:[[item(1)]],get_reviews:[[item(2,{state:"APPROVED",commit_id:"abc"})]],reviewComments:[{review_threads:[thread("t1","https://github.com/earendil-works/pi/pull/11910#discussion_r3",{resolved}),thread("t2","https://github.com/earendil-works/pi/pull/11910#discussion_r4",{outdated:true})],totalCount:2,pageInfo:{hasNextPage:false}}],get_status:[{sha:"abc",state:"success",total_count:0,statuses:[]}],get_check_runs:[{total_count:0,check_runs:[]}]};}
test("GitHub poll follows review comment cursor and normalizes all facets",async()=>{
 const f=factory(pollFixture());
 const adapter=createForgeAdapter(config,()=>f.make());const result=await adapter.poll(target,new AbortController().signal);
 assert.equal(result.head,"abc");assert.equal(result.comments.length,5);assert.equal(result.comments.find(x=>x.id.endsWith("discussion_r3"))?.actor,"reviewer");assert.equal(result.reviews.length,1);assert.equal(result.ci.length,1);
 assert.deepEqual(f.calls.filter(c=>c.args.method==="get_review_comments").map(c=>c.args.after),[undefined]);await adapter.close();
});
test("review-thread resolved/outdated changes are fingerprinted and comments use permalink identity",async()=>{
 const first=createForgeAdapter(config,()=>factory(pollFixture(false)).make()),second=createForgeAdapter(config,()=>factory(pollFixture(true)).make());
 const a=await first.poll(target,new AbortController().signal),b=await second.poll(target,new AbortController().signal);
 const id="review-comment:thread:t1",eventId="review-comment:https://github.com/earendil-works/pi/pull/11910#discussion_r3";
 assert.notEqual(a.comments.find(x=>x.id===id).fingerprint,b.comments.find(x=>x.id===id).fingerprint);
 assert.ok(a.comments.some(x=>x.id===eventId));assert.equal(a.comments.find(x=>x.id===eventId).actor,"reviewer");
 await first.close();await second.close();
});
test("review-thread missing/duplicate permalink or incomplete nested total fails closed",async()=>{
 for(const invalid of [thread("t1",undefined),{...thread("t1","https://github.com/earendil-works/pi/pull/11910#one"),total_count:2}]){
  const fixture=pollFixture();fixture.reviewComments=[{review_threads:[invalid],totalCount:1,pageInfo:{hasNextPage:false}}];
  const adapter=createForgeAdapter(config,()=>factory(fixture).make());await assert.rejects(adapter.poll(target,new AbortController().signal),/permalink|total_count/);await adapter.close();
 }
 const repeated=pollFixture();repeated.reviewComments=[{review_threads:[thread("t1","https://github.com/earendil-works/pi/pull/11910#same"),thread("t2","https://github.com/earendil-works/pi/pull/11910#same")],totalCount:2,pageInfo:{hasNextPage:false}}];
 const adapter=createForgeAdapter(config,()=>factory(repeated).make());await assert.rejects(adapter.poll(target,new AbortController().signal),/duplicated/);await adapter.close();
});
test("GitHub poll fails closed on missing cursor, head race, and page limits",async()=>{
 const f=factory({get:[{head:{sha:"abc"},state:"open"},{head:{sha:"abc"},state:"open"},{head:{sha:"abc"},state:"open"}],get_comments:[[]],get_reviews:[[]],reviewComments:[{review_threads:[],totalCount:0,pageInfo:{hasNextPage:true}}]});
 const adapter=createForgeAdapter(config,()=>f.make());await assert.rejects(adapter.poll(target,new AbortController().signal),/cursor/);await adapter.close();
 const race=factory({get:[{head:{sha:"abc"},state:"open"},{head:{sha:"abc"},state:"open"},{head:{sha:"def"},state:"open"}],get_comments:[[]],get_reviews:[[]],reviewComments:[{review_threads:[],totalCount:0,pageInfo:{hasNextPage:false}}],get_status:[{sha:"abc",state:"success",total_count:0,statuses:[]}],get_check_runs:[{total_count:0,check_runs:[]}]});
 const raced=createForgeAdapter(config,()=>race.make());await assert.rejects(raced.poll(target,new AbortController().signal),/changed during snapshot/);await raced.close();
 const limitedConfig={servers:[{...config.servers[0],maxPages:1}]};
 const limited=factory({get:[{head:{sha:"abc"},state:"open"},{head:{sha:"abc"},state:"open"}],get_comments:[{items:Array.from({length:100},(_,i)=>item(i+1)),count:200}]});
 const limitedAdapter=createForgeAdapter(limitedConfig,()=>limited.make());await assert.rejects(limitedAdapter.poll(target,new AbortController().signal),/pagination|Unsupported/);await limitedAdapter.close();
});
function review(id,state="APPROVED",commit="a".repeat(40),day=1,login="taugoust",extra={}){return {id,user:{login},state,commit_id:commit,submitted_at:iso(day),...extra};}
function approvalClient({heads=["a".repeat(40),"a".repeat(40),"a".repeat(40)],reviewPages=[[]],fail}={}){
 let hi=0,ri=0;return {maxPages:10,async call(_tool,args){if(fail)throw fail;if(args.method==="get")return {head:{sha:heads[hi++]}};if(args.method==="get_reviews")return reviewPages[ri++]??[];},async close(){}};
}
async function check(records,opts={}){let fac=()=>approvalClient({reviewPages:[records,records],...opts});return checkApproval({target,reviewer:"taugoust",expectedHead:"a".repeat(40),config},fac);}
test("approval accepts only exact reviewer approval on expected head; COMMENTED is non-decisive",async()=>{
 assert.equal((await check([review(1),review(2,"COMMENTED","a".repeat(40),2)])).approved,true);
 assert.equal((await check([review(1,"APPROVED","a".repeat(40),1,"someone_else")])).approved,false);
 assert.equal((await check([review(1,"APPROVED","b".repeat(40))])).approved,false);
});
test("newer dismissed, changes-requested, or other-commit decisive review blocks",async()=>{
 for(const newer of [review(2,"DISMISSED","a".repeat(40),2),review(2,"CHANGES_REQUESTED","a".repeat(40),2),review(2,"APPROVED","b".repeat(40),2)])assert.equal((await check([review(1),newer])).approved,false);
});
test("malformed timestamps, duplicate conflicting IDs, and tied conflicting state fail closed",async()=>{
 assert.match((await check([review(1,"APPROVED","a".repeat(40),1,"taugoust",{submitted_at:"yesterday"})])).reason,/timestamp/);
 assert.match((await check([review(1),review(1,"DISMISSED")])).reason,/duplicate/);
 assert.match((await check([review(1),review(2,"DISMISSED","a".repeat(40),1)])).reason,/timestamp/);
});
test("reviewer and expected full SHA are validated by shared checker",async()=>{
 assert.match((await checkApproval({target,reviewer:"bad/login",expectedHead:"abc",config})).reason,/reviewer/);
 assert.match((await checkApproval({target,reviewer:"taugoust",expectedHead:"abc",config})).reason,/full 40/);
});
test("approval CLI prints JSON and exits nonzero on incomplete input and read errors",()=>{
 const dir=mkdtempSync(join(tmpdir(),"forge-approval-cli-")),configPath=join(dir,"config.json");
 try{
  writeFileSync(configPath,JSON.stringify(config));
  const hookSource=`import {registerHooks} from 'node:module';import {readFileSync} from 'node:fs';import {join} from 'node:path';import {pathToFileURL} from 'node:url';const root=process.env.PI_MCP_PACKAGE_ROOT;if(root){const m=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));registerHooks({resolve(s,c,n){const sub=s==='@earendil-works/pi-mcp'?'.':s.startsWith('@earendil-works/pi-mcp/')?s.slice('@earendil-works/pi-mcp/'.length):undefined;const e=sub?m.exports[sub==='.'?'.': './'+sub]?.import:undefined;return e?n(pathToFileURL(join(root,e)).href,c):n(s,c)}})}`;
  const hook=`data:text/javascript,${encodeURIComponent(hookSource)}`;
  const run=spawnSync(process.execPath,["--import",hook,"--experimental-strip-types",cliPath,"--url",target.url,"--reviewer","taugoust","--head","abc","--config",configPath],{cwd:dir,encoding:"utf8",env:process.env});
  assert.equal(run.error,undefined);assert.equal(run.signal,null);assert.notEqual(run.stdout.trim(),"",run.stderr);
  assert.equal(run.status,1);const output=JSON.parse(run.stdout);assert.equal(output.approved,false);assert.match(output.reason,/full 40-character/);
  const failedConfig=join(dir,"failed-config.json");writeFileSync(failedConfig,JSON.stringify({requestTimeoutMs:250,servers:[{provider:"github",host:"github.com",url:"https://127.0.0.1:1/mcp"}]}));
  const failed=spawnSync(process.execPath,["--import",hook,"--experimental-strip-types",cliPath,"--url",target.url,"--reviewer","taugoust","--head","a".repeat(40),"--config",failedConfig],{cwd:dir,encoding:"utf8",env:process.env});
  assert.equal(failed.error,undefined);assert.equal(failed.signal,null);assert.notEqual(failed.stdout.trim(),"",failed.stderr);
  assert.equal(failed.status,1);const failure=JSON.parse(failed.stdout);assert.equal(failure.approved,false);assert.equal(typeof failure.reason,"string");
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("head and reviewer state races/errors/incomplete histories fail closed",async()=>{
 const sha="a".repeat(40),approved=[review(1)];
 assert.match((await check(approved,{heads:[sha,"b".repeat(40)]})).reason,/head changed/);
 assert.match((await check(approved,{reviewPages:[approved,[...approved,review(2,"CHANGES_REQUESTED","a".repeat(40),2)]]})).reason,/changed/);
 assert.match((await check(approved,{fail:new Error("network")})).reason,/unavailable/);
});
