import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import { ModelRuntime } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js";
import { ModelRegistry } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.js";
import { createAssistantMessageEventStream } from "../node_modules/@earendil-works/pi-ai/dist/index.js";

const accountModule = await createJiti(import.meta.url).import("../openai-accounts/accounts.ts");
const verificationModule = await createJiti(import.meta.url).import("../openai-accounts/model-auth-verification.ts");
const oauthModule = await createJiti(import.meta.url).import("../openai-accounts/oauth.ts");
const usageModule = await createJiti(import.meta.url).import("../openai-usage/index.ts");
const compactionModule = await createJiti(import.meta.url).import("../idle-context-warning/compaction.ts");
const guardModule = await createJiti(import.meta.url).import("../idle-context-warning/guard.ts");
const { AccountStore, InMemoryAccountStorageBackend } = accountModule;
const { createBtwService } = await createJiti(import.meta.url).import("../btw/service.ts");

function jwtToken(accountId, subject) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ sub: subject, "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.fixture-signature`;
}

test("Codex binding verification rejects custom origins and conflicting model Authorization", async () => {
  const model = { id: "fixture-codex", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" };
  const ctx = { modelRegistry: { getAll: () => [model], getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture-selected-codex", baseUrl: model.baseUrl, headers: { Authorization: "Bearer fixture-override" } }) } };
  const adapter = { id: "openai-codex", displayName: "OpenAI Codex" };
  await assert.rejects(verificationModule.verifyModelApiKeyAuth(ctx, adapter, "fixture-selected-codex", new AbortController().signal), /conflicting authentication header/);
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "fixture-selected-codex", baseUrl: "https://attacker.invalid/codex", headers: {} });
  await assert.rejects(verificationModule.verifyModelApiKeyAuth(ctx, adapter, "fixture-selected-codex", new AbortController().signal), /official ChatGPT origin/);
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "fixture-selected-codex", baseUrl: model.baseUrl, headers: {} });
  await verificationModule.verifyModelApiKeyAuth(ctx, adapter, "fixture-selected-codex", new AbortController().signal);
});

test("BTW inherits the parent named account and blocks switching during a real registry side stream", async () => {
  const { randomUUID } = await import("node:crypto");
  const f = await fixture();
  let btw, pause;
  try {
    const selected = await switchRequest(f, "alpha", randomUUID());
    assert.equal(selected.ok, true);
    const mainModel = f.ctx.model, branch = structuredClone(f.branch);
    btw = createBtwService(f.ctx);
    pause = f.pauseProvider();
    const threadId = randomUUID();
    btw.handle({ operation: "start", requestId: randomUUID(), threadId, sessionId: btw.sessionId, serviceEpoch: btw.serviceEpoch,
      model: "openai/gpt-6-luna", question: "Side question", context: "recent" });
    await pause.started;
    const busy = await f.service.getSnapshot({ sessionId: f.sessionId });
    assert.equal(busy.busy, true);
    const switched = await switchRequest(f, "beta", randomUUID(), busy.selectionRevision);
    assert.equal(switched.ok, false); assert.equal(switched.reason, "busy");
    pause.release();
    await new Promise(resolve => setImmediate(resolve));
    const snapshot = btw.handle({ operation: "snapshot", sessionId: btw.sessionId, serviceEpoch: btw.serviceEpoch, threadId });
    assert.equal(snapshot.threads[0].state, "idle");
    assert.equal(f.delegated.at(-1).id, "gpt-6-luna");
    assert.equal(f.delegated.at(-1).apiKey, "fixture-secret-alpha");
    assert.equal(f.ctx.model, mainModel); assert.deepEqual(f.branch, branch);
    assert.equal(JSON.stringify(snapshot).includes("fixture-secret"), false);
  } finally { pause?.release(); btw?.dispose(); await dispose(f); }
});

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "pae-openai-runtime-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const codexPersonalToken = jwtToken("personal-account", "personal-subject");
  const authPath = join(root, "auth.json");
  const authData = options.codexPersonalAuth === false ? {} : { "openai-codex": { type: "oauth", access: codexPersonalToken, refresh: "fixture-personal-refresh", expires: Date.now() + 86_400_000, accountId: "personal-account" } };
  await writeFile(authPath, JSON.stringify(authData), { mode: 0o600 });
  await chmod(authPath, 0o600);
  const runtime = await ModelRuntime.create({
    authPath, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  const delegated = [];
  const codexDelegated = [];
  const providerErrors = [];
  let holdProvider = false;
  let providerStarted;
  let releaseProvider;
  let providerStartedPromise;
  let providerGate;
  let providerPayload = false;
  let authPause;
  const resolveAuth = registry.getApiKeyAndHeaders.bind(registry);
  registry.getApiKeyAndHeaders = async (model) => {
    const result = await resolveAuth(model);
    if (providerPayload && authPause) {
      const pause = authPause;
      authPause = undefined;
      pause.entered();
      await pause.gate;
    }
    return result;
  };
  const answer = (model) => ({
    role: "assistant", api: "openai-responses", provider: "openai", model: model.id,
    timestamp: Date.now(), stopReason: "stop", content: [{ type: "text", text: "safe summary" }],
    usage: { input: 8, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const stream = (model, _context, options = {}) => {
    const result = createAssistantMessageEventStream();
    void Promise.resolve().then(async () => {
      providerPayload = true;
      try { await options.onPayload?.({ model: model.id }, model); }
      finally { providerPayload = false; }
      delegated.push({ id: model.id, apiKey: options.apiKey });
      if (holdProvider) { holdProvider = false; providerStarted(); await providerGate; }
      result.end(answer(model));
    }).catch((error) => {
      providerErrors.push(error);
      result.end({ ...answer(model), stopReason: "error", errorMessage: error instanceof Error ? error.message : "blocked" });
    });
    return result;
  };
  const codexStream = (model, _context, options = {}) => {
    const result = createAssistantMessageEventStream();
    void Promise.resolve().then(async () => {
      try {
        providerPayload = true;
        try { await options.onPayload?.({ model: model.id }, model); }
        finally { providerPayload = false; }
        codexDelegated.push({ id: model.id, apiKey: options.apiKey, baseUrl: model.baseUrl });
        result.end({ role: "assistant", api: "openai-codex-responses", provider: "openai-codex", model: model.id, timestamp: Date.now(), stopReason: "stop", content: [{ type: "text", text: "codex fixture" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
      } catch (error) {
        providerErrors.push(error);
        result.end({ role: "assistant", api: "openai-codex-responses", provider: "openai-codex", model: model.id, timestamp: Date.now(), stopReason: "error", errorMessage: error instanceof Error ? error.message : "blocked", content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
      }
    });
    return result;
  };
  registry.registerProvider("openai-codex", { name: "Fixture Codex config", api: "openai-codex-responses", apiKey: options.codexApiKeyOverride, baseUrl: "https://chatgpt.com/backend-api", headers: { "X-Codex-Config": "preserved" }, streamSimple: codexStream });
  const codexModel = registry.getProvider("openai-codex").getModels()[0];
  registry.registerProvider("openai", {
    name: "Fake native OpenAI adapter",
    api: "openai-responses",
    apiKey: "default-config-key",
    baseUrl: "https://configured.example/v1",
    headers: { "X-Local-Config": "preserved" },
    streamSimple: stream,
  });
  const models = registry.getProvider("openai").getModels();
  const fakeNativeOAuth = {
    name: "Fixture native OAuth",
    async login() { throw new Error("login is not invoked by tests"); },
    async refresh(credential) { return credential; },
    async toAuth(credential) { return { apiKey: credential.access }; },
  };
  const fakeNativeProvider = {
    id: "openai", name: "Separately registered native OpenAI", auth: {
      apiKey: { name: "native fixture", async resolve({ credential }) { return credential?.key ? { auth: { apiKey: credential.key } } : undefined; } },
      oauth: fakeNativeOAuth,
    },
    getModels: () => models,
    stream,
    streamSimple: stream,
  };
  if (options.customNativeProvider) registry.registerProvider(fakeNativeProvider);
  const nativeBeforeExtension = registry.getRegisteredNativeProvider("openai");
  const configBeforeExtension = registry.getRegisteredProviderConfig("openai");
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.updateProvider("openai", (state) => ({
    ...state,
    accounts: Object.assign(Object.create(null), {
      alpha: { type: "api_key", key: "fixture-secret-alpha" },
      beta: { type: "api_key", key: "fixture-secret-beta" },
    }),
  }));
  await store.updateProvider("openai-codex", (state) => ({ ...state, accounts: { Work: { type: "oauth", access: jwtToken("work-account", "work-subject"), refresh: "fixture-work-refresh", expires: Date.now() + 86_400_000, accountId: "work-account" } } }));
  await registry.refresh({ providers: ["openai-codex"], allowNetwork: false });
  await store.update((data) => ({
    ...data,
    providers: { ...data.providers, "other-provider": { active: "kept", accounts: { kept: { type: "api_key", key: "untouched" } } } },
  }));
  const handlers = new Map();
  const events = new Map();
  const commands = new Map();
  const notices = [];
  const statuses = new Map();
  const pi = {
    events: { on(name, handler) { const list = events.get(name) ?? []; list.push(handler); events.set(name, list); } },
    on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
    registerCommand(name, definition) { commands.set(name, definition); },
    registerProvider(name, config) { registry.registerProvider(name, config); },
    registerVirtualModel(definition) { registry.registerVirtualModel(definition); },
    unregisterProvider(name) { registry.unregisterProvider(name); },
    appendEntry() {},
  };
  const entries = [];
  let sessionId = "session-one";
  let idle = true;
  let branch = [{ type: "message", id: "prior", parentId: null, timestamp: new Date().toISOString(), message: {
    role: "assistant", model: "gpt-6-astra", provider: "openai", timestamp: Date.now(), stopReason: "stop", content: [{ type: "text", text: "prior" }],
  } }];
  const sessionManager = {
    getSessionId: () => sessionId,
    getEntries: () => entries,
    getBranch: () => branch,
    getLeafId: () => entries.at(-1)?.id ?? null,
    appendCustomEntry(customType, data) {
      const entry = { type: "custom", id: `entry-${entries.length + 1}`, customType, data, timestamp: new Date().toISOString() };
      entries.push(entry);
      return entry.id;
    },
  };
  const ctx = {
    cwd: root, mode: "tui", hasUI: true, model: models[0], modelRegistry: registry, sessionManager,
    get isIdle() { return () => idle; }, get signal() { return undefined; }, scopedModels: [],
    ui: {
      setStatus(key, value) { statuses.set(key, value); },
      notify(message, level) { notices.push({ message, level }); },
      async select() { throw new Error("unexpected select in runtime test"); },
      async input() { throw new Error("unexpected input in runtime test"); },
      async confirm() { return false; },
    },
    getContextUsage: () => undefined,
    abort() {}, hasPendingMessages: () => false,
  };
  const builtinAdapters = oauthModule.createBuiltinProviderAdapters();
  const adapter = builtinAdapters.find((item) => item.id === "openai");
  assert.ok(adapter);
  assert.equal(oauthModule.resolveProviderOAuth(adapter, ctx), registry.getProvider("openai").auth.oauth);
  const codexOAuth = { async login() { throw new Error("unexpected Codex login"); }, async refresh(credential) { return credential; }, async toAuth(credential) { return { apiKey: credential.access }; } };
  const codexAdapter = { ...builtinAdapters.find((item) => item.id === "openai-codex"), oauth: codexOAuth, resolveOAuth: () => codexOAuth };
  accountModule.default(pi, { store, providers: [adapter, codexAdapter] });
  const fire = async (event, value = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...value }, ctx);
  };
  let startupError;
  if (options.startSession !== false) {
    try {
      await fire("session_start");
      await fire("before_agent_start", { prompt: "test" });
    } catch (error) { startupError = error; }
  }
  const service = globalThis.__paeAccountControlsV1;
  assert.equal(service?.protocol, 1);
  const initial = startupError || options.startSession === false ? undefined : await service.getSnapshot({ sessionId });
  return {
    root, runtime, registry, models, codexModel, codexDelegated, store, handlers, events, commands, notices, statuses, pi, ctx, previousAgentDir,
    get sessionId() { return sessionId; }, set sessionId(value) { sessionId = value; },
    get idle() { return idle; }, set idle(value) { idle = value; },
    get branch() { return branch; }, set branch(value) { branch = value; },
    delegated, providerErrors, service, initial, startupError, nativeBeforeExtension, configBeforeExtension, fire,
    pauseFinalAuth() {
      let entered;
      let release;
      const started = new Promise((resolve) => { entered = resolve; });
      const gate = new Promise((resolve) => { release = resolve; });
      authPause = { entered, gate };
      return { started, release: () => release() };
    },
    pauseProvider() {
      holdProvider = true;
      providerStartedPromise = new Promise((resolve) => { providerStarted = resolve; });
      providerGate = new Promise((resolve) => { releaseProvider = resolve; });
      return { started: providerStartedPromise, release: () => releaseProvider() };
    },
  };
}

async function switchRequest(f, accountId, requestId, revision = f.initial.selectionRevision, providerId) {
  return f.service.switchAccount({
    protocol: 1, ...(providerId ? { providerId } : {}), requestId, expectedSessionId: f.sessionId, expectedServiceEpoch: f.initial.serviceEpoch,
    expectedSelectionRevision: revision, accountId,
  });
}

async function dispose(f) {
  await f.fire("session_shutdown");
  await rm(f.root, { recursive: true, force: true });
  if (f.previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = f.previousAgentDir;
}

test("installed Pi 1.0.0 gates normal OpenAI dispatch and cheap Luna compaction with the named key", async () => {
  const f = await fixture();
  try {
    const modelCallsBeforeSwitch = f.delegated.length;
    const changed = await switchRequest(f, "alpha", "switch-alpha");
    assert.equal(changed.ok, true);
    assert.equal(f.delegated.length, modelCallsBeforeSwitch, "account switching must not issue a model call");
    assert.equal(changed.snapshot.usage.effectiveCredential, "api-key-configured");
    assert.equal(changed.snapshot.usage.status, "local-binding-confirmed");
    assert.equal(changed.snapshot.usage.remoteEntitlement, "not-queried");
    assert.doesNotMatch(JSON.stringify(changed.snapshot), /fixture-secret/);
    const model = f.registry.find("openai", "gpt-6-astra");
    const resolvedAuth = await f.registry.getApiKeyAndHeaders(model);
    assert.equal(resolvedAuth.ok, true, JSON.stringify(resolvedAuth));
    const response = await f.registry.stream(model, [], {}).result();
    assert.equal(response.stopReason, "stop", JSON.stringify({ response, delegated: f.delegated, errors: f.providerErrors.map((error) => error.stack) }));
    assert.deepEqual(f.delegated.map(({ id }) => id), ["gpt-6-astra"]);
    assert.equal(f.delegated[0].apiKey, "fixture-secret-alpha");

    const old = Date.now() - 60 * 60_000;
    const event = {
      type: "session_before_compact", reason: "manual", willRetry: false, signal: new AbortController().signal,
      branchEntries: [{ type: "message", id: "prior", parentId: null, timestamp: new Date(old).toISOString(), message: {
        role: "assistant", model: "gpt-6-astra", provider: "openai", timestamp: old, stopReason: "stop", content: [{ type: "text", text: "prior history" }],
      } }], customInstructions: "", preparation: {
        firstKeptEntryId: "kept", messagesToSummarize: [{ role: "user", content: "keep the goal", timestamp: old }],
        turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 100, fileOps: { read: new Set(), edited: new Set(), written: new Set() },
        settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 2000 },
      },
    };
    f.ctx.model = model;
    const selectedConversationModel = f.ctx.model;
    const compaction = await compactionModule.beforeCompact(event, f.ctx, () => ({ idleMinutes: 30, contextPercent: 20, cheapCompactionModel: "openai/gpt-6-luna:low" }));
    assert.ok(compaction?.compaction);
    assert.equal(f.ctx.model, selectedConversationModel, "cheap compaction must preserve the selected conversation model");
    assert.equal(f.delegated.at(-1).id, "gpt-6-luna");
    assert.equal(f.delegated.at(-1).apiKey, "fixture-secret-alpha");
    const restored = await f.service.switchAccount({
      protocol: 1, requestId: "restore-default", expectedSessionId: f.sessionId,
      expectedServiceEpoch: f.initial.serviceEpoch, expectedSelectionRevision: 1, accountId: null,
    });
    assert.equal(restored.ok, true);
    assert.equal(restored.snapshot.defaultSelected, true);
    assert.equal(restored.snapshot.usage.remoteEntitlement, "not-queried");
    const config = f.registry.getRegisteredProviderConfig("openai");
    assert.equal(config.baseUrl, "https://configured.example/v1");
    assert.equal(config.headers["X-Local-Config"], "preserved");
    assert.equal((await f.store.readAsync()).providers["other-provider"].active, "kept");
  } finally { await dispose(f); }
});

test("independent Pi ModelRuntime instances do not share selected account credentials", async () => {
  const left = await fixture();
  let right;
  try {
    assert.equal((await switchRequest(left, "alpha", "left-alpha")).ok, true);
    assert.equal(await left.registry.getApiKeyForProvider("openai"), "fixture-secret-alpha");
    right = await fixture();
    assert.equal((await switchRequest(right, "beta", "right-beta")).ok, true);
    assert.equal(await right.registry.getApiKeyForProvider("openai"), "fixture-secret-beta");
    assert.equal(await left.registry.getApiKeyForProvider("openai"), "fixture-secret-alpha");
  } finally {
    if (right) await dispose(right);
    await dispose(left);
  }
});

test("provider-scoped defaults and idempotency allow the same request ID across native providers", async () => {
  const f = await fixture();
  try {
    const openai = await switchRequest(f, "alpha", "shared-request-id");
    assert.equal(openai.ok, true);
    assert.equal(openai.snapshot.providerId, "openai");
    const codex = await switchRequest(f, null, "shared-request-id", 0, "openai-codex");
    assert.equal(codex.ok, true);
    assert.equal(codex.snapshot.providerId, "openai-codex");
    assert.equal(codex.snapshot.currentAccountId, null);
    assert.equal(codex.snapshot.selectionRevision, 1);
    assert.equal(codex.snapshot.usage.status, "local-binding-confirmed", JSON.stringify({ auth: (await f.registry.getProviderAuth("openai-codex"))?.source, authStatus: f.registry.getProviderAuthStatus("openai-codex"), base: f.registry.getProvider("openai-codex")?.baseUrl, models: f.registry.getAll().filter(m => m.provider === "openai-codex").map(m => [m.api,m.baseUrl,!!m.headers]) }));
    assert.match(codex.snapshot.usage.accountKey, /^[a-f0-9]{64}$/);
    assert.equal(codex.snapshot.usage.nativeRegistrationVersion, undefined);
    assert.equal((await f.service.getSnapshot({ sessionId: f.sessionId, providerId: "openai" })).currentAccountId, "alpha");
    assert.equal((await f.service.getSnapshot({ sessionId: f.sessionId, providerId: "openai-codex" })).currentAccountId, null);
    const replay = await switchRequest(f, null, "shared-request-id", 0, "openai-codex");
    assert.deepEqual(replay, codex);
    const staleCodex = await switchRequest(f, null, "stale-codex", 0, "openai-codex");
    assert.equal(staleCodex.ok, false);
    assert.equal(staleCodex.reason, "stale-selection");
    assert.equal((await f.service.getSnapshot({ sessionId: f.sessionId, providerId: "openai" })).selectionRevision, 1);
  } finally { await dispose(f); }
});

test("Codex default account proof is withheld under runtime, environment, and registered API-key overrides", async () => {
  const registered = await fixture({ codexApiKeyOverride: "fixture-registered-override" });
  let noStored;
  try {
    const snapshot = await registered.service.getSnapshot({ sessionId: registered.sessionId, providerId: "openai-codex" });
    assert.equal(snapshot.usage.accountKey, undefined);
    assert.equal(snapshot.usage.status, "unknown");
  } finally { await dispose(registered); }
  const priorKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "fixture-environment-key";
  try {
    noStored = await fixture({ codexPersonalAuth: false });
    await writeFile(join(noStored.root, "models.json"), JSON.stringify({ providers: { "openai-codex": { apiKey: "${OPENAI_API_KEY}" } } }), { mode: 0o600 });
    const environment = await noStored.service.getSnapshot({ sessionId: noStored.sessionId, providerId: "openai-codex" });
    assert.equal(environment.usage.accountKey, undefined);
    assert.equal(environment.usage.status, "unknown");
    await noStored.runtime.setRuntimeApiKey("openai-codex", "fixture-runtime-override");
    const runtime = await noStored.service.getSnapshot({ sessionId: noStored.sessionId, providerId: "openai-codex" });
    assert.equal(runtime.usage.accountKey, undefined);
    assert.equal(runtime.usage.status, "unknown");
  } finally {
    if (noStored) await dispose(noStored);
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = priorKey;
  }
});

test("Codex native stream dispatch uses the selected Work OAuth grant, not the personal default", async () => {
  const f = await fixture();
  try {
    const before = await f.service.getSnapshot({ sessionId: f.sessionId, providerId: "openai-codex" });
    assert.equal(before.usage.status, "local-binding-confirmed", JSON.stringify({ auth: (await f.registry.getProviderAuth("openai-codex"))?.source, authStatus: f.registry.getProviderAuthStatus("openai-codex"), base: f.registry.getProvider("openai-codex")?.baseUrl, models: f.registry.getAll().filter(m => m.provider === "openai-codex").map(m => [m.api,m.baseUrl,!!m.headers]) }));
    const personalKey = before.usage.accountKey;
    const defaultConfig = f.registry.getRegisteredProviderConfig("openai-codex");
    const authBefore = await readFile(join(f.root, "auth.json"), "utf8");
    const changed = await switchRequest(f, "Work", "codex-work", 0, "openai-codex");
    assert.equal(changed.ok, true, JSON.stringify(changed));
    assert.notEqual(changed.snapshot.usage.accountKey, personalKey);
    const model = f.registry.find("openai-codex", f.codexModel.id);
    const result = await f.registry.streamSimple(model, [], {}).result();
    assert.equal(result.stopReason, "stop", JSON.stringify(result));
    assert.equal(f.codexDelegated.at(-1).apiKey, jwtToken("work-account", "work-subject"));
    assert.equal(f.codexDelegated.at(-1).baseUrl, "https://chatgpt.com/backend-api");
    assert.doesNotMatch(JSON.stringify(changed.snapshot), /fixture-work|fixture-personal/);
    assert.equal(f.registry.getRegisteredProviderConfig("openai-codex").headers["X-Codex-Config"], "preserved");
    const restored = await switchRequest(f, null, "codex-default", 1, "openai-codex");
    assert.equal(restored.ok, true);
    assert.equal(restored.snapshot.usage.accountKey, personalKey);
    assert.equal(restored.snapshot.usage.nativeRegistrationVersion, undefined);
    const defaultResult = await f.registry.streamSimple(model, [], {}).result();
    assert.equal(defaultResult.stopReason, "stop", JSON.stringify(defaultResult));
    assert.equal(f.codexDelegated.at(-1).apiKey, jwtToken("personal-account", "personal-subject"));
    assert.equal(f.registry.getRegisteredProviderConfig("openai-codex").baseUrl, "https://chatgpt.com/backend-api");
    assert.equal(f.registry.getRegisteredProviderConfig("openai-codex").headers["X-Codex-Config"], "preserved");
    assert.deepEqual(f.registry.getRegisteredProviderConfig("openai-codex"), defaultConfig);
    assert.equal(await readFile(join(f.root, "auth.json"), "utf8"), authBefore);
  } finally { await dispose(f); }
});

test("deleted Codex Work account blocks dispatch instead of falling back to the personal OAuth grant", async () => {
  const f = await fixture();
  try {
    await new Promise(resolve => setImmediate(resolve));
    const selected = await switchRequest(f, "Work", "codex-select-work", 0, "openai-codex");
    assert.equal(selected.ok, true, JSON.stringify(selected));
    const calls = f.codexDelegated.length;
    await f.store.updateProvider("openai-codex", (state) => ({ ...state, accounts: {} }));
    const result = await f.registry.streamSimple(f.registry.find("openai-codex", f.codexModel.id), [], {}).result();
    assert.equal(result.stopReason, "error");
    assert.equal(f.codexDelegated.length, calls);
    assert.notEqual(await f.registry.getApiKeyForProvider("openai-codex"), jwtToken("personal-account", "personal-subject"));
  } finally { await dispose(f); }
});

test("Codex gate blocks an Authorization override changed during payload validation", async () => {
  const f = await fixture();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await switchRequest(f, "Work", "codex-override-work", 0, "openai-codex")).ok, true);
    const calls = f.codexDelegated.length;
    const model = f.registry.find("openai-codex", f.codexModel.id);
    const result = await f.registry.streamSimple(model, [], { onPayload: async (payload) => {
      const config = f.registry.getRegisteredProviderConfig("openai-codex");
      f.registry.registerProvider("openai-codex", { ...config, headers: { ...config.headers, Authorization: `Bearer ${jwtToken("personal-account", "personal-subject")}` } });
      return payload;
    } }).result();
    assert.equal(result.stopReason, "error");
    assert.equal(f.codexDelegated.length, calls);
  } finally { await dispose(f); }
});

test("busy Codex dispatch blocks cross-provider switching without leaking the selected identity", async () => {
  const f = await fixture();
  try {
    await new Promise(resolve => setImmediate(resolve));
    const selected = await switchRequest(f, "Work", "codex-busy-work", 0, "openai-codex");
    assert.equal(selected.ok, true, JSON.stringify(selected));
    const pause = f.pauseFinalAuth();
    const stream = f.registry.streamSimple(f.registry.find("openai-codex", f.codexModel.id), [], {}).result();
    await pause.started;
    const codexSwitch = await switchRequest(f, null, "codex-busy-switch", 1, "openai-codex");
    const openaiSwitch = await switchRequest(f, "alpha", "openai-busy-switch", 0, "openai");
    assert.equal(codexSwitch.reason, "busy");
    assert.equal(openaiSwitch.reason, "busy");
    assert.equal((await f.service.getSnapshot({ sessionId: f.sessionId, providerId: "openai-codex" })).currentAccountId, "Work");
    pause.release();
    assert.equal((await stream).stopReason, "stop");
    assert.equal(f.codexDelegated.at(-1).apiKey, jwtToken("work-account", "work-subject"));
  } finally { await dispose(f); }
});

test("custom native OpenAI registration is rejected without replacement", async () => {
  const f = await fixture({ customNativeProvider: true });
  try {
    assert.match(f.startupError?.message ?? "", /separately registered native OpenAI provider/);
    assert.equal(f.registry.getRegisteredNativeProvider("openai"), f.nativeBeforeExtension);
    assert.deepEqual(f.registry.getRegisteredProviderConfig("openai"), f.configBeforeExtension);
    await assert.rejects(f.service.getSnapshot({ sessionId: f.sessionId }), /stale-session/);
  } finally { await dispose(f); }
});

test("same-session startup/resume restores its saved selection while a new session starts at Pi default", async () => {
  const f = await fixture();
  try {
    assert.equal((await switchRequest(f, "alpha", "resume-alpha")).ok, true);
    const before = await f.service.getSnapshot({ sessionId: f.sessionId });
    assert.equal(before.currentAccountId, "alpha");
    await f.fire("session_start");
    await f.fire("before_agent_start", { prompt: "resume" });
    const resumed = await f.service.getSnapshot({ sessionId: f.sessionId });
    assert.equal(resumed.currentAccountId, "alpha");
    assert.equal(resumed.defaultSelected, false);
    assert.doesNotMatch(JSON.stringify(resumed), /fixture-secret/);
  } finally { await dispose(f); }
});

test("idle-guard physical Astra route reaches the same request-time OpenAI auth gate", async () => {
  const f = await fixture();
  try {
    const switched = await switchRequest(f, "alpha", "guard-alpha");
    assert.equal(switched.ok, true);
    const settings = { idleMinutes: 30, contextPercent: 20, guardedModels: { astra: "openai/gpt-6-astra" } };
    const guard = guardModule.registerGuard(f.pi, () => settings, { tombstonePath: join(f.root, "guard-aliases.json") });
    await f.fire("session_start");
    f.ctx.model = { provider: "idle-guard", id: "astra" };
    const proxy = f.registry.find("idle-guard-proxy", "astra");
    assert.ok(proxy);
    const result = await f.registry.streamSimple(proxy, [], {}).result();
    assert.equal(result.stopReason, "stop", JSON.stringify(result));
    assert.equal(f.delegated.at(-1).id, "gpt-6-astra");
    assert.equal(f.delegated.at(-1).apiKey, "fixture-secret-alpha");
    assert.equal(guard.compactionProof(f.ctx)?.mode, "physical");
    assert.equal(guard.compactionProof(f.ctx)?.target, "openai/gpt-6-astra");
  } finally { await dispose(f); }
});

test("idle-guard rechecks after a delayed final auth resolution and sends no cold history", async () => {
  const f = await fixture();
  try {
    assert.equal((await switchRequest(f, "alpha", "guard-pause-alpha")).ok, true);
    const settings = { idleMinutes: 30, contextPercent: 20, guardedModels: { astra: "openai/gpt-6-astra" } };
    guardModule.registerGuard(f.pi, () => settings, { tombstonePath: join(f.root, "paused-guard-aliases.json") });
    await f.fire("session_start");
    f.ctx.model = { provider: "idle-guard", id: "astra" };
    f.branch = [{ type: "message", id: "warm", parentId: null, timestamp: new Date().toISOString(), message: {
      role: "assistant", model: "gpt-6-astra", provider: "openai", timestamp: Date.now(), stopReason: "stop", content: [{ type: "text", text: "warm" }],
    } }];
    const proxy = f.registry.find("idle-guard-proxy", "astra");
    const pause = f.pauseFinalAuth();
    const before = f.delegated.length;
    const resultPromise = f.registry.streamSimple(proxy, [], {}).result();
    await pause.started;
    f.branch = [{ type: "message", id: "cold", parentId: null, timestamp: new Date(Date.now() - 60 * 60_000).toISOString(), message: {
      role: "assistant", model: "gpt-6-astra", provider: "openai", timestamp: Date.now() - 60 * 60_000, stopReason: "stop", content: [{ type: "text", text: "cold" }],
    } }];
    pause.release();
    const result = await resultPromise;
    assert.equal(result.stopReason, "error");
    assert.equal(f.delegated.length, before, "cold transcript must never reach the expensive provider");
  } finally { await dispose(f); }
});

test("an idle-looking direct request in flight still blocks account switching", async () => {
  const f = await fixture();
  try {
    assert.equal((await switchRequest(f, "alpha", "inflight-alpha")).ok, true);
    const pause = f.pauseProvider();
    const streamResult = f.registry.streamSimple(f.registry.find("openai", "gpt-6-luna"), [], {}).result();
    await pause.started;
    assert.equal(f.idle, true);
    const result = await f.service.switchAccount({
      protocol: 1, requestId: "inflight-switch", expectedSessionId: f.sessionId,
      expectedServiceEpoch: f.initial.serviceEpoch, expectedSelectionRevision: 1, accountId: "beta",
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "busy");
    assert.equal(result.snapshot.selectionRevision, 1);
    pause.release();
    assert.equal((await streamResult).stopReason, "stop");
  } finally { await dispose(f); }
});

test("request gate rejects a named credential replaced during final auth resolution", async () => {
  const f = await fixture();
  try {
    assert.equal((await switchRequest(f, "alpha", "replace-alpha")).ok, true);
    const pause = f.pauseFinalAuth();
    const before = f.delegated.length;
    const pending = f.registry.stream(f.registry.find("openai", "gpt-6-astra"), [], {}).result();
    await pause.started;
    await f.store.updateProvider("openai", (state) => ({
      ...state,
      accounts: Object.assign(Object.create(null), state.accounts, { alpha: { type: "api_key", key: "replacement-during-auth" } }),
    }));
    pause.release();
    const result = await pending;
    assert.equal(result.stopReason, "error");
    assert.equal(f.delegated.length, before);
    assert.doesNotMatch(JSON.stringify(await f.service.getSnapshot({ sessionId: f.sessionId })), /replacement-during-auth/);
  } finally { await dispose(f); }
});

test("request gate fails closed when the selected account disappears; never calls the provider fallback", async () => {
  const priorApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "fixture-environment-fallback";
  let f;
  try {
    f = await fixture();
    assert.equal((await switchRequest(f, "alpha", "select-alpha")).ok, true);
    const count = f.delegated.length;
    await f.store.updateProvider("openai", (state) => ({
      ...state,
      accounts: Object.assign(Object.create(null), state.accounts, { alpha: { type: "api_key", key: "replacement-not-active" } }),
    }));
    const replacedSnapshot = await f.service.getSnapshot({ sessionId: f.sessionId });
    assert.equal(replacedSnapshot.currentAccountId, "alpha");
    assert.equal(replacedSnapshot.usage.effectiveCredential, "unavailable");
    await f.store.updateProvider("openai", (state) => {
      const accounts = Object.assign(Object.create(null), state.accounts);
      delete accounts.alpha;
      return { ...state, accounts };
    });
    const failed = await f.registry.streamSimple(f.registry.find("openai", "gpt-6-astra"), [], {}).result();
    assert.equal(failed.stopReason, "error");
    assert.equal(f.delegated.length, count);
    assert.equal((await f.registry.getApiKeyForProvider("openai")), "pi-accounts-auth-failed");
  } finally {
    if (f) await dispose(f);
    if (priorApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorApiKey;
  }
});

test("service serializes competing revisions, rejects busy-after-await, replays exact IDs, and rejects conflicting reuse", async () => {
  const f = await fixture();
  try {
    let pauseNext = false;
    let entered;
    let release;
    const enteredPromise = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const readProvider = f.store.readProviderAsync.bind(f.store);
    f.store.readProviderAsync = async (...args) => {
      if (pauseNext) { pauseNext = false; entered(); await gate; }
      return readProvider(...args);
    };
    pauseNext = true;
    const a = switchRequest(f, "alpha", "concurrent-a", 0);
    await enteredPromise;
    const b = switchRequest(f, "beta", "concurrent-b", 0);
    release();
    const [first, second] = await Promise.all([a, b]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.reason, "stale-selection");
    assert.equal(first.snapshot.selectionRevision, 1);
    assert.deepEqual(await switchRequest(f, "alpha", "concurrent-a", 0), first);
    const conflict = await switchRequest(f, "beta", "concurrent-a", 0);
    assert.equal(conflict.reason, "request-id-conflict");

    let pauseBusy = false;
    let busyEntered;
    let releaseBusy;
    const busyEnteredPromise = new Promise((resolve) => { busyEntered = resolve; });
    const busyGate = new Promise((resolve) => { releaseBusy = resolve; });
    f.store.readProviderAsync = async (...args) => {
      if (pauseBusy) { pauseBusy = false; busyEntered(); await busyGate; }
      return readProvider(...args);
    };
    pauseBusy = true;
    const busySwitch = f.service.switchAccount({
      protocol: 1, requestId: "became-busy", expectedSessionId: f.sessionId, expectedServiceEpoch: f.initial.serviceEpoch,
      expectedSelectionRevision: 1, accountId: "beta",
    });
    await busyEnteredPromise;
    f.idle = false;
    releaseBusy();
    const rejected = await busySwitch;
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, "busy");
    assert.equal(rejected.snapshot.selectionRevision, 1);
    f.idle = true;

    const oldSessionId = f.sessionId;
    f.sessionId = "session-two";
    await f.fire("session_start");
    assert.equal(f.service.sessionId, "session-two");
    await f.fire("before_agent_start", { prompt: "new session" });
    await assert.rejects(f.service.getSnapshot({ sessionId: oldSessionId }), /stale-session/);
    const next = await f.service.getSnapshot({ sessionId: "session-two" });
    assert.equal(next.defaultSelected, true);
    const staleReplay = await f.service.switchAccount({
      protocol: 1, requestId: "concurrent-a", expectedSessionId: oldSessionId,
      expectedServiceEpoch: f.initial.serviceEpoch, expectedSelectionRevision: 0, accountId: "alpha",
    });
    assert.equal(staleReplay.reason, "stale-session");
  } finally { await dispose(f); }
});

test("credential management refuses RPC/Paseo UI mode without forwarding secret prompts", async () => {
  const f = await fixture();
  try {
    f.ctx.mode = "rpc";
    await f.commands.get("accounts").handler("", f.ctx);
    assert.match(f.notices.at(-1).message, /native Pi TUI/);
    assert.doesNotMatch(JSON.stringify(f.service), /fixture-secret/);
  } finally { await dispose(f); }
});

test("/usage does not reuse a platform link when the owner snapshot is unavailable", async () => {
  const f = await fixture();
  try {
    usageModule.default(f.pi);
    f.service.getSnapshot = async () => { throw new Error("stale owner"); };
    await f.commands.get("usage").handler("", f.ctx);
    assert.equal(f.notices.at(-1).message, "OpenAI credential status unavailable.");
    assert.doesNotMatch(f.notices.at(-1).message, /platform\\.openai\\.com|chatgpt\\.com/);
  } finally { await dispose(f); }
});

test("/usage is local-only and reports a link without issuing any companion request", async () => {
  const f = await fixture();
  const beforeFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async (...args) => { fetchCalls += 1; throw new Error(`unexpected fetch ${args[0]}`); };
  try {
    assert.equal((await switchRequest(f, "alpha", "usage-alpha")).ok, true);
    usageModule.default(f.pi);
    await f.commands.get("usage").handler("", f.ctx);
    assert.equal(fetchCalls, 0);
    assert.match(f.notices.at(-1).message, /platform\.openai\.com\/settings\/organization\/usage/);
    assert.doesNotMatch(f.notices.at(-1).message, /quota|tokens?\s*[:=]\s*0/i);
  } finally {
    globalThis.fetch = beforeFetch;
    await dispose(f);
  }
});
