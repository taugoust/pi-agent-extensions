import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GOAL_REVIEW_WORKER_KEY, type GoalReferenceRequest } from "./goal-review-worker.ts";

/** Registration grants no read authority: the exact dedicated helper must exist,
 * inherited read must still be active, and file reads run through Pi tool hooks.
 */
export function registerGoalReferenceTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "goal_reference", label: "Goal reference",
    description: "Explicitly register a source or deliverable for the current dedicated goal. Relative workspace text/PNG files require inherited read permission and go through the read tool; HTTPS links are not fetched. Returns a durable reference ID usable in questionnaire attachmentIds. This cannot ask, answer or approve a human decision, execute work, or read arbitrary host paths. Available only in the exact dedicated goal worker.",
    parameters: {type:"object",properties:{title:{type:"string",minLength:1,maxLength:160},target:{type:"string",minLength:1,maxLength:4096},role:{type:"string",enum:["source","deliverable"]}},required:["title","target","role"],additionalProperties:false} as any,
    async execute(toolCallId,input:Pick<GoalReferenceRequest,"title"|"target"|"role">,signal,_update,ctx) {
      const service=(globalThis as any)[GOAL_REVIEW_WORKER_KEY];
      if(service?.protocol!==1||service.sessionId!==ctx.sessionManager.getSessionId()||typeof service.register!=="function"||typeof service.identity!=="function"||!pi.getActiveTools().includes("read")||!pi.getActiveTools().includes("goal_reference"))throw Error("Goal reference requires the exact dedicated worker and inherited read capability");
      if(typeof (ctx as any).executeTool!=="function")throw Error("Goal reference requires nested read-tool support in this runtime");
      const request:GoalReferenceRequest={...service.identity(),request_id:toolCallId,title:input.title,target:input.target,role:input.role};
      const reference=await service.register(request,async(path:string,readSignal?:AbortSignal)=>await (ctx as any).executeTool("read",{path},{signal:readSignal}),signal);
      return {content:[{type:"text" as const,text:`Registered goal reference ${reference.id}: ${reference.title}`}],details:{reference_id:reference.id,goal_id:request.goal_id,activation_id:request.activation_id,role:reference.role,kind:reference.kind}};
    },
  });
}
