import { randomUUID } from "node:crypto";
import { hasMaxGraphemeLength, MAX_PROGRESS_TEXT_LENGTH } from "../shared/goal-checklist.ts";

export type SavedGoalTask = { id: string; text: string; status: "pending" | "in_progress" | "completed" | "blocked" };
export type SavedGoalTaskEdit = { id?: string; text?: string; before_task_id?: string | null };

export function savedGoalTaskText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || !hasMaxGraphemeLength(value, MAX_PROGRESS_TEXT_LENGTH)) throw new Error("Expected text of 1–503 grapheme clusters");
  return value.trim();
}
function taskId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 128;
}

/** Apply a complete saved-goal checklist mutation to a private copy. */
export function mutateSavedGoalTasks(tasks: readonly SavedGoalTask[], edits: unknown, removals: unknown): SavedGoalTask[] {
  if (!Array.isArray(edits) || !Array.isArray(removals)) throw new Error("Task edits and removals must be arrays");
  if (edits.length > 50 || removals.length > 50) throw new Error("Task edits and removals are limited to 50 each");
  if (!edits.length && !removals.length) throw new Error("Task mutation must not be empty");

  const originalIds = new Set(tasks.map(task => task.id));
  const removeIds = new Set<string>();
  for (const id of removals) {
    if (!taskId(id) || removeIds.has(id)) throw new Error("Invalid or duplicate task removal ID");
    if (!originalIds.has(id)) throw new Error("Removed task does not belong to this goal");
    removeIds.add(id);
  }

  const editIds = new Set<string>();
  const normalized = edits.map((raw): SavedGoalTaskEdit & { id?: string } => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !["id", "text", "before_task_id"].includes(key))) throw new Error("Invalid task edit fields");
    const edit = raw as Record<string, unknown>;
    if (Object.hasOwn(edit, "id") && !taskId(edit.id)) throw new Error("Invalid task edit ID");
    if (Object.hasOwn(edit, "text")) savedGoalTaskText(edit.text);
    if (Object.hasOwn(edit, "before_task_id") && edit.before_task_id !== null && !taskId(edit.before_task_id)) throw new Error("Invalid before_task_id");
    if (!Object.hasOwn(edit, "id") && !Object.hasOwn(edit, "text")) throw new Error("New tasks require text");
    if (Object.hasOwn(edit, "id") && !Object.hasOwn(edit, "text") && !Object.hasOwn(edit, "before_task_id")) throw new Error("Task edit must change text or position");
    const id = edit.id as string | undefined;
    if (id !== undefined) {
      if (editIds.has(id)) throw new Error("Duplicate task edit ID");
      editIds.add(id);
      if (removeIds.has(id)) throw new Error("Task cannot be edited and removed");
      if (!originalIds.has(id)) throw new Error("Edited task does not belong to this goal");
    }
    return { ...(id === undefined ? {} : { id }), ...(Object.hasOwn(edit, "text") ? { text: edit.text as string } : {}), ...(Object.hasOwn(edit, "before_task_id") ? { before_task_id: edit.before_task_id as string | null } : {}) };
  });

  let result = tasks.filter(task => !removeIds.has(task.id)).map(task => ({ ...task }));
  const retainedIds = new Set(result.map(task => task.id));
  for (const edit of normalized) {
    const existing = edit.id === undefined ? undefined : result.find(task => task.id === edit.id);
    if (edit.id !== undefined && !existing) throw new Error("Edited task does not belong to this goal");
    if (edit.before_task_id !== undefined && edit.before_task_id !== null) {
      if (edit.before_task_id === edit.id || !retainedIds.has(edit.before_task_id)) throw new Error("before_task_id must name another retained task in this goal");
    }
    let task: SavedGoalTask;
    if (existing) {
      task = { ...existing, ...(edit.text === undefined ? {} : { text: savedGoalTaskText(edit.text) }) };
      if (edit.before_task_id !== undefined) result = result.filter(item => item.id !== existing.id);
      else result[result.findIndex(item => item.id === existing.id)] = task;
    } else {
      task = { id: randomUUID(), text: savedGoalTaskText(edit.text), status: "pending" };
    }
    if (edit.before_task_id === undefined) {
      if (!existing) result.push(task);
    } else if (edit.before_task_id === null) result.push(task);
    else result.splice(result.findIndex(item => item.id === edit.before_task_id), 0, task);
  }

  if (result.length > 50) throw new Error("Goal task limit reached");
  const descriptions = new Set<string>();
  for (const task of result) {
    task.text = savedGoalTaskText(task.text);
    if (descriptions.has(task.text)) throw new Error("Goal tasks need distinct descriptions after trimming");
    descriptions.add(task.text);
  }
  return result;
}
