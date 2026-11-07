import type { ForgeAdapter, ForgeSnapshot, ForgeTarget } from "./types.ts";
import { createForgeMcpClient, type ForgeMcpConfig, ForgeError } from "./mcp.ts";

export function createForgeAdapter(config: ForgeMcpConfig, clientFactory=createForgeMcpClient): ForgeAdapter & { close(): Promise<void> } {
  let closed = false;
  const clients = new Map<string, ReturnType<typeof createForgeMcpClient>>();
  const getClient=(target:ForgeTarget)=>{
    const key=`${target.provider}:${target.host.toLowerCase()}`;
    let client=clients.get(key);
    if(!client){client=clientFactory(config,target);clients.set(key,client);}
    return client;
  };
  return {
    async poll(target: ForgeTarget, signal: AbortSignal): Promise<ForgeSnapshot> {
      if (closed) throw new ForgeError("Forge adapter is closed");
      if (signal.aborted) throw new ForgeError("Forge poll aborted");
      if (target.provider !== "github") throw new ForgeError("GitLab adapter schema is not yet verified; refusing incomplete snapshot");
      const [owner, repo] = target.project.split("/");
      if (!owner || !repo || target.project.split("/").length !== 2) throw new ForgeError("Invalid GitHub project path");
      const client=getClient(target);
      try {
        const call=(method:string, extra:Record<string,unknown>={})=>client.call("pull_request_read",{method,owner,repo,pullNumber:target.number,...extra},signal);
        const before=stringAt(objectData(await call("get")),["head","sha"]);
        if(!before)throw new ForgeError("GitHub pull request response omitted head SHA");
        const pr=objectData(await call("get"));
        const head=stringAt(pr,["head","sha"]), state=stringAt(pr,["state"]);
        if(!head||!state)throw new ForgeError("GitHub pull request response omitted head or state");
        const comments=await paged(client,call,"get_comments");
        const reviews=await paged(client,call,"get_reviews");
        const reviewComments=await reviewCommentPages(client,call,target);
        const statuses=await paged(client,call,"get_status","statuses","total_count");
        const checkRuns=await paged(client,call,"get_check_runs","check_runs","total_count");
        const after=stringAt(objectData(await call("get")),["head","sha"]);
        if(head!==before||after!==before)throw new ForgeError("Pull request head changed during snapshot; retry poll");
        const statusSummary={id:`summary:${head}`,sha:head,state};
        return {head,state,comments:normalize(comments,"issue-comment").concat(normalize(reviewComments,"review-comment")),reviews:normalize(reviews,"review"),ci:normalize([statusSummary,...statuses],"status").concat(normalize(checkRuns,"check-run"))};
      } finally { /* cached client remains open until adapter.close() */ }
    },
    async close() { closed=true; await Promise.all([...clients.values()].map(c=>c.close())); clients.clear(); },
  };
}
type Call=(method:string,extra?:Record<string,unknown>)=>Promise<unknown>;
async function paged(client:ReturnType<typeof createForgeMcpClient>,call:Call,method:string,itemsKey?:string,totalKey?:string):Promise<unknown[]> {
 const all:unknown[]=[];
 for(let page=1;page<=client.maxPages;page++) {
  const raw=objectData(await call(method,{page,perPage:100}));
  const items=Array.isArray(raw)?raw:firstArray(raw,itemsKey?[itemsKey]:["items","results","data"]);
  if(!items)throw new ForgeError(`Unsupported ${method} response shape; cannot prove pagination completeness`);
  all.push(...items);
  const total=typeof raw?.[totalKey??"count"]==="number"?raw[totalKey??"count"]:undefined;
  if(total!==undefined&&all.length>=total)return all;
  if(items.length<100){if(total!==undefined&&all.length<total)throw new ForgeError(`${method} reported truncated results`);return all;}
 }
 throw new ForgeError(`${method} pagination exceeded configured maximum; snapshot incomplete`);
}
async function reviewCommentPages(client:ReturnType<typeof createForgeMcpClient>,call:Call,target:ForgeTarget):Promise<unknown[]> {
 const all:unknown[]=[];let after:string|undefined;const threadIds=new Set<string>(),permalinks=new Set<string>();let expectedThreadCount:number|undefined;
 for(let page=0;page<client.maxPages;page++) {
  const data=objectData(await call("get_review_comments",{perPage:100,...(after?{after}:{})}));
  const threads=data?.review_threads,info=data?.pageInfo,total=data?.totalCount;
  if(!Array.isArray(threads)||typeof info?.hasNextPage!=="boolean"||!Number.isSafeInteger(total)||total<0)throw new ForgeError("Unsupported review-thread cursor response; cannot prove pagination completeness");
  if(expectedThreadCount!==undefined&&expectedThreadCount!==total)throw new ForgeError("Review-thread totalCount changed during pagination");
  expectedThreadCount=total;
  for(const thread of threads){
   const threadId=thread?.id??thread?.node_id;
   if((typeof threadId!=="string"&&typeof threadId!=="number")||!String(threadId)||threadIds.has(String(threadId)))throw new ForgeError("Review thread omitted a unique stable ID");
   threadIds.add(String(threadId));
   if(!Array.isArray(thread.comments))throw new ForgeError("Review thread omitted comments");
   if(!Number.isSafeInteger(thread.total_count)||thread.total_count<0||thread.total_count!==thread.comments.length)throw new ForgeError("Review thread comments are incomplete or lack a trustworthy total_count");
   if(typeof thread.is_resolved!=="boolean"||typeof thread.is_outdated!=="boolean")throw new ForgeError("Review thread omitted resolved/outdated state");
   all.push({id:`thread:${threadId}`,thread_id:String(threadId),thread_resolved:thread.is_resolved,thread_outdated:thread.is_outdated,thread_collapsed:thread.is_collapsed??null,total_count:thread.total_count});
   for(const comment of thread.comments){
    if(typeof comment?.html_url!=="string")throw new ForgeError("Review comment omitted stable permalink identity");
    let permalink:URL;try{permalink=new URL(comment.html_url);}catch{throw new ForgeError("Review comment has invalid permalink identity");}
    if(permalink.protocol!=="https:"||permalink.host.toLowerCase()!==target.host.toLowerCase()||permalink.username||permalink.password||permalink.search||permalinks.has(permalink.href))throw new ForgeError("Review comment permalink is invalid or duplicated");
    permalinks.add(permalink.href);
    all.push({...comment,id:permalink.href,thread_id:String(threadId),thread_resolved:thread.is_resolved,thread_outdated:thread.is_outdated});
   }
  }
  if(!info.hasNextPage){if(threadIds.size!==expectedThreadCount)throw new ForgeError("Review-thread pagination ended before totalCount");return all;}
  if(typeof info.endCursor!=="string"||!info.endCursor||info.endCursor===after)throw new ForgeError("Review-thread pagination cursor missing or repeated");
  after=info.endCursor;
 }
 throw new ForgeError("Review-thread pagination exceeded configured maximum");
}
function firstArray(value:any,keys:string[]):unknown[]|undefined { for(const key of keys)if(Array.isArray(value?.[key]))return value[key];return undefined; }
function objectData(value:any):any {
 if(value?.structuredContent!==undefined)return value.structuredContent;
 if(Array.isArray(value?.content)){const text=value.content.filter((x:any)=>x.type==="text").map((x:any)=>x.text).join("\n");if(text){try{return JSON.parse(text)}catch{return value}}}
 return value;
}
function stringAt(value:any,...paths:string[][]):string|undefined {for(const path of paths){let node=value;for(const k of path)node=node?.[k];if(typeof node==="string"&&node)return node;}return undefined;}
function normalize(values:unknown[],namespace:string):ForgeSnapshot["comments"] {return values.map((raw:any)=>{
 if(!raw||typeof raw!=="object")throw new ForgeError("Unsupported forge item shape");
 const id=raw.id??raw.databaseId??raw.node_id??raw.sha??raw.context;
 if(id===undefined||id===null)throw new ForgeError("Forge item lacks stable ID");
 const actor=raw.user?.login??(typeof raw.author==="string"?raw.author:raw.author?.login??raw.author?.username??raw.author?.name)??raw.actor?.login;
 const stable={id:String(id),actor:actor??null,body:raw.body??raw.message??null,state:raw.state??raw.conclusion??null,commit:raw.commit_id??raw.sha??null,created:raw.created_at??raw.submitted_at??null,updated:raw.updated_at??null,name:raw.name??null,status:raw.status??null,context:raw.context??null,thread:raw.thread_id??null,resolved:raw.thread_resolved??null,outdated:raw.thread_outdated??null,collapsed:raw.thread_collapsed??null,total_count:raw.total_count??null};
 return {id:`${namespace}:${String(id)}`,fingerprint:JSON.stringify(stable),...(typeof actor==="string"?{actor}:{})};
});}
