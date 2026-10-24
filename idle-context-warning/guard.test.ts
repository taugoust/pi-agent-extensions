import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertGuardProofCurrent, registerGuard } from "./guard.ts";
import { getConfiguredSessionModelReference, notifySessionRoutingChanged, onSessionRoutingChanged, registerSessionRouting, resolveSessionPhysicalModelReference } from "../shared/session-routing.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("guard session routing", () => {
  it("refreshes proxy context limits and invalidates proofs only for the changed session", () => {
    const dir = mkdtempSync(join(tmpdir(), "idle-guard-routing-")); dirs.push(dir);
    const models: Record<string, any> = {
      "openai/model": { provider: "openai", id: "model", api: "openai", contextWindow: 1_000_000, maxTokens: 20_000, input: ["text"] },
      "codex/model": { provider: "codex", id: "model", api: "codex", contextWindow: 128_000, maxTokens: 8_000, input: ["text"] },
    };
    const settings = () => ({ idleMinutes: 30, contextPercent: 20, guardedModels: { role: "openai/model" } });
    const providers: any[] = [];
    const events: Record<string, Function[]> = {};
    const pi: any = {
      registerProvider: (_id: string, provider: any) => providers.push(provider),
      registerVirtualModel() {}, on: (name: string, callback: Function) => { (events[name] ??= []).push(callback); },
      appendEntry() {}, registerCommand() {}, sendMessage() {},
    };
    let profile: any = { version: 1, ownerSessionId: "s1", providerId: "openai", accountId: "a", revision: 1 };
    const manager: any = { getSessionId: () => "s1", getBranch: () => [], getLeafId: () => null };
    registerSessionRouting({ sessionManager: manager }, { file: join(dir, "profile.json"), getProfile: () => profile });
    const ctx: any = { model: { provider: "idle-guard", id: "role" }, sessionManager: manager, modelRegistry: { find: (provider: string, id: string) => models[`${provider}/${id}`] }, hasPendingMessages: () => false, isIdle: () => true };
    const api = registerGuard(pi, settings, { tombstonePath: join(dir, "tombstones.json") });
    for (const handler of events.session_start) handler({}, ctx);
    const proof = api.compactionProof(ctx)!;
    expect(getConfiguredSessionModelReference(ctx)).toEqual({ provider: "openai", id: "model" });
    expect(resolveSessionPhysicalModelReference(ctx)).toEqual({ provider: "openai", id: "model" });
    expect(providers.at(-1).models[0].contextWindow).toBe(1_000_000);

    profile = { ...profile, providerId: "codex", accountId: "b", revision: 2 };
    notifySessionRoutingChanged({ sessionManager: manager });
    expect(providers.at(-1).models[0].contextWindow).toBe(128_000);
    expect(resolveSessionPhysicalModelReference(ctx)).toEqual({ provider: "codex", id: "model" });
    expect(() => assertGuardProofCurrent(proof)).toThrow(/stale compaction attempt/);

    const otherManager: any = { getSessionId: () => "s2", getBranch: () => [], getLeafId: () => null };
    registerSessionRouting({ sessionManager: otherManager }, { file: join(dir, "other.json"), getProfile: () => ({ ...profile, ownerSessionId: "s2", providerId: "openai", accountId: "x", revision: 1 }) });
    let unrelatedChanges = 0;
    onSessionRoutingChanged({ sessionManager: otherManager }, () => { unrelatedChanges++; });
    notifySessionRoutingChanged({ sessionManager: manager });
    expect(unrelatedChanges).toBe(0);
    expect(() => assertGuardProofCurrent(proof)).toThrow(/stale compaction attempt/);
  });
});
