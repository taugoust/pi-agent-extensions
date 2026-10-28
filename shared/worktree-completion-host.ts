import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, relative, sep, join } from "node:path";
import { ownedWorktrees, saveOwnedWorktree, serialized, worktreeGit, type OwnedWorktree } from "./subagent-worktrees.ts";
import { listWorktrees, worktreeInventory } from "../workflows/worktree/git.ts";
import { harnessReadOnlyRegistry } from "./harness-readonly.ts";
import { type CompletionHost, type CompletionInspection, type WorktreeCompletion } from "./worktree-completion.ts";

const within = (root: string, path: string) => { const part = relative(root, path); return !part || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`)); };
/** On-demand same-user process evidence. Unsupported/inaccessible evidence fails closed. */
export async function worktreeHasActiveUsers(path: string): Promise<boolean> {
  if (process.platform !== "linux" || !process.getuid) throw new Error("Active-user inspection is unavailable on this platform");
  const processes = (await fs.readdir("/proc")).filter(name => /^\d+$/.test(name));
  if (processes.length > 16384) throw new Error("Active-user process inventory exceeds the safe inspection limit");
  let descriptors = 0;
  for (const name of processes) {
    if (!/^\d+$/.test(name)) continue;
    const base = join("/proc", name);
    try {
      if ((await fs.stat(base)).uid !== process.getuid()) continue;
      if (within(path, (await fs.readlink(join(base, "cwd"))).replace(/ \(deleted\)$/, ""))) return true;
      for (const fd of await fs.readdir(join(base, "fd"))) {
        if (++descriptors > 65536) throw new Error("Active-user descriptor inventory exceeds the safe inspection limit");
        try { if (within(path, (await fs.readlink(join(base, "fd", fd))).replace(/ \(deleted\)$/, ""))) return true; }
        catch (error: any) { if (error.code !== "ENOENT") throw error; }
      }
    } catch (error: any) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw new Error(`Cannot verify active users: ${error.message}`); }
  }
  return false;
}
export type CompletionContext = {
  sessionManager: { getSessionId(): string };
  cwd: string;
  isIdle(): boolean;
  hasPendingMessages(): boolean;
};
/** Terminal retained evidence is never inferred to be disposable from release alone. */
export async function currentOwnerWorktreeSafety(ctx: CompletionContext, record: OwnedWorktree) {
  const owner = ctx.sessionManager.getSessionId(), service = harnessReadOnlyRegistry()?.subagents;
  if (!service || service.sessionId !== owner || record.ownerSessionId !== owner) throw new Error("Worker activity/evidence inventory unavailable for this owner session");
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const snapshot = await service.list({ sessionId: owner, limit: 50, cursor });
    if (snapshot.state !== "available" || snapshot.sessionId !== owner) throw new Error("Worker activity/evidence inventory is unavailable");
    // Inventory snapshots intentionally advertise stale=true; they locate identity only.
    const task = snapshot.items.find(row => row.taskId === record.taskId && row.childId === record.childId);
    if (task) {
      if (!service.sessionSource) throw new Error("Verified worker session source unavailable");
      const source = await service.sessionSource({ sessionId: owner, taskId: task.taskId, childId: task.childId, attempt: task.attempt, runtimeId: task.runtimeId });
      if (source.taskId !== record.taskId || source.childId !== record.childId || source.attempt !== task.attempt || source.runtimeId !== task.runtimeId || source.cwd !== record.cwd) throw new Error("Worker source identity changed");
      return { active: source.status === "running" || source.reaped !== true, retained: source.status !== "completed" };
    }
    cursor = snapshot.nextCursor;
    if (!cursor) break;
  }
  throw new Error("Worker activity/evidence record unavailable; cleanup requires owner review");
}
export type CompletionSafety = (record: OwnedWorktree) => Promise<{ active: boolean; retained: boolean }>;
/** Identity is captured from a real command/service context, never from request data. */
export function ownedWorktreeCompletionHost(ctx: CompletionContext, safety: CompletionSafety, signal?: AbortSignal, guard: () => void = () => {}): CompletionHost {
  const owner = ctx.sessionManager.getSessionId();
  const current = () => { guard(); if (!owner || ctx.sessionManager.getSessionId() !== owner || signal?.aborted) throw new Error("Worktree owner session changed or operation cancelled"); };
  const record = async (task: string) => { current(); const value = (await ownedWorktrees(owner)).find(r => r.taskId === task); if (!value) throw new Error("Worktree is not owned by the current session"); return value; };
  const exec = async (_command: string, args: string[], options: any = {}) => ({ code: 0, killed: false, stderr: "", stdout: await worktreeGit(args, options.cwd, signal) });
  async function inspect(task: string): Promise<CompletionInspection> {
    const r = await record(task);
    let activityUnavailable: string | undefined;
    const extra = await safety(r).catch(error => { activityUnavailable = error.message; return { active: true, retained: false }; });
    let exists = true;
    try { const stat = await fs.lstat(r.path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Worktree path replaced"); }
    catch (error: any) { if (error.code === "ENOENT") exists = false; else throw error; }
    if (!isAbsolute(r.path) || !r.branch.startsWith("pi/") || r.path === r.repo || !r.physicalIdentity) throw new Error("Harness worktree provenance unavailable");
    if (await fs.realpath(r.commonDir) !== r.commonDir || await fs.realpath(r.repo) !== r.repo) throw new Error("Repository identity changed");
    const common = (await worktreeGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], r.repo, signal)).trim();
    if (common !== r.commonDir) throw new Error("Repository common directory changed");
    await worktreeGit(["check-ref-format", `refs/heads/${r.branch}`], r.repo, signal);
    const trees = await listWorktrees({ exec }, r.repo, signal);
    const own = trees.find(t => t.path === r.path);
    let identityChanged = exists ? !own || own.branch !== r.branch || own.lockedReason !== undefined || own.prunableReason !== undefined : !!own;
    if (trees.some(t => t.path !== r.path && (t.branch === r.branch || within(r.path, t.path) || within(t.path, r.path)))) identityChanged = true;
    let remainingFiles = false;
    if (exists) {
      if (await fs.realpath(r.path) !== r.path) identityChanged = true;
      const gitDir = (await worktreeGit(["rev-parse", "--path-format=absolute", "--git-dir"], r.path, signal)).trim();
      const stat = await fs.stat(gitDir), expected = r.physicalIdentity;
      if (String(stat.dev) !== expected.dev || String(stat.ino) !== expected.ino || String(stat.birthtimeMs) !== expected.birthtimeMs) identityChanged = true;
      if ((await worktreeGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], r.path, signal)).trim() !== r.commonDir) identityChanged = true;
      if ((await worktreeInventory({ exec }, r.path, signal)).length) remainingFiles = true;
      // Git status omits empty untracked directories: preserve those artifacts too.
      const tracked = (await worktreeGit(["ls-files", "-z"], r.path, signal)).split("\0").filter(Boolean);
      const inspectDirectory = async (directory: string, prefix = ""): Promise<void> => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          const path = prefix + entry.name;
          if (path === ".git") continue;
          if (entry.isDirectory()) {
            if (!tracked.some(file => file.startsWith(`${path}/`))) remainingFiles = true;
            else await inspectDirectory(join(directory, entry.name), `${path}/`);
          } else if (!tracked.includes(path)) remainingFiles = true;
        }
      };
      await inspectDirectory(r.path);
    }
    let branchOid: string | undefined, branchIdentity: string | undefined;
    const refs = await worktreeGit(["for-each-ref", "--format=%(refname)%00%(objectname)", `refs/heads/${r.branch}`], r.repo, signal);
    const exact = refs.trim().split("\n").find(line => line.split("\0")[0] === `refs/heads/${r.branch}`);
    if (exact) {
      branchOid = exact.split("\0")[1];
      // Raw reflog plus ref stat detects advance-and-return and replacement, not just OID changes.
      const refPath = join(r.commonDir, "refs", "heads", r.branch);
      const digest = createHash("sha256");
      try { const stat = await fs.lstat(refPath); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe branch ref"); digest.update(`${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.mtimeMs}:${stat.ctimeMs}`); }
      catch (error: any) { if (error.code !== "ENOENT") throw error; digest.update("packed"); }
      try { digest.update(await fs.readFile(join(r.commonDir, "logs", "refs", "heads", r.branch))); }
      catch (error: any) { if (error.code !== "ENOENT") throw error; throw new Error("Branch history evidence unavailable"); }
      branchIdentity = digest.digest("hex");
    }
    let processActive = true;
    try { processActive = await worktreeHasActiveUsers(r.path); }
    catch (error: any) { activityUnavailable = error.message; }
    return { activityUnavailable, owned: true, released: r.released, retained: !!r.retain || r.state !== "ready" || !!r.error || extra.retained,
      active: extra.active || !ctx.isIdle() || ctx.hasPendingMessages() || within(r.path, ctx.cwd) || processActive,
      remainingFiles, identityChanged, worktreeExists: exists, branchOid, branchIdentity };
  }
  async function guarded(task: string, oid: string, removed: boolean) {
    current(); const r = await record(task), state = await inspect(task), marker = r.completion;
    if (!marker || marker.phase !== (removed ? "worktree-removed" : "removal-pending") || marker.branchOid !== oid || state.branchOid !== oid || marker.branchIdentity !== state.branchIdentity
      || !state.released || state.active || state.retained || state.identityChanged || state.remainingFiles || state.worktreeExists === removed) throw new Error("Worktree cleanup preconditions changed");
    return r;
  }
  return {
    authorize: async task => { await record(task); return { ownerSessionId: owner, actorSessionId: owner }; },
    exclusive: async (session, task, action) => { if (session !== owner) throw new Error("Owner mismatch"); return serialized(owner, task, action); },
    load: async (_session, task) => (await record(task)).completion,
    save: async marker => { current(); const r = await record(marker.taskId); if (marker.ownerSessionId !== owner) throw new Error("Owner mismatch"); await saveOwnedWorktree({ ...r, completion: marker }); },
    inspect: async (_session, task) => inspect(task),
    removeWorktree: async (_session, task, oid) => { const r = await guarded(task, oid, false); await worktreeGit(["worktree", "remove", r.path], r.repo, signal); },
    deleteBranch: async (_session, task, oid) => { const r = await guarded(task, oid, true); await worktreeGit(["update-ref", "-d", `refs/heads/${r.branch}`, oid], r.repo, signal); },
  };
}
