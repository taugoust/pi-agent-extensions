import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveSessionModelSelector, registerSessionModelReference, SESSION_MODEL_REFERENCE_EVENT } from "../shared/session-routing.ts";
import type { Config } from "./policy.ts";

export const LEGACY_PROVIDER = "idle-guard";
export const LEGACY_PROXY = "idle-guard-proxy";
export function parseLegacyAliases(value: unknown): Record<string, string> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("guardedModels must be an alias-to-provider/model object");
  const out: Record<string, string> = Object.create(null);
  for (const [alias, target] of Object.entries(value)) {
    if (!alias || /\s/.test(alias) || typeof target !== "string" || !/^[^/\s]+\/\S+$/.test(target) || /:(off|minimal|low|medium|high|xhigh|max)$/.test(target) || [LEGACY_PROVIDER, LEGACY_PROXY].includes(target.split("/")[0])) throw new Error("Invalid legacy guardedModels mapping");
    out[alias] = target;
  }
  return out;
}
export function migrateSelector(selector: string, aliases: Record<string, string>): string {
  const slash = selector.indexOf("/");
  if (![LEGACY_PROVIDER, LEGACY_PROXY].includes(selector.slice(0, slash))) return selector;
  const id = selector.slice(slash + 1);
  const target = aliases[id];
  if (!target) throw new Error(`Legacy idle alias ${selector} has no explicit physical mapping`);
  return target;
}
/** Pure settings planner: no files, credentials, sessions or account choices. */
export function planSettingsMigration(settings: Record<string, any>, aliases: Record<string, string>): Record<string, any> {
  const out = structuredClone(settings);
  if (out.defaultProvider && out.defaultModel) {
    const target = migrateSelector(`${out.defaultProvider}/${out.defaultModel}`, aliases);
    const slash = target.indexOf("/"); out.defaultProvider = target.slice(0, slash); out.defaultModel = target.slice(slash + 1);
  }
  for (const field of ["modelThinkingLevels"] as const) if (out[field]) {
    const values: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(out[field])) {
      const target = migrateSelector(key, aliases);
      if (target in values && JSON.stringify(values[target]) !== JSON.stringify(value)) throw new Error(`Conflicting ${field} migration for ${target}`);
      values[target] = value;
    }
    out[field] = values;
  }
  if (out.compaction?.modelOverrides) out.compaction.modelOverrides = planSettingsMigration({ modelThinkingLevels: out.compaction.modelOverrides }, aliases).modelThinkingLevels;
  if (Array.isArray(out.enabledModels)) out.enabledModels = out.enabledModels.map((selector: string) => {
    if (/^(idle-guard|idle-guard-proxy)\//.test(selector) && /[*?]/.test(selector)) throw new Error(`Expand legacy model pattern explicitly: ${selector}`);
    const suffix = selector.match(/:(off|minimal|low|medium|high|xhigh|max)$/)?.[0] ?? "";
    return migrateSelector(suffix ? selector.slice(0, -suffix.length) : selector, aliases) + suffix;
  });
  return out;
}
function rememberedAliases(path: string): string[] {
  const result: string[] = [];
  try { const old = JSON.parse(readFileSync(path, "utf8")); if (Array.isArray(old)) result.push(...old.filter((id): id is string => typeof id === "string" && !!id && !/\s/.test(id))); } catch { /* No legacy state is normal. */ }
  try { for (const file of readdirSync(`${path}.d`).filter(name => name.endsWith(".json"))) { const id = JSON.parse(readFileSync(join(`${path}.d`, file), "utf8")); if (typeof id === "string" && id && !/\s/.test(id)) result.push(id); } } catch { /* Read-only compatibility; never create tombstones. */ }
  return result;
}
/** Temporary startup compatibility only. Closed virtual placeholders prevent
 * stock Pi silently restoring the last physical/proxy response. They NEVER route
 * or wrap requests. Known aliases become ordinary physical selections via the
 * public setModel API; unknown aliases stay closed with actionable migration. */
export function installLegacyMigration(pi: ExtensionAPI, readSettings: () => Config, path = join(getAgentDir(), "idle-guard-aliases.json")): void {
  let configured: string[] = [];
  try {
    const mappings = readSettings().guardedModels;
    if (mappings && typeof mappings === "object" && !Array.isArray(mappings)) configured = Object.keys(mappings).filter(alias => !!alias && !/\s/.test(alias));
  } catch { /* Keep remembered selections closed even with broken settings. */ }
  for (const alias of new Set([...rememberedAliases(path), ...configured])) for (const provider of [LEGACY_PROVIDER, LEGACY_PROXY]) pi.registerVirtualModel({
    provider, id: alias, name: `Legacy idle alias: ${alias} (migration required)`,
    thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    route() { throw new Error("Legacy idle alias is closed. Run /idle-context-migrate with a configured physical mapping."); },
  });
  let removeReference: (() => void) | undefined;
  const bind = (ctx: ExtensionContext) => {
    removeReference?.();
    removeReference = registerSessionModelReference(ctx, () => {
      if (!ctx.model || ![LEGACY_PROVIDER, LEGACY_PROXY].includes(ctx.model.provider)) return;
      const target = parseLegacyAliases(readSettings().guardedModels)[ctx.model.id];
      if (!target) return;
      const slash = target.indexOf("/"); return { provider: target.slice(0, slash), id: target.slice(slash + 1) };
    });
  };
  const unsubscribe = pi.events?.on?.(SESSION_MODEL_REFERENCE_EVENT, (request: any) => {
    if (request?.ctx?.model && [LEGACY_PROVIDER, LEGACY_PROXY].includes(request.ctx.model.provider)) bind(request.ctx);
  });
  const migrate = async (ctx: ExtensionContext) => {
    if (!ctx.model || ![LEGACY_PROVIDER, LEGACY_PROXY].includes(ctx.model.provider)) return;
    const initial = ctx.model, session = ctx.sessionManager.getSessionId(), thinking = ctx.thinkingLevel;
    try {
      const target = resolveSessionModelSelector(ctx, migrateSelector(`${initial.provider}/${initial.id}`, parseLegacyAliases(readSettings().guardedModels)));
      const slash = target.indexOf("/"), physical = ctx.modelRegistry.find(target.slice(0, slash), target.slice(slash + 1));
      if (!physical || physical.api === "pi-virtual") throw new Error(`Physical migration model unavailable: ${target}`);
      if (ctx.sessionManager.getSessionId() !== session || ctx.model !== initial) return;
      if (!await pi.setModel(physical)) throw new Error(`Physical migration model lacks credentials: ${target}`);
      if (thinking) pi.setThinkingLevel(thinking);
      if (ctx.hasUI) ctx.ui.notify(`Legacy idle alias migrated to ${target}; account routing retained. Idle admission no longer owns model dispatch.`, "info");
    } catch (error) { if (ctx.hasUI) ctx.ui.notify(String(error), "warning"); else process.stderr.write(`[idle-context-warning] ${String(error)}\n`); }
  };
  pi.on("session_start", async (_event, ctx) => { bind(ctx); await migrate(ctx); });
  pi.on("session_shutdown", () => { removeReference?.(); removeReference = undefined; unsubscribe?.(); });
  pi.registerCommand("idle-context-migrate", { description: "Resolve selected legacy idle alias to its configured physical model (does not change defaults/accounts)", handler: async (_args, ctx) => { await ctx.waitForIdle(); await migrate(ctx); } });
}
