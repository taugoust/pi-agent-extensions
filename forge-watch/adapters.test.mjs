import test from "node:test";
import assert from "node:assert/strict";
import { createForgeAdapter } from "./adapters.ts";
import { checkApproval } from "./approval.ts";
const target={provider:"github",host:"github.com",project:"earendil-works/pi",number:11910,url:"https://github.com/earendil-works/pi/pull/11910"};
const config={servers:[{provider:"github",host:"github.com",url:"https://api.githubcopilot.com/mcp/readonly",auth:{env:"GH_TOKEN"}}]};
function factory(responses){const calls=[];return {calls,make:()=>({maxPages:10,async call(_tool,args,signal){calls.push({args,signal});const method=args.method;if(method==="get")return responses.get.shift();if(method==="get_review_comments")return responses.reviewComments.shift();return responses[method].shift();},async close(){}})};}
const rawItems=(id,extra={})=>({id,user:{login:"reviewer"},body:"comment",...extra});

test("GitHub poll follows review comment cursor and normalizes all facets",async()=>{
 const f=factory({get:[{head:{sha:"abc"},state:"open"},{head:{sha:"abc"},state:"open"},{head:{sha:"abc"}}],get_comments:[[rawItems(1)]],get_reviews:[[rawItems(2,{state:"APPROVED",commit_id:"abc"})]],reviewComments:[{review_threads:[{comments:[rawItems(3)]}],totalCount:1,pageInfo:{hasNextPage:true,endCursor:"cursor1"}},{review_threads:[{comments:[rawItems(4)]}],totalCount:1,pageInfo:{hasNextPage:false}}],get_status:[{sha:"abc",state:"success",total_count:1,statuses:[rawItems(5)]},{sha:"abc",state:"success",total_count:1,statuses:[]}],get_check_runs:[{total_count:1,check_runs:[rawItems(6,{name:"test",status:"completed",conclusion:"success"})]}]});
 const adapter=createForgeAdapter(config,()=>f.make());
 const result=await adapter.poll(target,new AbortController().signal);
 assert.equal(result.head,"abc");assert.equal(result.comments.length,3);assert.equal(result.reviews.length,1);assert.equal(result.ci.length,2);
 assert.deepEqual(f.calls.filter(c=>c.args.method==="get_review_comments").map(c=>c.args.after),[undefined,"cursor1"]);
 await adapter.close();
});

test("GitHub poll fails closed when review cursor or head consistency is incomplete",async()=>{
 const f=factory({get:[{head:{sha:"abc"},state:"open"},{head:{sha:"abc"},state:"open"},{head:{sha:"def"},state:"open"}],get_comments:[[]],get_reviews:[[]],reviewComments:[{review_threads:[],pageInfo:{hasNextPage:true}}]});
 const adapter=createForgeAdapter(config,()=>f.make());
 await assert.rejects(adapter.poll(target,new AbortController().signal),/cursor/);await adapter.close();
});

test("approval requires exact current reviewer and revision and rejects head race",async()=>{
 const make=(reviews,heads=["abc","abc"])=>{let reads=0;return {maxPages:10,async call(_tool,args){if(args.method==="get")return {head:{sha:heads[reads++]}};return reviews;},async close(){}};};
 const input={target,reviewer:"taugoust",expectedHead:"abc",config};
 assert.equal((await checkApproval(input,()=>make([{user:{login:"taugoust"},state:"APPROVED",commit_id:"abc",id:1}]))).approved,true);
 assert.equal((await checkApproval(input,()=>make([{user:{login:"other"},state:"APPROVED",commit_id:"abc"}]))).approved,false);
 assert.equal((await checkApproval(input,()=>make([{user:{login:"taugoust"},state:"APPROVED",commit_id:"old"}]))).approved,false);
 assert.equal((await checkApproval(input,()=>make([{user:{login:"taugoust"},state:"APPROVED",commit_id:"abc",submitted_at:"2026-01-01",id:1},{user:{login:"taugoust"},state:"DISMISSED",commit_id:"abc",submitted_at:"2026-01-02",id:2}]))).approved,false);
 assert.match((await checkApproval(input,()=>make([{user:{login:"taugoust"},state:"APPROVED",commit_id:"abc",id:1}], ["abc","def"]))).reason,/changed/);
});
