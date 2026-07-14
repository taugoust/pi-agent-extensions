/**
 * Subagent Finalizer Extension
 *
 * Gives long-running child Pi processes one urgent steering turn before their
 * context reaches automatic compaction. Top-level Pi sessions remain inert.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export const SUBAGENT_FINALIZE_THRESHOLD_PERCENT = 90;

export const SUBAGENT_FINALIZE_MESSAGE =
  "URGENT: Context usage has exceeded 90%. Finish now and return your answer to the original task immediately. " +
  "Do not make any more tool calls or continue investigating. Give the best complete answer you can from the work already done before automatic compaction.";

export function isSubagentProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.AGENTSH_SUBAGENT_ID?.trim() || env.PI_SUBAGENT_ID?.trim());
}

export default function (pi: ExtensionAPI) {
  if (!isSubagentProcess()) return;

  let finalizeMessageSent = false;

  pi.on("turn_end", (event, ctx) => {
    if (finalizeMessageSent) return;
    if (event.message.role !== "assistant") return;
    if (event.message.stopReason !== "toolUse" && event.message.stopReason !== "length") return;

    const percent = ctx.getContextUsage()?.percent;
    if (typeof percent !== "number" || !Number.isFinite(percent)) return;
    if (percent <= SUBAGENT_FINALIZE_THRESHOLD_PERCENT) return;

    finalizeMessageSent = true;
    pi.sendUserMessage(SUBAGENT_FINALIZE_MESSAGE, { deliverAs: "steer" });
  });
}
