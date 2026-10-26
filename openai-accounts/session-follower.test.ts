import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSessionFollower } from "./session-follower.ts";
import { readInheritedSessionRoutingProfile, registerSessionRouting, routingProfilePath, writeInheritedSessionRoutingProfile, writeSessionRoutingProfile } from "../shared/session-routing.ts";

function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "session-native-routing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env };
  t.after(() => { for (const key of ["PI_SESSION_ROUTING_FILE", "PI_SESSION_ROUTING_OWNER_SESSION"]) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; } });
  const file = routingProfilePath(dir, "parent"), local = routingProfilePath(dir, "child");
  process.env.PI_SESSION_ROUTING_FILE = file;
  process.env.PI_SESSION_ROUTING_OWNER_SESSION = "parent";
  const publish = (providerId: string, revision: number) => writeSessionRoutingProfile(file, { version: 1, ownerSessionId: "parent", providerId, accountId: "fixture", revision });
  publish("openai", 0);
  writeInheritedSessionRoutingProfile(local, "child", { PI_SESSION_ROUTING_FILE: file, PI_SESSION_ROUTING_OWNER_SESSION: "parent" });
  const models = new Map<string, any>(["openai", "openai-codex"].map(provider => [`${provider}/small`, { provider, id: "small", api: "fixture" }]));
  const ctx: any = { model: models.get("openai/small"), sessionManager: { getSessionId: () => "child" }, modelRegistry: { find: (provider: string, id: string) => models.get(`${provider}/${id}`) } };
  t.after(registerSessionRouting(ctx, { file: local, getProfile: () => readInheritedSessionRoutingProfile(ctx), prepareRequest: async () => readInheritedSessionRoutingProfile(ctx) }));
  const pi: any = {
    registerVirtualModel() { assert.fail("native inheritance must not register virtual models"); },
    async setModel() { assert.fail("inheritance must not replace the session's native identity"); },
  };
  return { ctx, pi, publish, models };
}

test("inheritance and reload retain native role/provider identity without a virtual model", async t => {
  const f = fixture(t), original = f.ctx.model;
  (await installSessionFollower(f.pi, f.ctx))();
  f.publish("openai-codex", 1);
  (await installSessionFollower(f.pi, f.ctx))();
  assert.equal(f.ctx.model, original);
  assert.equal(f.ctx.model.provider, "openai");
  assert.equal(f.ctx.model.id, "small");
});

test("missing inherited physical role and virtual roles fail closed", async t => {
  const f = fixture(t);
  f.publish("openai-codex", 1);
  f.models.delete("openai-codex/small");
  await assert.rejects(installSessionFollower(f.pi, f.ctx), /unavailable/);
  f.ctx.model = { provider: "virtual", id: "small", api: "pi-virtual" };
  await assert.rejects(installSessionFollower(f.pi, f.ctx), /native physical role/);
});
