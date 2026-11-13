import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GOAL_REVIEW_WORKER_KEY, type GoalReferenceRequest } from "./goal-review-worker.ts";

type ReferenceInput = Omit<GoalReferenceRequest, "request_id">;

/** Registration grants no read authority: the dedicated goal worker must exist,
 * inherited read must still be active, and file reads run through Pi tool hooks. */
export function registerGoalReferenceTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "goal_reference",
    label: "Goal reference",
    description: "Register a source or deliverable for the current dedicated goal. Workspace text and PNG files are read through the read tool and need read permission. HTTPS links are recorded, not fetched. Returns a reference ID you can pass to questionnaire attachmentIds.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 160 },
        target: { type: "string", minLength: 1, maxLength: 4096, description: "A workspace-relative file path or an HTTPS link." },
        role: { type: "string", enum: ["source", "deliverable"] },
      },
      required: ["title", "target", "role"],
      additionalProperties: false,
    } as any,
    async execute(toolCallId, input: ReferenceInput, signal, _update, ctx) {
      const worker = (globalThis as any)[GOAL_REVIEW_WORKER_KEY];
      const tools = pi.getActiveTools();
      const available = worker?.protocol === 1 && worker.sessionId === ctx.sessionManager.getSessionId()
        && typeof worker.register === "function" && tools.includes("read") && tools.includes("goal_reference");
      if (!available) throw Error("Goal reference requires the exact dedicated worker and inherited read capability");
      const executeTool = (ctx as any).executeTool;
      if (typeof executeTool !== "function") throw Error("Goal reference requires nested read-tool support in this runtime");

      const request: GoalReferenceRequest = { request_id: toolCallId, title: input.title, target: input.target, role: input.role };
      const read = (path: string, readSignal?: AbortSignal) => executeTool("read", { path }, { signal: readSignal });
      const reference = await worker.register(request, read, signal);
      return {
        content: [{ type: "text" as const, text: `Registered goal reference ${reference.id}: ${reference.title}` }],
        details: { reference_id: reference.id, role: reference.role, kind: reference.kind },
      };
    },
  });
}
