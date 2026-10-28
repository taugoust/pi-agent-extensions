/** Explicit model-judged completion, not evidence of merge or permission to delete.
 * Host bindings must authenticate the owning session before invoking this API.
 * No paths or profile names are accepted from the caller.
 */
export type WorktreeCompletion = {
  version: 1;
  taskId: string;
  ownerSessionId: string;
  decidedBySessionId: string;
  reason: string;
  completedAt: string;
  branchOid: string;
  branchIdentity?: string;
  phase: "marked" | "removal-pending" | "worktree-removed" | "cleaned";
  blockedReason?: string;
};
export interface CompletionInspection {
  /** Exact, validated ownership record still exists, including recorded path identity. */
  owned: boolean;
  released: boolean;
  retained: boolean;
  active: boolean;
  activityUnavailable?: string;
  /** Includes ignored/untracked files, index flags and initialized submodules. */
  remainingFiles: boolean;
  /** Path/administrative identity changed, nested or linked checkout, branch used elsewhere. */
  identityChanged: boolean;
  worktreeExists: boolean;
  branchOid?: string;
  branchIdentity?: string;
}
export interface CompletionHost {
  /** Serialize with provisioning/resume/release and other cleanup operations. */
  exclusive<T>(owner: string, task: string, action: () => Promise<T>): Promise<T>;
  /** Authenticated context identity; never a request-supplied owner/profile. */
  authorize(task: string): Promise<{ ownerSessionId: string; actorSessionId: string }>;
  load(owner: string, task: string): Promise<WorktreeCompletion | undefined>;
  /** Atomic durable write; preserve this record after filesystem removal. */
  save(marker: WorktreeCompletion): Promise<void>;
  inspect(owner: string, task: string): Promise<CompletionInspection>;
  /** Non-force removal through existing permission boundary. Recheck before mutation. */
  removeWorktree(owner: string, task: string, expectedOid: string): Promise<void>;
  /** Compare-and-delete exact ref with expected OID; refuse a checked-out branch. */
  deleteBranch(owner: string, task: string, expectedOid: string): Promise<void>;
}
function blocker(s: CompletionInspection, marker: WorktreeCompletion): string | undefined {
  if (!s.owned) return "Harness ownership cannot be verified";
  if (s.retained) return "Explicit retention or retained evidence prevents cleanup";
  if (s.activityUnavailable) return s.activityUnavailable;
  if (s.active || !s.released) return "An agent or user may still be using the worktree";
  if (s.identityChanged) return "Worktree or branch identity changed or is linked elsewhere";
  if (s.remainingFiles) return "Worktree contains remaining files or protected repository state";
  if (s.branchOid && marker.branchIdentity && s.branchIdentity !== marker.branchIdentity) return "Branch reference history changed since completion";
  if (s.branchOid !== marker.branchOid && !(marker.phase === "worktree-removed" && !s.branchOid)) return "Branch advanced, was replaced, or disappeared since completion";
  if (marker.phase === "marked" && !s.worktreeExists) return "Worktree disappeared before cleanup began";
  if (marker.phase === "worktree-removed" && s.worktreeExists) return "Worktree path was reused after removal";
}
export function validateWorktreeCompletion(value: WorktreeCompletion, owner: string, task: string): void {
  if (!value || value.version !== 1 || value.ownerSessionId !== owner || value.taskId !== task
    || typeof value.decidedBySessionId !== "string" || !value.decidedBySessionId
    || typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > 2000
    || typeof value.completedAt !== "string" || !Number.isFinite(Date.parse(value.completedAt))
    || !/^[a-f0-9]{40,64}$/.test(value.branchOid)
    || (value.branchIdentity !== undefined && !/^[a-f0-9]{64}$/.test(value.branchIdentity))
    || !["marked", "removal-pending", "worktree-removed", "cleaned"].includes(value.phase)
    || (value.blockedReason !== undefined && (typeof value.blockedReason !== "string" || value.blockedReason.length > 2000))) throw new Error("Invalid worktree completion record");
}
export async function markWorktreeComplete(host: CompletionHost, task: string, reason: string): Promise<WorktreeCompletion> {
  if (!reason.trim() || reason.length > 2000) throw new Error("A completion rationale of 1–2000 characters is required");
  const identity = await host.authorize(task);
  return host.exclusive(identity.ownerSessionId, task, async () => {
    const previous = await host.load(identity.ownerSessionId, task);
    if (previous) { validateWorktreeCompletion(previous, identity.ownerSessionId, task); return previous; } // Repeated completion cannot move the deletion snapshot.
    const state = await host.inspect(identity.ownerSessionId, task);
    if (!state.owned || state.identityChanged || !state.worktreeExists || !state.branchOid) throw new Error("Harness worktree identity cannot be verified for completion");
    const marker: WorktreeCompletion = { version: 1, taskId: task, ownerSessionId: identity.ownerSessionId,
      decidedBySessionId: identity.actorSessionId, reason: reason.trim(), completedAt: new Date().toISOString(),
      branchOid: state.branchOid, branchIdentity: state.branchIdentity, phase: "marked" };
    validateWorktreeCompletion(marker, identity.ownerSessionId, task);
    await host.save(marker);
    return marker;
  });
}
export async function cleanupCompletedWorktree(host: CompletionHost, task: string): Promise<WorktreeCompletion> {
  const identity = await host.authorize(task);
  return host.exclusive(identity.ownerSessionId, task, async () => {
    let marker = await host.load(identity.ownerSessionId, task);
    if (!marker) throw new Error("Explicit completion is required before cleanup");
    validateWorktreeCompletion(marker, identity.ownerSessionId, task);
    if (marker.ownerSessionId !== identity.ownerSessionId || marker.taskId !== task) throw new Error("Completion ownership mismatch");
    if (marker.phase === "cleaned") return marker;
    const persist = async (patch: Partial<WorktreeCompletion>) => {
      marker = { ...marker!, ...patch, ...(patch.blockedReason ? { blockedReason: patch.blockedReason.slice(0, 2000) } : {}) }; await host.save(marker); return marker;
    };
    try {
      let state = await host.inspect(identity.ownerSessionId, task);
      let blocked = blocker(state, marker);
      if (blocked) return await persist({ blockedReason: blocked });
      if (marker.phase !== "worktree-removed") {
        await persist({ phase: "removal-pending", blockedReason: undefined });
        // Durable intent allows recovery when removal succeeds but the next save fails.
        state = await host.inspect(identity.ownerSessionId, task);
        blocked = blocker(state, marker);
        if (blocked) return await persist({ blockedReason: blocked });
        if (state.worktreeExists) await host.removeWorktree(identity.ownerSessionId, task, marker.branchOid);
        await persist({ phase: "worktree-removed", blockedReason: undefined });
      }
      state = await host.inspect(identity.ownerSessionId, task);
      blocked = blocker(state, marker);
      if (blocked) return await persist({ blockedReason: blocked });
      if (state.branchOid) await host.deleteBranch(identity.ownerSessionId, task, marker.branchOid);
      return await persist({ phase: "cleaned", blockedReason: undefined });
    } catch (error) {
      return persist({ blockedReason: `Cleanup stopped: ${error instanceof Error ? error.message : String(error)}` });
    }
  });
}
