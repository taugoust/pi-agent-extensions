import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerGoalReview, previewGoalReview, validateGoalReview, goalReviewRoot } from "./goal-review.ts";
import { DelegatedGoalRegistry, type DelegatedGoalEntry } from "./delegated-goals.ts";
const entry = (): DelegatedGoalEntry => ({ id: "11111111-1111-4111-8111-111111111111", revision: 1, status: "paused", text: "Review", tasks: [], child: { taskId: "task", childId: "child", jobId: "job", attempt: 1 }, tokenBudget: null, tokensUsed: 0, automaticTurns: 0, noProgressTurns: 0, summary: null, waiting: null });

test("review roots require exact retained ownership and inherited read policy",()=>{
 const e=entry(),record={taskId:"task",childId:"child",attempt:1,ownerSessionId:"owner",spec:{task:"Review",cwd:"/bound-workspace",tools:["read"]}};
 assert.equal(goalReviewRoot("owner",e,record,true),"/bound-workspace");
 for(const changed of [{...record,ownerSessionId:"other"},{...record,taskId:"other"},{...record,childId:"other"},{...record,attempt:2},{...record,spec:{...record.spec,tools:[]}},{...record,spec:{...record.spec,cwd:"relative"}}])assert.throws(()=>goalReviewRoot("owner",e,changed,true),/policy/);
 assert.throws(()=>goalReviewRoot("owner",e,record,false),/policy/);
});

test("registered goal review reads bounded immutable content only for the exact goal/attempt",async()=>{
 const root=await mkdtemp(join(tmpdir(),"goal-review-"));
 try {
  const e=entry();await writeFile(join(root,"spec.md"),"# Explicit spec\n");
  const ref=await registerGoalReview(root,e,"Spec","spec.md","source");e.review=[ref];validateGoalReview(e.review,e.id);
  assert.deepEqual(await previewGoalReview(root,e,ref.id),{kind:"text",text:"# Explicit spec\n"});
  await assert.rejects(previewGoalReview(root,{...e,id:"22222222-2222-4222-8222-222222222222"},ref.id),/reference/);
  await assert.rejects(previewGoalReview(root,{...e,child:{...e.child!,attempt:2}},ref.id),/attempt/);
  await assert.rejects(previewGoalReview(root,e,"unknown"),/unavailable/);
  await writeFile(join(root,"spec.md"),"changed");await assert.rejects(previewGoalReview(root,e,ref.id),/changed/);
  await rm(join(root,"spec.md"));await assert.rejects(previewGoalReview(root,e,ref.id),/ENOENT/);
  for(const target of ["../secret","/etc/passwd","a/../../secret","./spec.md","a\\b","file:///etc/passwd","http://example.test","https://user:pass@example.test"])
    await assert.rejects(registerGoalReview(root,e,"Bad",target,"source"));
  await assert.rejects(registerGoalReview(root,{...e,child:null},"No binding","https://example.test","source"),/attempt/);
  const link=await registerGoalReview(root,e,"Issue","https://example.test/issues/1","source");e.review=[link];assert.deepEqual(await previewGoalReview(root,e,link.id),{kind:"link",url:link.target});
 }finally{await rm(root,{recursive:true,force:true});}
});

test("review rejects symlinks, folders, oversized/binary text and unsupported executable image formats",async()=>{
 const root=await mkdtemp(join(tmpdir(),"goal-review-negative-"));
 try {
  const e=entry();await mkdir(join(root,"folder"));await writeFile(join(root,"text"),"visible");await symlink(join(root,"text"),join(root,"link"));await symlink("/etc",join(root,"outside"));
  for(const path of ["folder","link","outside/passwd"])await assert.rejects(registerGoalReview(root,e,"Bad",path,"deliverable"));
  await writeFile(join(root,"large.txt"),"x".repeat(32769));await assert.rejects(registerGoalReview(root,e,"Large","large.txt","deliverable"),/32 KiB/);
  await writeFile(join(root,"binary"),Buffer.from([0,255]));await assert.rejects(registerGoalReview(root,e,"Binary","binary","deliverable"));
  await writeFile(join(root,"image.png"),Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(256*1024)]));await assert.rejects(registerGoalReview(root,e,"Large image","image.png","deliverable"),/256 KiB/);
  // SVG/HTML remain selectable UTF-8 text, never executable markup or image data.
  await writeFile(join(root,"page.html"),"<script>bad()</script>");const html=await registerGoalReview(root,e,"Page source","page.html","source");assert.equal(html.kind,"text");
  await writeFile(join(root,"image.png"),Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=","base64"));const png=await registerGoalReview(root,e,"Screenshot","image.png","deliverable");e.review=[png];assert.equal((await previewGoalReview(root,e,png.id)).kind,"image");
  const hugeDimensions=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=","base64");hugeDimensions.writeUInt32BE(100000,16);await writeFile(join(root,"dimensions.png"),hugeDimensions);await assert.rejects(registerGoalReview(root,e,"Dimensions","dimensions.png","deliverable"),/dimensions/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("review registry registration is revision-bound, idempotent, bounded, and never changes terminal outcome",async()=>{
 const root=await mkdtemp(join(tmpdir(),"goal-review-registry-"));
 try {
  const e={...entry(),status:"complete" as const};let reads=0;
  const registry=new DelegatedGoalRegistry("owner",{async start(){throw Error("must not start");},async resume(){throw Error("must not resume");},async pause(){throw Error("must not pause");},async registerReview(entry,title,target,role){reads++;return registerGoalReview(root,entry,title,target,role);}},()=>{}, {version:1,revision:0,entries:[e]});
  const request={action:"goals.reference" as const,requestId:"register",expectedGoalId:e.id,expectedEntryRevision:1,reviewTitle:"Issue",reviewTarget:"https://example.test",reviewRole:"source" as const};
  const registered=await registry.mutate("owner",request);assert.equal(registered.entries[0].review?.length,1);assert.equal(registered.entries[0].status,"complete");assert.deepEqual(await registry.mutate("owner",request),registered);assert.equal(reads,1);
  await assert.rejects(registry.mutate("foreign",{...request,requestId:"other"}),/session/);
  await assert.rejects(registry.mutate("owner",{...request,requestId:"stale"}),/revision/);
  await assert.rejects(registry.mutate("owner",{...request,requestId:"unknown",expectedEntryRevision:2,answer:{} as any}),/fields/);
 }finally{await rm(root,{recursive:true,force:true});}
});
