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
const { createJiti } =
  createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("jiti");
const load = createJiti(import.meta.url);
const accounts = await load.import("../openai-accounts/accounts.ts");
const oauth = await load.import("../openai-accounts/oauth.ts");
const { AccountStore, InMemoryAccountStorageBackend } = accounts;
const {
  readSessionRoutingProfile, routingProfilePath, SESSION_ROUTING_FILE_ENV,
  SESSION_ROUTING_OWNER_ENV,
} = await load.import("../shared/session-routing.ts");
const CODEX = "openai-codex";
const BASE_URL = "https://chatgpt.com/backend-api";
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const usage = {
  input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { ...cost, total: 0 },
};
function codexToken(account = "sdk-codex") {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const claims = {
    sub: "sdk-user", "https://api.openai.com/auth": { chatgpt_account_id: account },
  };
  return `${encode({ alg: "none" })}.${encode(claims)}.fixture`;
}

test("Pi SDK accounts startup preserves retained follower routing",
  { timeout: 20_000 }, async () => {
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
    globalThis.fetch = async () => {
      throw new Error("Live HTTP is forbidden in follower SDK test");
    };
    const store = new AccountStore(new InMemoryAccountStorageBackend());
    await store.updateProvider(CODEX, (state) => ({
      ...state, active: "alpha",
      accounts: { alpha: {
        type: "oauth", access: codexToken("sdk-alpha"), refresh: "fixture-alpha-refresh",
        expires: Date.now() + 86_400_000, accountId: "sdk-alpha",
      } },
    }));
    const authPath = join(root, "auth.json");
    await writeFile(authPath, JSON.stringify({
      [CODEX]: {
        type: "oauth", access: codexToken(), refresh: "fixture-refresh",
        expires: Date.now() + 86_400_000, accountId: "sdk-codex",
      },
    }), { mode: 0o600 });

    const makeSession = async (sessionDir) => {
      await mkdir(sessionDir, { recursive: true });
      const runtime = await ModelRuntime.create({
        authPath, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
      });
      const settings = SettingsManager.inMemory({
        defaultProvider: CODEX, defaultModel: "gpt-6-astra",
        compaction: { enabled: false }, retry: { enabled: false },
      });
      const providerFactory = (pi) => {
        pi.registerProvider(CODEX, codexProvider);
        accounts.default(pi, { store, providers: oauth.createBuiltinProviderAdapters() });
      };
      const codexProvider = {
        name: "SDK fixture Codex", api: "openai-codex-responses", baseUrl: BASE_URL,
        models: [{
          id: "gpt-6-astra", name: "SDK fixture role", api: "openai-codex-responses",
          baseUrl: BASE_URL, input: ["text"], contextWindow: 32_000, maxTokens: 4096, cost,
        }],
        streamSimple(model, _context, options = {}) {
          const stream = createAssistantMessageEventStream();
          const base = { role: "assistant", api: model.api, provider: CODEX, model: model.id };
          queueMicrotask(async () => {
            try {
              await options.onPayload?.({ model: model.id }, model);
              calls.push({ provider: CODEX, model: model.id, apiKey: options.apiKey });
              stream.end({
                ...base, content: [{ type: "text", text: "inherited SDK answer" }],
                stopReason: "stop", timestamp: Date.now(), usage,
              });
            } catch (error) {
              stream.end({
                ...base, content: [], stopReason: "error", timestamp: Date.now(), usage,
                errorMessage: error instanceof Error ? error.message : "blocked",
              });
            }
          });
          return stream;
        },
      };
      // Like the CLI, the physical provider exists before session events are bound.
      runtime.registerProvider(CODEX, codexProvider);
      const loader = new DefaultResourceLoader({
        cwd: sessionDir, agentDir: root, settingsManager: settings, noExtensions: true,
        noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [providerFactory],
      });
      await loader.reload();
      const { session } = await createAgentSession({
        cwd: sessionDir, agentDir: root, modelRuntime: runtime, settingsManager: settings,
        resourceLoader: loader, sessionManager: SessionManager.inMemory(sessionDir),
        noTools: "builtin",
      });
      const roleModel = runtime.getModel(CODEX, "gpt-6-astra");
      assert.ok(roleModel, "fixture role model exists in the actual SDK ModelRuntime");
      await session.setModel(roleModel);
      const services = {
        cwd: sessionDir, agentDir: root, modelRuntime: runtime, settingsManager: settings,
        resourceLoader: loader, diagnostics: [],
      };
      const owner = new AgentSessionRuntime(session, services, async () => {
        throw new Error("Unexpected session replacement");
      });
      const errors = [];
      await session.bindExtensions({ onError: (error) => errors.push(error) });
      assert.deepEqual(errors, []);
      return { session, owner, runtime, loader };
    };

    try {
      rootBundle = await makeSession(root);
      const rootSessionId = rootBundle.session.sessionManager.getSessionId();
      const parentModel = rootBundle.session.model;
      assert.equal(parentModel.provider, CODEX);
      const routeFile = routingProfilePath(root, rootSessionId);
      assert.equal(readSessionRoutingProfile(routeFile, rootSessionId).providerId, CODEX,
        "account startup retains the physical role provider");
      const snapshot = await globalThis.__paeAccountControlsV1.getSnapshot({
        sessionId: rootSessionId, providerId: CODEX,
      });
      assert.equal("sessionRouting" in snapshot, false);
      process.env[SESSION_ROUTING_FILE_ENV] = routeFile;
      process.env[SESSION_ROUTING_OWNER_ENV] = rootSessionId;
      childBundle = await makeSession(join(root, "child"));
      assert.equal(childBundle.session.model.provider, CODEX);
      assert.equal(childBundle.session.model.id, "gpt-6-astra");
      const childResult = await childBundle.session.prompt("Answer using the inherited account.");
      assert.equal(childBundle.session.model.provider, CODEX);
      assert.equal(rootBundle.session.model, parentModel,
        "helper routing must not change the parent's selected model");
      const alpha = codexToken("sdk-alpha");
      assert.ok(calls.some((call) => call.model === "gpt-6-astra" && call.apiKey === alpha),
        JSON.stringify(calls));
      assert.equal(JSON.stringify(childResult ?? {}).includes(alpha), false);
      const childEntries = JSON.stringify(childBundle.session.sessionManager.getEntries());
      assert.equal(childEntries.includes(alpha), false);
      const childRuntime = childBundle.runtime;
      await childBundle.owner.dispose();
      childBundle = undefined;
      assert.equal(childRuntime.getModel("session-follow", "gpt-6-astra"), undefined,
        "shutdown removes child-local follower registration");
    } finally {
      if (childBundle) { await childBundle.owner.dispose(); childBundle = undefined; }
      if (rootBundle) { await rootBundle.owner.dispose(); rootBundle = undefined; }
      globalThis.fetch = oldFetch;
      const restore = (key, value) => {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      };
      restore("PI_CODING_AGENT_DIR", oldDir);
      restore(SESSION_ROUTING_FILE_ENV, oldFile);
      restore(SESSION_ROUTING_OWNER_ENV, oldOwner);
      await rm(root, { recursive: true, force: true });
    }
  });
