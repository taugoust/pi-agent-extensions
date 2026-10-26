import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createAgentSession, AgentSessionRuntime, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
const { createJiti } = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("jiti");
const load = createJiti(import.meta.url, { fsCache: false });
const { default: accounts } = await load.import("../openai-accounts/accounts.ts");
const oauth = await load.import("../openai-accounts/oauth.ts");
const { AccountStore, InMemoryAccountStorageBackend } = await load.import("../openai-accounts/account-store.ts");
const { registerGuard } = await load.import("../idle-context-warning/guard.ts");
const { registerCompaction } = await load.import("../idle-context-warning/compaction.ts");
const routing = await load.import("../shared/session-routing.ts");
const token = (id) => `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: id, "https://api.openai.com/auth": { chatgpt_account_id: id } })).toString("base64url")}.fixture`;

test("actual AgentSession startup order and retained follower use coherent provider/account snapshots", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "routing-sdk-"));
  const saved = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_SESSION_ROUTING_FILE", "PI_SESSION_ROUTING_OWNER_SESSION"].map(k => [k, process.env[k]]));
  const oldFetch = globalThis.fetch, owners = [], calls = [], errors = [];
  let network = 0, release, started;
  const held = new Promise(resolve => { release = resolve; });
  const dispatched = new Promise(resolve => { started = resolve; });
  process.env.PI_CODING_AGENT_DIR = root;
  delete process.env.PI_SESSION_ROUTING_FILE; delete process.env.PI_SESSION_ROUTING_OWNER_SESSION;
  globalThis.fetch = async () => { network++; throw new Error("Live HTTP forbidden in routing SDK test"); };
  try {
    const personal = token("personal"), work = token("work");
    await writeFile(join(root, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fixture-default" }, "openai-codex": { type: "oauth", access: personal, refresh: "fixture-personal-refresh", expires: Date.now() + 86400000, accountId: "personal" } }), { mode: 0o600 });
    const store = new AccountStore(new InMemoryAccountStorageBackend());
    await store.updateProvider("openai", state => ({ ...state, active: "Alpha", accounts: { Alpha: { type: "api_key", key: "fixture-alpha" } } }));
    await store.updateProvider("openai-codex", state => ({ ...state, accounts: { Work: { type: "oauth", access: work, refresh: "fixture-work-refresh", expires: Date.now() + 86400000, accountId: "work" } } }));
    const settings = { idleMinutes: 30, contextPercent: 20, guardedModels: { astra: "openai/main-fixture" }, cheapCompactionModel: "small-fixture:low" };
    const text = context => context.messages.filter(m => m.role === "user").at(-1)?.content;
    const factory = refs => pi => {
      for (const provider of ["openai", "openai-codex"]) pi.registerProvider(provider, {
        api: provider === "openai" ? "openai-responses" : "openai-codex-responses",
        baseUrl: provider === "openai" ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api",
        models: ["main-fixture", "small-fixture"].map(id => ({ id, name: id, reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
        streamSimple(model, context, options) {
          const stream = createAssistantMessageEventStream();
          queueMicrotask(async () => {
            try {
              await options?.onPayload?.({ fixture: true }, model);
              calls.push({ provider: model.provider, model: model.id, key: options.apiKey });
              if (model.id === "small-fixture" && JSON.stringify(text(context)).includes("hold")) { started(); await held; }
              const message = { role: "assistant", provider: model.provider, api: model.api, model: model.id, content: [{ type: "text", text: "offline answer" }], stopReason: "stop", timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
              stream.push({ type: "done", reason: "stop", message }); stream.end();
            } catch (error) { stream.push({ type: "error", reason: "error", error: { role: "assistant", provider: model.provider, api: model.api, model: model.id, content: [], stopReason: "error", errorMessage: String(error), timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }); stream.end(); }
          });
          return stream;
        },
      });
      pi.on("session_start", (_e, ctx) => { refs.ctx = ctx; });
    };
    async function session(child = false) {
      const refs = {};
      const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
      // Like the CLI, select an explicit model before binding session events.
      // SDK sessions with caller-supplied runtimes do not infer a late factory's model.
      factory({})({ registerProvider: (provider, definition) => runtime.registerProvider(provider, definition), on() {} });
      if (!child) runtime.registerVirtualModel({ provider: "idle-guard", id: "astra", name: "Bootstrap guard", thinkingLevels: ["low"], route() { throw new Error("Guard registration must replace bootstrap before dispatch"); } });
      const config = SettingsManager.inMemory({ defaultProvider: child ? "openai" : "idle-guard", defaultModel: child ? "small-fixture" : "astra", defaultThinkingLevel: "low", compaction: { enabled: false }, retry: { enabled: false } });
      const factories = [factory(refs), pi => accounts(pi, { store, providers: oauth.createBuiltinProviderAdapters() })];
      // Deliberately load Accounts BEFORE Guard: bootstrap cannot rely on session_start order.
      if (!child) factories.push(pi => { const guard = registerGuard(pi, () => settings, { tombstonePath: join(root, "aliases.json") }); registerCompaction(pi, () => settings, guard.compactionProof); });
      const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: config, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: factories });
      await loader.reload();
      const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, settingsManager: config, resourceLoader: loader, sessionManager: SessionManager.inMemory(root), noTools: "builtin" });
      const initial = runtime.getModel(child ? "openai" : "idle-guard", child ? "small-fixture" : "astra");
      assert.ok(initial, "explicit fixture model is available before session binding");
      await session.setModel(initial);
      const owner = new AgentSessionRuntime(session, { cwd: root, agentDir: root, modelRuntime: runtime, settingsManager: config, resourceLoader: loader, diagnostics: [] }, async () => { throw new Error("No replacement requested"); });
      owners.push(owner);
      await session.bindExtensions({ onError: error => errors.push(error) });
      return { session, owner, ctx: refs.ctx, controls: globalThis.__paeAccountControlsV1 };
    }
    const parent = await session();
    assert.equal(parent.session.model.provider, "idle-guard");
    assert.equal(routing.getSessionRoutingProfile(parent.ctx).providerId, "openai");
    await parent.session.prompt("warm");
    assert.equal(calls.at(-1).key, "fixture-alpha");
    const rootId = parent.session.sessionManager.getSessionId();
    process.env.PI_SESSION_ROUTING_FILE = routing.routingProfilePath(root, rootId);
    process.env.PI_SESSION_ROUTING_OWNER_SESSION = rootId;
    const child = await session(true);
    assert.equal(child.session.model.provider, "openai");
    const pending = child.session.prompt("hold");
    await dispatched;
    async function select(providerId, accountId) {
      // Real workers live in separate Pi processes. Temporarily select the
      // parent's service slot to model that process-local singleton faithfully.
      const active = globalThis.__paeAccountControlsV1;
      globalThis.__paeAccountControlsV1 = parent.controls;
      try {
        const snapshot = await parent.controls.getSnapshot({ sessionId: rootId, providerId });
        const result = await parent.controls.switchAccount({ protocol: 1, providerId, requestId: randomUUID(), expectedSessionId: rootId, expectedServiceEpoch: snapshot.serviceEpoch, expectedSelectionRevision: snapshot.selectionRevision, expectedRoutingRevision: snapshot.sessionRouting.revision, accountId });
        assert.equal(result.ok, true, JSON.stringify(result));
      } finally { globalThis.__paeAccountControlsV1 = active; }
    }
    await select("openai-codex", "Work");
    release(); await pending;
    assert.equal(calls.at(-1).key, "fixture-alpha", "already dispatched child request retained its old account");
    const childService = globalThis.__paeAccountControlsV1;
    globalThis.__paeAccountControlsV1 = parent.controls;
    try { await parent.session.prompt("still warm after account/provider switch"); }
    finally { globalThis.__paeAccountControlsV1 = childService; }
    assert.notEqual(parent.session.messages.at(-1)?.stopReason, "error", JSON.stringify(parent.session.messages.at(-1)));
    assert.equal(calls.at(-1).provider, "openai-codex"); assert.equal(calls.at(-1).key, work);
    await child.session.prompt("next");
    assert.equal(calls.at(-1).model, "small-fixture"); assert.equal(calls.at(-1).provider, "openai-codex"); assert.equal(calls.at(-1).key, work);
    await select("openai-codex", null);
    await child.session.prompt("default account");
    assert.equal(calls.at(-1).key, personal);
    await select("openai", "Alpha");
    await child.session.prompt("reverse provider");
    assert.equal(calls.at(-1).provider, "openai"); assert.equal(calls.at(-1).key, "fixture-alpha");
    await parent.owner.dispose(); owners.splice(owners.indexOf(parent.owner), 1);
    await child.session.prompt("retained after parent exits");
    assert.equal(calls.at(-1).key, "fixture-alpha");
    assert.deepEqual(errors, []); assert.equal(network, 0);
  } finally {
    release();
    for (const owner of owners.reverse()) await owner.dispose();
    globalThis.fetch = oldFetch;
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
});
