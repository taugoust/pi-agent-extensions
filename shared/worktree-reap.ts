import { promises as fs } from "node:fs";
import { ownedWorktrees, saveOwnedWorktree, serialized, type OwnedWorktree } from "./subagent-worktrees.ts";
import { ownedWorktreeReapHost, type CompletionContext, type CompletionSafety, type WorktreeReapHost } from "./worktree-completion-host.ts";

export type ReapTarget = { ownerSessionId: string; taskId: string; childId: string; reaped: boolean; attempt?: number };
export type WorktreeReapRequest = {
  actorSessionId: string;
  /** Exact root identity supplied by the trusted manifest. */
  root?: Pick<ReapTarget, "ownerSessionId" | "taskId" | "childId">;
  /** Exact direct/nested targets from authenticated descendant ancestry. */
  descendants: ReapTarget[];
  /** All reachable owner sessions; every registry record for these owners is accounted for. */
  ownedSessionIds: string[];
  context: Pick<CompletionContext, "cwd" | "isIdle" | "hasPendingMessages"> & { safety?: CompletionSafety; managedWorktreeActivity?: (path: string) => Promise<boolean> };
  force?: boolean;
  reason?: string;
};
export type ReapIdentity = { ownerSessionId: string; taskId: string; childId: string; path: string; physicalIdentity?: OwnedWorktree["physicalIdentity"] };
export type ReapReport = { scope: "registered-harness-worktrees-only"; limitation: "Externally created or unregistered worktrees are not inventoried or removed"; removed: string[]; blocked: (ReapIdentity & { requestedRoot?: Pick<ReapTarget, "ownerSessionId" | "taskId" | "childId">; reason: string })[]; remaining: string[]; remainingWorktrees: ReapIdentity[]; audited: boolean };
export class WorktreeReapError extends Error {
  readonly report: ReapReport;
  constructor(message: string, report: ReapReport) { super(message); this.report = report; this.name = "WorktreeReapError"; }
}
type ReapHost = WorktreeReapHost;

const sameIdentity = (a: OwnedWorktree, b: OwnedWorktree) => a.ownerSessionId === b.ownerSessionId && a.taskId === b.taskId
  && a.childId === b.childId && a.path === b.path && a.repo === b.repo && a.commonDir === b.commonDir && a.branch === b.branch
  && JSON.stringify(a.physicalIdentity) === JSON.stringify(b.physicalIdentity);

/** Authenticated, exact-record worktree cleanup. This never marks completion or deletes branches. */
export async function reapOwnedWorktrees(host: ReapHost, request: WorktreeReapRequest): Promise<ReapReport>;
export async function reapOwnedWorktrees(request: WorktreeReapRequest): Promise<ReapReport>;
export async function reapOwnedWorktrees(first: ReapHost | WorktreeReapRequest, maybeRequest?: WorktreeReapRequest): Promise<ReapReport> {
  const request = maybeRequest ?? first as WorktreeReapRequest;
  const targets = new Map(request.descendants.map(row => [`${row.ownerSessionId}\0${row.taskId}`, row]));
  if (targets.size !== request.descendants.length) throw new Error("Duplicate attributed reap target");
  const safety: CompletionSafety = request.context.safety ?? (async record => ({ active: targets.get(`${record.ownerSessionId}\0${record.taskId}`)?.reaped !== true, retained: false }));
  const ctx: CompletionContext = { cwd: request.context.cwd, isIdle: request.context.isIdle, hasPendingMessages: request.context.hasPendingMessages,
    ...(request.context.managedWorktreeActivity ? { managedWorktreeActivity: request.context.managedWorktreeActivity } : {}),
    sessionManager: { getSessionId: () => request.actorSessionId } };
  const host = maybeRequest ? first as ReapHost : ownedWorktreeReapHost(ctx, safety, undefined, undefined, request.root, request.descendants, request.ownedSessionIds);
  if (!request.actorSessionId) throw new Error("Authenticated actor session is required");
  if (request.force && (!request.reason?.trim() || Buffer.byteLength(request.reason) > 1000)) throw new Error("Force audit requires a reason of 1–1000 bytes");
  const ownerIds = new Set(request.ownedSessionIds);
  const inventory = await ownedWorktrees();
  const records = inventory.filter(row => ownerIds.has(row.ownerSessionId));
  const rootCandidate = request.root && inventory.find(row => row.ownerSessionId === request.root!.ownerSessionId && row.taskId === request.root!.taskId);
  if (rootCandidate && !records.some(row => row.taskId === rootCandidate.taskId && row.ownerSessionId === rootCandidate.ownerSessionId)) records.push(rootCandidate);
  const report: ReapReport = { scope: "registered-harness-worktrees-only", limitation: "Externally created or unregistered worktrees are not inventoried or removed",
    removed: [], blocked: [], remaining: [], remainingWorktrees: [], audited: !!request.force };
  const rootRecord = rootCandidate?.childId === request.root?.childId ? rootCandidate : undefined;
  const rootIdentityMismatch = !!request.root && !!rootCandidate && !rootRecord;
  if (rootIdentityMismatch && !request.force) report.blocked.push({ ...identity(rootCandidate!), requestedRoot: request.root,
    reason: "Manifest root identity does not match the current registry child; refusing to remove a newer or replaced attempt" });
  for (const record of records) {
    if (record.ownerSessionId === request.root?.ownerSessionId && record.taskId === request.root.taskId) continue;
    const target = targets.get(`${record.ownerSessionId}\0${record.taskId}`);
    if (!request.force) {
      if (!target || target.childId !== record.childId) report.blocked.push({ ...identity(record), reason: "Owned registry record is missing exact authenticated ancestry/lifecycle evidence" });
      else if (!target.reaped || !record.released) report.blocked.push({ ...identity(record), reason: "Descendant is not verified reaped and released" });
    }
  }
  const selected = records.filter(record => !(request.root && record.ownerSessionId === request.root.ownerSessionId && record.taskId === request.root.taskId))
    .sort((a, b) => a.taskId.localeCompare(b.taskId) || a.ownerSessionId.localeCompare(b.ownerSessionId));
  if (request.force && rootCandidate) selected.push(rootCandidate); // force only audits current path/identity; never removes
  else if (rootRecord) selected.push(rootRecord); // normal root is always last
  if (request.force) {
    for (const record of selected) {
      try {
        await serialized(record.ownerSessionId, record.taskId, async () => {
          const latest = (await ownedWorktrees(record.ownerSessionId)).find(row => row.taskId === record.taskId);
          if (!latest || !sameIdentity(record, latest)) throw new Error("Owned registry identity changed");
          const isRoot = !!request.root && record.ownerSessionId === request.root.ownerSessionId && record.taskId === request.root.taskId;
          let uncertainty: string | undefined, observedPathIdentity: { dev: string; ino: string; birthtimeMs: string } | undefined;
          let provenance: "verified" | "uncertain" | "missing" = "uncertain";
          try {
            const stat = await fs.lstat(record.path);
            observedPathIdentity = { dev: String(stat.dev), ino: String(stat.ino), birthtimeMs: String(stat.birthtimeMs) };
            if (!stat.isDirectory() || stat.isSymbolicLink()) uncertainty = "Recorded path is not a regular worktree directory";
            else if (!record.physicalIdentity) uncertainty = "Registry physical identity is unavailable";
            else {
              const state = await host.inspectForReap(record.taskId, isRoot, record.ownerSessionId);
              if (state.identityChanged || !state.worktreeExists) uncertainty = "Worktree provenance could not be verified";
              else provenance = "verified";
            }
          } catch (error) { uncertainty = error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000); }
          if (!observedPathIdentity && uncertainty?.includes("ENOENT")) provenance = "missing";
          const audit = { at: new Date().toISOString(), actorSessionId: request.actorSessionId, ...(request.root ? { root: request.root } : {}),
            recordedIdentity: { ownerSessionId: record.ownerSessionId, taskId: record.taskId, childId: record.childId },
            ...(isRoot ? { requestedRoot: request.root } : {}), reason: request.reason!.trim(), path: record.path, ...(record.physicalIdentity ? { recordedPhysicalIdentity: record.physicalIdentity } : {}),
            ...(observedPathIdentity ? { observedPathIdentity } : {}), provenance, ...(uncertainty ? { uncertainty } : {}) };
          const audits = latest.reapAudits ?? [];
          const auditIdentity = (entry: typeof audit) => JSON.stringify({ ...entry, at: undefined });
          if (audits.some(entry => auditIdentity(entry) === auditIdentity(audit))) return;
          if (audits.length >= 32) throw new Error("Durable worktree reap audit history is full; operator review/archive required");
          await saveOwnedWorktree({ ...latest, reapAudits: [...audits, audit] });
        });
        if (await exists(record.path)) report.remaining.push(record.path);
      } catch (error) { report.blocked.push({ ...identity(record), reason: `Force audit failed: ${String(error)}` }); }
    }
    await collectRemaining(report, selected);
    await reconcileFinalInventory(report, records, request, true);
    if (report.blocked.length) throw reportError(report);
    return report;
  }
  if (report.blocked.length) { await collectRemaining(report, rootIdentityMismatch && rootCandidate ? [...selected, rootCandidate] : selected); throw reportError(report); }
  for (let index = 0; index < selected.length; index++) {
    const record = selected[index];
    try {
      await serialized(record.ownerSessionId, record.taskId, async () => {
        const latest = (await ownedWorktrees(record.ownerSessionId)).find(row => row.taskId === record.taskId);
        if (!latest || !sameIdentity(record, latest)) throw new Error("Owned registry identity changed");
        const target = targets.get(`${record.ownerSessionId}\0${record.taskId}`);
        const root = !!request.root && record.taskId === request.root.taskId && record.ownerSessionId === request.root.ownerSessionId;
        if (!root && (!target?.reaped || !latest.released)) throw new Error("Descendant is not verified reaped and released");
        let reap = latest.reap;
        const state = await host.inspectForReap(record.taskId, root, record.ownerSessionId);
        if (!reap) {
          if (completionRemovalVerified(latest, state)) {
            reap = { version: 1, phase: "cleaned", requestedAt: new Date().toISOString(), branchOid: latest.completion!.branchOid, branchIdentity: latest.completion!.branchIdentity };
            await saveOwnedWorktree({ ...latest, reap }); report.removed.push(record.path); return;
          }
          const blocked = blockerReason(state, root);
          if (blocked) throw new Error(blocked);
          if (!state.worktreeExists) throw new Error("Recorded worktree path is missing before reap intent");
          if (!state.branchOid) throw new Error("Recorded branch identity is unavailable");
          reap = { version: 1, phase: "intent", requestedAt: new Date().toISOString(), branchOid: state.branchOid, branchIdentity: state.branchIdentity };
          await saveOwnedWorktree({ ...latest, reap });
        }
        if (reap.phase === "cleaned") {
          if (state.worktreeExists || state.identityChanged || state.active) throw new Error(blockerReason(state, root) ?? "Cleaned worktree path or identity was reused");
          report.removed.push(record.path); return;
        }
        if (reap.phase !== "worktree-removed") {
          const current = await host.inspectForReap(record.taskId, root, record.ownerSessionId);
          if (current.branchOid !== reap.branchOid || current.branchIdentity !== reap.branchIdentity) throw new Error("Branch identity or history changed since reap intent");
          if (current.worktreeExists) {
            const blocked = blockerReason(current, root);
            if (blocked) throw new Error(blocked);
            if (current.branchOid !== reap.branchOid || (reap.branchIdentity && current.branchIdentity !== reap.branchIdentity)) throw new Error("Branch identity or history changed since reap intent");
            await host.removeForReap(record.taskId, reap.branchOid, root, record.ownerSessionId, reap.branchIdentity);
          }
          await saveOwnedWorktree({ ...(await ownedWorktrees(record.ownerSessionId)).find(row => row.taskId === record.taskId)!, reap: { ...reap, phase: "worktree-removed" } });
        }
        const after = await host.inspectForReap(record.taskId, root, record.ownerSessionId);
        if (after.worktreeExists || after.identityChanged || after.active || after.activityUnavailable) throw new Error(blockerReason(after, root) ?? "Removed worktree path or identity could not be safely verified");
        if (after.branchOid !== reap.branchOid || after.branchIdentity !== reap.branchIdentity) throw new Error("Branch identity or history changed while recording worktree removal");
        await saveOwnedWorktree({ ...(await ownedWorktrees(record.ownerSessionId)).find(row => row.taskId === record.taskId)!, reap: { ...reap, phase: "cleaned" } });
        report.removed.push(record.path);
      });
    } catch (error) {
      report.blocked.push({ ...identity(record), reason: String(error) });
      await collectRemaining(report, selected.slice(index));
      break;
    }
  }
  if (!report.blocked.length) await reconcileFinalInventory(report, records, request, false);
  if (report.blocked.length) throw reportError(report);
  return report;
}
async function reconcileFinalInventory(report: ReapReport, previous: OwnedWorktree[], request: WorktreeReapRequest, auditOnly: boolean) {
  const owners = new Set(request.ownedSessionIds);
  const current = (await ownedWorktrees()).filter(row => owners.has(row.ownerSessionId)
    || !!request.root && row.ownerSessionId === request.root.ownerSessionId && row.taskId === request.root.taskId);
  for (const row of current) {
    const known = previous.some(record => sameIdentity(record, row));
    if (!known || !auditOnly && await exists(row.path)) report.blocked.push({ ...identity(row),
      reason: known ? "Registered owned worktree remains after cleanup; retry guarded reconciliation"
        : "Attributable worktree inventory changed during reap; retry to reconcile or audit its exact identity" });
  }
  if (report.blocked.length) await collectRemaining(report, current);
}
function identity(record: OwnedWorktree): ReapIdentity {
  return { ownerSessionId: record.ownerSessionId, taskId: record.taskId, childId: record.childId, path: record.path,
    ...(record.physicalIdentity ? { physicalIdentity: record.physicalIdentity } : {}) };
}
async function collectRemaining(report: ReapReport, records: OwnedWorktree[]) {
  const identities = new Map(report.remainingWorktrees.map(row => [`${row.ownerSessionId}\0${row.taskId}`, row]));
  for (const record of records) {
    if (!await exists(record.path)) continue;
    identities.set(`${record.ownerSessionId}\0${record.taskId}`, identity(record));
    if (!report.remaining.includes(record.path)) report.remaining.push(record.path);
  }
  report.remainingWorktrees = [...identities.values()];
}
function reportError(report: ReapReport) { return new WorktreeReapError(formatBlockers(report), report); }
async function exists(path: string) { try { await fs.lstat(path); return true; } catch (error: any) { return error.code !== "ENOENT"; } }
function completionRemovalVerified(record: OwnedWorktree, state: Awaited<ReturnType<ReapHost["inspectForReap"]>>) {
  const completion = record.completion;
  if (!completion || !["worktree-removed", "cleaned"].includes(completion.phase) || !state.owned || !state.released || state.retained
    || state.active || state.activityUnavailable || state.identityChanged || state.remainingFiles || state.worktreeExists) return false;
  if (completion.phase === "worktree-removed") return state.branchOid === completion.branchOid && state.branchIdentity === completion.branchIdentity;
  return state.branchOid === undefined;
}
function blockerReason(state: Awaited<ReturnType<ReapHost["inspectForReap"]>>, allowReservedUnreleased = false): string | undefined {
  if (!state.owned) return "Harness ownership cannot be verified";
  if (state.activityUnavailable) return state.activityUnavailable;
  if (state.retained) return "Explicit retention or retained evidence prevents worktree reap";
  if (state.active) return "An active agent, process, or user is still using the worktree";
  if (!allowReservedUnreleased && !state.released) return "Worktree lifecycle is not released";
  if (state.identityChanged) return "Worktree path, physical identity, repository, or branch identity changed";
  if (state.remainingFiles) return "Worktree contains remaining files or protected repository state";
  return;
}
function formatBlockers(report: ReapReport) {
  const remaining = [...new Set(report.remaining)];
  return `Worktree reap blocked: ${report.blocked.map(row => `${row.ownerSessionId}/${row.taskId}/${row.childId} (${row.path}): ${row.reason}`).join("; ")}. Remaining paths: ${remaining.join(", ") || "none removed"}`;
}
