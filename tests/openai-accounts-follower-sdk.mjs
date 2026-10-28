import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  createAgentSession, AgentSessionRuntime, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
const { createJiti } = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("jiti");
const accounts = await createJiti(import.meta.url).import("../openai-accounts/accounts.ts");
const oauth = await createJiti(import.meta.url).import("../openai-accounts/oauth.ts");
const { installLegacyMigration } = await createJiti(import.meta.url).import("../idle-context-warning/migration.ts");
const { AccountStore, InMemoryAccountStorageBackend } = accounts;
const { routingProfilePath, SESSION_ROUTING_FILE_ENV, SESSION_ROUTING_OWNER_ENV } = await createJiti(import.meta.url).import("../shared/session-routing.ts");
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { ...cost, total: 0 } };
function codexToken() {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ sub: "sdk-user", "https://api.openai.com/auth": { chatgpt_account_id: "sdk-codex" } })}.fixture`;
}

test("actual Pi SDK accounts startup preserves retained follower routing and legacy alias migration", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pae-account-follower-sdk-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldFile = process.env[SESSION_ROUTING_FILE_ENV];
  const oldOwner = process.env[SESSION_ROUTING_OWNER_ENV];
  const oldFetch = globalThis.fetch;
  const calls = [];
  let rootBundle, childBundle;
  process.env.PI_CODING_AGENT_DIR = root;
  delete process.env[SESSION_ROUTING_FILE_ENV];
  delete process.env[SESSION_ROUTING_OWNER_ENV];
  globalThis.fetch = async () => { throw new Error("Live HTTP is forbidden in follower SDK test"); };
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.updateProvider("openai", (state) => ({ ...state, accounts: { alpha: { type: "api_key", key: "fixture-sdk-alpha" } } }));
  const authPath = join(root, "auth.json");
  await writeFile(authPath, JSON.stringify({ "openai-codex": { type: "oauth", access: codexToken(), refresh: "fixture-refresh", expires: Date.now() + 86_400_000, accountId: "sdk-codex" } }), { mode: 0o600 });

  const makeSession = async (sessionDir, { guardedRoot = false } = {}) => {
    await mkdir(sessionDir, { recursive: true });
    const runtime = await ModelRuntime.create({ authPath, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    if (guardedRoot) runtime.registerVirtualModel({
      provider: "idle-guard", id: "astra", name: "Legacy idle alias", thinkingLevels: ["low", "medium", "high"],
      input: ["text"], contextWindow: 32_000, maxTokens: 4096,
      route() { throw new Error("Legacy aliases are closed until current migration resolves them"); },
    });
    const settings = SettingsManager.inMemory({ defaultProvider: "openai", defaultModel: "gpt-6-astra", compaction: { enabled: false }, retry: { enabled: false } });
    const providerFactory = (pi) => {
      pi.registerProvider("openai", {
        name: "SDK fixture OpenAI", api: "openai-responses", apiKey: "fixture-default", baseUrl: "https://configured.example/v1",
        models: [{ id: "gpt-6-astra", name: "SDK fixture role", api: "openai-responses", input: ["text"], contextWindow: 32_000, maxTokens: 4096, cost }],
        streamSimple(model, _context, options = {}) {
          const stream = createAssistantMessageEventStream();
          queueMicrotask(async () => {
            try {
              await options.onPayload?.({ model: model.id }, model);
              calls.push({ provider: "openai", model: model.id, apiKey: options.apiKey });
              stream.end({ role: "assistant", api: "openai-responses", provider: "openai", model: model.id, content: [{ type: "text", text: "inherited SDK answer" }], stopReason: "stop", timestamp: Date.now(), usage });
            } catch (error) {
              stream.end({ role: "assistant", api: "openai-responses", provider: "openai", model: model.id, content: [], stopReason: "error", errorMessage: error instanceof Error ? error.message : "blocked", timestamp: Date.now(), usage });
            }
          });
          return stream;
        },
      });
      pi.registerProvider("openai-codex", {
        name: "SDK fixture Codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api",
        models: [{ id: "sdk-codex-model", name: "SDK Codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api", input: ["text"], contextWindow: 32_000, maxTokens: 4096, cost }],
        streamSimple() { throw new Error("Codex stream was not expected in this test"); },
      });
      accounts.default(pi, { store, providers: oauth.createBuiltinProviderAdapters() });
      installLegacyMigration(pi, () => ({ idleMinutes: 30, contextPercent: 20, guardedModels: { astra: "openai/gpt-6-astra" } }), join(sessionDir, "legacy-aliases.json"));
    };
    const loader = new DefaultResourceLoader({
      cwd: sessionDir, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [providerFactory],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: sessionDir, agentDir: root, modelRuntime: runtime, settingsManager: settings, resourceLoader: loader,
      sessionManager: SessionManager.inMemory(sessionDir), noTools: "builtin",
    });
    if (guardedRoot) {
      const alias = runtime.getModel("idle-guard", "astra");
      assert.ok(alias, "closed migration sentinel exists before session binding");
      await session.setModel(alias);
    } else {
      const roleModel = runtime.getModel("openai", "gpt-6-astra");
      assert.ok(roleModel, "fixture role model exists in the actual SDK ModelRuntime");
      await session.setModel(roleModel);
    }
    const services = { cwd: sessionDir, agentDir: root, modelRuntime: runtime, settingsManager: settings, resourceLoader: loader, diagnostics: [] };
    const owner = new AgentSessionRuntime(session, services, async () => { throw new Error("Unexpected session replacement"); });
    const errors = [];
    await session.bindExtensions({ onError: (error) => errors.push(error) });
    assert.deepEqual(errors, []);
    return { session, owner, runtime, loader };
  };

  try {
    rootBundle = await makeSession(root, { guardedRoot: true });
    const rootSessionId = rootBundle.session.sessionManager.getSessionId();
    const parentModel = rootBundle.session.model;
    assert.equal(parentModel.provider, "openai");
    const routeSnapshot = await globalThis.__paeAccountControlsV1.getSnapshot({ sessionId: rootSessionId, providerId: "openai" });
    assert.equal(routeSnapshot.sessionRouting.providerId, "openai", "account startup retains the physical role provider");
    process.env[SESSION_ROUTING_FILE_ENV] = routingProfilePath(root, rootSessionId);
    process.env[SESSION_ROUTING_OWNER_ENV] = rootSessionId;
    childBundle = await makeSession(join(root, "child"));
    assert.equal(childBundle.session.model.provider, "openai");
    assert.equal(childBundle.session.model.id, "gpt-6-astra");
    const childResult = await childBundle.session.prompt("Answer using the inherited account.");
    assert.equal(childBundle.session.model.provider, "openai");
    assert.equal(rootBundle.session.model, parentModel, "helper routing must not change the parent's selected model");
    assert.ok(calls.some((call) => call.provider === "openai" && call.model === "gpt-6-astra" && call.apiKey === "fixture-default"), JSON.stringify(calls));
    assert.doesNotMatch(JSON.stringify(childResult ?? {}), /fixture-sdk-alpha/);
    assert.equal(JSON.stringify(childBundle.session.sessionManager.getEntries()).includes("fixture-sdk-alpha"), false);
    const childRuntime = childBundle.runtime;
    await childBundle.owner.dispose();
    childBundle = undefined;
    assert.equal(childRuntime.getModel("session-follow", "gpt-6-astra"), undefined, "shutdown removes child-local follower registration");
  } finally {
    if (childBundle) { await childBundle.owner.dispose(); childBundle = undefined; }
    if (rootBundle) { await rootBundle.owner.dispose(); rootBundle = undefined; }
    globalThis.fetch = oldFetch;
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
    if (oldFile === undefined) delete process.env[SESSION_ROUTING_FILE_ENV]; else process.env[SESSION_ROUTING_FILE_ENV] = oldFile;
    if (oldOwner === undefined) delete process.env[SESSION_ROUTING_OWNER_ENV]; else process.env[SESSION_ROUTING_OWNER_ENV] = oldOwner;
    await rm(root, { recursive: true, force: true });
  }
});
