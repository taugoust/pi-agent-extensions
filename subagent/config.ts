import { readExtensionDefaults, readPreferenceDocument, mergeExtensionSettings } from "../shared/extension-defaults.js";
import { join } from "node:path";
import {
  physicalSessionProvider,
  resolveSessionProvider,
  type RoutingContext,
  type RoutingProfile,
} from "../shared/session-routing.ts";
import { readModelTiers, resolveTierSelector, type ModelTierTable } from "../shared/model-tiers.ts";

export interface SubagentModelSettings {
  /** A tier, a model ID on the session's provider, or an explicit provider/model. */
  defaultModel: string;
  defaultThinkingLevel: string;
}

const defaults: SubagentModelSettings = {
  defaultModel: "cheap",
  defaultThinkingLevel: "low",
};
const thinkingSuffix = /:(off|minimal|low|medium|high|xhigh|max)$/;
// Used only without a session, for example in standalone tests.
const STANDALONE_PROVIDER = "openai-codex";

export function readSubagentModelSettings(agentDir: string): SubagentModelSettings {
  let value: unknown;
  try {
    value = mergeExtensionSettings(readExtensionDefaults("subagent", agentDir),
      readPreferenceDocument(join(agentDir, "subagent.json")));
  } catch (error) {
    throw new Error(`Cannot read subagent.json/defaults/subagent.json: ${String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("subagent.json must be an object");
  const settings = { ...defaults, ...value } as SubagentModelSettings;
  for (const key of Object.keys(defaults) as (keyof SubagentModelSettings)[]) {
    if (typeof settings[key] !== "string" || !settings[key].trim() || /\s/.test(settings[key])) {
      throw new Error(`Invalid subagent.json ${key}`);
    }
  }
  if (!/^(off|minimal|low|medium|high|xhigh|max)$/.test(settings.defaultThinkingLevel)) throw new Error("Invalid subagent.json defaultThinkingLevel");
  const { defaultModel, defaultThinkingLevel } = settings;
  return { defaultModel, defaultThinkingLevel };
}

/**
 * Tiers and bare model IDs use the session's provider. An explicit provider/model
 * is kept, so a session can start workers on another provider.
 */
export function resolveSubagentModel(
  model: string | undefined,
  settings: SubagentModelSettings,
  context?: RoutingContext,
  snapshot?: RoutingProfile,
  tiers: ModelTierTable = readModelTiers(),
): string {
  const provider = context
    ? physicalSessionProvider(context) ?? snapshot?.providerId ?? resolveSessionProvider(context)
    : STANDALONE_PROVIDER;
  const selected = resolveTierSelector(model ?? settings.defaultModel, provider, tiers,
    { crossProvider: true, defaultThinking: settings.defaultThinkingLevel });
  const reference = selected.replace(thinkingSuffix, "");
  const slash = reference.indexOf("/");
  if (context?.modelRegistry) {
    const physical = context.modelRegistry.find(reference.slice(0, slash), reference.slice(slash + 1));
    if (!physical || physical.api === "pi-virtual") throw new Error(`Unavailable physical subagent model: ${reference}; no provider/model fallback`);
  }
  return selected;
}

/** The provider part of a resolved provider/model[:thinking] selector. */
export function selectorProvider(selector: string | undefined): string | undefined {
  const slash = selector?.indexOf("/") ?? -1;
  return slash > 0 ? selector!.slice(0, slash) : undefined;
}
