import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readExtensionDefaults, readPreferenceDocument, mergeExtensionSettings } from "../shared/extension-defaults.js";
import { getSessionRoutingProfile, onSessionRoutingChanged } from "../shared/session-routing.ts";
import { installWakeAdmission } from "../shared/idle-admission.ts";
import { AdmissionLane, type AdmissionDetails, type Choice, type PendingAdmission } from "./admission.ts";
import { FORCE_CHEAP_COMPACTION_KEY, registerCompaction } from "./compaction.ts";
import { installLegacyMigration } from "./migration.ts";
import { lastModelActivity, shouldWarn, warningTitle, type Config } from "./policy.ts";
export { lastModelActivity, shouldWarn } from "./policy.ts";
export const REMOTE_PREFLIGHT_KEY = "__piIdleContextPreflightV1";
const globals = globalThis as Record<string, any>;
const DEFAULTS: Config = { idleMinutes: 30, contextPercent: 20 };
function configPath(): string { const canonical = join(getAgentDir(), "idle-context-warning.json"); return existsSync(canonical) ? canonical : join(getAgentDir(), "extensions", "idle-context-warning.json"); }
export function readConfig(path = configPath(), strict = false): Config {
  try {
    const parsed = mergeExtensionSettings(readExtensionDefaults("idle-context-warning"), readPreferenceDocument(path));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Configuration must be an object");
    const valid = (value: unknown, fallback: number, max: number) => typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= max ? value : fallback;
    return { idleMinutes: valid(parsed.idleMinutes, 30, 1440), contextPercent: valid(parsed.contextPercent, 20, 100), cheapCompactionModel: parsed.cheapCompactionModel, guardedModels: parsed.guardedModels };
  } catch (error) { if (strict) throw new Error(`Cannot read idle-context-warning.json: ${String(error)}`); return DEFAULTS; }
}
function isWorker(): boolean { return !!process.env.PI_SUBAGENT_ID || !!process.env.AGENTSH_SUBAGENT_ID; }
function details(ctx: ExtensionContext, settings: Config, origin: AdmissionDetails["origin"]): AdmissionDetails | undefined {
  const idleAt = lastModelActivity(ctx.sessionManager.getBranch()), usage = ctx.getContextUsage(), now = Date.now();
  if (!shouldWarn(idleAt, now, usage?.percent, settings)) return;
  const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown model";
  return { session: ctx.sessionManager.getSessionId(), model, idleMinutes: Math.floor((now - idleAt!) / 60_000), contextPercent: Math.round(usage!.percent!), origin,
    title: warningTitle(model, idleAt!, now, { tokens: usage!.tokens, contextWindow: usage!.contextWindow, percent: usage!.percent! }) };
}
function decisionPort(ctx: ExtensionContext, info: AdmissionDetails): ((signal: AbortSignal) => Promise<Choice>) | undefined {
  if (isWorker()) {
    const parent = globals.__piIdleContextParentV1;
    return typeof parent?.request === "function" ? signal => parent.request({ model: info.model, idleMinutes: info.idleMinutes, contextPercent: info.contextPercent }, signal) : undefined;
  }
  const remote = globals.__piPaseoRemoteUiV1;
  if (!ctx.hasUI && !(remote?.isConnected?.() && remote.selectMirrored)) return;
  return async signal => {
    const local = (dialogSignal: AbortSignal): Promise<string | undefined> => {
      const combined = AbortSignal.any([signal, dialogSignal]);
      if (combined.aborted) return Promise.resolve(undefined);
      if (!ctx.hasUI) return new Promise(resolve => combined.addEventListener("abort", () => resolve(undefined), { once: true }));
      return ctx.ui.select(info.title, ["Cancel", "Ignore", "Compact"], { signal: combined });
    };
    const response = remote?.isConnected?.() && remote.selectMirrored
      ? await remote.selectMirrored(info.title, ["Cancel", "Ignore", "Compact"], local, { signal }) : await local(signal);
    return response === "Ignore" ? "ignore" : response === "Compact" ? "compact" : "cancel";
  };
}

export default function (pi: ExtensionAPI, options: { readSettings?: () => Config; tombstonePath?: string } = {}) {
  const settings = options.readSettings ?? (() => readConfig(configPath(), true));
  registerCompaction(pi, settings);
  let active: ExtensionContext | undefined;
  let epoch = 0, lifecycle = new AbortController();
  let removeRouting: (() => void) | undefined, removeWake: (() => void) | undefined;
  let replay: { text: string; images: unknown; epoch: number } | undefined;
  type Submission = { id: string; text: string; images?: any[]; streamingBehavior?: "steer" | "followUp" };
  let submission: Submission | undefined;
  const persistSubmission = (item: Submission, state: "pending" | "released" | "cancelled") => {
    try { pi.appendEntry("idle-context-submission", { version: 1, state, ...item }); return true; } catch { return false; }
  };
  const lane = new AdmissionLane(pending => {
    try { if (active?.hasUI) active.ui.setStatus("idle-context", pending ? `idle decision ${pending.state}: /idle-context` : undefined); } catch { /* Status cannot approve. */ }
    try { pi.events?.emit?.("idle-context:pending", { session: active?.sessionManager.getSessionId(), pending }); } catch { /* Optional observers cannot affect admission. */ }
  });
  const invalidate = (preserveSubmission = false) => {
    if (submission && !preserveSubmission) persistSubmission(submission, "cancelled");
    submission = undefined; epoch++; replay = undefined; lifecycle.abort(); lane.invalidate(); lifecycle = new AbortController();
  };
  const identity = (ctx: ExtensionContext) => JSON.stringify([epoch, ctx.sessionManager.getSessionId(), ctx.model?.provider, ctx.model?.id, ctx.thinkingLevel, getSessionRoutingProfile(ctx)]);
  const contextRevision = (ctx: ExtensionContext) => ctx.sessionManager.getBranch().findLast(entry => ["message", "custom_message", "compaction", "branch_summary", "context_edit"].includes(entry.type))?.id;
  const compactAndWait = async (ctx: ExtensionContext, signal: AbortSignal): Promise<boolean> => {
    if (signal.aborted || !ctx.isIdle() || ctx.hasPendingMessages()) return false;
    const initial = identity(ctx), leaf = ctx.sessionManager.getLeafId(), sessionId = ctx.sessionManager.getSessionId(), token = randomUUID();
    const forced = { sessionId, token };
    globals[FORCE_CHEAP_COMPACTION_KEY] = forced;
    try {
      return await new Promise<boolean>(resolve => {
        let finished = false;
        const finish = (ok: boolean) => { if (finished) return; finished = true; clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(ok && !signal.aborted && identity(ctx) === initial); };
        const abort = () => finish(false);
        const timer = setTimeout(() => finish(false), 120_000);
        signal.addEventListener("abort", abort, { once: true });
        try { ctx.compact({ onError: () => finish(false), onComplete: () => {
          const entry = ctx.sessionManager.getBranch().findLast(item => item.type === "compaction");
          const data = entry?.type === "compaction" ? entry.details as Record<string, unknown> | undefined : undefined;
          finish(entry?.type === "compaction" && entry.parentId === leaf && ctx.sessionManager.getLeafId() === entry.id && entry.fromHook === true && data?.idleContextNativeCompaction === 1 && data?.idleContextExplicitAttempt === token);
        } }); } catch { finish(false); }
      });
    } finally { if (globals[FORCE_CHEAP_COMPACTION_KEY] === forced) delete globals[FORCE_CHEAP_COMPACTION_KEY]; }
  };
  const check = async (ctx: ExtensionContext, signal: AbortSignal | undefined, origin: AdmissionDetails["origin"] = "submission"): Promise<"continue" | "cancel"> => {
    const currentSignal = signal ? AbortSignal.any([signal, lifecycle.signal]) : lifecycle.signal;
    if (origin !== "submission") await lane.waitForIdle(currentSignal);
    if (currentSignal.aborted || !active) {
      if (origin !== "submission" && !signal?.aborted) throw new DOMException("Idle admission invalidated", "AbortError");
      return "cancel";
    }
    let info: AdmissionDetails | undefined;
    try { info = details(ctx, settings(), origin); }
    catch (error) {
      if (origin !== "submission") throw new DOMException(`Idle notification admission failed: ${String(error)}`, "AbortError");
      return "cancel";
    }
    if (!info) return "continue";
    const initial = identity(ctx);
    let revision = contextRevision(ctx), compactFailed = false;
    const result = await lane.run(info, origin === "autonomous" ? async (): Promise<Choice> => "compact" : decisionPort(ctx, info), currentSignal, async compactSignal => {
      if (identity(ctx) !== initial || contextRevision(ctx) !== revision) return false;
      const compacted = await compactAndWait(ctx, compactSignal);
      if (compacted) revision = contextRevision(ctx); else compactFailed = true;
      return compacted;
    });
    if (compactFailed && origin !== "submission") throw new DOMException("Idle notification compaction failed", "AbortError");
    if (currentSignal.aborted || identity(ctx) !== initial || contextRevision(ctx) !== revision) {
      if (origin !== "submission" && !signal?.aborted) throw new DOMException("Idle admission invalidated", "AbortError");
      return "cancel";
    }
    return result;
  };
  const capability = {
    ready: false,
    check: (signal?: AbortSignal) => active ? check(active, signal) : Promise.resolve("cancel" as const),
    get pending(): PendingAdmission | undefined { return lane.pending; },
    decide: (id: string, choice: Choice) => lane.decide(id, choice),
  };
  const retryDecisionChannel = async () => {
    const pending = lane.pending, ctx = active;
    if (!pending || pending.state !== "pending" || !ctx) return;
    const port = decisionPort(ctx, pending);
    if (port) { try { lane.decide(pending.id, await port(lifecycle.signal)); } catch { /* Still pending; a reconnect is not consent. */ } }
  };
  const removeChannelListener = pi.events?.on?.("idle-context:decision-channel-ready", () => { void retryDecisionChannel(); });
  globals[REMOTE_PREFLIGHT_KEY] = capability;
  pi.registerCommand("idle-context", {
    description: "Show or resolve pending root idle admission: [ignore|compact|cancel] [request-id]",
    handler: async (args, ctx) => {
      const pending = lane.pending;
      if (!pending) { if (ctx.hasUI) ctx.ui.notify("No pending idle decision.", "info"); return; }
      if (isWorker()) { if (ctx.hasUI) ctx.ui.notify("The owning parent decides this worker's idle warning.", "warning"); return; }
      const [choice, id = pending.id] = args.trim().split(/\s+/);
      if (["ignore", "compact", "cancel"].includes(choice)) { lane.decide(id, choice as Choice); return; }
      const port = decisionPort(ctx, pending);
      if (port) { try { lane.decide(pending.id, await port(lifecycle.signal)); } catch { /* Keep pending if channel disconnects. */ } }
      else if (ctx.hasUI) ctx.ui.notify(`Pending idle decision ${pending.id}: Ignore, Compact or Cancel required.`, "warning");
    },
  });
  const revoke = () => invalidate();
  pi.on("model_select", revoke);
  pi.on("thinking_level_select", revoke);
  pi.on("session_before_switch", revoke);
  pi.on("session_before_fork", revoke);
  pi.on("session_before_tree", revoke);
  pi.on("session_start", (_event, ctx) => {
    invalidate(); active = ctx; capability.ready = true; globals[REMOTE_PREFLIGHT_KEY] = capability;
    removeRouting?.(); removeRouting = onSessionRoutingChanged(ctx, revoke);
    removeWake?.(); removeWake = installWakeAdmission(ctx.sessionManager.getSessionId(), { check: (signal, origin) => check(ctx, signal, origin) });
    const latest = new Map<string, any>();
    for (const entry of ctx.sessionManager.getBranch()) if (entry.type === "custom" && entry.customType === "idle-context-submission") {
      const data = entry.data as any;
      if (data?.version === 1 && typeof data.id === "string") latest.set(data.id, data);
    }
    const saved = [...latest.values()].findLast(data => data.state === "pending" && typeof data.text === "string");
    if (saved) scheduleSubmission(ctx, { id: saved.id, text: saved.text, images: saved.images, streamingBehavior: saved.streamingBehavior });
  });
  pi.on("session_shutdown", event => {
    invalidate(event.reason === "reload"); active = undefined; capability.ready = false; removeRouting?.(); removeWake?.(); removeChannelListener?.();
    if (globals[REMOTE_PREFLIGHT_KEY] === capability) delete globals[REMOTE_PREFLIGHT_KEY];
  });
  const scheduleSubmission = (ctx: ExtensionContext, item: Submission) => {
    submission = item;
    const initialEpoch = epoch, initial = identity(ctx), signal = lifecycle.signal;
    setTimeout(() => {
      if (initialEpoch !== epoch || signal.aborted || submission !== item) return;
      void check(ctx, signal).then(result => {
        if (signal.aborted || identity(ctx) !== initial || submission !== item) return;
        submission = undefined;
        // Durable reservation before send prevents duplicate replay after a
        // process crash. A released-but-unsent request requires user resubmission.
        if (!persistSubmission(item, result === "continue" ? "released" : "cancelled") || result !== "continue") return;
        replay = { text: item.text, images: item.images, epoch };
        const content = item.images?.length ? [{ type: "text" as const, text: item.text }, ...item.images] : item.text;
        const options = { deliverAs: item.streamingBehavior, expandPromptTemplates: false };
        void (async () => {
          try {
            // Newer supervised Pi builds expose submitUserMessage(), whose
            // receipt resolves at the real prompt-admission boundary. Stock Pi
            // 1.4's sendUserMessage() is fire-and-forget at the extension facade.
            const submit = (pi as any).submitUserMessage;
            if (typeof submit === "function") {
              const receipt = await submit.call(pi, content, options);
              if (!receipt || !["started", "queued"].includes(receipt.disposition)) throw new Error(`Prompt was not admitted (${receipt?.disposition ?? "invalid receipt"})`);
            } else {
              const delivery = pi.sendUserMessage(content, options);
              if (delivery && typeof delivery.then === "function") await delivery;
            }
          } catch (error) {
            if (replay?.epoch === epoch && replay.text === item.text) replay = undefined;
            // This is only emitted when dispatch is positively rejected. Do not
            // retry automatically: an ambiguous accepted send could duplicate.
            try { if (ctx.hasUI) ctx.ui.notify(`Idle-approved message could not be submitted; resubmit it: ${String(error).slice(0, 300)}`, "error"); else process.stderr.write(`[idle-context-warning] Approved message submission failed: ${String(error)}\n`); } catch { /* Report failure without replaying an ambiguous send. */ }
          }
        })();
      }).catch(() => { /* Never replay on an unhandled failure. */ });
    }, 0);
  };
  pi.on("input", async (event, ctx) => {
    // The bridge's explicit preflight owns extension-origin submissions. Internal
    // continuation/direct calls have no universal stock input gate. A replay is
    // one exact payload, not a process-wide 'ignore next warning' authorization.
    if (event.source === "extension") {
      if (replay && replay.epoch === epoch && replay.text === event.text) replay = undefined;
      return;
    }
    let info: AdmissionDetails | undefined;
    try { info = details(ctx, settings(), "submission"); } catch { return { action: "handled" as const }; }
    if (!info) return;
    if (lane.pending || submission) { if (ctx.hasUI) ctx.ui.notify("An idle decision is already pending; this submission was not accepted. Resolve it, then resubmit.", "warning"); return { action: "handled" as const }; }
    const item: Submission = { id: randomUUID(), text: event.text, images: event.images, streamingBehavior: event.streamingBehavior };
    // Consume first: no pending input operation is held across a missing channel
    // or Compact. Keep the payload durable for reload, but never restore approval.
    if (persistSubmission(item, "pending")) scheduleSubmission(ctx, item);
    return { action: "handled" as const };
  });
  // Registration still finishes before startup selection. Put the asynchronous
  // migration session handler AFTER admission readiness, so migration/auth work
  // cannot expose an unregistered admission service to notification timers.
  installLegacyMigration(pi, settings, options.tombstonePath);
}
