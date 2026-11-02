import type { TuiWorkerManifest } from "./tui-worker-protocol.ts";

export type WorktreeIdentity = { ownerSessionId: string; taskId: string; childId: string };
export type WorkerWorktreeContext = {
  sessionId: string;
  automaticWorktrees: boolean;
  self: WorktreeIdentity;
  worktree?: WorktreeIdentity;
};
const key = Symbol.for("pi.authenticatedWorkerWorktreeContext.v1");
/** Installed only after the worker extension verifies its private manifest/session binding. */
export function installWorkerWorktreeContext(sessionId: string, manifest: TuiWorkerManifest): () => void {
  const value: WorkerWorktreeContext = { sessionId, automaticWorktrees: manifest.automaticWorktrees === true,
    self: { ownerSessionId: manifest.ownerSessionId, taskId: manifest.taskId, childId: manifest.childId },
    ...(manifest.worktreeIdentity ? { worktree: structuredClone(manifest.worktreeIdentity) } : {}) };
  (globalThis as any)[key] = value;
  return () => { if ((globalThis as any)[key] === value) delete (globalThis as any)[key]; };
}
export function workerWorktreeContext(sessionId: string): WorkerWorktreeContext | undefined {
  const value = (globalThis as any)[key] as WorkerWorktreeContext | undefined;
  return value?.sessionId === sessionId ? structuredClone(value) : undefined;
}
/** Parent policy, not the selected child's profile or the presence of a Goal. */
export function applyAutomaticWorktreePolicy(params: any, sessionId: string): any {
  if (params.operation || params.action) return params;
  const enabled = workerWorktreeContext(sessionId)?.automaticWorktrees === true;
  const apply = (spec: any) => ({ ...spec, ...(spec.worktree === undefined && enabled ? { worktree: true } : {}) });
  return params.tasks ? { ...params, tasks: params.tasks.map(apply) }
    : params.chain ? { ...params, chain: params.chain.map(apply) } : apply(params);
}
