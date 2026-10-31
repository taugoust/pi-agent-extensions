import { randomUUID, createHash } from "node:crypto";
import type { TaskInteractionInput, TaskInteractionAnswer } from "../shared/foreground-tasks.ts";
import { validInteractionInput, validInteractionAnswer } from "../shared/task-interactions.ts";
import { validateGoalStory, boundQuestionHistory, type GoalQuestion, type GoalQuestionReply } from "./goal-story.ts";
import { GOAL_QUESTION_RECORDER_KEY } from "../shared/goal-question-recorder.ts";
export { GOAL_QUESTION_RECORDER_KEY } from "../shared/goal-question-recorder.ts";
export const GOAL_QUESTIONS_ENTRY = "delegated-goal-questions-v1";
/** Owns actual outstanding questionnaire promises. No permission decisions and
 * no text prompts are dispatched by this service. Reply authority is supplied
 * by the private goal-worker RPC and exact epoch/revision checks below. */
export function createGoalQuestions(entryId: string, workerEpoch: string, branch: unknown[], persist: (data: unknown) => void, options: { bindAttachments?(questionId: string, input: Extract<TaskInteractionInput, {kind:"questionnaire"}>): string[] } = {}) {
  let questions: GoalQuestion[] = [], closed = false, truncated: boolean | undefined = false;
  const waiters = new Map<string, { resolve(value: TaskInteractionAnswer): void; reject(error: Error): void; forwardAbort: AbortController }>();
  const receipts = new Map<string, string>();
  for (const raw of branch) {
    const entry = raw as { type?: string; customType?: string; data?: { entryId?: string; workerEpoch?: string; questions?: GoalQuestion[]; truncated?: boolean; receipts?: Array<[string, string]> } };
    if (entry.type !== "custom" || entry.customType !== GOAL_QUESTIONS_ENTRY || entry.data?.entryId !== entryId) continue;
    validateGoalStory({ version: 1, timeline: [], activity: [], questions: entry.data.questions });
    questions = structuredClone(entry.data.questions ?? []);
    truncated = typeof entry.data.truncated === "boolean" ? entry.data.truncated : undefined;
    receipts.clear();
    if (entry.data.workerEpoch === workerEpoch) {
      const stored = entry.data.receipts ?? [];
      if (!Array.isArray(stored) || stored.length > 256 || stored.some(item => !Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || !item[0] || item[0].length > 256 || !/^[a-f0-9]{64}$/.test(item[1]))) throw new Error("Invalid question receipts");
      for (const [id, hash] of stored) receipts.set(id, hash);
    }
  }
  const save = (next: GoalQuestion[], nextReceipts = receipts) => {
    const bounded = boundQuestionHistory(next);
    if (bounded.length < next.length) truncated = true;
    next = bounded;
    persist({ entryId, workerEpoch, questions: structuredClone(next), ...(truncated === undefined ? {} : { truncated }), receipts: [...nextReceipts] });
    questions = next;
    if (nextReceipts !== receipts) { receipts.clear(); for (const [id, hash] of nextReceipts) receipts.set(id, hash); }
  };
  if (questions.some(q => q.status === "pending")) save(questions.map(q => q.status === "pending" ? { ...q, status: "cancelled", revision: q.revision + 1, answeredAt: Math.max(Date.now(), q.at) } : q));
  function cancel(id: string, reason = "Goal questionnaire cancelled") {
    const question = questions.find(q => q.id === id);
    if (!question || question.status !== "pending") return;
    save(questions.map(q => q.id === id ? { ...q, status: "cancelled", revision: q.revision + 1, answeredAt: Math.max(Date.now(), q.at) } : q));
    const waiter = waiters.get(id); waiters.delete(id);waiter?.forwardAbort.abort();waiter?.reject(new Error(reason));
  }
  const service = {
    snapshot: () => structuredClone(questions),
    coverage: () => truncated,
    async request(input: TaskInteractionInput, signal?: AbortSignal, forward?: (input: Extract<TaskInteractionInput,{kind:"questionnaire"}>, signal: AbortSignal) => Promise<TaskInteractionAnswer>): Promise<TaskInteractionAnswer> {
      if (closed || signal?.aborted || input.kind !== "questionnaire" || !validInteractionInput(input)) throw new Error("Goal questionnaire unavailable or invalid");
      if (waiters.size >= 4) throw new Error("Too many pending goal questions");
      const id = randomUUID();
      const attachmentIds = options.bindAttachments?.(id,input) ?? [];
      if (input.questions.some(question=>question.attachmentIds?.length) && !options.bindAttachments) throw new Error("Goal attachment registration unavailable");
      const question: GoalQuestion = { id, revision: 1, at: Date.now(), workerEpoch, status: "pending", request: structuredClone(input), ...(attachmentIds.length ? {attachmentIds} : {}) };
      const retained = questions.length >= 100 ? questions.filter(q => q.status === "pending").concat(questions.filter(q => q.status !== "pending").slice(-95)) : questions;
      if (retained.length < questions.length) truncated = true;
      save([...retained, question]);
      const forwardAbort = new AbortController();
      const promise = new Promise<TaskInteractionAnswer>((resolve, reject) => waiters.set(id, { resolve, reject, forwardAbort }));
      const abort = () => { try { cancel(id); } catch (error) { waiters.get(id)?.reject(error instanceof Error ? error : new Error("Question cancellation failed")); waiters.delete(id); } };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      // Registered IDs are goal-local preview authority, not transferable to a
      // top-level questionnaire. Keep them in the durable goal record/Goals UI;
      // forward only the unchanged human question/option DTO without local IDs.
      const forwarded = structuredClone(question.request);
      for(const item of forwarded.questions)delete item.attachmentIds;
      if (forward && !signal?.aborted) void forward(forwarded,signal ? AbortSignal.any([signal,forwardAbort.signal]) : forwardAbort.signal).then(answer => {
        service.answer({questionId:id,questionRevision:1,workerEpoch,answer},`forward:${id}`);
      }).catch(() => { try { cancel(id,"Goal questionnaire forwarding unavailable"); } catch { const waiter=waiters.get(id);waiters.delete(id);waiter?.forwardAbort.abort();waiter?.reject(new Error("Goal questionnaire receipt could not be persisted")); } });
      try { return await promise; } finally { signal?.removeEventListener("abort", abort); }
    },
    answer(reply: GoalQuestionReply, requestId: string) {
      if (closed || reply.workerEpoch !== workerEpoch || !requestId || requestId.length > 256) throw new Error("Stale goal question reply");
      const fingerprint = createHash("sha256").update(JSON.stringify(reply)).digest("hex");
      if (receipts.has(requestId)) {
        if (receipts.get(requestId) !== fingerprint) throw new Error("Question request ID conflict");
        return;
      }
      const q = questions.find(q => q.id === reply.questionId);
      if (!q || q.workerEpoch !== workerEpoch || q.revision !== reply.questionRevision || q.status !== "pending" || !waiters.has(q.id)
        || reply.answer?.kind !== "questionnaire" || !validInteractionAnswer(q.request, reply.answer)) throw new Error("Goal question changed or answer is invalid");
      if (receipts.size >= 256) throw new Error("Goal answer receipt limit reached");
      save(questions.map(item => item.id === q.id ? { ...item, revision: item.revision + 1, status: reply.answer.cancelled ? "cancelled" : "answered", answer: structuredClone(reply.answer), answeredAt: Math.max(Date.now(), item.at) } : item), new Map(receipts).set(requestId, fingerprint));
      const waiter = waiters.get(q.id)!; waiters.delete(q.id); waiter.resolve(structuredClone(reply.answer)); waiter.forwardAbort.abort();
    },
    // Called only by the authenticated worker stop lane after execution is idle.
    cancelPending() { for (const id of [...waiters.keys()]) cancel(id); },
    dispose() { closed = true; for (const id of [...waiters.keys()]) cancel(id); },
  };
  return service;
}
