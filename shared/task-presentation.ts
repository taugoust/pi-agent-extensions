export function uiText(value: unknown, limit = 160): string {
  const text = String(value ?? "").replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
export function outcomeLabel(state: unknown): string {
  return ({ delivered: "Reported delivered", partial: "Needs continuation", blocked: "Blocked", checkpointed: "Checkpoint saved", unreported: "Outcome not reported" } as Record<string,string>)[String(state)] ?? "Outcome not reported";
}
export function taskLabel(task: any): string {
  if (task.state === "running") return "Working";
  if (task.state === "interrupted") return "Interrupted";
  if (task.execution === "failed") return "Worker failed";
  if (task.execution === "aborted" || task.execution === "cancelled") return "Cancelled";
  if (task.execution === "timed out") return "Worker timed out";
  return outcomeLabel(task.outcome);
}
export function taskListText(tasks: any[], includeIds = true): string {
  if (!tasks.length) return "No retained tasks in this session yet.";
  return tasks.map(task => [
    `${taskLabel(task)} · ${uiText(task.title || "Untitled task", 110)} · attempt ${task.attempt}`,
    ...(task.summary ? [`  ${uiText(task.summary, 220)}`] : []),
    ...(task.next_action ? [`  Next: ${uiText(task.next_action, 180)}`] : []),
    ...(includeIds ? [`  ${task.task_id}`] : []),
  ].join("\n")).join("\n\n");
}
export function jobStatusLabel(status: string, observed = false): string {
  if (status === 'unavailable') return 'Temporarily unavailable';
  if (observed) return status === "running" || status === "starting" ? "Observing" : "Observation ended — exit status unknown";
  return ({starting:"Starting",running:"Running",completed:"Finished",failed:"Failed",cancelled:"Cancelled",lost:"Execution status unavailable"} as Record<string,string>)[status] ?? status;
}
export function watchResultText(action: string, data: any): string {
  if (action === "watches") {
    if (!data.watches?.length) return "No watches for this task/session.";
    return data.watches.map((w:any) => `${w.status === 'running' ? 'Watching' : uiText(w.status)} · ${uiText(w.label || w.log_path, 100)}\n  ${w.watch_id}`).join("\n");
  }
  if (action === "watch") return `Watching ${uiText(data.log_path, 160)}\nStage/match and completion alerts will reach the parent automatically.\n${data.watch_id}`;
  if (action === "ack") return `Alerts acknowledged through #${data.acknowledged_through}. Newer alerts remain unread.\n${data.watch_id}`;
  if (action === "unwatch") return `Stop watching requested. The build has NOT been cancelled.\n${data.watch_id}`;
  const rows = (data.events ?? []).map((e:any) => `#${e.sequence} · ${uiText(e.time, 32)} · ${uiText(e.rule || e.kind, 80)}\n${uiText(e.text ?? e.status ?? "", 512)}`);
  return [
    `Alerts · ${uiText(data.log_path, 140)}`,
    ...(data.overflow ? ["Some older alerts expired from the retained journal. Inspect the log before assuming full coverage."] : []),
    rows.length ? rows.join("\n\n") : "No unread alerts.",
    ...(rows.length ? [`Acknowledge the displayed events through #${data.next_sequence} after reviewing them.`] : []),
    data.watch_id,
  ].join("\n\n");
}

export function watchDeliveryCursors(entries: unknown[]): Map<string,number> {
  const cursors=new Map<string,number>();
  for(const raw of entries){
    const entry=raw as any;
    if(entry?.type!=="custom_message"||entry.customType!=="background-job-watch")continue;
    const detail=entry.details;
    const deliveries=Array.isArray(detail?.watches)?detail.watches:[detail];
    for(const item of deliveries){
      if(!/^watch-[0-9a-f]{24}$/.test(item?.watch_id??"")||!Number.isSafeInteger(item?.through_sequence)||item.through_sequence<0)continue;
      cursors.set(item.watch_id,Math.max(cursors.get(item.watch_id)??0,item.through_sequence));
    }
  }
  return cursors;
}

type ChoiceContext = { ui: { select(title:string, options:string[], settings?:any):Promise<string|undefined> } };
export function remoteTaskUiConnected(): boolean {
  const bridge = (globalThis as any).__piPaseoRemoteUiV1;
  try { return bridge?.isConnected?.() === true; } catch { return false; }
}
export async function taskChoice(ctx: ChoiceContext, title: string, choices: string[]): Promise<string|undefined> {
  const bridge = (globalThis as any).__piPaseoRemoteUiV1;
  if (remoteTaskUiConnected()) {
    if (typeof bridge.selectMirrored === "function") return await bridge.selectMirrored(title, choices, (signal:AbortSignal) => ctx.ui.select(title, choices, {signal}));
    return await bridge.select(title, choices);
  }
  return await ctx.ui.select(title, choices);
}
