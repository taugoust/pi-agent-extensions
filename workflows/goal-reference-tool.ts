import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GOAL_REVIEW_WORKER_KEY, type GoalReferenceRequest } from "./goal-review-worker.ts";

/** Registration grants no read authority: the exact dedicated helper must exist,
 * inherited read must still be active, and file reads run through Pi tool hooks.
 */
export function registerGoalReferenceTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "goal_reference", label: "Goal reference",
    description: "Explicitly register a source or deliverable for the current dedicated goal. Use goal_manage status for goal_id, activation_id and expected_revision. Relative workspace text/PNG files require inherited read permission and go through the read tool; HTTPS links are not fetched. Returns a durable reference ID usable in questionnaire attachmentIds. This cannot ask, answer or approve a human decision, execute work, or read arbitrary host paths. Available only in the exact dedicated goal worker; reuse request_id and payload on retries.",
    parameters: {type:"object",properties:{goal_id:{type:"string",maxLength:128},activation_id:{type:"string",maxLength:128},expected_revision:{type:"integer",minimum:0},request_id:{type:"string",minLength:1,maxLength:128},title:{type:"string",minLength:1,maxLength:160},target:{type:"string",minLength:1,maxLength:4096},role:{type:"string",enum:["source","deliverable"]}},required:["goal_id","activation_id","expected_revision","request_id","title","target","role"],additionalProperties:false} as any,
    async execute(_id,request:GoalReferenceRequest,signal,_update,ctx) {
      const service=(globalThis as any)[GOAL_REVIEW_WORKER_KEY];
      if(service?.protocol!==1||service.sessionId!==ctx.sessionManager.getSessionId()||typeof service.register!=="function"||!pi.getActiveTools().includes("read")||!pi.getActiveTools().includes("goal_reference"))throw Error("Goal reference requires the exact dedicated worker and inherited read capability");
      if(typeof (ctx as any).executeTool!=="function")throw Error("Goal reference requires nested read-tool support in this runtime");
      const reference=await service.register(request as GoalReferenceRequest,async(path:string,readSignal?:AbortSignal)=>await (ctx as any).executeTool("read",{path},{signal:readSignal}),signal);
      return {content:[{type:"text" as const,text:`Registered goal reference ${reference.id}: ${reference.title}`}],details:{reference_id:reference.id,goal_id:request.goal_id,activation_id:request.activation_id,role:reference.role,kind:reference.kind}};
    },
  });
}
