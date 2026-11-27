import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

type ParentNotifier = (message: string) => boolean;
type ToolResultRegistrar = (handler: (event: ToolResultEvent) => void) => () => void;

const MAX_NOTIFICATION_BYTES = 1000;
const ACTION_BUDGET_BYTES = 400;
const REPORT_SEPARATOR = "\nChild report: ";
const TRUNCATION_MARKER = "…[truncated]";

export function latestAssistantReport(branch: unknown[]): string {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as any;
    const message = entry?.type === "message" ? entry.message : entry;
    if (message?.role !== "assistant") continue;
    const text = assistantText(message.content).trim();
    if (text) return text;
  }
  return "";
}

function assistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");
}

function clippedHead(text: string, budget: number): string {
  if (Buffer.byteLength(text) <= budget) return text;
  const contentBudget = budget - Buffer.byteLength(TRUNCATION_MARKER);
  let clipped = "";
  for (const character of text) {
    if (Buffer.byteLength(clipped) + Buffer.byteLength(character) > contentBudget) break;
    clipped += character;
  }
  return `${clipped}${TRUNCATION_MARKER}`;
}

function reportMessage(action: string, report: string): string {
  const actionText = clippedHead(action, ACTION_BUDGET_BYTES);
  const reportBudget =
    MAX_NOTIFICATION_BYTES - Buffer.byteLength(actionText) - Buffer.byteLength(REPORT_SEPARATOR);
  const reportText = report ? `${REPORT_SEPARATOR}${clippedHead(report, reportBudget)}` : "";
  const message = `${actionText}${reportText}`;
  if (Buffer.byteLength(message) <= MAX_NOTIFICATION_BYTES) return message;
  return clippedHead(message, MAX_NOTIFICATION_BYTES);
}

function normalizedReason(reason: string): string {
  return reason.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Attach automatic Goal notifications to the real extension tool-result hook. */
export function registerGoalParentNotifications(
  register: ToolResultRegistrar,
  getNotifier: () => ParentNotifier | undefined,
  getBranch: () => unknown[],
): () => void {
  const notifiedWaits = new Set<string>();
  const handleResult = (event: ToolResultEvent) => {
    if (event.isError) return;
    const notify = getNotifier();
    if (!notify) return;
    const report = latestAssistantReport(getBranch());
    if (event.toolName === "goal_pr") {
      if (event.input.remove === true) return;
      const details = event.details as { prs?: unknown[] } | undefined;
      if (!Array.isArray(details?.prs)) return;
      const pr = String(event.input.pr ?? "recorded PR");
      notify(reportMessage(`Coordinator recorded PR ${pr}.`, report));
      return;
    }
    if (event.toolName !== "goal_wait") return;
    const details = event.details as { status?: unknown } | undefined;
    const reason = String(event.input.reason ?? "").trim();
    if (details?.status !== "waiting" || !reason) return;
    const key = normalizedReason(reason);
    if (notifiedWaits.has(key)) return;
    const accepted = notify(reportMessage(`Coordinator is waiting: ${reason}.`, report));
    if (accepted) notifiedWaits.add(key);
  };
  return register(handleResult);
}
