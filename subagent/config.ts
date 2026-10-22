import { readExtensionDefaults, readPreferenceDocument, mergeExtensionSettings } from "../shared/extension-defaults.js";
import { join } from "node:path";

export interface SubagentModelSettings {
  defaultProvider: string;
  defaultModel: string;
  defaultThinkingLevel: string;
}

// Match the managed configuration; never silently fall back to deprecated Codex auth.
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

export function resolveSubagentModel(model: string | undefined, settings: SubagentModelSettings): string {
  const selected = model ?? `${settings.defaultProvider}/${settings.defaultModel}`;
  return thinkingSuffix.test(selected) ? selected : `${selected}:${settings.defaultThinkingLevel}`;
}
