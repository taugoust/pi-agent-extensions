import { createHash } from "node:crypto";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { parsePrRef } from "../workflows/goal/prs.ts";

type StateRevision = { key: string; revision: string };
type ParentNotifier = (message: string, states: StateRevision[]) => boolean;
type ToolResultRegistrar = (handler: (event: ToolResultEvent) => void) => () => void;

const MAX_NOTIFICATION_BYTES = 1000;
const ACTION_BUDGET_BYTES = 400;
const REPORT_SEPARATOR = "\nChild report: ";
const TRUNCATION_MARKER = "…[truncated]";

function assistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");
}

function notifyInput(branch: unknown[], index: number, result: any): any {
  if (result.input && typeof result.input === "object") return result.input;
  const callId = result.toolCallId;
  if (typeof callId !== "string") return undefined;
  for (let i = index - 1; i >= 0; i--) {
    const entry = branch[i] as any;
    const message = entry?.type === "message" ? entry.message : entry;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const call = message.content.find(
      (part: any) => part?.type === "toolCall" && part.id === callId,
    );
    if (call) return call.arguments;
  }
  return undefined;
}

function latestCoordinatorReport(branch: unknown[]): string {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as any;
    const message = entry?.type === "message" ? entry.message : entry;
    if (message?.role === "toolResult" && message.toolName === "notify_parent") {
      if (message.isError) continue;
      const input = notifyInput(branch, i, message);
      const report = typeof input?.message === "string" ? input.message.trim() : "";
      if (report && input.requires_guidance !== true) return report;
      continue;
    }
    if (message?.role !== "assistant") continue;
    const text = assistantText(message.content).trim();
    if (text) return text;
  }
  return "";
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

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function taskState(event: ToolResultEvent): unknown {
  const details = event.details as any;
  if (event.toolName === "update_progress" && Array.isArray(details?.steps))
    return canonicalTasks(details.steps);
  if (event.toolName !== "goal_manage" || event.input.action === "status") return undefined;
  const tasks = details?.goal?.tasks;
  return Array.isArray(tasks) ? canonicalTasks(tasks) : undefined;
}

function canonicalTasks(tasks: any[]): Array<[unknown, unknown, unknown]> {
  return tasks.map((step) => [step.id ?? null, step.text ?? "", step.status ?? ""]);
}

function registeredPr(event: ToolResultEvent): string | undefined {
  if (event.toolName !== "goal_pr" || event.input.remove === true) return undefined;
  const details = event.details as { prs?: unknown[] } | undefined;
  if (!Array.isArray(details?.prs)) return undefined;
  const input = String(event.input.pr ?? "").trim();
  if (!input) return undefined;
  try {
    const canonicalRef = parsePrRef(input).ref;
    return details.prs.some((item: any) => item?.ref === canonicalRef) ? canonicalRef : undefined;
  } catch {
    return undefined;
  }
}

function reportNotice(
  notify: ParentNotifier,
  action: string,
  report: string,
  states: StateRevision[],
): void {
  notify(reportMessage(action, report), states);
}

function taskSummary(tasks: Array<[unknown, unknown, unknown]>): string {
  const summary = tasks.map(([, text, status]) => `${String(text)} (${String(status)})`).join("; ");
  return clippedHead(`Coordinator checklist changed: ${summary}`, ACTION_BUDGET_BYTES);
}

/** Attach automatic Goal notifications to the real extension tool-result hook. */
export function registerGoalParentNotifications(
  register: ToolResultRegistrar,
  getNotifier: () => ParentNotifier | undefined,
  getBranch: () => unknown[],
): () => void {
  const handleResult = (event: ToolResultEvent) => {
    if (event.isError) return;
    const tools = ["goal_pr", "goal_manage", "update_progress", "notify_parent", "goal_wait"];
    if (!tools.includes(event.toolName)) return;
    const notify = getNotifier();
    if (!notify) return;
    const report = latestCoordinatorReport(getBranch());
    const pr = registeredPr(event);
    if (pr) {
      notify(reportMessage(`Coordinator recorded PR ${pr}.`, report), [
        {
          key: `coordinator-pr:${fingerprint(pr)}`,
          revision: fingerprint("recorded"),
        },
        { key: "coordinator-report", revision: fingerprint(report) },
      ]);
      return;
    }
    const tasks = taskState(event);
    if (tasks !== undefined) {
      reportNotice(notify, taskSummary(tasks), report, [
        { key: "coordinator-tasks", revision: fingerprint(tasks) },
        { key: "coordinator-report", revision: fingerprint(report) },
      ]);
      return;
    }
    if (event.toolName === "notify_parent") {
      if (event.input.requires_guidance === true) return;
      const message = String(event.input.message ?? "").trim();
      if (message)
        reportNotice(notify, "Coordinator report changed.", message, [
          { key: "coordinator-report", revision: fingerprint(message) },
        ]);
      return;
    }
    if (event.toolName === "goal_wait") {
      const details = event.details as { status?: unknown } | undefined;
      if (details?.status !== "waiting" || !report) return;
      reportNotice(notify, "Coordinator report changed.", report, [
        { key: "coordinator-report", revision: fingerprint(report) },
      ]);
    }
  };
  return register(handleResult);
}
