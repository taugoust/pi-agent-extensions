import { createHash, randomUUID } from "node:crypto";
import { goalReviewFileVersion, isGoalReviewLink, registerGoalReview, validateGoalReview, type GoalReviewReference, type GoalReviewFileVersion } from "./goal-review.ts";
import type { DelegatedGoalEntry } from "./delegated-goals.ts";
import type { TaskInteractionInput } from "../shared/foreground-tasks.ts";
export const GOAL_REVIEW_ENTRY = "delegated-goal-review-v1";
export const GOAL_REVIEW_WORKER_KEY = "__paeGoalReviewWorkerV1";
export type GoalReferenceRequest = { goal_id: string; activation_id: string; expected_revision: number; request_id: string; title: string; target: string; role: "source" | "deliverable" };
export type WorkerReviewState = { entryId: string | null; childGoalId: string | null; childActivationId: string | null; revision: number | null; goal: {status:string} | null };
export function readRecordedGoalReview(branch: unknown[], entryId: string): GoalReviewReference[] | undefined {
  let refs: GoalReviewReference[] | undefined;
  for (const raw of branch) { const entry=raw as any;if(entry.type!=="custom"||entry.customType!==GOAL_REVIEW_ENTRY||entry.data?.entryId!==entryId)continue;validateGoalReview(entry.data.refs,entryId);refs=structuredClone(entry.data.refs ?? []); }
  return refs;
}
/** Explicit model registration. Actual file read goes through ctx.executeTool,
 * preserving read hooks/permission policy. This service has no approval method.
 */
export function createWorkerGoalReview(options: {
  entryId: string; child: NonNullable<DelegatedGoalEntry["child"]>; workerEpoch: string; root: string;
  branch: unknown[]; persist(data: unknown): void; current(): WorkerReviewState; readEnabled(): boolean;
}) {
  let refs=readRecordedGoalReview(options.branch,options.entryId)??[],closed=false,uncertain=false,lane:Promise<unknown>=Promise.resolve();
  const receipts=new Map<string,{fingerprint:string;referenceId:string}>();
  for(const raw of options.branch){const entry=raw as any;if(entry.type!=="custom"||entry.customType!==GOAL_REVIEW_ENTRY||entry.data?.entryId!==options.entryId||entry.data.workerEpoch!==options.workerEpoch)continue;receipts.clear();if(!Array.isArray(entry.data.receipts)||entry.data.receipts.length>256)throw Error("Invalid review receipts");for(const item of entry.data.receipts){if(!Array.isArray(item)||item.length!==2||typeof item[0]!=="string"||!item[0]||item[0].length>128||!/^[a-f0-9]{64}$/.test(item[1]?.fingerprint??"")||typeof item[1]?.referenceId!=="string")throw Error("Invalid review receipt");receipts.set(item[0],item[1]);}}
  function current(request?: GoalReferenceRequest,checkRevision=true){if(closed)throw Error("Goal reference worker closed");if(uncertain)throw Error("Goal reference receipt durability uncertain; reload required");const state=options.current();if(state.entryId!==options.entryId||!state.childGoalId||!state.childActivationId||state.goal?.status!=="active"||(request&&(state.childGoalId!==request.goal_id||state.childActivationId!==request.activation_id||checkRevision&&state.revision!==request.expected_revision)))throw Error("Goal reference identity, activation or revision changed");if(!options.readEnabled())throw Error("Goal reference read capability unavailable");return state;}
  function save(next: GoalReviewReference[], nextReceipts=receipts){validateGoalReview(next,options.entryId);try{options.persist({entryId:options.entryId,workerEpoch:options.workerEpoch,refs:structuredClone(next),receipts:[...nextReceipts]});}catch(error){uncertain=true;throw error;}refs=next;if(nextReceipts!==receipts){receipts.clear();for(const [id,receipt]of nextReceipts)receipts.set(id,receipt);}}
  return {
    snapshot:()=>structuredClone(refs),
    register(request:GoalReferenceRequest,read:(path:string,signal?:AbortSignal)=>Promise<{isError?:boolean}>,signal?:AbortSignal):Promise<GoalReviewReference>{
      const next=lane.then(async()=>{
        if(!request||typeof request.goal_id!=="string"||!request.goal_id||request.goal_id.length>128||typeof request.activation_id!=="string"||!request.activation_id||request.activation_id.length>128||Object.keys(request).some(key=>!["goal_id","activation_id","expected_revision","request_id","title","target","role"].includes(key))||typeof request.request_id!=="string"||!request.request_id||request.request_id.length>128||!Number.isSafeInteger(request.expected_revision)||request.expected_revision<0||typeof request.title!=="string"||!request.title.trim()||request.title.trim().length>160||typeof request.target!=="string"||!request.target||request.target.length>4096||!["source","deliverable"].includes(request.role))throw Error("Invalid explicit goal reference request");
        current(request,false);if(signal?.aborted)throw Error("Goal reference cancelled");
        const fingerprint=createHash("sha256").update(JSON.stringify(Object.keys(request).sort().map(key=>[key,request[key as keyof GoalReferenceRequest]]))).digest("hex");
        const receipt=receipts.get(request.request_id);if(receipt){if(receipt.fingerprint!==fingerprint)throw Error("Reference request ID conflict");const ref=refs.find(ref=>ref.id===receipt.referenceId);if(!ref)throw Error("Reference receipt no longer retained");return structuredClone(ref);}
        current(request);
        if(refs.length>=16||receipts.size>=256)throw Error("Goal reference capacity reached");
        let version:GoalReviewFileVersion|undefined;
        if(!isGoalReviewLink(request.target)){if(/^[a-z][a-z0-9+.-]*:/i.test(request.target))throw Error("Only HTTPS links and workspace files are supported");const inspected=await goalReviewFileVersion(options.root,request.target);version=inspected.version;const result=await read(inspected.path,signal);if(!result||result.isError)throw Error("Goal reference read was not authorized");}
        current(request);if(signal?.aborted)throw Error("Goal reference cancelled");
        const entry={id:options.entryId,child:options.child} as DelegatedGoalEntry;
        const ref={...await registerGoalReview(options.root,entry,request.title,request.target,request.role,version),workerEpoch:options.workerEpoch};
        current(request);if(signal?.aborted)throw Error("Goal reference cancelled");
        save([...refs,ref],new Map(receipts).set(request.request_id,{fingerprint,referenceId:ref.id}));return structuredClone(ref);
      });lane=next.catch(()=>{});return next;
    },
    bindAttachments(questionId:string,input:Extract<TaskInteractionInput,{kind:"questionnaire"}>):string[]{
      current();const ids=[...new Set(input.questions.flatMap(question=>question.attachmentIds??[]))];if(!ids.length)return [];
      if(ids.length>8||refs.length+ids.length>16)throw Error("Question attachment capacity reached");
      const attached=ids.map(id=>{const ref=refs.find(ref=>ref.id===id);if(!ref||ref.questionId!==undefined||ref.goalId!==options.entryId||ref.taskId!==options.child.taskId||ref.childId!==options.child.childId||ref.attempt!==options.child.attempt||ref.workerEpoch!==options.workerEpoch)throw Error("Question attachment belongs to another goal, question or attempt");return {...ref,id:randomUUID(),questionId,at:Date.now()};});
      save([...refs,...attached]);return attached.map(ref=>ref.id);
    },
    dispose(){closed=true;},
  };
}
