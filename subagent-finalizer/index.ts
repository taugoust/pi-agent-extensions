/**
 * Subagent Finalizer Extension
 *
 * Gives long-running child Pi processes one urgent steering turn before their
 * context reaches automatic compaction or their AgentSH execution deadline.
 * Top-level Pi sessions remain inert.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export const SUBAGENT_FINALIZE_THRESHOLD_PERCENT = 90;
export const SUBAGENT_DEADLINE_WARNING_LEAD_MS = 5 * 60 * 1000;
export const AGENTSH_SUBAGENT_DEADLINE_ENV = "AGENTSH_SUBAGENT_DEADLINE_EPOCH_MS";
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export const SUBAGENT_FINALIZE_MESSAGE =
  "URGENT: Context usage has exceeded 90%. Finish now and return your answer to the original task immediately. " +
  "Stop investigating and making work/tool calls, except: if task_outcome is available and you have not reported the current outcome, make one truthful task_outcome call, then return. " +
  "Use partial, blocked, or checkpointed when work is incomplete; never claim delivered just to finish. Report only evidence already obtained and any remaining work before automatic compaction.";

export const SUBAGENT_DEADLINE_FINALIZE_MESSAGE =
  "URGENT: Your execution deadline is near. Finish now and return your answer to the original task immediately. " +
  "Stop investigating and making work/tool calls, except: if task_outcome is available and you have not reported the current outcome, make one truthful task_outcome call, then return. " +
  "Use partial, blocked, or checkpointed when work is incomplete; never claim delivered just to finish. Report only evidence already obtained and any remaining work before the supervisor ends this subagent.";

export function isSubagentProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.AGENTSH_SUBAGENT_ID?.trim() || env.PI_SUBAGENT_ID?.trim());
}

export function subagentDeadlineEpochMS(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env[AGENTSH_SUBAGENT_DEADLINE_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const deadline = Number(raw);
  if (!Number.isSafeInteger(deadline) || deadline <= 0) return undefined;
  return deadline;
}

export function subagentDeadlineWarningAt(now: number, deadline: number): number {
  const remaining = Math.max(0, deadline - now);
  const proportionalLead = Math.max(1, Math.floor(remaining / 4));
  const lead = Math.min(SUBAGENT_DEADLINE_WARNING_LEAD_MS, proportionalLead);
  return Math.max(now, deadline - lead);
}

export default function (pi: ExtensionAPI) {
  if (!isSubagentProcess()) return;

  let finalizeMessageSent = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  const sendFinalizationMessage = (message: string) => {
    if (finalizeMessageSent) return;
    finalizeMessageSent = true;
    pi.sendUserMessage(message, { deliverAs: "steer" });
  };

  const clearDeadlineTimer = () => {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    deadlineTimer = undefined;
  };

  pi.on("session_start", () => {
    clearDeadlineTimer();
    const deadline = subagentDeadlineEpochMS();
    if (deadline === undefined || finalizeMessageSent) return;
    const warningAt = subagentDeadlineWarningAt(Date.now(), deadline);
    const waitUntilWarning = () => {
      const remaining = warningAt - Date.now();
      if (remaining <= 0) {
        deadlineTimer = undefined;
        sendFinalizationMessage(SUBAGENT_DEADLINE_FINALIZE_MESSAGE);
        return;
      }
      deadlineTimer = setTimeout(waitUntilWarning, Math.min(remaining, MAX_TIMER_DELAY_MS));
      deadlineTimer.unref?.();
    };
    waitUntilWarning();
  });

  pi.on("session_shutdown", clearDeadlineTimer);

  pi.on("turn_end", (event, ctx) => {
    if (finalizeMessageSent) return;
    if (event.message.role !== "assistant") return;
    if (event.message.stopReason !== "toolUse" && event.message.stopReason !== "length") return;

    const percent = ctx.getContextUsage()?.percent;
    if (typeof percent !== "number" || !Number.isFinite(percent)) return;
    if (percent <= SUBAGENT_FINALIZE_THRESHOLD_PERCENT) return;

    sendFinalizationMessage(SUBAGENT_FINALIZE_MESSAGE);
  });
}
