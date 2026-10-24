import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSessionFollower } from "./session-follower.ts";
import { getSessionModelRequestProfile, readInheritedSessionRoutingProfile, registerSessionRouting, resolveSessionPhysicalModelReference, routingProfilePath, writeSessionRoutingProfile, type RoutingProfile } from "../shared/session-routing.ts";

function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "session-follower-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env };
  t.after(() => { for (const key of ["PI_SESSION_ROUTING_FILE", "PI_SESSION_ROUTING_OWNER_SESSION"]) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; } });
  const file = routingProfilePath(dir, "parent");
  process.env.PI_SESSION_ROUTING_FILE = file;
  process.env.PI_SESSION_ROUTING_OWNER_SESSION = "parent";
  const publish = (providerId: string, accountId: string, revision: number) => writeSessionRoutingProfile(file, { version: 1, ownerSessionId: "parent", providerId, accountId, revision });
  publish("openai", "Personal", 0);
  const models = new Map<string, any>(["openai", "openai-codex"].map(provider => [`${provider}/small`, { provider, id: "small", api: "fixture", input: ["text"], contextWindow: 1024, maxTokens: 128 }]));
  const definitions = new Map<string, any>();
  const ctx: any = { model: models.get("openai/small"), sessionManager: { getSessionId: () => "child" }, modelRegistry: { find: (provider: string, id: string) => models.get(`${provider}/${id}`) } };
  let prepared: RoutingProfile | undefined;
  t.after(registerSessionRouting(ctx, { file, getProfile: () => prepared, prepareRequest: async () => (prepared = readInheritedSessionRoutingProfile(ctx)) }));
  const pi: any = {
    registerVirtualModel(def: any) { definitions.set(`${def.provider}/${def.id}`, def); models.set(`${def.provider}/${def.id}`, { ...def, api: "pi-virtual" }); },
    unregisterVirtualModel(provider: string, id: string) { definitions.delete(`${provider}/${id}`); models.delete(`${provider}/${id}`); },
    async setModel(model: any) { ctx.model = model; return true; },
  };
  return { ctx, pi, publish, models, definitions };
}

test("existing helper requests follow both provider directions and named accounts, preserving admitted snapshots", async t => {
  const f = fixture(t), dispose = await installSessionFollower(f.pi, f.ctx);
  t.after(dispose);
  assert.equal(f.ctx.model.provider, "session-follow");
  const router = f.definitions.get("session-follow/small");
  const first = await router.route({ thinkingLevel: "low", reason: "user" }, f.ctx);
  f.publish("openai-codex", "Work", 1);
  const second = await router.route({ thinkingLevel: "low", reason: "continuation" }, f.ctx);
  f.publish("openai-codex", "Personal", 2);
  const third = await router.route({ thinkingLevel: "high", reason: "direct" }, f.ctx);
  f.publish("openai", "Work", 3);
  const fourth = await router.route({ thinkingLevel: "low", reason: "retry" }, f.ctx);
  assert.deepEqual([first, second, third, fourth].map(r => r.model.provider), ["openai", "openai-codex", "openai-codex", "openai"]);
  assert.deepEqual([first, second, third, fourth].map(r => getSessionModelRequestProfile(r.model)!.accountId), ["Personal", "Work", "Personal", "Work"]);
  assert.equal(first.model.id, "small"); assert.equal(third.thinkingLevel, "high");
  assert.equal(getSessionModelRequestProfile(first.model)!.revision, 0);
  assert.equal(JSON.stringify(first.model).includes("Personal"), false);
  assert.equal(JSON.stringify(second.model).includes("Work"), false);
  assert.equal(resolveSessionPhysicalModelReference(f.ctx, getSessionModelRequestProfile(fourth.model)).id, "small");
});

test("missing role model on new provider fails without choosing a different role or provider", async t => {
  const f = fixture(t), dispose = await installSessionFollower(f.pi, f.ctx);
  t.after(dispose);
  f.models.delete("openai-codex/small");
  f.publish("openai-codex", "Work", 1);
  await assert.rejects(f.definitions.get("session-follow/small").route({ thinkingLevel: "low" }, f.ctx), /Unavailable inherited role model: openai-codex\/small/);
});

test("reload preserves the original role ID rather than wrapping an alias as a new role", async t => {
  const f = fixture(t), firstDispose = await installSessionFollower(f.pi, f.ctx);
  firstDispose();
  f.publish("openai-codex", "Work", 1);
  const dispose = await installSessionFollower(f.pi, f.ctx);
  t.after(dispose);
  const routed = await f.definitions.get("session-follow/small").route({ thinkingLevel: "low" }, f.ctx);
  assert.equal(routed.model.provider, "openai-codex");
  assert.equal(routed.model.id, "small");
});
