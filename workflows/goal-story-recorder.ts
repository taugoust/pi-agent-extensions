import { createHash } from "node:crypto";
import { emptyGoalStory, recordGoalEvent, validateGoalStory, boundStoryEvents, GOAL_STORY_LIMIT, type GoalStory, type GoalTimelineKind } from "./goal-story.ts";

type Task = { id: string; text: string; status: string };
type State = { status: string; tasks: Task[] };
export const GOAL_STORY_ENTRY = "delegated-goal-story-v1";
/** Records explicit tools and actual engine transitions, never assistant prose. */
export function createGoalStoryRecorder(entryId: string, branch: unknown[], persist: (data: unknown) => void) {
  let story = emptyGoalStory(), previous: State | undefined;
  const notifications = new Set<string>();
  for (const raw of branch) {
    const entry = raw as { type?: string; customType?: string; data?: { entryId?: string; story?: GoalStory; previous?: State; notifications?: string[] } };
    if (entry.type !== "custom" || entry.customType !== GOAL_STORY_ENTRY || entry.data?.entryId !== entryId) continue;
    validateGoalStory(entry.data.story);
    if (entry.data.story) story = structuredClone(entry.data.story);
    previous = entry.data.previous;
    notifications.clear();
    for (const id of entry.data.notifications ?? []) notifications.add(id);
  }
  const save = () => persist({ entryId, story: structuredClone(story), previous, notifications: [...notifications].slice(-GOAL_STORY_LIMIT) });
  return {
    snapshot: () => structuredClone(story),
    // Bootstrap seeds metadata; it is not a historical task transition.
    baseline(state: State) { previous = structuredClone(state); save(); },
    observe(state: State, at = Date.now()) {
      const before = JSON.stringify(story);
      if (previous) {
        if (previous.status !== state.status) {
          const kind: GoalTimelineKind = state.status === "complete" ? "completed" : state.status === "active" ? "resumed" : state.status === "blocked" ? "blocked" : "paused";
          recordGoalEvent(story, kind, `Goal ${state.status.replaceAll("_", " ")}`, undefined, at);
        }
        const tasks = new Map(previous.tasks.map(task => [task.id, task]));
        for (const task of state.tasks) {
          const prior = tasks.get(task.id);
          if (!prior || prior.status !== task.status || prior.text !== task.text) recordGoalEvent(story, "task", `${task.text}: ${task.status.replaceAll("_", " ")}`, task.id, at);
        }
        const current = new Set(state.tasks.map(task => task.id));
        for (const task of previous.tasks) if (!current.has(task.id)) recordGoalEvent(story, "task", `Task removed: ${task.text}`, task.id, at);
      }
      previous = structuredClone(state);
      if (before !== JSON.stringify(story)) save();
    },
    activity(id: string, text: string, at = Date.now()) {
      if (!id || notifications.has(id) || !text.trim()) return;
      notifications.add(id);
      story.activity.push({ id: `notification:${createHash("sha256").update(id).digest("hex")}`, at, text: text.trim().slice(0, 4000) });
      story.activity = story.activity.slice(-GOAL_STORY_LIMIT);
      boundStoryEvents(story);
      save();
    },
  };
}
