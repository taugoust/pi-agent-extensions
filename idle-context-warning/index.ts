import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const REMOTE_UI_KEY = "__piPaseoRemoteUiV1";
export const REMOTE_PREFLIGHT_KEY = "__piIdleContextPreflightV1";
const CONFIG_PATH = join(homedir(), ".pi/agent/extensions/idle-context-warning.json");
type Config = { idleMinutes: number; contextPercent: number };
type RemoteUi = {
  isConnected(): boolean;
  selectMirrored?(title: string, options: string[], local: (signal: AbortSignal) => Promise<string | undefined>, settings?: { signal?: AbortSignal }): Promise<string | undefined>;
};
type Decision = "continue" | "cancel";
type PreflightCapability = { ready: boolean; check(signal?: AbortSignal): Promise<Decision> };
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

async function check(ctx: ExtensionContext, signal?: AbortSignal): Promise<Decision> {
  const settings = config();
  if (!ctx.hasUI || !ctx.sessionManager || signal?.aborted) return "continue";
  const idleAt = lastModelActivity(ctx.sessionManager.getBranch());
  const usage = ctx.getContextUsage();
  const now = Date.now();
  if (!shouldWarn(idleAt, now, usage?.percent, settings)) return "continue";

  const minutes = Math.floor((now - idleAt!) / 60_000);
  const percentage = Math.round(usage!.percent!);
  const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown model";
  const tokens = usage!.tokens == null ? "unknown" : Math.round(usage!.tokens).toLocaleString();
  const window = usage!.contextWindow.toLocaleString();
  const title = `Model: ${model}\nLast model response: ${minutes} minutes ago\nContext: ${tokens} / ${window} tokens (${percentage}%). The model cache may have expired.`;
  const local = async (dialogSignal: AbortSignal) => {
    if (dialogSignal.aborted) return undefined;
    return ctx.ui.select(title, ["Cancel", "Ignore"], { signal: dialogSignal });
  };
  const remote = (globalThis as Record<string, unknown>)[REMOTE_UI_KEY] as RemoteUi | undefined;
  let choice: string | undefined;
  try {
    if (remote?.isConnected() && remote.selectMirrored) {
      choice = await remote.selectMirrored(title, ["Cancel", "Ignore"], local, { signal });
    } else {
      choice = await local(signal ?? new AbortController().signal);
    }
  } catch { choice = undefined; }
  return choice === "Ignore" ? "continue" : "cancel";
}

export default function (pi: ExtensionAPI) {
  const capability: PreflightCapability = {
    ready: false,
    check: async () => "continue",
  };
  const globals = globalThis as Record<string, unknown>;
  pi.on("session_start", (_event, ctx) => {
    capability.check = (signal) => check(ctx, signal);
    capability.ready = true;
    globals[REMOTE_PREFLIGHT_KEY] = capability;
  });
  pi.on("session_shutdown", () => {
    capability.ready = false;
    if (globals[REMOTE_PREFLIGHT_KEY] === capability) delete globals[REMOTE_PREFLIGHT_KEY];
  });
  pi.on("input", async (event, ctx) => {
    // Paseo-originated prompts go through the bridge's explicit preflight. Other
    // extension-originated inputs (including automatic continuations) bypass it.
    if (event.source === "extension") return;
    const decision = await check(ctx);
    if (decision === "continue") return;
    if (event.source === "interactive" && ctx.mode === "tui") ctx.ui.setEditorText(event.text);
    return { action: "handled" as const };
  });
}
