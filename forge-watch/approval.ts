import type { ForgeTarget } from "./types.ts";
import { createForgeMcpClient, type ForgeMcpConfig, ForgeError } from "./mcp.ts";
export type ApprovalCheckInput={target:ForgeTarget;reviewer:string;expectedHead:string;signal?:AbortSignal;config:ForgeMcpConfig};
export type ApprovalCheckResult={approved:boolean;reason:string;head?:string;reviewer?:string;evidence?:string};
const FULL_SHA=/^[0-9a-f]{40}$/i;
const LOGIN=/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;
const DECISIVE=new Set(["APPROVED","CHANGES_REQUESTED","DISMISSED"]);

/** Approval is a point-in-time observation across repeated head/reviewer reads, not a durable certificate; the forge can change immediately after the final read. */
export async function checkApproval(input:ApprovalCheckInput,clientFactory=createForgeMcpClient):Promise<ApprovalCheckResult>{
 const fail=(reason:string,head?:string):ApprovalCheckResult=>({approved:false,reason,...(head?{head}:{}),reviewer:input.reviewer});
 if(input.target.provider!=="github")return fail("UNKNOWN: GitLab approval revision binding has not been verified");
 if(typeof input.reviewer!=="string"||!LOGIN.test(input.reviewer)||input.reviewer.trim()!==input.reviewer)return fail("reviewer must be a valid GitHub login");
 if(typeof input.expectedHead!=="string"||!FULL_SHA.test(input.expectedHead))return fail("expectedHead must be a full 40-character commit SHA");
 if(input.signal?.aborted)return fail("check aborted");
 const [owner,repo]=input.target.project.split("/");
 if(!owner||!repo||input.target.project.split("/").length!==2||!Number.isSafeInteger(input.target.number)||input.target.number<1)return fail("invalid pull request target");
 const client=clientFactory(input.config,input.target);
 try{
  const read=(method:string,page?:number)=>client.call("pull_request_read",{method,owner,repo,pullNumber:input.target.number,...(page?{page,perPage:100}:{})},input.signal);
  const readHead=async()=>{const value=unwrap(await read("get"));return value?.head?.sha??value?.headSha;};
  const initial=await readHead();
  if(typeof initial!=="string"||!FULL_SHA.test(initial))return fail("UNKNOWN: current full head SHA unavailable");
  if(initial.toLowerCase()!==input.expectedHead.toLowerCase())return fail("head does not match expectedHead",initial);
  const first=await allReviews(client,read);
  const middle=await readHead();
  if(middle!==initial)return fail("head changed while reading reviewer state",typeof middle==="string"?middle:undefined);
  const second=await allReviews(client,read);
  const final=await readHead();
  if(final!==initial)return fail("head changed during approval check",typeof final==="string"?final:undefined);
  const relevant=(records:Review[])=>records.filter(r=>r.login.toLowerCase()===input.reviewer.toLowerCase());
  const before=relevant(first),after=relevant(second);
  if(canonical(before)!==canonical(after))return fail("reviewer state changed during approval check",final);
  const decisive=after.filter(r=>DECISIVE.has(r.state)).sort(compareReview);
  const latest=decisive.at(-1);
  const tied=latest?decisive.filter(r=>r.submittedAt===latest.submittedAt):[];
  if(tied.length>1&&new Set(tied.map(r=>`${r.state}:${r.commitId??""}`)).size>1)return fail("UNKNOWN: conflicting decisive reviews share a timestamp",final);
  if(!latest||latest.state!=="APPROVED"||latest.commitId?.toLowerCase()!==input.expectedHead.toLowerCase())return fail("latest decisive review by configured reviewer is not APPROVED on expected head",final);
  return {approved:true,reason:"exact reviewer approved expected head; reviewer state and head stable during check",head:final,reviewer:input.reviewer,evidence:String(latest.id)};
 }catch(error){return fail(error instanceof ForgeError?error.message:"approval state unavailable");}
 finally{await client.close();}
}
type Review={id:string;login:string;state:string;submittedAt:number;commitId?:string};
async function allReviews(client:any,read:(method:string,page?:number)=>Promise<unknown>):Promise<Review[]>{
 const records:Review[]=[];
 for(let page=1;page<=client.maxPages;page++){
  const raw=unwrap(await read("get_reviews",page));
  const items=Array.isArray(raw)?raw:raw?.reviews??raw?.items??raw?.data;
  if(!Array.isArray(items))throw new ForgeError("UNKNOWN: review pagination shape unsupported");
  for(const item of items)records.push(validateReview(item));
  const total=typeof raw?.total_count==="number"?raw.total_count:typeof raw?.totalCount==="number"?raw.totalCount:undefined;
  if(total!==undefined&&records.length>=total)return deduplicate(records);
  if(items.length<100){if(total!==undefined&&records.length<total)throw new ForgeError("UNKNOWN: review history is incomplete");return deduplicate(records);}
  if(page===client.maxPages)throw new ForgeError("UNKNOWN: review history exceeds pagination limit");
 }
 throw new ForgeError("UNKNOWN: review history exceeds pagination limit");
}
function validateReview(raw:any):Review{
 if(!raw||typeof raw!=="object")throw new ForgeError("UNKNOWN: malformed review record");
 const id=raw.id??raw.node_id,login=raw.user?.login??raw.author?.login,state=String(raw.state??"").toUpperCase(),stamp=raw.submitted_at;
 if((typeof id!=="number"&&typeof id!=="string")||!String(id)||typeof login!=="string"||!LOGIN.test(login)||!DECISIVE.has(state)&&state!=="COMMENTED")throw new ForgeError("UNKNOWN: review record omitted valid identity or state");
 if(typeof stamp!=="string"||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(stamp)||!Number.isFinite(Date.parse(stamp)))throw new ForgeError("UNKNOWN: review record has invalid submitted_at timestamp");
 const commitId=raw.commit_id;
 if(commitId!==undefined&&(typeof commitId!=="string"||!FULL_SHA.test(commitId)))throw new ForgeError("UNKNOWN: review record has invalid commit SHA");
 return {id:String(id),login,state,submittedAt:Date.parse(stamp),...(commitId?{commitId}:{})};
}
function compareReview(a:Review,b:Review):number{return a.submittedAt-b.submittedAt||a.id.localeCompare(b.id,undefined,{numeric:true});}
function deduplicate(reviews:Review[]):Review[]{
 const byId=new Map<string,Review>();
 for(const review of reviews){const old=byId.get(review.id);if(old&&canonical(old)!==canonical(review))throw new ForgeError("UNKNOWN: conflicting duplicate review ID");byId.set(review.id,review);}
 return [...byId.values()];
}
function canonical(value:unknown):string{return JSON.stringify(value);}
function unwrap(value:any):any{if(value?.structuredContent!==undefined)return value.structuredContent;if(Array.isArray(value?.content)){const text=value.content.filter((c:any)=>c.type==="text").map((c:any)=>c.text).join("\n");if(text){try{return JSON.parse(text)}catch{return value}}}return value;}
