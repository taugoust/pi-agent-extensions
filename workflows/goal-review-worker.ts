import { createHash, randomUUID } from "node:crypto";
import { goalReviewFileVersion, isGoalReviewLink, registerGoalReview, validateGoalReview, type GoalReviewReference, type GoalReviewFileVersion } from "./goal-review.ts";
import type { DelegatedGoalEntry } from "./delegated-goals.ts";
import type { TaskInteractionInput } from "../shared/foreground-tasks.ts";

export const GOAL_REVIEW_ENTRY = "delegated-goal-review-v1";
export const GOAL_REVIEW_WORKER_KEY = "__paeGoalReviewWorkerV1";

/** A reference the model asked to register. `request_id` is the tool call ID. */
export type GoalReferenceRequest = { request_id: string; title: string; target: string; role: "source" | "deliverable" };
export type WorkerReviewState = { entryId: string | null; childGoalId: string | null; childActivationId: string | null; revision: number | null; goal: { status: string } | null };

type Receipt = { fingerprint: string; referenceId: string };
const MAX_REFERENCES = 16;
const MAX_RECEIPTS = 256;
const MAX_QUESTION_ATTACHMENTS = 8;

function reviewEntries(branch: unknown[], entryId: string) {
  return branch.map(raw => raw as any).filter(entry => entry.type === "custom" && entry.customType === GOAL_REVIEW_ENTRY && entry.data?.entryId === entryId);
}

export function readRecordedGoalReview(branch: unknown[], entryId: string): GoalReviewReference[] | undefined {
  let refs: GoalReviewReference[] | undefined;
  for (const entry of reviewEntries(branch, entryId)) {
    validateGoalReview(entry.data.refs, entryId);
    refs = structuredClone(entry.data.refs ?? []);
  }
  return refs;
}

/** Receipts for retried registrations, from this worker attempt's latest entry. */
function readReceipts(branch: unknown[], entryId: string, workerEpoch: string): Map<string, Receipt> {
  const latest = reviewEntries(branch, entryId).filter(entry => entry.data.workerEpoch === workerEpoch).at(-1);
  const receipts = new Map<string, Receipt>();
  if (!latest) return receipts;
  if (!Array.isArray(latest.data.receipts) || latest.data.receipts.length > MAX_RECEIPTS) throw Error("Invalid review receipts");
  for (const item of latest.data.receipts) {
    const valid = Array.isArray(item) && item.length === 2 && typeof item[0] === "string" && item[0] && item[0].length <= 128
      && /^[a-f0-9]{64}$/.test(item[1]?.fingerprint ?? "") && typeof item[1]?.referenceId === "string";
    if (!valid) throw Error("Invalid review receipt");
    receipts.set(item[0], item[1]);
  }
  return receipts;
}

function validateRequest(request: GoalReferenceRequest) {
  const valid = request
    && Object.keys(request).every(key => ["request_id", "title", "target", "role"].includes(key))
    && typeof request.request_id === "string" && request.request_id && request.request_id.length <= 128
    && typeof request.title === "string" && request.title.trim() && request.title.trim().length <= 160
    && typeof request.target === "string" && request.target && request.target.length <= 4096
    && ["source", "deliverable"].includes(request.role);
  if (!valid) throw Error("Invalid explicit goal reference request");
}

function fingerprint(request: GoalReferenceRequest) {
  const fields = Object.keys(request).sort().map(key => [key, request[key as keyof GoalReferenceRequest]]);
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

/** Explicit model registration. Actual file reads go through ctx.executeTool,
 * preserving read hooks and permission policy. This service cannot approve anything. */
export function createWorkerGoalReview(options: {
  entryId: string; child: NonNullable<DelegatedGoalEntry["child"]>; workerEpoch: string; root: string;
  branch: unknown[]; persist(data: unknown): void; current(): WorkerReviewState; readEnabled(): boolean;
}) {
  let refs = readRecordedGoalReview(options.branch, options.entryId) ?? [];
  let receipts = readReceipts(options.branch, options.entryId, options.workerEpoch);
  let closed = false;
  let uncertain = false;
  let lane: Promise<unknown> = Promise.resolve();

  /** The active goal this worker serves. With `expected`, also require it is
   * still the same goal and activation a registration started on. */
  function activeGoal(expected?: WorkerReviewState) {
    if (closed) throw Error("Goal reference worker closed");
    if (uncertain) throw Error("Goal reference receipt durability uncertain; reload required");
    const state = options.current();
    const active = state.entryId === options.entryId && state.childGoalId && state.childActivationId && state.goal?.status === "active";
    const same = !expected || (state.childGoalId === expected.childGoalId && state.childActivationId === expected.childActivationId);
    if (!active || !same) throw Error("Goal reference goal or activation changed");
    if (!options.readEnabled()) throw Error("Goal reference read capability unavailable");
    return state;
  }

  function save(next: GoalReviewReference[], nextReceipts = receipts) {
    validateGoalReview(next, options.entryId);
    try {
      options.persist({ entryId: options.entryId, workerEpoch: options.workerEpoch, refs: structuredClone(next), receipts: [...nextReceipts] });
    } catch (error) {
      uncertain = true;
      throw error;
    }
    refs = next;
    receipts = nextReceipts;
  }

  async function register(request: GoalReferenceRequest, read: (path: string, signal?: AbortSignal) => Promise<{ isError?: boolean }>, signal?: AbortSignal) {
    validateRequest(request);
    const goal = activeGoal();
    const checkStill = () => {
      activeGoal(goal);
      if (signal?.aborted) throw Error("Goal reference cancelled");
    };
    checkStill();
    const requestFingerprint = fingerprint(request);
    const receipt = receipts.get(request.request_id);
    if (receipt) {
      if (receipt.fingerprint !== requestFingerprint) throw Error("Reference request ID conflict");
      const ref = refs.find(ref => ref.id === receipt.referenceId);
      if (!ref) throw Error("Reference receipt no longer retained");
      return structuredClone(ref);
    }
    if (refs.length >= MAX_REFERENCES || receipts.size >= MAX_RECEIPTS) throw Error("Goal reference capacity reached");

    let version: GoalReviewFileVersion | undefined;
    if (!isGoalReviewLink(request.target)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(request.target)) throw Error("Only HTTPS links and workspace files are supported");
      const inspected = await goalReviewFileVersion(options.root, request.target);
      version = inspected.version;
      const result = await read(inspected.path, signal);
      if (!result || result.isError) throw Error("Goal reference read was not authorized");
    }
    checkStill();
    const entry = { id: options.entryId, child: options.child } as DelegatedGoalEntry;
    const ref = { ...await registerGoalReview(options.root, entry, request.title, request.target, request.role, version), workerEpoch: options.workerEpoch };
    checkStill();
    save([...refs, ref], new Map(receipts).set(request.request_id, { fingerprint: requestFingerprint, referenceId: ref.id }));
    return structuredClone(ref);
  }

  return {
    snapshot: () => structuredClone(refs),
    /** Registrations run one at a time, in order. */
    register(request: GoalReferenceRequest, read: (path: string, signal?: AbortSignal) => Promise<{ isError?: boolean }>, signal?: AbortSignal): Promise<GoalReviewReference> {
      const next = lane.then(() => register(request, read, signal));
      lane = next.catch(() => {});
      return next;
    },
    bindAttachments(questionId: string, input: Extract<TaskInteractionInput, { kind: "questionnaire" }>): string[] {
      activeGoal();
      const ids = [...new Set(input.questions.flatMap(question => question.attachmentIds ?? []))];
      if (!ids.length) return [];
      if (ids.length > MAX_QUESTION_ATTACHMENTS || refs.length + ids.length > MAX_REFERENCES) throw Error("Question attachment capacity reached");
      const attached = ids.map(id => {
        const ref = refs.find(ref => ref.id === id);
        const ours = ref && ref.questionId === undefined && ref.goalId === options.entryId && ref.taskId === options.child.taskId
          && ref.childId === options.child.childId && ref.attempt === options.child.attempt && ref.workerEpoch === options.workerEpoch;
        if (!ours) throw Error("Question attachment belongs to another goal, question or attempt");
        return { ...ref, id: randomUUID(), questionId, at: Date.now() };
      });
      save([...refs, ...attached]);
      return attached.map(ref => ref.id);
    },
    dispose() { closed = true; },
  };
}
