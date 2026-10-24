import { readExtensionDefaults, readPreferenceDocument, mergeExtensionSettings } from "../shared/extension-defaults.js";
import { join } from "node:path";
import { resolveSessionModelSelector, type RoutingContext, type RoutingProfile } from "../shared/session-routing.ts";

export interface SubagentModelSettings {
  defaultProvider: string;
  defaultModel: string;
  defaultThinkingLevel: string;
}

// Legacy standalone defaults. Active launches rebind the provider to their
// owning session; this field must never pin a helper to another provider.
const defaults: SubagentModelSettings = {
  defaultProvider: "openai",
  defaultModel: "gpt-6-luna",
  defaultThinkingLevel: "low",
};
const thinkingSuffix = /:(off|minimal|low|medium|high|xhigh|max)$/;

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
  return settings;
}

export function resolveSubagentModel(model: string | undefined, settings: SubagentModelSettings, context?: RoutingContext, snapshot?: RoutingProfile): string {
  // Keep legacy configuration readable, but provider policy belongs to the
  // owning session, not to role defaults or model-generated launch arguments.
  const selected = context
    ? resolveSessionModelSelector(context, model ?? settings.defaultModel, snapshot)
    : model ?? `${settings.defaultProvider}/${settings.defaultModel}`;
  const reference = selected.replace(thinkingSuffix, "");
  const slash = reference.indexOf("/");
  if (context?.modelRegistry) {
    const physical = context.modelRegistry.find(reference.slice(0, slash), reference.slice(slash + 1));
    if (!physical || physical.api === "pi-virtual") throw new Error(`Unavailable physical subagent model: ${reference}; no provider/model fallback`);
  }
  return thinkingSuffix.test(selected) ? selected : `${selected}:${settings.defaultThinkingLevel}`;
}
