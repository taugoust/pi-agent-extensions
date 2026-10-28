import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ownedWorktrees } from "../../shared/subagent-worktrees.ts";
import { currentOwnerWorktreeSafety, ownedWorktreeCompletionHost } from "../../shared/worktree-completion-host.ts";
import { cleanupCompletedWorktree, markWorktreeComplete } from "../../shared/worktree-completion.ts";

/** Shared by the existing command and authenticated owner-session workflow service. */
export async function completionFlow(ctx: ExtensionCommandContext, action: "complete" | "cleanup", taskId: string, reason?: string, guard: () => void = () => {}): Promise<void> {
  guard();
  if (!/^subagent-task-[a-f0-9]{24}$/.test(taskId)) throw new Error("A valid owned task ID is required");
  if (!ctx.hasUI) throw new Error("Worktree completion/cleanup requires confirmation UI");
  const owner = ctx.sessionManager.getSessionId();
  const record = (await ownedWorktrees(owner)).find(row => row.taskId === taskId);
  if (!record) throw new Error("Worktree is not owned by this session");
  if (action === "complete" && (!reason?.trim() || reason.length > 2000)) throw new Error("Explicit completion requires a rationale of 1–2000 characters");
  if (!(await ctx.ui.confirm(action === "complete" ? "Mark owned worktree complete?" : "Clean up completed owned worktree?",
    `${taskId}\n${record.path}\nBranch: ${record.branch}\n\n${action === "complete" ? `${reason}\n\nThis records the owner's judgment only; it does not infer a merge or delete anything.` : "Removes this harness-created checkout and its exact completed branch. Active users, remaining files (including ignored files), changed identity, retained evidence or explicit retention block cleanup. No force removal is permitted."}`))) return;
  guard();
  if (ctx.sessionManager.getSessionId() !== owner) throw new Error("Owner session changed");
  const host = ownedWorktreeCompletionHost(ctx, r => { guard(); return currentOwnerWorktreeSafety(ctx, r); }, ctx.signal, guard);
  const result = action === "complete" ? await markWorktreeComplete(host, taskId, reason!) : await cleanupCompletedWorktree(host, taskId);
  ctx.ui.notify(result.blockedReason ? `Completion retained; cleanup blocked: ${result.blockedReason}` : `Owned worktree ${taskId}: ${result.phase}`, result.blockedReason ? "warning" : "info");
}
