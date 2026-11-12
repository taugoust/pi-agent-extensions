import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { GuidanceBroker, GUIDANCE_HISTORY_CUSTOM, guidanceHandle, handleTarget, type GuidanceRecord, type GuidanceTarget } from "./guidance.ts";
import { upstreamGuidance } from "./guidance-worker.ts";

const targetSchema = Type.Object({ ownerSessionId: Type.String(), ownerRuntimeEpoch: Type.String(), taskId: Type.String(), childId: Type.String(), attempt: Type.Integer({ minimum: 1 }), workerEpoch: Type.String(), goalId: Type.Optional(Type.String()), requestId: Type.String(), workerRuntimeEpoch: Type.String(), expectedRevision: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
/** Installed by subagent, not auto-discovered as a second extension. */
export function installGuidance(pi: ExtensionAPI, root: string, notify: (ctx: any, record: GuidanceRecord) => void) {
  let broker: GuidanceBroker | undefined;
  pi.on("session_start", async (_event, ctx) => {
    try {
      await broker?.close();
      broker = new GuidanceBroker(ctx.sessionManager.getSessionId(), root, record => notify(ctx, record), upstreamGuidance(), {
        archive(record) { pi.appendEntry(GUIDANCE_HISTORY_CUSTOM,{ownerSessionId:ctx.sessionManager.getSessionId(),record}); },
        hasRequest(requestId) { return ctx.sessionManager.getEntries().some((entry:any)=>entry.type==='custom'&&entry.customType===GUIDANCE_HISTORY_CUSTOM&&entry.data?.ownerSessionId===ctx.sessionManager.getSessionId()&&entry.data?.record?.requestId===requestId); },
      });
      await broker.start();
    } catch (error) { try { await broker?.close(); } catch { /* retain original startup error */ } broker = undefined; if (ctx.hasUI) ctx.ui.notify(`Coordinator guidance unavailable: ${String(error)}`, "warning"); }
  });
  pi.on("session_shutdown", async () => { try { await broker?.close(); } catch { /* Old pending records recover as unavailable, never replay. */ } finally { broker = undefined; } });
  pi.registerTool({ name: "guidance", label: "Coordinator guidance", description: "Resolve structured requests from your exact directly owned workers, not human goals.answer. list returns each request with an opaque handle; pass that handle to reply, escalate or human. reply supplies bounded implementation guidance and resolves the actual waiting tool. For questions outside your assignment use escalate to your direct parent; do not decide human preferences. human invokes the EXISTING questionnaire only at the top level and returns its actual human response to the correct worker; no model answer is accepted. Permission approvals are NEVER guidance. Retained unavailable/cancelled requests must not be replayed.",
    parameters: Type.Object({ operation: Type.Union([Type.Literal("list"), Type.Literal("reply"), Type.Literal("escalate"), Type.Literal("human")]), handle: Type.Optional(Type.String({ pattern: "^guidance-[0-9a-f]{24}$", description: "Request handle from guidance list or a guidance notification." })), target: Type.Optional(targetSchema), replyId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), guidance: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })) }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      if (!broker || broker.ownerSessionId !== ctx.sessionManager.getSessionId()) throw new Error("Owning coordinator runtime unavailable");
      let result: unknown;
      if (params.operation === "list") {
        if (params.handle || params.target || params.replyId || params.guidance) throw new Error("list accepts no reply fields");
        const records = broker.list().sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending") || b.createdAt.localeCompare(a.createdAt));
        const offset = params.offset ?? 0, limit = params.limit ?? 2;
        result = { history: 'Older terminal records are retained in coordinator-guidance-history-v1 session entries, never reconstructed as waiters.', records: records.slice(offset, offset + limit).map(record => ({ handle: guidanceHandle(record), ...record })), total: records.length, ...(offset + limit < records.length ? { nextOffset: offset + limit } : {}) };
      } else {
        if (params.offset !== undefined || params.limit !== undefined) throw new Error("Pagination fields are list-only");
        if (!!params.handle === !!params.target) throw new Error("Give the request's handle from guidance list (or, for compatibility, its exact target), not both");
        // The handle resolves to the full authenticated target server-side; the broker still checks
        // owner, attempt, epochs and revision exactly as for an explicit target.
        const record = params.handle ? broker.list().find(candidate => guidanceHandle(candidate) === params.handle) : undefined;
        if (params.handle && !record) throw new Error("Unknown, stale or foreign guidance handle; run guidance list for the current one");
        const target = record ? handleTarget(record) : params.target as GuidanceTarget;
        if (params.operation === "reply") {
          if (!params.replyId || !params.guidance) throw new Error("Reply requires explicit idempotency ID and guidance");
          result = broker.reply(target, params.replyId, { kind: "guidance", guidance: params.guidance });
        } else {
          if (params.replyId !== undefined || params.guidance !== undefined) throw new Error("Escalation/human accepts no model answer fields");
          if (params.operation === "escalate") result = await broker.forward(target, signal);
          else result = await broker.askHuman(target, async (input, waiterSignal) => {
            if (input.kind !== "questionnaire" || typeof (ctx as any).executeTool !== "function") throw new Error("Existing top-level questionnaire interaction unavailable");
            const outcome = await (ctx as any).executeTool("questionnaire", { questions: input.questions }, { signal: signal ? AbortSignal.any([signal, waiterSignal]) : waiterSignal });
            const details = outcome.result?.details;
            if (details?.timedOut) throw new Error("Questionnaire timed out.");
            if (outcome.isError || !details || details.failure || typeof details.cancelled !== "boolean"
              || details.cancelled && details.cancelledByHuman !== true) throw new Error("Top-level questionnaire did not return a verified result; request remains pending");
            return { kind: "questionnaire", cancelled: details.cancelled, answers: (details.answers ?? []).map(({ id, value, wasCustom }: any) => ({ id, value, wasCustom })) };
          });
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: { coordinatorGuidance: true } };
    } });
  return {
    pending(ctx:any):GuidanceRecord[]|undefined {
      if(!broker||broker.ownerSessionId!==ctx.sessionManager.getSessionId())return undefined;
      return broker.pendingNotifications();
    },
  };
}
