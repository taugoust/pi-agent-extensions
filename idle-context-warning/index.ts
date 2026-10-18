import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REMOTE_UI_KEY = "__piPaseoRemoteUiV1";
const REMOTE_PROMPT_KEY = "__piPaseoIdlePromptV1";
const CONFIG_PATH = join(homedir(), ".pi/agent/extensions/idle-context-warning.json");
type Config = { idleMinutes: number; contextPercent: number };
type RemoteUi = {
  isConnected(): boolean;
  selectMirrored?(title: string, options: string[], local: (signal: AbortSignal) => Promise<string | undefined>, settings?: { signal?: AbortSignal }): Promise<string | undefined>;
};
const DEFAULTS: Config = { idleMinutes: 30, contextPercent: 20 };

function config(): Config {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return {
      idleMinutes: valid(parsed.idleMinutes, DEFAULTS.idleMinutes, 1, 1440),
      contextPercent: valid(parsed.contextPercent, DEFAULTS.contextPercent, 1, 100),
    };
  } catch { return DEFAULTS; }
}
function valid(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}
export function lastModelActivity(branch: any[]): number | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "message" || entry.message?.role !== "assistant" || !entry.message?.model) continue;
    const timestamp = Number(entry.message.timestamp ?? Date.parse(entry.timestamp));
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return undefined;
}
export function shouldWarn(idleAt: number | undefined, now: number, percent: number | null | undefined, settings: Config): boolean {
  return idleAt !== undefined && percent != null && Number.isFinite(percent) &&
    now - idleAt >= settings.idleMinutes * 60_000 && percent >= settings.contextPercent;
}

export default function (pi: ExtensionAPI) {
  pi.on("input", async (event, ctx) => {
    const globals = globalThis as Record<string, any>;
    const remotePrompt = globals[REMOTE_PROMPT_KEY];
    if (event.source === "extension" && !remotePrompt) return; // never intercept automatic extension continuations
    const finishRemotePrompt = (approved: boolean) => remotePrompt?.resolve?.(approved);
    const settings = config();
    if (!ctx.hasUI || !ctx.sessionManager || event.streamingBehavior) {
      finishRemotePrompt(true);
      return;
    }
    const idleAt = lastModelActivity(ctx.sessionManager.getBranch());
    const usage = ctx.getContextUsage();
    const now = Date.now();
    if (!shouldWarn(idleAt, now, usage?.percent, settings)) {
      finishRemotePrompt(true);
      return;
    }

    const minutes = Math.floor((now - idleAt!) / 60_000);
    const percentage = Math.round(usage!.percent!);
    const title = `The last model response was ${minutes} minutes ago. Context usage is ${percentage}%. The prompt-cache entry may have expired; Pi's cache-warming decision does not confirm that warming occurred.`;
    const local = async (signal: AbortSignal) => {
      if (signal.aborted) return undefined;
      return ctx.ui.select(title, ["Cancel", "Ignore"]);
    };
    const remote = (globalThis as Record<string, unknown>)[REMOTE_UI_KEY] as RemoteUi | undefined;
    let choice: string | undefined;
    try {
      if (remote?.isConnected() && remote.selectMirrored) choice = await remote.selectMirrored(title, ["Cancel", "Ignore"], local);
      else choice = await local(new AbortController().signal);
    } catch { choice = undefined; }

    const approved = choice === "Ignore";
    finishRemotePrompt(approved);
    if (approved) return;
    // Handled submissions never reach the agent. Restore the exact text into the editor,
    // so cancellation does not discard the user's draft.
    if (event.source === "interactive" && ctx.mode === "tui") ctx.ui.setEditorText(event.text);
    return { action: "handled" as const };
  });
}
