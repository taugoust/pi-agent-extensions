import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
const { createJiti } = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("jiti");
const load = createJiti(import.meta.url);
const { createBtwService } = await load.import("./service.ts");
const { resolveBtwDispatchModel } = await load.import("./candidate/btw.ts");
const { registerSessionRouting, registerSessionModelReference, prepareSessionRoutingRequest, getSessionModelRequestProfile } = await import("../shared/session-routing.ts");
const model = (provider, id = "role", api = "test-api") => ({ provider, id, api, name: id, contextWindow: 8192, maxTokens: 1024, input: ["text"], output: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
function setup({ provider = "alpha", account = "Named-A", models = [model("alpha"), model("beta")] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "btw-routing-test-"));
  const profile = { version: 1, ownerSessionId: randomUUID(), providerId: provider, accountId: account, revision: 1 };
  const sessionManager = { getSessionId: () => profile.ownerSessionId, getBranch: () => [] };
  const dispatches = [], prepared = [];
  const ctx = { model: model(provider), sessionManager, modelRegistry: {
    getAvailable: () => models,
    find: (p, id) => models.find(m => m.provider === p && m.id === id),
    streamSimple: selected => {
      dispatches.push({ provider: selected.provider, id: selected.id, binding: getSessionModelRequestProfile(selected) });
      const response = { role: "assistant", api: selected.api, provider: selected.provider, model: selected.id, content: [{ type: "text", text: "ok" }], stopReason: "stop", timestamp: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      return { async *[Symbol.asyncIterator]() {}, result: async () => response };
    },
  } };
  const dispose = registerSessionRouting(ctx, { file: join(dir, "descriptor.json"), getProfile: () => profile, prepareRequest: async () => { prepared.push({ providerId: profile.providerId, accountId: profile.accountId, revision: profile.revision }); return { ...profile }; } });
  return { ctx, profile, dispatches, prepared, dispose: () => { dispose(); rmSync(dir, { recursive: true, force: true }); } };
}
test("Paseo service rebinds existing-thread follow-ups across providers and named account changes", async () => {
  const { ctx, profile, dispatches, prepared, dispose } = setup();
  try {
    const service = createBtwService(ctx, "alpha/role");
    const request = (operation, threadId, fields = {}) => service.handle({ operation, sessionId: service.sessionId, serviceEpoch: service.serviceEpoch, ...(operation === "snapshot" ? {} : { requestId: randomUUID() }), threadId, ...fields });
    const id = randomUUID();
    request("start", id, { question: "first", model: "alpha/role", context: "none" });
    await new Promise(r => setTimeout(r, 10));
    profile.providerId = "beta"; ctx.model = model("beta"); profile.accountId = "Named-B"; profile.revision++;
    const currentSnapshot = request("snapshot", id);
    assert.equal(currentSnapshot.threads[0].model, "beta/role");
    assert.ok(currentSnapshot.models.includes("beta/role"));
    const newId = randomUUID();
    request("start", newId, { question: "new provider thread", model: "beta/role", context: "none" });
    await new Promise(r => setTimeout(r, 10));
    request("send", id, { question: "follow-up" }); await new Promise(r => setTimeout(r, 10));
    profile.accountId = "Named-C"; profile.revision++;
    request("send", id, { question: "account-only change" }); await new Promise(r => setTimeout(r, 10));
    profile.providerId = "alpha"; ctx.model = model("alpha"); profile.revision++;
    request("send", id, { question: "reverse provider" }); await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(dispatches.map(d => d.provider), ["alpha", "beta", "beta", "beta", "alpha"]);
    assert.deepEqual(dispatches.map(d => d.binding?.accountId), ["Named-A", "Named-B", "Named-B", "Named-C", "Named-C"]);
    assert.deepEqual(prepared.map(p => p.accountId), ["Named-A", "Named-B", "Named-B", "Named-C", "Named-C"]);
    service.dispose();
  } finally { dispose(); }
});
test("terminal BTW resolves guarded default physically, preserves override ID, and fails unavailable model without fallback", () => {
  const { ctx, profile, dispose } = setup({ provider: "idle-guard", models: [model("alpha", "physical-role"), model("beta", "physical-role"), model("beta", "override")] });
  try {
    ctx.model = model("idle-guard", "guard-alias", "pi-virtual");
    const unregister = registerSessionModelReference(ctx, () => ({ provider: "alpha", id: "physical-role" }));
    try {
      profile.providerId = "beta";
      const boundDefault = resolveBtwDispatchModel(ctx, { model: ctx.model }, profile);
      assert.equal(boundDefault.provider, "beta");
      assert.equal(getSessionModelRequestProfile(boundDefault)?.accountId, profile.accountId);
      const override = resolveBtwDispatchModel(ctx, { model: model("alpha", "override") }, profile);
      assert.equal(override.id, "override"); assert.equal(override.provider, "beta");
      profile.providerId = "gamma";
      assert.throws(() => resolveBtwDispatchModel(ctx, { model: ctx.model }, profile), /unavailable.*no fallback/i);
    } finally { unregister(); }
  } finally { dispose(); }
});
test("a dispatch keeps its captured provider/account profile when routing changes in flight", async () => {
  const { ctx, profile, dispose } = setup();
  try {
    const captured = await prepareSessionRoutingRequest(ctx);
    profile.providerId = "beta"; profile.accountId = "Named-B"; profile.revision++;
    const selector = (await import("../shared/session-routing.ts")).resolveSessionModelSelector(ctx, "alpha/role", captured);
    assert.equal(selector, "alpha/role");
    assert.equal(captured.accountId, "Named-A");
  } finally { dispose(); }
});
