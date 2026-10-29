import { randomUUID, createHash } from "node:crypto";
import type { TaskInteractionInput, TaskInteractionAnswer } from "../shared/foreground-tasks.ts";
import { validInteractionInput, validInteractionAnswer } from "../shared/task-interactions.ts";
import { validateGoalStory, type GoalQuestion, type GoalQuestionReply } from "./goal-story.ts";
export const GOAL_QUESTIONS_ENTRY = "delegated-goal-questions-v1";
/** Owns actual outstanding questionnaire promises. No permission decisions and
 * no text prompts are dispatched by this service. Reply authority is supplied
 * by the private goal-worker RPC and exact epoch/revision checks below. */
export function createGoalQuestions(entryId: string, workerEpoch: string, branch: unknown[], persist: (data: unknown) => void) {
  let questions: GoalQuestion[] = [], closed = false;
  const waiters = new Map<string, { resolve(value: TaskInteractionAnswer): void; reject(error: Error): void }>();
  const receipts = new Map<string, string>();
  for (const raw of branch) {
    const entry = raw as { type?: string; customType?: string; data?: { entryId?: string; workerEpoch?: string; questions?: GoalQuestion[]; receipts?: Array<[string, string]> } };
    if (entry.type !== "custom" || entry.customType !== GOAL_QUESTIONS_ENTRY || entry.data?.entryId !== entryId) continue;
    validateGoalStory({ version: 1, timeline: [], activity: [], questions: entry.data.questions });
    questions = structuredClone(entry.data.questions ?? []);
    receipts.clear();
    if (entry.data.workerEpoch === workerEpoch) {
      const stored = entry.data.receipts ?? [];
      if (!Array.isArray(stored) || stored.length > 256 || stored.some(item => !Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || !item[0] || item[0].length > 256 || !/^[a-f0-9]{64}$/.test(item[1]))) throw new Error("Invalid question receipts");
      for (const [id, hash] of stored) receipts.set(id, hash);
    }
  }
  const save = (next: GoalQuestion[], nextReceipts = receipts) => {
    persist({ entryId, workerEpoch, questions: structuredClone(next), receipts: [...nextReceipts] });
    questions = next;
    if (nextReceipts !== receipts) { receipts.clear(); for (const [id, hash] of nextReceipts) receipts.set(id, hash); }
  };
  if (questions.some(q => q.status === "pending")) save(questions.map(q => q.status === "pending" ? { ...q, status: "cancelled", revision: q.revision + 1, answeredAt: Math.max(Date.now(), q.at) } : q));
  function cancel(id: string) {
    const question = questions.find(q => q.id === id);
    if (!question || question.status !== "pending") return;
    save(questions.map(q => q.id === id ? { ...q, status: "cancelled", revision: q.revision + 1, answeredAt: Math.max(Date.now(), q.at) } : q));
    waiters.get(id)?.reject(new Error("Goal questionnaire cancelled")); waiters.delete(id);
  }
  return {
    snapshot: () => structuredClone(questions),
    async request(input: TaskInteractionInput, signal?: AbortSignal): Promise<TaskInteractionAnswer> {
      if (closed || signal?.aborted || input.kind !== "questionnaire" || !validInteractionInput(input)) throw new Error("Goal questionnaire unavailable or invalid");
      if (waiters.size >= 4) throw new Error("Too many pending goal questions");
      const id = randomUUID();
      const question: GoalQuestion = { id, revision: 1, at: Date.now(), workerEpoch, status: "pending", request: structuredClone(input) };
      const retained = questions.length >= 100 ? questions.filter(q => q.status === "pending").concat(questions.filter(q => q.status !== "pending").slice(-95)) : questions;
      save([...retained, question]);
      const promise = new Promise<TaskInteractionAnswer>((resolve, reject) => waiters.set(id, { resolve, reject }));
      const abort = () => { try { cancel(id); } catch (error) { waiters.get(id)?.reject(error instanceof Error ? error : new Error("Question cancellation failed")); waiters.delete(id); } };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
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
      const waiter = waiters.get(q.id)!; waiters.delete(q.id); waiter.resolve(structuredClone(reply.answer));
    },
    dispose() { closed = true; for (const id of [...waiters.keys()]) cancel(id); },
  };
}
