import { compact, type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent, type SessionBeforeCompactResult } from "@earendil-works/pi-coding-agent";
import { isIdle, lastModelActivity, type Config } from "./policy.ts";
import { bindSessionModelRequest, prepareSessionRoutingRequest, resolveSessionModelSelector, resolveSessionProvider, type RoutingProfile } from "../shared/session-routing.ts";

type Thinking = NonNullable<Parameters<typeof compact>[6]>;
const thinkingSuffix = /:(off|minimal|low|medium|high|xhigh|max)$/;
const DETAILS_VERSION = "idleContextNativeCompaction";
export const FORCE_CHEAP_COMPACTION_KEY = "__piIdleContextForceCheapV1";
function resolveCompactionSelector(ctx: ExtensionContext, selected: { provider: string; id: string }, profile?: RoutingProfile): string {
  if (profile) return resolveSessionModelSelector(ctx, `${selected.provider || "_"}/${selected.id}`, profile);
  return selected.provider ? resolveSessionModelSelector(ctx, `${selected.provider}/${selected.id}`) : `${resolveSessionProvider(ctx)}/${selected.id}`;
}
function sameRoutingProfile(a?: RoutingProfile, b?: RoutingProfile): boolean {
  return a === undefined ? b === undefined : b !== undefined && a.ownerSessionId === b.ownerSessionId && a.providerId === b.providerId && a.accountId === b.accountId && a.revision === b.revision;
}
export function parseModelSelector(value: unknown): { provider: string; id: string; thinking: Thinking } {
  if (typeof value !== "string" || !value || /\s/.test(value)) throw new Error("cheapCompactionModel must be provider/model[:thinking]");
  const suffix = value.match(thinkingSuffix);
  const model = suffix ? value.slice(0, -suffix[0].length) : value;
  const slash = model.indexOf("/");
  if (slash === model.length - 1) throw new Error("cheapCompactionModel must include a model ID");
  // Preserve legacy provider-relative selection/account routing semantics.
  return { provider: slash > 0 ? model.slice(0, slash) : "", id: slash > 0 ? model.slice(slash + 1) : model, thinking: (suffix?.[1] ?? "low") as Thinking };
}
export function restoreFileTracking(event: SessionBeforeCompactEvent): void {
  const previous = event.branchEntries.findLast(entry => entry.type === "compaction");
  if (previous?.type !== "compaction" || !previous.fromHook) return;
  const details = previous.details as Record<string, unknown> | undefined;
  if (details?.[DETAILS_VERSION] !== 1) return;
  for (const [key, target] of [["readFiles", event.preparation.fileOps.read], ["modifiedFiles", event.preparation.fileOps.edited]] as const) {
    const files = details[key];
    if (Array.isArray(files)) for (const file of files) if (typeof file === "string") target.add(file);
  }
}
function reportFailure(ctx: ExtensionContext, error: unknown): void {
  try {
    const message = `Compaction cancelled; no default-model fallback: ${String(error instanceof Error ? error.message : error).replace(/[\r\n]+/g, " ").slice(0, 500)}`;
    if (ctx.hasUI) ctx.ui.notify(message, "error"); else process.stderr.write(`[idle-context-warning] ${message}\n`);
  } catch { /* Diagnostics cannot allow default-model fallback. */ }
}
/** Owns summary selection, not dispatch admission. Cancelling summary generation
 * is not a veto over Pi's independent internal continuations/retries. */
export async function beforeCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext, readSettings: () => Config): Promise<SessionBeforeCompactResult | undefined> {
  try {
    restoreFileTracking(event);
    const settings = readSettings();
    const forced = (globalThis as Record<string, unknown>)[FORCE_CHEAP_COMPACTION_KEY] as { sessionId?: string; token?: string } | undefined;
    const forcedCheap = forced?.sessionId === ctx.sessionManager.getSessionId() && typeof forced.token === "string";
    if (!forcedCheap && (settings.cheapCompactionModel == null || !isIdle(lastModelActivity(event.branchEntries), Date.now(), settings.idleMinutes))) return;
    event.signal.throwIfAborted();
    if (settings.cheapCompactionModel == null) throw new Error("Explicit cheap compaction requires cheapCompactionModel");
    const selected = parseModelSelector(settings.cheapCompactionModel);
    const requestProfile = await prepareSessionRoutingRequest(ctx);
    const effectiveSelector = resolveCompactionSelector(ctx, selected, requestProfile);
    const [provider, ...parts] = effectiveSelector.split("/");
    const model = ctx.modelRegistry.find(provider, parts.join("/"));
    if (!model) throw new Error(`Unknown compaction model: ${effectiveSelector}`);
    if (model.api === "pi-virtual") throw new Error("Compaction requires a direct physical model");
    const requestModel = requestProfile ? bindSessionModelRequest(model, requestProfile) : model;
    const stream: NonNullable<Parameters<typeof compact>[7]> = async (_target, context, options) => {
      const assertCurrent = async () => {
        event.signal.throwIfAborted();
        const profile = await prepareSessionRoutingRequest(ctx);
        if (resolveCompactionSelector(ctx, selected, profile) !== effectiveSelector || !sameRoutingProfile(requestProfile, profile)) throw new Error("Session routing changed during compaction; cancel and retry so native chunk planning uses matching model limits");
      };
      await assertCurrent();
      const result = ctx.modelRegistry.streamSimple(requestModel, context, {
        ...options, onPayload: async (payload, physicalModel) => {
          const replacement = await options?.onPayload?.(payload, physicalModel);
          await assertCurrent();
          return replacement;
        },
      });
      const response = await result.result();
      event.signal.throwIfAborted();
      if (response.stopReason !== "stop") throw new Error(response.errorMessage || `Summary stopped with ${response.stopReason}`);
      if (response.content.some(block => block.type === "toolCall")) throw new Error("Summary attempted a tool call");
      if (!response.content.some(block => block.type === "text" && block.text.trim())) throw new Error("Summary was empty");
      return result;
    };
    const result = await compact(event.preparation, requestModel, undefined, undefined, event.customInstructions, event.signal, selected.thinking, stream);
    event.signal.throwIfAborted();
    return { compaction: { ...result, details: { ...(result.details as object), [DETAILS_VERSION]: 1, ...(forcedCheap ? { idleContextExplicitAttempt: forced!.token } : {}) } } };
  } catch (error) { reportFailure(ctx, error); return { cancel: true }; }
}
export function registerCompaction(pi: ExtensionAPI, readSettings: () => Config): void {
  pi.on("session_before_compact", (event, ctx) => beforeCompact(event, ctx, readSettings));
}
