import { describe, expect, it } from "bun:test";
import { installLegacyMigration, migrateSelector, parseLegacyAliases, planSettingsMigration } from "./migration.ts";
import { registerSessionRouting } from "../shared/session-routing.ts";

const aliases = { role: "openai/model", small: "openai/small" };
describe("legacy selection migration", () => {
  it("plans default, scopes, thinking and compaction overrides without mutating input", () => {
    const original = { defaultProvider: "idle-guard", defaultModel: "role", enabledModels: ["idle-guard/role:high", "vendor/explicit"], modelThinkingLevels: { "idle-guard/role": "high" }, compaction: { modelOverrides: { "idle-guard/role": { reserveTokens: 100 } } } };
    expect(planSettingsMigration(original, aliases)).toEqual({ defaultProvider: "openai", defaultModel: "model", enabledModels: ["openai/model:high", "vendor/explicit"], modelThinkingLevels: { "openai/model": "high" }, compaction: { modelOverrides: { "openai/model": { reserveTokens: 100 } } } });
    expect(original.defaultProvider).toBe("idle-guard");
  });
  it("never guesses unknown aliases, patterns or conflicting per-model preferences", () => {
    expect(() => migrateSelector("idle-guard/missing", aliases)).toThrow("no explicit");
    expect(() => planSettingsMigration({ enabledModels: ["idle-guard/*"] }, aliases)).toThrow("Expand");
    expect(() => planSettingsMigration({ modelThinkingLevels: { "idle-guard/role": "high", "openai/model": "low" } }, aliases)).toThrow("Conflicting");
    expect(migrateSelector("other/user-choice", aliases)).toBe("other/user-choice");
  });
  it("registers closed compatibility selections only, never a provider/proxy stream", async () => {
    const routes: any[] = [], events: any = {}, selections: any[] = [], levels: any[] = [];
    const pi: any = { on: (name: string, fn: any) => events[name] = fn, events: { on: () => () => {} }, registerVirtualModel: (model: any) => routes.push(model), registerCommand() {},
      setModel: async (model: any) => { selections.push(model); return true; }, setThinkingLevel: (level: any) => levels.push(level) };
    installLegacyMigration(pi, () => ({ idleMinutes: 30, contextPercent: 20, guardedModels: aliases }), "/nonexistent/idle-aliases");
    expect(routes).toHaveLength(4); expect(() => routes[0].route()).toThrow("closed");
    const physical = { provider: "openai", id: "model", api: "openai-responses" };
    const ctx: any = { model: { provider: "idle-guard", id: "role" }, thinkingLevel: "high", hasUI: false,
      sessionManager: { getSessionId: () => "migration", getBranch: () => [] }, modelRegistry: { find: () => physical } };
    await events.session_start({}, ctx);
    expect(selections).toEqual([physical]); expect(levels).toEqual(["high"]);
    ctx.model = { provider: "vendor", id: "explicit" }; await events.session_start({}, ctx); expect(selections).toHaveLength(1);
    events.session_shutdown();
  });
  it("keeps malformed configured aliases discoverable but closed instead of triggering stock physical fallback", () => {
    const routes: any[] = [];
    const pi: any = { on() {}, events: { on: () => () => {} }, registerCommand() {}, registerVirtualModel: (model: any) => routes.push(model) };
    installLegacyMigration(pi, () => ({ idleMinutes: 30, contextPercent: 20, guardedModels: { broken: "invalid-target" } }), "/nonexistent/idle-aliases");
    expect(routes.map(route => `${route.provider}/${route.id}`)).toEqual(["idle-guard/broken", "idle-guard-proxy/broken"]);
    expect(() => routes[0].route()).toThrow("closed");
  });
  it("resolves under the current account routing profile without switching accounts", async () => {
    const events: any = {}, selections: any[] = [];
    const physical = { provider: "codex", id: "model", api: "openai-codex-responses" };
    const manager: any = { getSessionId: () => "account-test", getBranch: () => [] };
    const profile: any = { version: 1, ownerSessionId: "account-test", providerId: "codex", accountId: "work", revision: 7 };
    const remove = registerSessionRouting({ sessionManager: manager }, { file: "/nonexistent/fixture-profile", getProfile: () => profile });
    const pi: any = { on: (name: string, fn: any) => events[name] = fn, events: { on: () => () => {} }, registerVirtualModel() {}, registerCommand() {}, setThinkingLevel() {}, setModel: async (model: any) => { selections.push(model); return false; } };
    installLegacyMigration(pi, () => ({ idleMinutes: 30, contextPercent: 20, guardedModels: aliases }), "/nonexistent/idle-aliases");
    const ctx: any = { model: { provider: "idle-guard", id: "role" }, sessionManager: manager, hasUI: true, ui: { notify() {} }, modelRegistry: { find: (provider: string, id: string) => provider === "codex" && id === "model" ? physical : undefined } };
    await events.session_start({}, ctx); expect(selections).toEqual([physical]); expect(profile.accountId).toBe("work"); expect(ctx.model.provider).toBe("idle-guard");
    events.session_shutdown(); remove?.();
  });
});
