import { harnessReadOnlyRegistry, type ReadonlyPage } from "../../shared/harness-readonly.ts";

const LIMIT = 20;
const TIMEOUT_MS = 1_000;
type Context = { sessionManager: { getSessionId(): string; getBranch(): readonly unknown[] } };
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128;
const states = new Set(["starting", "pending", "running", "completed", "failed", "cancelled", "skipped", "lost", "unavailable", "unknown"]);

/** Read-only, bounded projection of existing owner-validated providers. Session
 * ownership is not goal assignment. Never expose private runtime/source fields. */
export async function readGoalSessionActivity(ctx: Context) {
  const sessionId = ctx.sessionManager.getSessionId();
  const registry = harnessReadOnlyRegistry();
  const read = async (kind: "jobs" | "subagents") => {
    const service = registry?.[kind];
    const unavailable = { state: "unavailable", stale: true, truncated: false, items: [] };
    if (!service || service.protocol !== 1 || service.sessionId !== sessionId) return unavailable;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const page = await Promise.race([
        service.list({ sessionId, limit: LIMIT }) as Promise<ReadonlyPage<any>>,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Activity timeout")), TIMEOUT_MS); }),
      ]);
      // Reload/session replacement while awaiting must not expose the old owner.
      if (ctx.sessionManager.getSessionId() !== sessionId || harnessReadOnlyRegistry()?.[kind] !== service ||
          page.protocol !== 1 || page.sessionId !== sessionId) return unavailable;
      if (page.state !== "available") return { ...unavailable, state: page.state === "unsupported" ? "unsupported" : "unavailable" };
      const guidance = new Map<string, string | undefined>();
      for (const raw of ctx.sessionManager.getBranch()) {
        const entry = raw as any;
        if (entry?.type !== "custom" || entry.customType !== "harness-state-receipt") continue;
        const receipt = entry.data;
        if (receipt?.v !== 1 || !id(receipt.key)) continue;
        guidance.set(receipt.key, receipt.state === "queued" && receipt.update?.requires_guidance === true && id(receipt.update.child_id) ? receipt.update.child_id : undefined);
      }
      const pending = new Set(guidance.values());
      const items = (Array.isArray(page.items) ? page.items : []).slice(0, LIMIT).flatMap(item => {
        if (!item || !states.has(item.status)) return [];
        if (kind === "jobs") return id(item.jobId) ? [{ jobId: item.jobId, status: item.status,
          observationOnly: item.observationOnly === true, fromSubagent: item.fromSubagent === true }] : [];
        if (!id(item.taskId) || !id(item.childId) || !id(item.groupId)) return [];
        return [{ taskId: item.taskId, childId: item.childId, jobId: item.groupId, status: item.status,
          stale: item.stale !== false, reaped: item.reaped === true, needsAttention: item.needsAttention === true,
          pendingGuidance: pending.has(item.childId) }];
      });
      return { state: "available", stale: page.stale !== false, truncated: !!page.nextCursor || page.items.length > LIMIT, items };
    } catch { return unavailable; } finally { clearTimeout(timer); }
  };
  const [jobs, subagents] = await Promise.all([read("jobs"), read("subagents")]);
  return { scope: "session-owned activity; goal assignment is not established", jobs, subagents,
    instructions: "Use exact jobId with background_job status/output, or subagent jobId/childId/taskId with its status/result/prompt operations as appropriate. Inspect stale records before relying on them. Pending guidance reflects queued delivery, not all unanswered requests. Read further inventory with those tools when truncated. Activity alone is not a reason to wait; preserve independent goal work." };
}
