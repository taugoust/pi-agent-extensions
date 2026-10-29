import { randomUUID } from "node:crypto";
import type { TaskInteractionInput, TaskInteractionAnswer } from "../shared/foreground-tasks.ts";
import { validInteractionInput, validInteractionAnswer } from "../shared/task-interactions.ts";
export type GoalQuestion = { id: string; revision: number; at: number; workerEpoch: string; status: "pending" | "answered" | "cancelled"; request: Extract<TaskInteractionInput, { kind: "questionnaire" }>; answer?: Extract<TaskInteractionAnswer, { kind: "questionnaire" }>; answeredAt?: number };
export type GoalQuestionReply = { questionId: string; questionRevision: number; workerEpoch: string; answer: Extract<TaskInteractionAnswer, { kind: "questionnaire" }> };

export type GoalTimelineKind = "created" | "started" | "paused" | "resumed" | "blocked" | "completed" | "cleared" | "edited" | "task";
export type GoalTimelineEvent = { id: string; at: number; kind: GoalTimelineKind; text: string; taskId?: string };
export type GoalActivityEvent = { id: string; at: number; text: string };
export type GoalStory = { version: 1; timeline: GoalTimelineEvent[]; activity: GoalActivityEvent[]; questions?: GoalQuestion[] };
export const GOAL_STORY_LIMIT = 200;
/** Read only extension-owned records for an already authenticated goal lineage. */
export function readRecordedGoalStory(branch: unknown[], entryId: string): GoalStory | undefined {
  let story: GoalStory | undefined, questions: GoalQuestion[] | undefined;
  for (const raw of branch) {
    const entry = raw as { type?: string; customType?: string; data?: { entryId?: string; story?: GoalStory; questions?: GoalQuestion[] } };
    if (entry.type !== "custom" || entry.data?.entryId !== entryId) continue;
    if (entry.customType === "delegated-goal-story-v1" && entry.data.story) { validateGoalStory(entry.data.story); story = structuredClone(entry.data.story); }
    if (entry.customType === "delegated-goal-questions-v1") { validateGoalStory({ version: 1, timeline: [], activity: [], questions: entry.data.questions }); questions = structuredClone(entry.data.questions ?? []); }
  }
  return story || questions ? { ...(story ?? emptyGoalStory()), ...(questions ? { questions } : {}) } : undefined;
}
export function mergeGoalStory(target: GoalStory | undefined, observed: GoalStory): GoalStory {
  validateGoalStory(observed);
  const merged = structuredClone(target ?? emptyGoalStory());
  function merge<T extends GoalActivityEvent>(before: T[], incoming: T[]): T[] {
    const events = new Map(before.map(event => [event.id, event]));
    for (const event of incoming) {
      const prior = events.get(event.id);
      if (prior && JSON.stringify(prior) !== JSON.stringify(event)) throw new Error("Goal story event identity changed");
      events.set(event.id, event);
    }
    return [...events.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)).slice(-GOAL_STORY_LIMIT);
  }
  merged.timeline = merge(merged.timeline, observed.timeline);
  merged.activity = merge(merged.activity, observed.activity);
  const questions = new Map((merged.questions ?? []).map(question => [question.id, question]));
  for (const question of observed.questions ?? []) {
    const prior = questions.get(question.id);
    if (prior && (prior.workerEpoch !== question.workerEpoch || JSON.stringify(prior.request) !== JSON.stringify(question.request))) throw new Error("Goal question identity changed");
    if (!prior || question.revision > prior.revision) questions.set(question.id, structuredClone(question));
    else if (question.revision === prior.revision && JSON.stringify(prior) !== JSON.stringify(question)) throw new Error("Goal question revision conflict");
  }
  merged.questions = [...questions.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)).slice(-100);
  return merged;
}
export function emptyGoalStory(): GoalStory { return { version: 1, timeline: [], activity: [], questions: [] }; }
export function recordGoalEvent(story: GoalStory, kind: GoalTimelineKind, text: string, taskId?: string, at = Date.now()): void {
  story.timeline.push({ id: randomUUID(), at, kind, text: text.slice(0, 4000), ...(taskId ? { taskId } : {}) });
  story.timeline = story.timeline.slice(-GOAL_STORY_LIMIT);
}
export function validateGoalStory(value: unknown): asserts value is GoalStory | undefined {
  if (value === undefined) return; // old entries have no fabricated history
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid goal story");
  const story = value as GoalStory;
  if (story.version !== 1 || !Array.isArray(story.timeline) || !Array.isArray(story.activity)
    || story.timeline.length > GOAL_STORY_LIMIT || story.activity.length > GOAL_STORY_LIMIT) throw new Error("Invalid goal story");
  for (const events of [story.timeline, story.activity]) {
    const ids = new Set<string>();
    for (const event of events) {
      if (!event || typeof event.id !== "string" || !event.id || event.id.length > 128 || ids.has(event.id)
        || !Number.isSafeInteger(event.at) || event.at < 0 || typeof event.text !== "string" || !event.text.trim() || event.text.length > 4000) throw new Error("Invalid goal story event");
      ids.add(event.id);
    }
  }
  if (story.questions !== undefined) {
    if (!Array.isArray(story.questions) || story.questions.length > 100) throw new Error("Invalid goal questions");
    const ids = new Set<string>();
    for (const q of story.questions) {
      if (!q || typeof q.id !== "string" || !q.id || q.id.length > 128 || ids.has(q.id)
        || !Number.isSafeInteger(q.revision) || q.revision < 1 || !Number.isSafeInteger(q.at) || q.at < 0
        || typeof q.workerEpoch !== "string" || !q.workerEpoch || q.workerEpoch.length > 128
        || !["pending", "answered", "cancelled"].includes(q.status) || q.request?.kind !== "questionnaire" || !validInteractionInput(q.request)
        || (q.answer !== undefined && !validInteractionAnswer(q.request, q.answer))
        || (q.status === "pending" && (q.answer !== undefined || q.answeredAt !== undefined))
        || (q.status === "answered" && (!q.answer || q.answer.cancelled))
        || (q.status !== "pending" && (!Number.isSafeInteger(q.answeredAt) || q.answeredAt! < q.at))) throw new Error("Invalid goal question");
      ids.add(q.id);
    }
  }
  for (const event of story.timeline) {
    if (!["created", "started", "paused", "resumed", "blocked", "completed", "cleared", "edited", "task"].includes(event.kind)
      || (event.taskId !== undefined && (typeof event.taskId !== "string" || !event.taskId || event.taskId.length > 128))) throw new Error("Invalid goal timeline event");
  }
}
