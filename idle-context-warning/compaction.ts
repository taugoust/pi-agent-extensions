import {
  compact,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";
import { isIdle, lastModelActivity, type Config } from "./policy.ts";

type Thinking = NonNullable<Parameters<typeof compact>[6]>;
const thinkingSuffix = /:(off|minimal|low|medium|high|xhigh|max)$/;
const DETAILS_VERSION = "idleContextNativeCompaction";

export function parseModelSelector(value: unknown): { provider: string; id: string; thinking: Thinking } {
  if (typeof value !== "string" || !value || /\s/.test(value)) {
    throw new Error("cheapCompactionModel must be provider/model[:thinking]");
  }
  const suffix = value.match(thinkingSuffix);
  const model = suffix ? value.slice(0, -suffix[0].length) : value;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error("cheapCompactionModel must include a provider and model ID");
  }
  // Keep additional slashes and non-thinking colons in model IDs (OpenRouter,
  // Ollama, etc.). No fuzzy matching or fallback to another provider/model.
  return { provider: model.slice(0, slash), id: model.slice(slash + 1), thinking: (suffix?.[1] ?? "low") as Thinking };
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
    const message = `Cheap compaction cancelled; no default-model fallback: ${reason.replace(/[\r\n]+/g, " ").slice(0, 500)}`;
    if (ctx.hasUI) ctx.ui.notify(message, "error");
    else process.stderr.write(`[idle-context-warning] ${message}\n`);
  } catch { /* Cancellation is authoritative even if reporting fails. */ }
}

export async function beforeCompact(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  readSettings: () => Config,
): Promise<SessionBeforeCompactResult | undefined> {
  try {
    restoreFileTracking(event);
    const settings = readSettings();
    if (settings.cheapCompactionModel == null || !isIdle(lastModelActivity(event.branchEntries), Date.now(), settings.idleMinutes)) return;
    event.signal.throwIfAborted();
    const selected = parseModelSelector(settings.cheapCompactionModel);
    const model = ctx.modelRegistry.find(selected.provider, selected.id);
    if (!model) throw new Error(`Unknown cheap compaction model: ${selected.provider}/${selected.id}`);

    // Reuse Pi's complete native algorithm, including iterative summaries,
    // split turns, usage aggregation, retained boundary and file-operation tags.
    // The registry owns request-time credentials, custom providers and headers.
    // Never call pi.setModel() or change the conversation's thinking level.
    const stream: NonNullable<Parameters<typeof compact>[7]> = async (target, context, options) => {
      event.signal.throwIfAborted();
      const result = ctx.modelRegistry.streamSimple(target, context, options);
      const response = await result.result();
      event.signal.throwIfAborted();
      if (response.stopReason !== "stop") throw new Error(response.errorMessage || `Summary stopped with ${response.stopReason}`);
      if (response.content.some((block) => block.type === "toolCall")) throw new Error("Summary attempted a tool call");
      if (!response.content.some((block) => block.type === "text" && block.text.trim())) throw new Error("Summary was empty");
      return result;
    };
    const result = await compact(event.preparation, model, undefined, undefined, event.customInstructions, event.signal, selected.thinking, stream);
    event.signal.throwIfAborted();
    return { compaction: { ...result, details: { ...(result.details as object), [DETAILS_VERSION]: 1 } } };
  } catch (error) {
    reportFailure(ctx, error);
    return { cancel: true };
  }
}

export function registerCompaction(pi: ExtensionAPI, readSettings: () => Config): void {
  pi.on("session_before_compact", (event, ctx) => beforeCompact(event, ctx, readSettings));
}
