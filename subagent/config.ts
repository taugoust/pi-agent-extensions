import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface SubagentModelSettings {
  defaultProvider: string;
  defaultModel: string;
  defaultThinkingLevel: string;
}

// Preserve the historical defaults for installations without configuration.
const defaults: SubagentModelSettings = {
  defaultProvider: "openai-codex",
  defaultModel: "gpt-6-astra",
  defaultThinkingLevel: "low",
};
const thinkingSuffix = /:(off|minimal|low|medium|high|xhigh|max)$/;

export function readSubagentModelSettings(agentDir: string): SubagentModelSettings {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(agentDir, "subagent.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...defaults };
    throw new Error(`Cannot read subagent.json: ${String(error)}`);
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
