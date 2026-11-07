import type { ForgeTarget } from "./types.ts";
import { createForgeMcpClient, type ForgeMcpConfig, ForgeError } from "./mcp.ts";

export type ApprovalCheckInput = { target: ForgeTarget; reviewer: string; expectedHead: string; signal?: AbortSignal; config: ForgeMcpConfig };
export type ApprovalCheckResult = { approved: boolean; reason: string; head?: string; reviewer?: string; evidence?: string };

export async function checkApproval(input: ApprovalCheckInput, clientFactory=createForgeMcpClient): Promise<ApprovalCheckResult> {
  const fail=(reason:string,head?:string):ApprovalCheckResult=>({approved:false,reason,...(head?{head}:{}),reviewer:input.reviewer});
  if(!input.reviewer||!input.expectedHead) return fail("reviewer and expectedHead are required");
  if(input.signal?.aborted) return fail("check aborted");
  if(input.target.provider!=="github") return fail("UNKNOWN: GitLab approval revision binding has not been verified");
  const [owner,repo]=input.target.project.split("/");
  const client=clientFactory(input.config,input.target);
  try {
    const read=async(method:string,page?:number)=>client.call("pull_request_read",{method,owner,repo,pullNumber:input.target.number,...(page?{page,perPage:100}:{})},input.signal);
    const head=async()=>{const raw=await read("get"), data=unwrap(raw);return data?.head?.sha??data?.headSha;};
    const first=await head();
    if(typeof first!=="string")return fail("UNKNOWN: current head unavailable");
    if(first!==input.expectedHead)return fail("head does not match expectedHead",first);
    const reviews:any[]=[];
    for(let page=1;page<=client.maxPages;page++) {
      const data=unwrap(await read("get_reviews",page));
      const items=Array.isArray(data)?data:data?.reviews??data?.items??data?.data;
      if(!Array.isArray(items))return fail("UNKNOWN: review pagination shape unsupported",first);
      reviews.push(...items);
      if(items.length<100)break;
      if(page===client.maxPages)return fail("UNKNOWN: review history exceeds pagination limit",first);
    }
    const second=await head();
    if(second!==first)return fail("head changed during approval check",second);
    const authorReviews=reviews.filter(r=>String(r?.user?.login??r?.author?.login??"").toLowerCase()===input.reviewer.toLowerCase());
    const exact=authorReviews.filter(r=>r?.commit_id===input.expectedHead);
    const latest=exact.sort((a,b)=>Date.parse(b.submitted_at??"")-Date.parse(a.submitted_at??""))[0];
    if(!latest||String(latest.state).toUpperCase()!=="APPROVED")return fail("latest review by configured reviewer is not APPROVED on expected head",second);
    return {approved:true,reason:"exact reviewer approved expected head",head:second,reviewer:input.reviewer,evidence:String(latest.id??latest.node_id??"review")};
  } catch(error) { return fail(error instanceof ForgeError?error.message:"approval state unavailable"); }
  finally { await client.close(); }
}
function unwrap(value:any):any {
 if(value?.structuredContent!==undefined)return value.structuredContent;
 if(Array.isArray(value?.content)){const text=value.content.filter((c:any)=>c.type==="text").map((c:any)=>c.text).join("\n");if(text){try{return JSON.parse(text)}catch{return value}}}
 return value;
}
