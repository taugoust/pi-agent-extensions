import {
  compact,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import { isIdle, lastModelActivity, type Config } from "./policy.ts";
import { bindSessionModelRequest, prepareSessionRoutingRequest, resolveSessionModelSelector, resolveSessionProvider, type RoutingProfile } from "../shared/session-routing.ts";
import { GUARD_ERROR, GUARD_PROOF, GUARD_PROVIDER, PROXY_PROVIDER, assertGuardProofCurrent, parseGuardedModels, type GuardProof } from "./guard.ts";

type Thinking = NonNullable<Parameters<typeof compact>[6]>;
const thinkingSuffix = /:(off|minimal|low|medium|high|xhigh|max)$/;
const DETAILS_VERSION = "idleContextNativeCompaction";
function resolveCompactionSelector(ctx: ExtensionContext, selected: { provider: string; id: string }, profile?: RoutingProfile): string {
  if (profile) return resolveSessionModelSelector(ctx, `${selected.provider || "_"}/${selected.id}`, profile);
  return selected.provider
    ? resolveSessionModelSelector(ctx, `${selected.provider}/${selected.id}`)
    : `${resolveSessionProvider(ctx)}/${selected.id}`;
}
function sameRoutingProfile(a?: RoutingProfile, b?: RoutingProfile): boolean {
  return a === undefined ? b === undefined : b !== undefined && a.ownerSessionId === b.ownerSessionId && a.providerId === b.providerId && a.accountId === b.accountId && a.revision === b.revision;
}
export const FORCE_CHEAP_COMPACTION_KEY = "__piIdleContextForceCheapV1";

export function parseModelSelector(value: unknown): { provider: string; id: string; thinking: Thinking } {
  if (typeof value !== "string" || !value || /\s/.test(value)) {
    throw new Error("cheapCompactionModel must be provider/model[:thinking]");
  }
  const suffix = value.match(thinkingSuffix);
  const model = suffix ? value.slice(0, -suffix[0].length) : value;
  const slash = model.indexOf("/");
  if (slash === model.length - 1) throw new Error("cheapCompactionModel must include a model ID");
  // A bare model ID is provider-relative. Qualified legacy preferences retain
  // their model ID but bind to the active physical provider.
  const id = slash > 0 ? model.slice(slash + 1) : model;
  return { provider: slash > 0 ? model.slice(0, slash) : "", id, thinking: (suffix?.[1] ?? "low") as Thinking };
}

export function restoreFileTracking(event: SessionBeforeCompactEvent): void {
  // Pi skips details on fromHook summaries. Our details are native, so carry
  // them forward even when this attempt returns to normal Pi compaction.
  const previous = event.branchEntries.findLast((entry) => entry.type === "compaction");
  if (previous?.type !== "compaction" || !previous.fromHook) return;
  const details = previous.details as Record<string, unknown> | undefined;
  if (details?.[DETAILS_VERSION] !== 1) return;
  for (const [key, target] of [["readFiles", event.preparation.fileOps.read], ["modifiedFiles", event.preparation.fileOps.edited]] as const) {
    const files = details[key];
    if (Array.isArray(files)) for (const file of files) if (typeof file === "string") target.add(file);
  }
}

function reportFailure(ctx: ExtensionContext, error: unknown): void {
  // Even a broken UI/diagnostic sink must not make the hook throw: Pi would
  // catch it and could fall through to expensive default compaction.
  try {
    const reason = error instanceof Error ? error.message : String(error);
    const message = `Compaction cancelled; no default-model fallback: ${reason.replace(/[\r\n]+/g, " ").slice(0, 500)}`;
    if (ctx.hasUI) ctx.ui.notify(message, "error");
    else process.stderr.write(`[idle-context-warning] ${message}\n`);
  } catch { /* Cancellation is authoritative even if reporting fails. */ }
}

export async function beforeCompact(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  readSettings: () => Config,
  getGuardProof?: (ctx: ExtensionContext) => GuardProof | undefined,
): Promise<SessionBeforeCompactResult | undefined> {
  try {
    restoreFileTracking(event);
    const settings = readSettings();
    const proof = getGuardProof?.(ctx);
    const guarded = ctx.model?.provider === GUARD_PROVIDER;
    const forced = (globalThis as Record<string, unknown>)[FORCE_CHEAP_COMPACTION_KEY] as { sessionId?: string; token?: string } | undefined;
    const forcedCheap = forced?.sessionId === ctx.sessionManager.getSessionId() && typeof forced.token === "string";
    if (!guarded && !proof && !forcedCheap && (settings.cheapCompactionModel == null || !isIdle(lastModelActivity(event.branchEntries), Date.now(), settings.idleMinutes))) return;
    const warmPhysical = guarded && (proof ? proof.mode === "physical" : !isIdle(lastModelActivity(event.branchEntries), Date.now(), settings.idleMinutes));
    event.signal.throwIfAborted();
    const alias = ctx.model?.id;
    const physicalSelector = warmPhysical ? parseGuardedModels(settings.guardedModels)[alias!] : undefined;
    if (warmPhysical && !physicalSelector) throw new Error("Warm guarded compaction requires an exact physical target");
    if (!warmPhysical && settings.cheapCompactionModel == null) throw new Error("Idle/recovery compaction requires cheapCompactionModel");
    const selected = warmPhysical
      ? { ...parseModelSelector(physicalSelector), thinking: (ctx.thinkingLevel ?? "off") as Thinking }
      : parseModelSelector(settings.cheapCompactionModel);
    const requestProfile = await prepareSessionRoutingRequest(ctx);
    const effectiveSelector = resolveCompactionSelector(ctx, selected, requestProfile);
    const [effectiveProvider, ...modelParts] = effectiveSelector.split("/");
    const effectiveId = modelParts.join("/");
    const model = ctx.modelRegistry.find(effectiveProvider, effectiveId);
    if (!model) throw new Error(`Unknown compaction model: ${effectiveProvider}/${effectiveId}`);
    if (model.api === "pi-virtual" || [GUARD_PROVIDER, PROXY_PROVIDER].includes(model.provider)) throw new Error("Compaction requires a direct physical model");
    const requestModel = requestProfile ? bindSessionModelRequest(model, requestProfile) : model;
    const session = warmPhysical ? ctx.sessionManager.getSessionId() : undefined;
    const assertWarmDispatch = () => {
      event.signal.throwIfAborted();
      if (!warmPhysical) return;
      if (proof) assertGuardProofCurrent(proof);
      const current = readSettings();
      if (ctx.sessionManager.getSessionId() !== session || ctx.model?.provider !== GUARD_PROVIDER || ctx.model.id !== alias || parseGuardedModels(current.guardedModels)[alias!] !== physicalSelector || isIdle(lastModelActivity(ctx.sessionManager.getBranch()), Date.now(), current.idleMinutes)) {
        throw new Error(`${GUARD_ERROR}: warm physical compaction became idle or stale; use /idle-guard-retry for cheap recovery`);
      }
    };

    // Reuse Pi's complete native algorithm, including iterative summaries,
    // split turns, usage aggregation, retained boundary and file-operation tags.
    // The registry owns request-time credentials, custom providers and headers.
    // Never call pi.setModel() or change the conversation's thinking level.
    const stream: NonNullable<Parameters<typeof compact>[7]> = async (target, context, options) => {
      assertWarmDispatch();
      const originalPayload = options?.onPayload;
      const routeProfile = await prepareSessionRoutingRequest(ctx);
      const routedSelector = resolveCompactionSelector(ctx, selected, routeProfile);
      if (routedSelector !== effectiveSelector || !sameRoutingProfile(requestProfile, routeProfile)) {
        throw new Error("Session routing changed during compaction; cancel and retry so native chunk planning uses matching model limits");
      }
      const result = ctx.modelRegistry.streamSimple(requestModel, context, warmPhysical ? {
        ...options,
        onPayload: async (payload, physicalModel) => {
          const replacement = await originalPayload?.(payload, physicalModel);
          assertWarmDispatch();
          return replacement;
        },
      } : options);
      const response = await result.result();
      event.signal.throwIfAborted();
      if (response.stopReason !== "stop") throw new Error(response.errorMessage || `Summary stopped with ${response.stopReason}`);
      if (response.content.some((block) => block.type === "toolCall")) throw new Error("Summary attempted a tool call");
      if (!response.content.some((block) => block.type === "text" && block.text.trim())) throw new Error("Summary was empty");
      return result;
    };
    const result = await compact(event.preparation, requestModel, undefined, undefined, event.customInstructions, event.signal, selected.thinking, stream);
    event.signal.throwIfAborted();
    return { compaction: { ...result, details: { ...(result.details as object), [DETAILS_VERSION]: 1, ...(forcedCheap ? { idleContextExplicitAttempt: forced!.token } : {}), ...(proof ? { [GUARD_PROOF]: proof } : {}) } } };
  } catch (error) {
    reportFailure(ctx, error);
    return { cancel: true };
  }
}

export function registerCompaction(pi: ExtensionAPI, readSettings: () => Config, getGuardProof?: (ctx: ExtensionContext) => GuardProof | undefined): void {
  pi.on("session_before_compact", (event, ctx) => beforeCompact(event, ctx, readSettings, getGuardProof));
}
