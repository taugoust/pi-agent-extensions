import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  resolveSessionModelSelector,
  type RoutingContext,
  type RoutingProfile,
} from "./session-routing.ts";
import {
  mergeExtensionSettings,
  readExtensionDefaults,
  readPreferenceDocument,
} from "./extension-defaults.js";

/**
 * Model tiers name a cost level instead of a model ID. A tier reference such as
 * `cheap` or `expensive:high` resolves to that tier's model on a given provider.
 */
export const MODEL_TIERS = ["cheap", "expensive", "superintelligence"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
export type ModelTierTable = Record<string, Partial<Record<ModelTier, string>>>;

export const DEFAULT_MODEL_TIERS: ModelTierTable = {
  "openai-codex": {
    cheap: "gpt-6-luna",
    expensive: "gpt-6.1-sol",
    superintelligence: "gpt-6-astra",
  },
  "claude-bridge": {
    cheap: "claude-haiku-5-5",
    expensive: "claude-opus-5-5",
    superintelligence: "claude-fable-5-1",
  },
};

const THINKING = /:(off|minimal|low|medium|high|xhigh|max)$/;
const MODEL_ID = /^[^\s/:][^\s]*$/;

export interface ParsedSelector {
  provider?: string;
  id?: string;
  tier?: ModelTier;
  thinking?: string;
}

export function isModelTier(value: string): value is ModelTier {
  return (MODEL_TIERS as readonly string[]).includes(value);
}

/** `tier[:thinking]`, `model[:thinking]` or `provider/model[:thinking]`. */
export function parseModelSelector(selector: string): ParsedSelector {
  if (typeof selector !== "string" || !selector || /\s/.test(selector)) {
    throw new Error(`Invalid model selector: ${String(selector)}`);
  }
  const suffix = selector.match(THINKING);
  const body = suffix ? selector.slice(0, -suffix[0].length) : selector;
  const thinking = suffix?.[1];
  const slash = body.indexOf("/");
  if (slash < 0) {
    if (!body) throw new Error(`Invalid model selector: ${selector}`);
    return isModelTier(body) ? { tier: body, thinking } : { id: body, thinking };
  }
  const provider = body.slice(0, slash), id = body.slice(slash + 1);
  if (!provider || !id) {
    throw new Error(`Model selector needs a provider and model ID: ${selector}`);
  }
  return { provider, id, thinking };
}

export function validateModelTiers(value: unknown): ModelTierTable {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("model-tiers must be an object of providers");
  }
  const table: ModelTierTable = {};
  for (const [provider, tiers] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(provider)) {
      throw new Error(`Invalid model-tiers provider: ${provider}`);
    }
    if (tiers === null) continue;
    if (!tiers || typeof tiers !== "object" || Array.isArray(tiers)) {
      throw new Error(`model-tiers.${provider} must be an object`);
    }
    const entry: Partial<Record<ModelTier, string>> = {};
    for (const [tier, model] of Object.entries(tiers as Record<string, unknown>)) {
      if (!isModelTier(tier)) throw new Error(`Unknown model tier ${provider}.${tier}`);
      if (model === null) continue;
      if (typeof model !== "string" || !MODEL_ID.test(model)) {
        throw new Error(`model-tiers.${provider}.${tier} must be a model ID`);
      }
      entry[tier] = model;
    }
    table[provider] = entry;
  }
  return table;
}

/** Built-ins < defaults/model-tiers.json < model-tiers.json. */
export function readModelTiers(agentDir = getAgentDir()): ModelTierTable {
  const configured = mergeExtensionSettings(
    readExtensionDefaults("model-tiers", agentDir),
    readPreferenceDocument(join(agentDir, "model-tiers.json")),
  );
  return validateModelTiers(mergeExtensionSettings(DEFAULT_MODEL_TIERS, configured));
}

export function tierModel(tiers: ModelTierTable, provider: string, tier: ModelTier): string {
  const model = tiers[provider]?.[tier];
  if (!model) {
    throw new Error(
      `No ${tier} model is configured for provider ${provider}; ` +
      `set programs.pi.modelTiers.${provider}.${tier} (or model-tiers.json)`,
    );
  }
  return model;
}

/**
 * Resolves a selector for a session on `provider`. Tiers and bare model IDs use
 * that provider. An explicit `provider/model` is kept when `crossProvider` is set
 * and otherwise rebound to the session provider.
 */
export function resolveTierSelector(
  selector: string,
  provider: string,
  tiers: ModelTierTable,
  options: { crossProvider?: boolean; defaultThinking?: string } = {},
): string {
  const parsed = parseModelSelector(selector);
  const target = parsed.provider && options.crossProvider ? parsed.provider : provider;
  const id = parsed.tier ? tierModel(tiers, target, parsed.tier) : parsed.id!;
  const thinking = parsed.thinking ?? options.defaultThinking;
  return `${target}/${id}${thinking ? `:${thinking}` : ""}`;
}

/**
 * Like resolveSessionModelSelector, but a tier names that tier's model on the
 * session's provider. Other selectors keep their existing session rebinding.
 */
export function resolveSessionTierSelector(
  ctx: RoutingContext,
  selector: string,
  snapshot?: RoutingProfile,
  tiers?: ModelTierTable,
): string {
  const parsed = parseModelSelector(selector);
  if (!parsed.tier) return resolveSessionModelSelector(ctx, selector, snapshot);
  const placeholder = resolveSessionModelSelector(ctx, "tier", snapshot);
  const provider = placeholder.slice(0, placeholder.indexOf("/"));
  const thinking = parsed.thinking ? `:${parsed.thinking}` : "";
  return `${provider}/${tierModel(tiers ?? readModelTiers(), provider, parsed.tier)}${thinking}`;
}
