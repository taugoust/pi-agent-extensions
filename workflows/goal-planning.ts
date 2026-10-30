import { randomUUID } from "node:crypto";

/** Parent-owned advisory metadata. Never a scheduler, lifecycle or agent edge. */
export type GoalDependency = { taskId: string; waitsFor: string[] };
export type GoalBlocker = { id: string; at: number; reason: string; evidence: string; taskId?: string; clearedAt?: number };
export type GoalPlanning = { dependencies: GoalDependency[]; blockers: GoalBlocker[] };
export type GoalPlanningAction = "goals.dependencies" | "goals.blocker.add" | "goals.blocker.clear";
export function goalPlanningFields(action: string): string[] {
  return action === "goals.dependencies" ? ["taskId", "waitsFor"] : action === "goals.blocker.add" ? ["blockerReason", "blockerEvidence", "blockerTaskId"] : action === "goals.blocker.clear" ? ["blockerId"] : [];
}
type Task = { id: string };
const keys = (value: object, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
export function validateGoalPlanning(value: GoalPlanning | undefined, tasks: readonly Task[]): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || !keys(value,["dependencies","blockers"]) || !Array.isArray(value.dependencies) || value.dependencies.length > 50 || !Array.isArray(value.blockers) || value.blockers.length > 32) throw new Error("Invalid goal planning metadata");
  const taskIds = new Set(tasks.map(task => task.id)), edges = new Map<string,string[]>();
  for (const edge of value.dependencies) {
    if (!edge || !keys(edge,["taskId","waitsFor"]) || !taskIds.has(edge.taskId) || edges.has(edge.taskId) || !Array.isArray(edge.waitsFor) || edge.waitsFor.length > 49 || new Set(edge.waitsFor).size !== edge.waitsFor.length || edge.waitsFor.some(id => typeof id !== "string" || !taskIds.has(id) || id === edge.taskId)) throw new Error("Dependencies must name distinct tasks in this goal");
    edges.set(edge.taskId,edge.waitsFor);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(id: string) { if (visiting.has(id)) throw new Error("Task dependency cycle"); if (visited.has(id)) return; visiting.add(id);for (const other of edges.get(id) ?? []) visit(other);visiting.delete(id);visited.add(id); }
  for (const id of edges.keys()) visit(id);
  const ids = new Set<string>();
  for (const blocker of value.blockers) {
    if (!blocker || !keys(blocker,["id","at","reason","evidence","taskId","clearedAt"]) || typeof blocker.id !== "string" || !/^[a-f0-9-]{36}$/.test(blocker.id) || ids.has(blocker.id)
      || !Number.isSafeInteger(blocker.at) || blocker.at < 0 || typeof blocker.reason !== "string" || !blocker.reason.trim() || blocker.reason.length > 500 || typeof blocker.evidence !== "string" || !blocker.evidence.trim() || blocker.evidence.length > 2000
      || (blocker.taskId !== undefined && (typeof blocker.taskId !== "string" || !blocker.taskId || blocker.taskId.length > 128)) || (blocker.clearedAt !== undefined && (!Number.isSafeInteger(blocker.clearedAt) || blocker.clearedAt < blocker.at))) throw new Error("Invalid recorded goal blocker");
    ids.add(blocker.id);
  }
}
export function setGoalDependencies(before: GoalPlanning | undefined, tasks: readonly Task[], taskId: string, waitsFor: string[]): GoalPlanning {
  const result = structuredClone(before ?? {dependencies:[],blockers:[]});
  if (typeof taskId !== "string" || !Array.isArray(waitsFor)) throw new Error("Explicit task dependency IDs required");
  result.dependencies = result.dependencies.filter(edge => edge.taskId !== taskId).concat(waitsFor.length ? [{taskId,waitsFor:[...waitsFor]}] : []);
  if (!tasks.some(task => task.id === taskId)) throw new Error("Task does not belong to this goal");
  validateGoalPlanning(result,tasks);return result;
}
export function addGoalBlocker(before: GoalPlanning | undefined, tasks: readonly Task[], reason: string, evidence: string, taskId?: string): GoalPlanning {
  if (typeof reason !== "string" || typeof evidence !== "string" || (taskId !== undefined && !tasks.some(task => task.id === taskId))) throw new Error("Blocker must belong to this goal");
  const result = structuredClone(before ?? {dependencies:[],blockers:[]});
  result.blockers.push({id:randomUUID(),at:Date.now(),reason:reason.trim(),evidence:evidence.trim(),...(taskId === undefined ? {} : {taskId})});
  validateGoalPlanning(result,tasks);return result;
}
export function clearGoalBlocker(before: GoalPlanning | undefined, tasks: readonly Task[], id: string): GoalPlanning {
  const result = structuredClone(before ?? {dependencies:[],blockers:[]});const blocker = result.blockers.find(item => item.id === id);
  if (!blocker || blocker.clearedAt !== undefined) throw new Error("Recorded blocker is missing or already cleared");
  blocker.clearedAt = Math.max(Date.now(),blocker.at);validateGoalPlanning(result,tasks);return result;
}
/** A real removed task invalidates its advisory edges, not historical blockers. */
export function pruneGoalDependencies(planning: GoalPlanning | undefined, tasks: readonly Task[]): void {
  if (!planning) return;const ids = new Set(tasks.map(task => task.id));
  planning.dependencies = planning.dependencies.filter(edge => ids.has(edge.taskId)).map(edge => ({taskId:edge.taskId,waitsFor:edge.waitsFor.filter(id => ids.has(id))})).filter(edge => edge.waitsFor.length);
}
