import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FORCE_CHEAP_COMPACTION_KEY, registerCompaction } from "./compaction.ts";
import { GUARD_PROVIDER, registerGuard } from "./guard.ts";
import { lastModelActivity, shouldWarn, type Config } from "./policy.ts";
export { lastModelActivity, shouldWarn } from "./policy.ts";

const REMOTE_UI_KEY = "__piPaseoRemoteUiV1";
const PARENT_DECISION_KEY = "__piIdleContextParentV1";
export const REMOTE_PREFLIGHT_KEY = "__piIdleContextPreflightV1";
const CONFIG_PATH = join(homedir(), ".pi/agent/extensions/idle-context-warning.json");
type RemoteUi = {
  isConnected(): boolean;
  selectMirrored?(title: string, options: string[], local: (signal: AbortSignal) => Promise<string | undefined>, settings?: { signal?: AbortSignal }): Promise<string | undefined>;
};
type Decision = "continue" | "cancel" | "compact";
type PreflightCapability = { ready: boolean; check(signal?: AbortSignal): Promise<Decision> };
type ParentDecision = { request(details: { model: string; idleMinutes: number; contextPercent: number }, signal?: AbortSignal): Promise<"ignore" | "compact" | "cancel"> };
const DEFAULTS: Config = { idleMinutes: 30, contextPercent: 20 };

export function readConfig(path = CONFIG_PATH, strict = false): Config {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Configuration must be an object");
    return {
      idleMinutes: valid(parsed.idleMinutes, DEFAULTS.idleMinutes, 1, 1440),
      contextPercent: valid(parsed.contextPercent, DEFAULTS.contextPercent, 1, 100),
      // Validate only when selected; malformed selectors must cancel, not fall
      // back to the conversation model.
      cheapCompactionModel: parsed.cheapCompactionModel,
      guardedModels: parsed.guardedModels,
    };
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Cannot read idle-context-warning.json: ${String(error)}`);
    }
    return DEFAULTS;
  }
}
function valid(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

async function check(ctx: ExtensionContext, signal?: AbortSignal, readSettings: () => Config = () => readConfig(), lifecycleSignal?: AbortSignal): Promise<Decision> {
  // Guarded selections use the non-bypassable final dispatch gate, not Ignore.
  const worker = !!process.env.PI_SUBAGENT_ID || !!process.env.AGENTSH_SUBAGENT_ID;
  if (signal?.aborted || lifecycleSignal?.aborted) return "cancel";
  if (ctx.model?.provider === GUARD_PROVIDER) return "continue";
  const initialSession = typeof ctx.sessionManager?.getSessionId === "function" ? ctx.sessionManager.getSessionId() : undefined;
  const initialModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
  const initialThinking = ctx.thinkingLevel;
  const decisionSignal = signal && lifecycleSignal ? AbortSignal.any([signal, lifecycleSignal]) : signal ?? lifecycleSignal;
  let settings: Config;
  try { settings = readSettings(); } catch { return "cancel"; }
  if (!ctx.sessionManager) return worker ? "cancel" : "continue";
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
  let choice: string | undefined;
  try {
    if (worker) {
      const parent = (globalThis as Record<string, unknown>)[PARENT_DECISION_KEY] as ParentDecision | undefined;
      if (!parent || typeof parent.request !== "function") return "cancel";
      const response = await parent.request({ model, idleMinutes: minutes, contextPercent: percentage }, decisionSignal);
      choice = response === "ignore" ? "Ignore" : response === "compact" ? "Compact" : "Cancel";
    } else {
      if (!ctx.hasUI) return "continue";
      const local = async (dialogSignal: AbortSignal) => {
        if (dialogSignal.aborted) return undefined;
        const combinedSignal = decisionSignal ? AbortSignal.any([decisionSignal, dialogSignal]) : dialogSignal;
        return ctx.ui.select(title, ["Cancel", "Ignore", "Compact"], { signal: combinedSignal });
      };
      const remote = (globalThis as Record<string, unknown>)[REMOTE_UI_KEY] as RemoteUi | undefined;
      if (remote?.isConnected() && remote.selectMirrored) choice = await remote.selectMirrored(title, ["Cancel", "Ignore", "Compact"], local, { signal: decisionSignal });
      else choice = await local(signal ?? new AbortController().signal);
    }
  } catch { choice = undefined; }
  if (decisionSignal?.aborted || (initialSession !== undefined && ctx.sessionManager.getSessionId?.() !== initialSession)
    || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "") !== initialModel || ctx.thinkingLevel !== initialThinking) return "cancel";
  return choice === "Ignore" ? "continue" : choice === "Compact" ? "compact" : "cancel";
}

export default function (pi: ExtensionAPI, options: { readSettings?: () => Config; tombstonePath?: string } = {}) {
  const settings = options.readSettings ?? (() => readConfig(CONFIG_PATH, true));
  const guard = registerGuard(pi, settings, { tombstonePath: options.tombstonePath });
  registerCompaction(pi, settings, guard.compactionProof);
  const capability: PreflightCapability = { ready: false, check: async () => "continue" };
  let activeContext: ExtensionContext | undefined;
  let runtimeEpoch = 0;
  let pendingInteractivePrompt: { session: string; text: string; images?: unknown[]; epoch: number; lifecycleSignal: AbortSignal } | undefined;
  let compactWaiter: { session: string; token: string; resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout>; signal?: AbortSignal; abort: () => void; epoch: number } | undefined;
  let shutdownController = new AbortController();
  const finishCompact = (session: string, token: string, ok: boolean) => {
    const waiter = compactWaiter;
    if (!waiter || waiter.session !== session || waiter.token !== token) return;
    compactWaiter = undefined;
    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener("abort", waiter.abort);
    const valid = ok && waiter.epoch === runtimeEpoch && activeContext?.sessionManager?.getSessionId() === session;
    waiter.resolve(valid);
    const pending = pendingInteractivePrompt;
    pendingInteractivePrompt = undefined;
    if (pending && valid && pending.session === session && pending.epoch === runtimeEpoch) {
      try { pi.sendUserMessage(pending.images?.length ? [{ type: "text", text: pending.text }, ...pending.images as any[]] : pending.text); } catch { /* Fail closed: never replay into a replacement session. */ }
    }
  };
  const invalidateCompact = () => {
    runtimeEpoch++;
    if (compactWaiter) finishCompact(compactWaiter.session, compactWaiter.token, false);
    pendingInteractivePrompt = undefined;
    shutdownController.abort();
    shutdownController = new AbortController();
  };
  pi.on("model_select", invalidateCompact);
  pi.on("thinking_level_select", invalidateCompact);
  pi.on("session_before_switch", invalidateCompact);
  pi.on("session_before_fork", invalidateCompact);
  pi.on("session_before_tree", invalidateCompact);
  const compactAndWait = async (ctx: ExtensionContext, signal?: AbortSignal): Promise<boolean> => {
    if (!ctx.sessionManager || !ctx.isIdle() || signal?.aborted || compactWaiter) return false;
    const sessionId = ctx.sessionManager.getSessionId();
    const token = crypto.randomUUID();
    const forced = { sessionId, token };
    const beforeIds = new Set(ctx.sessionManager.getBranch().map((entry: any) => entry.id));
    (globalThis as Record<string, unknown>)[FORCE_CHEAP_COMPACTION_KEY] = forced;
    const controller = new AbortController();
    const lifecycleSignal = shutdownController.signal;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    lifecycleSignal.addEventListener("abort", abort, { once: true });
    try {
      return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => finishCompact(sessionId, token, false), 120_000);
        const abortWaiter = () => finishCompact(sessionId, token, false);
        compactWaiter = { session: sessionId, token, epoch: runtimeEpoch, resolve, timer, signal: controller.signal, abort: abortWaiter };
        controller.signal.addEventListener("abort", abortWaiter, { once: true });
        ctx.compact({
          onComplete: () => {
            if (compactWaiter?.token !== token || compactWaiter.epoch !== runtimeEpoch) return;
            try {
              const persisted = ctx.sessionManager.getBranch().some((entry: any) => !beforeIds.has(entry.id)
                && entry.type === "compaction" && entry.fromHook === true
                && (entry.details as Record<string, unknown> | undefined)?.idleContextNativeCompaction === 1
                && (entry.details as Record<string, unknown> | undefined)?.idleContextExplicitAttempt === token);
              finishCompact(sessionId, token, persisted);
            } catch { finishCompact(sessionId, token, false); }
          },
          onError: () => finishCompact(sessionId, token, false),
        });
      });
    } catch { finishCompact(sessionId, token, false); return false; }
    finally {
      signal?.removeEventListener("abort", abort);
      lifecycleSignal.removeEventListener("abort", abort);
      if ((globalThis as Record<string, unknown>)[FORCE_CHEAP_COMPACTION_KEY] === forced) delete (globalThis as Record<string, unknown>)[FORCE_CHEAP_COMPACTION_KEY];
    }
  };
  const globals = globalThis as Record<string, unknown>;
  globals[REMOTE_PREFLIGHT_KEY] = capability;
  pi.on("session_start", (_event, ctx) => {
    invalidateCompact();
    activeContext = ctx;
    capability.check = async (signal) => {
      const decision = await check(ctx, signal, settings, shutdownController.signal);
      if (decision !== "compact") return decision;
      return await compactAndWait(ctx, signal) ? "continue" : "cancel";
    };
    capability.ready = true;
    globals[REMOTE_PREFLIGHT_KEY] = capability;
  });
  pi.on("session_shutdown", () => {
    runtimeEpoch++;
    shutdownController.abort();
    if (compactWaiter) finishCompact(compactWaiter.session, compactWaiter.token, false);
    pendingInteractivePrompt = undefined;
    activeContext = undefined;
    capability.ready = false;
    if (globals[REMOTE_PREFLIGHT_KEY] === capability) delete globals[REMOTE_PREFLIGHT_KEY];
  });
  pi.on("input", async (event, ctx) => {
    // Paseo-originated prompts go through the bridge's explicit preflight. Other
    // extension-originated inputs (including automatic continuations) bypass it.
    if (event.source === "extension" || ctx.model?.provider === GUARD_PROVIDER) return;
    const decision = await check(ctx, undefined, settings, shutdownController.signal);
    if (decision === "continue") return;
    if (decision === "compact") {
      if (event.source === "interactive" && ctx.mode === "tui") {
        if (!ctx.sessionManager || !ctx.isIdle()) return { action: "handled" as const };
        const pending = { text: event.text, images: event.images, session: ctx.sessionManager.getSessionId(), epoch: runtimeEpoch, lifecycleSignal: shutdownController.signal };
        pendingInteractivePrompt = pending;
        setTimeout(() => {
          const stillOwned = pendingInteractivePrompt === pending && pending.epoch === runtimeEpoch
            && !pending.lifecycleSignal.aborted && activeContext?.sessionManager?.getSessionId() === pending.session;
          if (!stillOwned) { if (pendingInteractivePrompt === pending) pendingInteractivePrompt = undefined; return; }
          void compactAndWait(ctx, pending.lifecycleSignal).then((ok) => {
            if (!ok && pendingInteractivePrompt === pending) pendingInteractivePrompt = undefined;
          });
        }, 0);
        return { action: "handled" as const };
      }
      if (await compactAndWait(ctx)) return;
    }
    return { action: "handled" as const };
  });
}
