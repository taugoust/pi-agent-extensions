import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { ModelRuntime, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
const { createJiti } =
  createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("jiti");

const load = createJiti(import.meta.url);
const accountModule = await load.import("../openai-accounts/accounts.ts");
const verificationModule = await load.import("../openai-accounts/model-auth-verification.ts");
const oauthModule = await load.import("../openai-accounts/oauth.ts");
const storageModule = await load.import("../openai-accounts/storage.ts");
const usageModule = await load.import("../openai-usage/index.ts");
const compactionModule = await load.import("../idle-context-warning/compaction.ts");
const routingModule = await load.import("../shared/session-routing.ts");
const { AccountStore, InMemoryAccountStorageBackend } = accountModule;
const { createBtwService } = await load.import("../btw/service.ts");
const {
  SESSION_ROUTING_FILE_ENV, SESSION_ROUTING_OWNER_ENV, prepareSessionRoutingRequest,
  resolveSessionProvider, registerSessionModelReference, bindSessionModelRequest,
} = routingModule;
// A harness worker may inherit live routing descriptors. Fixtures own their routing
// explicitly; never read or mutate the invoking worker's account/session state.
const outerRoutingEnv = [SESSION_ROUTING_FILE_ENV, SESSION_ROUTING_OWNER_ENV]
  .map((key) => [key, process.env[key]]);
for (const [key] of outerRoutingEnv) delete process.env[key];
test.after(() => {
  for (const [key, value] of outerRoutingEnv) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

const CODEX = "openai-codex";
const CODEX_URL = "https://chatgpt.com/backend-api";
const ROLE = "gpt-6-astra";
const CHEAP = "gpt-6-luna";
const REMOVED_SNAPSHOT_FIELDS =
  ["supportedProviders", "sessionRouting", "guardedDefaultSwitchVersion"];
const REMOVED_USAGE_FIELDS = ["nativeRegistrationKey", "nativeRegistrationVersion"];

function jwtToken(accountId, subject) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const claims = { sub: subject, "https://api.openai.com/auth": { chatgpt_account_id: accountId } };
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(claims)}.fixture-signature`;
}
const grant = (name) => jwtToken(`${name}-account`, `${name}-subject`);
const oauthCredential = (name, access = grant(name)) => ({
  type: "oauth", access, refresh: `fixture-${name}-refresh`,
  expires: Date.now() + 86_400_000, accountId: `${name}-account`,
});
const ALPHA = grant("alpha"), BETA = grant("beta"), WORK = grant("work");
const PERSONAL = grant("personal");
const LEGACY_OPENAI = {
  active: "alpha",
  accounts: { alpha: { type: "api_key", key: "fixture-legacy-openai-alpha" } },
};

function assertNoRemovedFields(snapshot) {
  assert.equal(snapshot.providerId, CODEX);
  for (const field of REMOVED_SNAPSHOT_FIELDS) assert.equal(field in snapshot, false, field);
  for (const field of REMOVED_USAGE_FIELDS) assert.equal(field in snapshot.usage, false, field);
}

test("Codex binding verification rejects custom origins and conflicting model Authorization",
  async () => {
    const model = { id: "fixture-codex", provider: CODEX, api: "openai-codex-responses",
      baseUrl: CODEX_URL };
    const resolved = (baseUrl, headers) => async () =>
      ({ ok: true, apiKey: "fixture-selected-codex", baseUrl, headers });
    const override = { Authorization: "Bearer fixture-override" };
    const ctx = { modelRegistry: { getAll: () => [model],
      getApiKeyAndHeaders: resolved(model.baseUrl, override) } };
    const adapter = { id: CODEX, displayName: "OpenAI Codex" };
    const verify = () => verificationModule.verifyModelApiKeyAuth(
      ctx, adapter, "fixture-selected-codex", new AbortController().signal);
    await assert.rejects(verify(), /conflicting authentication header/);
    ctx.modelRegistry.getApiKeyAndHeaders = resolved("https://attacker.invalid/codex", {});
    await assert.rejects(verify(), /official ChatGPT origin/);
    ctx.modelRegistry.getApiKeyAndHeaders = resolved(model.baseUrl, {});
    await verify();
  });

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "pae-openai-runtime-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const authPath = join(root, "auth.json");
  const authData = options.codexPersonalAuth === false
    ? {} : { [CODEX]: oauthCredential("personal", PERSONAL) };
  await writeFile(authPath, JSON.stringify(authData), { mode: 0o600 });
  await chmod(authPath, 0o600);
  const runtime = await ModelRuntime.create({
    authPath, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  });
  const registry = new ModelRegistry(runtime);
  const openaiDelegated = [];
  const codexDelegated = [];
  const providerErrors = [];
  let holdProvider = false;
  let providerStarted, releaseProvider, providerStartedPromise, providerGate;
  let providerPayload = false;
  let authPause;
  const resolveAuth = registry.getApiKeyAndHeaders.bind(registry);
  registry.getApiKeyAndHeaders = async (model) => {
    const result = await resolveAuth(model);
    const stage = providerPayload ? "payload" : "dispatch";
    if (authPause && authPause.stage === stage && model.provider === CODEX) {
      const pause = authPause;
      authPause = undefined;
      pause.entered();
      await pause.gate;
    }
    return result;
  };
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const fakeStream = (provider, api, delegated) => (model, _context, options = {}) => {
    const result = createAssistantMessageEventStream();
    const base = {
      role: "assistant", api, provider, model: model.id, timestamp: Date.now(), usage,
    };
    void Promise.resolve().then(async () => {
      providerPayload = true;
      try { await options.onPayload?.({ model: model.id }, model); }
      finally { providerPayload = false; }
      delegated.push({ id: model.id, apiKey: options.apiKey, baseUrl: model.baseUrl });
      if (holdProvider) { holdProvider = false; providerStarted(); await providerGate; }
      const content = [{ type: "text", text: "safe summary" }];
      result.end({ ...base, stopReason: "stop", content });
    }).catch((error) => {
      providerErrors.push(error);
      result.end({ ...base, stopReason: "error", content: [],
        errorMessage: error instanceof Error ? error.message : "blocked" });
    });
    return result;
  };
  const codexStream = fakeStream(CODEX, "openai-codex-responses", codexDelegated);
  const openaiStream = fakeStream("openai", "openai-responses", openaiDelegated);
  registry.registerProvider(CODEX, {
    name: "Fixture Codex config", api: "openai-codex-responses",
    apiKey: options.codexApiKeyOverride, baseUrl: CODEX_URL,
    headers: { "X-Codex-Config": "preserved" }, streamSimple: codexStream,
  });
  const codexModel = registry.getProvider(CODEX).getModels()[0];
  // Pi's built-in `openai` provider stays a plain provider that Accounts never touches.
  registry.registerProvider("openai", {
    name: "Fake native OpenAI adapter", api: "openai-responses", apiKey: "default-config-key",
    baseUrl: "https://configured.example/v1", headers: { "X-Local-Config": "preserved" },
    streamSimple: openaiStream,
  });
  const models = registry.getProvider("openai").getModels();
  const codexRegistered = registry.getRegisteredProviderConfig(CODEX);
  const codexModels = registry.getProvider(CODEX).getModels();
  const roleCopy = {
    ...models[0], provider: CODEX, api: "openai-codex-responses", baseUrl: CODEX_URL,
  };
  registry.registerProvider(CODEX, {
    ...codexRegistered,
    models: options.noCodexRoleModel ? codexModels : [...codexModels, roleCopy],
  });
  const fakeNativeOAuth = {
    name: "Fixture native OAuth",
    async login() { throw new Error("login is not invoked by tests"); },
    async refresh(credential) { return credential; },
    async toAuth(credential) { return { apiKey: credential.access }; },
  };
  const nativeProvider = (id, getModels, stream) => ({
    id, name: `Separately registered native ${id}`, auth: {
      apiKey: { name: "native fixture", async resolve({ credential }) {
        return credential?.key ? { auth: { apiKey: credential.key } } : undefined;
      } },
      oauth: fakeNativeOAuth,
    },
    getModels, stream, streamSimple: stream,
  });
  if (options.customNativeProvider)
    registry.registerProvider(nativeProvider("openai", () => models, openaiStream));
  if (options.customNativeCodexProvider)
    registry.registerProvider(nativeProvider(CODEX, () => codexModels, codexStream));
  const nativeBeforeExtension = registry.getRegisteredNativeProvider("openai");
  const configBeforeExtension = registry.getRegisteredProviderConfig("openai");
  const codexNativeBeforeExtension = registry.getRegisteredNativeProvider(CODEX);
  const codexConfigBeforeExtension = registry.getRegisteredProviderConfig(CODEX);
  const store = options.store ?? new AccountStore(new InMemoryAccountStorageBackend());
  await store.updateProvider(CODEX, (state) => ({
    ...state,
    accounts: Object.assign(Object.create(null), state.accounts, {
      alpha: oauthCredential("alpha"),
      beta: oauthCredential("beta"),
      Work: oauthCredential("work"),
    }),
  }));
  await registry.refresh({ providers: [CODEX], allowNetwork: false });
  await store.update((data) => ({
    ...data,
    providers: {
      ...data.providers,
      // Former OpenAI account namespace: stored data only, never managed.
      ...(data.providers.openai ? {} : { openai: structuredClone(LEGACY_OPENAI) }),
      "other-provider": {
        active: "kept", accounts: { kept: { type: "api_key", key: "untouched" } },
      },
    },
  }));
  const handlers = new Map();
  const events = new Map();
  const commands = new Map();
  const notices = [];
  const statuses = new Map();
  const pi = {
    events: { on(name, handler) {
      const list = events.get(name) ?? []; list.push(handler); events.set(name, list);
    } },
    on(name, handler) {
      const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list);
    },
    registerCommand(name, definition) { commands.set(name, definition); },
    registerProvider(name, config) { registry.registerProvider(name, config); },
    registerVirtualModel(definition) { registry.registerVirtualModel(definition); },
    unregisterProvider(name) { registry.unregisterProvider(name); },
    unregisterVirtualModel(provider, id) { registry.unregisterVirtualModel(provider, id); },
    appendEntry() {},
  };
  const entries = [];
  let sessionId = options.sessionId ?? "session-one";
  let idle = true;
  const openaiSession = options.openaiSession || options.noCodexRoleModel;
  const sessionModel = openaiSession ? models[0] : registry.find(CODEX, ROLE);
  assert.ok(sessionModel);
  let branch = [{ type: "message", id: "prior", parentId: null, timestamp: new Date().toISOString(),
    message: { role: "assistant", model: sessionModel.id, provider: sessionModel.provider,
      timestamp: Date.now(), stopReason: "stop", content: [{ type: "text", text: "prior" }] } }];
  const sessionManager = {
    getSessionId: () => sessionId,
    getEntries: () => entries,
    getBranch: () => branch,
    getLeafId: () => entries.at(-1)?.id ?? null,
    appendCustomEntry(customType, data) {
      const entry = { type: "custom", id: `entry-${entries.length + 1}`, customType, data,
        timestamp: new Date().toISOString() };
      entries.push(entry);
      branch.push(entry);
      return entry.id;
    },
  };
  const ctx = {
    cwd: root, mode: "tui", hasUI: true, model: sessionModel, modelRegistry: registry,
    sessionManager, get isIdle() { return () => idle; }, get signal() { return undefined; },
    scopedModels: [],
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
  assert.deepEqual(builtinAdapters.map((item) => item.id), [CODEX]);
  const codexOAuth = {
    async login() { throw new Error("unexpected Codex login"); },
    async refresh(credential) { return credential; },
    async toAuth(credential) { return { apiKey: credential.access }; },
  };
  const codexAdapter = { ...builtinAdapters[0], oauth: codexOAuth, resolveOAuth: () => codexOAuth };
  accountModule.default(pi, { store, providers: [codexAdapter] });
  const fire = async (event, value = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...value }, ctx);
  };
  pi.setModel = async (model) => {
    ctx.model = model;
    await fire("model_select", { model });
    return true;
  };
  if (options.legacyBootstrap) {
    ctx.model = { provider: "idle-guard", id: "astra", api: "pi-virtual" };
    registerSessionModelReference(ctx, () => ({ provider: CODEX, id: ROLE }));
  }
  let startupError;
  if (options.startSession !== false) {
    try {
      await fire("session_start");
      await fire("before_agent_start", { prompt: "test" });
    } catch (error) { startupError = error; }
  }
  const service = globalThis.__paeAccountControlsV1;
  assert.equal(service?.protocol, 1);
  const initial = startupError || options.startSession === false
    ? undefined : await service.getSnapshot({ sessionId, providerId: CODEX });
  const pause = (stage) => {
    let entered, release;
    const started = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    authPause = { stage, entered, gate };
    return { started, release: () => release() };
  };
  return {
    root, runtime, registry, models, codexModel, codexDelegated, openaiDelegated, openaiStream,
    store, handlers, events, commands, notices, statuses, pi, ctx, previousAgentDir, entries,
    get sessionId() { return sessionId; }, set sessionId(value) { sessionId = value; },
    get idle() { return idle; }, set idle(value) { idle = value; },
    get branch() { return branch; }, set branch(value) { branch = value; },
    providerErrors, service, initial, startupError, fire, nativeBeforeExtension,
    configBeforeExtension, codexNativeBeforeExtension, codexConfigBeforeExtension,
    role: () => registry.find(CODEX, ROLE),
    /** Pauses final auth resolution inside the gate's onPayload recheck. */
    pauseFinalAuth: () => pause("payload"),
    /** Pauses the gate's pre-dispatch auth resolution, before its store recheck. */
    pauseDispatchAuth: () => pause("dispatch"),
    pauseProvider() {
      holdProvider = true;
      providerStartedPromise = new Promise((resolve) => { providerStarted = resolve; });
      providerGate = new Promise((resolve) => { releaseProvider = resolve; });
      return { started: providerStartedPromise, release: () => releaseProvider() };
    },
  };
}

async function switchRequest(f, accountId, requestId, revision = f.initial.selectionRevision) {
  return f.service.switchAccount({
    protocol: 1, providerId: CODEX, requestId, expectedSessionId: f.sessionId,
    expectedServiceEpoch: f.initial.serviceEpoch, expectedSelectionRevision: revision, accountId,
  });
}
const snapshotOf = (f, sessionId = f.sessionId) =>
  f.service.getSnapshot({ sessionId, providerId: CODEX });
const dispatch = (f, model = f.role(), options = {}) =>
  f.registry.streamSimple(model, [], options).result();

async function dispose(f) {
  await f.fire("session_shutdown");
  await rm(f.root, { recursive: true, force: true });
  if (f.previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = f.previousAgentDir;
}

test("BTW inherits the parent named account and blocks switching during a side stream",
  async () => {
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
      btw.handle({ operation: "start", requestId: randomUUID(), threadId, sessionId: btw.sessionId,
        serviceEpoch: btw.serviceEpoch, model: `${CODEX}/${CHEAP}`, question: "Side question",
        context: "recent" });
      await pause.started;
      const busy = await snapshotOf(f);
      assert.equal(busy.busy, true);
      const switched = await switchRequest(f, "beta", randomUUID(), busy.selectionRevision);
      assert.equal(switched.ok, false);
      assert.equal(switched.reason, "busy");
      pause.release();
      await new Promise((resolve) => setImmediate(resolve));
      const snapshot = btw.handle({ operation: "snapshot", sessionId: btw.sessionId,
        serviceEpoch: btw.serviceEpoch, threadId });
      assert.equal(snapshot.threads[0].state, "idle");
      assert.equal(f.codexDelegated.at(-1).id, CHEAP);
      assert.equal(f.codexDelegated.at(-1).apiKey, ALPHA);
      assert.equal(f.ctx.model, mainModel);
      assert.deepEqual(structuredClone(f.branch), branch);
      assert.equal(JSON.stringify(snapshot).includes(ALPHA), false);
    } finally { pause?.release(); btw?.dispose(); await dispose(f); }
  });

test("account controls reject openai and missing providerId without touching state", async () => {
  const f = await fixture();
  try {
    assert.equal((await switchRequest(f, "alpha", "unsupported-baseline")).ok, true);
    const storeBefore = await f.store.readAsync();
    const entriesBefore = f.entries.length;
    const routeBefore = routingModule.getSessionRoutingProfile(f.ctx);
    const snapshotBefore = await snapshotOf(f);
    const base = {
      protocol: 1, requestId: "unsupported-request", expectedSessionId: f.sessionId,
      expectedServiceEpoch: f.initial.serviceEpoch,
      expectedSelectionRevision: snapshotBefore.selectionRevision, accountId: "beta",
    };
    const management = [
      { operation: "default", accountId: "beta" },
      { operation: "rename", accountId: "alpha", label: "Renamed" },
      { operation: "remove", accountId: "beta" },
      { operation: "add", accountName: "gamma", method: "oauth" },
      { operation: "cancel-login", accountName: "gamma" },
    ];
    for (const scope of [{ providerId: "openai" }, {}]) {
      const rejected = /unsupported-provider/;
      await assert.rejects(f.service.getSnapshot({ sessionId: f.sessionId, ...scope }), rejected);
      await assert.rejects(f.service.switchAccount({ ...base, ...scope }), rejected);
      await assert.rejects(f.service.switchAccount(
        { ...base, ...scope, accountId: null, inherit: true }), rejected);
      for (const request of management) {
        await assert.rejects(
          f.service.manageAccount({ ...request, sessionId: f.sessionId, ...scope }), rejected);
      }
    }
    assert.deepEqual(await f.store.readAsync(), storeBefore, "store unchanged");
    assert.equal(f.entries.length, entriesBefore, "no session entries appended");
    assert.deepEqual(routingModule.getSessionRoutingProfile(f.ctx), routeBefore, "route unchanged");
    assert.deepEqual(await snapshotOf(f), snapshotBefore, "Codex selection unchanged");
    const accepted = await f.service.switchAccount({ ...base, providerId: CODEX });
    assert.equal(accepted.ok, true, "rejected attempts never claim a request ID");
    assert.equal(accepted.snapshot.currentAccountId, "beta");
    assert.equal(f.codexDelegated.length + f.openaiDelegated.length, 0);
  } finally { await dispose(f); }
});

test("snapshots are Codex-only and never publish removed provider-switching fields", async () => {
  const f = await fixture();
  try {
    assertNoRemovedFields(f.initial);
    const selected = await switchRequest(f, "Work", "snapshot-fields");
    assertNoRemovedFields(selected.snapshot);
    assert.match(selected.snapshot.usage.accountKey, /^[a-f0-9]{64}$/);
    const readAsync = f.store.readAsync.bind(f.store);
    f.store.readAsync = async () => { throw new Error("fixture store unavailable"); };
    try {
      const fallback = await snapshotOf(f);
      assert.equal(fallback.activationStatus, "activation-failed");
      assertNoRemovedFields(fallback);
    } finally { f.store.readAsync = readAsync; }
  } finally { await dispose(f); }
});

test("plain openai keeps its own configuration and login without any account wrapper", async () => {
  const f = await fixture();
  try {
    assert.equal(f.startupError, undefined);
    assert.deepEqual(f.registry.getRegisteredProviderConfig("openai"), f.configBeforeExtension);
    assert.equal(f.registry.getRegisteredProviderConfig("openai").streamSimple, f.openaiStream);
    assert.equal((await switchRequest(f, "alpha", "plain-openai-alpha")).ok, true);
    const response = await dispatch(f, f.registry.find("openai", ROLE));
    assert.equal(response.stopReason, "stop", JSON.stringify(response));
    assert.equal(f.openaiDelegated.at(-1).apiKey, "default-config-key");
    assert.equal(f.codexDelegated.length, 0);
    let topology;
    for (const handler of f.events.get("accounts:topology:v1") ?? [])
      handler({ reply: (value) => { topology = value; } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(topology.providers.map((provider) => provider.providerId), [CODEX]);
    let activation;
    for (const handler of f.events.get("accounts:activation:v1") ?? []) {
      handler({ session: f.ctx.sessionManager, provider: "openai", account: "alpha",
        reply: (value) => { activation = value; } });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(activation.code, "provider_unsupported");
    const stored = JSON.parse(JSON.stringify((await f.store.readAsync()).providers.openai));
    assert.deepEqual(stored, LEGACY_OPENAI);
    await f.fire("session_shutdown");
    assert.deepEqual(f.registry.getRegisteredProviderConfig("openai"), f.configBeforeExtension);
  } finally { await dispose(f); }
});

test("a Codex store write leaves an existing providers.openai section on disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pae-openai-legacy-store-"));
  const file = join(dir, "pi-accounts.json");
  const legacy = { ...structuredClone(LEGACY_OPENAI), extra: { keep: [1, 2, 3] } };
  const initial = { version: 1, providers: { openai: legacy } };
  await writeFile(file, JSON.stringify(initial), { mode: 0o600 });
  const store = new AccountStore(new storageModule.FileAccountStorageBackend(file));
  const f = await fixture({ store });
  try {
    const manage = (request) =>
      f.service.manageAccount({ ...request, sessionId: f.sessionId, providerId: CODEX });
    await manage({ operation: "default", accountId: "Work" });
    await manage({ operation: "rename", accountId: "Work", label: "Work grant" });
    assert.equal((await switchRequest(f, "beta", "legacy-store-beta", 2)).ok, true);
    const stored = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(stored.providers.openai, legacy, "providers.openai is preserved unchanged");
    assert.equal(stored.providers[CODEX].active, "Work");
    assert.equal(stored.providers[CODEX].accounts.Work.label, "Work grant");
  } finally {
    await dispose(f);
    await rm(dir, { recursive: true, force: true });
  }
});

test("session reload restores only current branch account and routing entries", async () => {
  const f = await fixture();
  try {
    const selected = await switchRequest(f, "alpha", "branch-alpha");
    assert.equal(selected.ok, true);
    const currentBranch = [...f.branch];
    const globalAccounts = await f.store.readAsync();
    const abandoned = await switchRequest(
      f, "beta", "branch-beta", selected.snapshot.selectionRevision);
    assert.equal(abandoned.ok, true);
    const abandonedRoute = routingModule.getSessionRoutingProfile(f.ctx);
    assert.ok(f.entries.length > currentBranch.length - 1);
    f.branch = currentBranch;
    await f.fire("session_tree");
    const snapshot = await snapshotOf(f);
    assert.equal(snapshot.currentAccountId, "alpha");
    const staleReplay = await switchRequest(f, "alpha", "branch-alpha");
    assert.equal(staleReplay.ok, false, "branch navigation must not replay an abandoned admission");
    assert.equal(staleReplay.reason, "stale-selection");
    const profile = await prepareSessionRoutingRequest(f.ctx);
    assert.equal(profile.accountId, "alpha");
    assert.ok(profile.revision > abandonedRoute.revision,
      "restored branch must publish a fresh revision rather than replay abandoned state");
    assert.deepEqual(await f.store.readAsync(), globalAccounts,
      "branch selection and restoration must not mutate global account defaults");
    assert.equal(f.codexDelegated.length, 0,
      "branch restoration must not dispatch a model request");
  } finally { await dispose(f); }
});

test("Pi SDK gates Codex dispatch and cheap Luna compaction with the named grant", async () => {
  const f = await fixture();
  try {
    const changed = await switchRequest(f, "alpha", "switch-alpha");
    assert.equal(changed.ok, true);
    assert.equal(f.codexDelegated.length, 0, "account switching must not issue a model call");
    assert.equal(changed.snapshot.usage.effectiveCredential, "chatgpt-grant-matched-refreshed");
    assert.equal(changed.snapshot.usage.status, "local-binding-confirmed");
    assert.equal(changed.snapshot.usage.remoteEntitlement, "not-queried");
    assert.equal(JSON.stringify(changed.snapshot).includes(ALPHA), false);
    const model = f.role();
    const response = await dispatch(f, model);
    assert.equal(response.stopReason, "stop", JSON.stringify({ response,
      errors: f.providerErrors.map((error) => error.stack) }));
    assert.deepEqual(f.codexDelegated.map(({ id }) => id), [ROLE]);
    assert.equal(f.codexDelegated[0].apiKey, ALPHA);

    const old = Date.now() - 60 * 60_000;
    const event = {
      type: "session_before_compact", reason: "manual", willRetry: false,
      signal: new AbortController().signal,
      branchEntries: [{ type: "message", id: "prior", parentId: null,
        timestamp: new Date(old).toISOString(), message: {
          role: "assistant", model: ROLE, provider: CODEX, timestamp: old, stopReason: "stop",
          content: [{ type: "text", text: "prior history" }],
        } }],
      customInstructions: "",
      preparation: {
        firstKeptEntryId: "kept",
        messagesToSummarize: [{ role: "user", content: "keep the goal", timestamp: old }],
        turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 100,
        fileOps: { read: new Set(), edited: new Set(), written: new Set() },
        settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 2000 },
      },
    };
    f.ctx.model = model;
    const selectedConversationModel = f.ctx.model;
    const compaction = await compactionModule.beforeCompact(event, f.ctx, () => ({
      idleMinutes: 30, contextPercent: 20, cheapCompactionModel: `${CODEX}/${CHEAP}:low`,
    }));
    assert.ok(compaction?.compaction);
    assert.equal(f.ctx.model, selectedConversationModel,
      "cheap compaction must preserve the selected conversation model");
    assert.equal(f.codexDelegated.at(-1).id, CHEAP);
    assert.equal(f.codexDelegated.at(-1).apiKey, ALPHA);
    const restored = await switchRequest(
      f, null, "restore-default", changed.snapshot.selectionRevision);
    assert.equal(restored.ok, true);
    assert.equal(restored.snapshot.defaultSelected, true);
    assert.equal(restored.snapshot.usage.remoteEntitlement, "not-queried");
    const config = f.registry.getRegisteredProviderConfig(CODEX);
    assert.equal(config.baseUrl, CODEX_URL);
    assert.equal(config.headers["X-Codex-Config"], "preserved");
    assert.equal((await f.store.readAsync()).providers["other-provider"].active, "kept");
  } finally { await dispose(f); }
});

test("stale Accounts routing callbacks fail closed before unregister on session replacement",
  async () => {
    const f = await fixture();
    try {
      await f.fire("model_select", { model: f.role() });
      f.sessionId = "replacement-session";
      assert.throws(() => routingModule.getSessionRoutingProfile(f.ctx),
        /Accounts routing owner is stale/);
      await f.fire("session_shutdown");
      assert.equal(routingModule.getSessionRoutingProfile(f.ctx), undefined,
        "shutdown unregisters Accounts ownership and retains no stale profile");
    } finally { await dispose(f); }
  });

test("failed routing history publication revokes descriptor and blocks main/helper routing",
  async () => {
    const f = await fixture();
    try {
      const append = f.ctx.sessionManager.appendCustomEntry;
      f.ctx.sessionManager.appendCustomEntry = function (customType, data) {
        if (customType === "pi-session-routing-profile")
          throw new Error("fixture history write failure");
        return append.call(this, customType, data);
      };
      const switched = await switchRequest(f, "alpha", "routing-publication-fails");
      assert.equal(switched.ok, false);
      assert.equal(switched.reason, "activation-failed");
      assert.throws(() => routingModule.readSessionRoutingProfile(
        routingModule.routingProfilePath(f.root, f.sessionId), f.sessionId));
      assert.throws(() => resolveSessionProvider(f.ctx), /routing is unavailable/);
      assert.equal((await dispatch(f)).stopReason, "error");
      assert.equal(f.codexDelegated.length, 0);
    } finally { await dispose(f); }
  });

test("legacy alias bootstraps account routing from an explicit physical model", async () => {
  const f = await fixture({ legacyBootstrap: true });
  try {
    assert.equal(f.ctx.model.provider, "idle-guard",
      "account bootstrap alone must not bypass explicit legacy migration");
    const profile = routingModule.getSessionRoutingProfile(f.ctx);
    assert.equal(profile.providerId, CODEX);
    assert.equal(profile.accountId, null);
    assert.equal(profile.ownerSessionId, f.sessionId);
  } finally { await dispose(f); }
});

test("physical model selection publishes credential-free session routing and switches revise it",
  async () => {
    const f = await fixture();
    try {
      await f.fire("model_select", { model: f.role() });
      const profile = routingModule.getSessionRoutingProfile(f.ctx);
      assert.equal(profile.providerId, CODEX);
      assert.equal(profile.accountId, null);
      assert.equal(profile.ownerSessionId, f.sessionId);
      const file = routingModule.routingProfilePath(f.root, f.sessionId);
      const persisted = routingModule.readSessionRoutingProfile(file, f.sessionId);
      assert.deepEqual(persisted, profile);
      const changed = await switchRequest(f, "alpha", "routing-account-alpha");
      assert.equal(changed.ok, true);
      const updated = routingModule.getSessionRoutingProfile(f.ctx);
      assert.equal(updated.accountId, "alpha");
      assert.ok(updated.revision > profile.revision);
      assert.equal(JSON.stringify(updated).includes(ALPHA), false);
      assertNoRemovedFields(await snapshotOf(f));
      const routeEntries = f.entries.filter(
        (entry) => entry.customType === "pi-session-routing-profile");
      assert.ok(routeEntries.length > 0);
    } finally { await dispose(f); }
  });

test("retained helper requests inherit the parent's named account without credential IPC",
  async () => {
    const parent = await fixture();
    let child, pause;
    const previousFile = process.env[SESSION_ROUTING_FILE_ENV];
    const previousOwner = process.env[SESSION_ROUTING_OWNER_ENV];
    const asParent = async (action) => {
      const active = globalThis.__paeAccountControlsV1;
      globalThis.__paeAccountControlsV1 = parent.service;
      try { return await action(); } finally { globalThis.__paeAccountControlsV1 = active; }
    };
    try {
      await parent.fire("model_select", { model: parent.role() });
      assert.equal((await switchRequest(parent, "alpha", "parent-route-alpha")).ok, true);
      process.env[SESSION_ROUTING_FILE_ENV] =
        routingModule.routingProfilePath(parent.root, parent.sessionId);
      process.env[SESSION_ROUTING_OWNER_ENV] = parent.sessionId;
      child = await fixture({ store: parent.store, sessionId: "retained-helper-session" });
      assert.equal(child.ctx.model.provider, CODEX);
      assert.equal(child.ctx.model.id, ROLE);
      const profile = await prepareSessionRoutingRequest(child.ctx);
      assert.equal(profile.providerId, CODEX);
      assert.equal(profile.accountId, "alpha");
      assert.equal(JSON.stringify(profile).includes(ALPHA), false);
      assert.equal(JSON.stringify(profile).includes("Authorization"), false);
      const childSnapshot = await snapshotOf(child);
      assert.equal(childSnapshot.busy, false);
      assert.equal(childSnapshot.canSwitch, true);
      assert.equal(childSnapshot.inheritance, "inherited");
      assert.equal((await prepareSessionRoutingRequest(child.ctx)).accountId, "alpha");
      const boundAlphaModel = bindSessionModelRequest(child.role(), profile);
      assert.equal(JSON.stringify(boundAlphaModel).includes(ALPHA), false);
      assert.equal((await asParent(
        () => switchRequest(parent, "beta", "parent-route-beta", 1))).ok, true);
      const refreshedSnapshot = await snapshotOf(child);
      assert.equal(refreshedSnapshot.currentAccountId, "beta",
        "idle helper snapshots refresh inherited account state");
      const beforeStale = child.codexDelegated.length;
      assert.equal((await dispatch(child, boundAlphaModel)).stopReason, "error");
      assert.equal(child.codexDelegated.length, beforeStale,
        "stale bound account is rejected before provider dispatch");
      const nextProfile = await prepareSessionRoutingRequest(child.ctx);
      assert.equal(nextProfile.accountId, "beta");
      assert.ok(nextProfile.revision > profile.revision);
      const boundBetaModel = bindSessionModelRequest(child.role(), nextProfile);
      const finalAuthPause = child.pauseFinalAuth();
      const beforeFinalCheck = child.codexDelegated.length;
      const staleAtPayload = dispatch(child, boundBetaModel);
      await finalAuthPause.started;
      assert.equal((await asParent(
        () => switchRequest(parent, "alpha", "parent-route-alpha-at-payload", 2))).ok, true);
      finalAuthPause.release();
      assert.equal((await staleAtPayload).stopReason, "error");
      assert.equal(child.codexDelegated.length, beforeFinalCheck,
        "onPayload rejects changed route before provider dispatch");
      const heldProfile = await prepareSessionRoutingRequest(child.ctx);
      const heldModel = bindSessionModelRequest(child.role(), heldProfile);
      pause = child.pauseProvider();
      const heldStream = dispatch(child, heldModel);
      await pause.started;
      const busyChild = await snapshotOf(child);
      assert.equal(busyChild.busy, true);
      const deniedSwitch = await switchRequest(child, "beta", "child-inflight-cannot-reroute",
        busyChild.selectionRevision);
      assert.equal(deniedSwitch.ok, false);
      assert.equal(deniedSwitch.reason, "busy");
      const deniedClear = await child.service.switchAccount({
        protocol: 1, providerId: CODEX, requestId: "child-inflight-cannot-clear",
        expectedSessionId: child.sessionId, expectedServiceEpoch: busyChild.serviceEpoch,
        expectedSelectionRevision: busyChild.selectionRevision, accountId: null, inherit: true,
      });
      assert.equal(deniedClear.ok, false);
      assert.equal(deniedClear.reason, "busy");
      assert.equal((await asParent(
        () => switchRequest(parent, "beta", "parent-route-beta-again", 3))).ok, true);
      pause.release();
      assert.equal((await heldStream).stopReason, "stop");
      assert.equal(child.codexDelegated.at(-1).apiKey, ALPHA,
        "already-dispatched helper request retains captured credentials");
      pause = undefined;
      const fresh = await dispatch(child, bindSessionModelRequest(child.role(),
        await prepareSessionRoutingRequest(child.ctx)));
      assert.equal(fresh.stopReason, "stop");
      assert.equal(child.codexDelegated.at(-1).apiKey, BETA);
    } finally {
      pause?.release();
      if (previousFile === undefined) delete process.env[SESSION_ROUTING_FILE_ENV];
      else process.env[SESSION_ROUTING_FILE_ENV] = previousFile;
      if (previousOwner === undefined) delete process.env[SESSION_ROUTING_OWNER_ENV];
      else process.env[SESSION_ROUTING_OWNER_ENV] = previousOwner;
      if (child) await dispose(child);
      await dispose(parent);
    }
  });

test("a Codex child of a session on plain openai fails closed instead of using either login",
  async () => {
    const parent = await fixture({ openaiSession: true });
    let child;
    const previousFile = process.env[SESSION_ROUTING_FILE_ENV];
    const previousOwner = process.env[SESSION_ROUTING_OWNER_ENV];
    try {
      assert.equal(routingModule.getSessionRoutingProfile(parent.ctx).providerId, "openai");
      process.env[SESSION_ROUTING_FILE_ENV] =
        routingModule.routingProfilePath(parent.root, parent.sessionId);
      process.env[SESSION_ROUTING_OWNER_ENV] = parent.sessionId;
      child = await fixture({ store: parent.store, sessionId: "codex-child-of-openai" });
      assert.equal(child.startupError, undefined);
      assert.equal(child.ctx.model.provider, CODEX);
      const result = await dispatch(child);
      assert.equal(result.stopReason, "error");
      assert.equal(child.codexDelegated.length + child.openaiDelegated.length, 0);
    } finally {
      if (previousFile === undefined) delete process.env[SESSION_ROUTING_FILE_ENV];
      else process.env[SESSION_ROUTING_FILE_ENV] = previousFile;
      if (previousOwner === undefined) delete process.env[SESSION_ROUTING_OWNER_ENV];
      else process.env[SESSION_ROUTING_OWNER_ENV] = previousOwner;
      if (child) await dispose(child);
      await dispose(parent);
    }
  });

test("child overrides govern only their subtree, survive reload and clear separately from default",
  async () => {
    const saved = { file: process.env[SESSION_ROUTING_FILE_ENV],
      owner: process.env[SESSION_ROUTING_OWNER_ENV], service: globalThis.__paeAccountControlsV1 };
    const all = [];
    const scope = async (f, parent, action) => {
      if (parent) {
        process.env[SESSION_ROUTING_FILE_ENV] =
          routingModule.routingProfilePath(parent.root, parent.sessionId);
        process.env[SESSION_ROUTING_OWNER_ENV] = parent.sessionId;
      } else {
        delete process.env[SESSION_ROUTING_FILE_ENV];
        delete process.env[SESSION_ROUTING_OWNER_ENV];
      }
      if (f) {
        globalThis.__paeAccountControlsV1 = f.service;
        process.env.PI_CODING_AGENT_DIR = f.root;
      }
      return action();
    };
    const create = async (id, parent) => scope(undefined, parent, async () => {
      const f = await fixture({ sessionId: id, ...(parent ? { store: parent.store } : {}) });
      all.push(f);
      assert.equal(f.startupError, undefined);
      return f;
    });
    const route = (f, parent) => scope(f, parent, () => prepareSessionRoutingRequest(f.ctx));
    const choose = (f, parent, accountId, inherit = false) => scope(f, parent, async () => {
      const snapshot = await snapshotOf(f);
      const result = await f.service.switchAccount({
        protocol: 1, providerId: CODEX, requestId: `subtree-${Math.random()}`,
        expectedSessionId: f.sessionId, expectedServiceEpoch: snapshot.serviceEpoch,
        expectedSelectionRevision: snapshot.selectionRevision, accountId,
        ...(inherit ? { inherit: true } : {}),
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      return result;
    });
    try {
      const root = await create("subtree-root");
      await choose(root, undefined, "alpha");
      const child = await create("subtree-child", root);
      const inheritedBranch = [...child.branch];
      const sibling = await create("subtree-sibling", root);
      const grandchild = await create("subtree-grandchild", child);
      assert.equal((await route(grandchild, child)).accountId, "alpha");
      await choose(child, root, "Work");
      assert.equal(child.ctx.model.provider, CODEX);
      assert.equal((await route(root)).accountId, "alpha");
      assert.equal((await route(sibling, root)).accountId, "alpha");
      assert.equal((await route(grandchild, child)).accountId, "Work");
      const nativeRole = grandchild.ctx.model;
      const response = await scope(grandchild, child, () => dispatch(grandchild, nativeRole));
      assert.equal(response.stopReason, "stop", JSON.stringify(response));
      assert.equal(grandchild.ctx.model, nativeRole,
        "inherited routing never replaces native role identity");
      assert.equal(grandchild.codexDelegated.at(-1).apiKey, WORK);
      const future = await create("subtree-future", child);
      assert.equal((await route(future, child)).accountId, "Work");
      await choose(root, undefined, "beta");
      assert.equal((await route(child, root)).accountId, "Work");
      assert.equal((await route(sibling, root)).accountId, "beta");
      await scope(child, undefined, () => child.fire("session_start"));
      assert.equal((await route(child, root)).accountId, "Work",
        "local override survives extension reload");
      const nativeSelect = grandchild.ctx.ui.select;
      let choices = ["Restore default Pi login", "Close"];
      grandchild.ctx.ui.select = async (_title, options) => {
        const answer = choices.shift();
        assert.ok(options.includes(answer), answer);
        return answer;
      };
      const openMenu = () => scope(grandchild, child,
        () => grandchild.commands.get("accounts").handler("", grandchild.ctx));
      await openMenu();
      assert.equal((await route(grandchild, child)).accountId, null,
        "native TUI default is an explicit built-in login choice");
      await choose(child, root, null, true);
      assert.equal((await route(child, root)).accountId, "beta");
      const firstClearProfile = await route(future, child);
      assert.equal(firstClearProfile.accountId, "beta");
      const earlierClearBranch = [...child.branch];
      await choose(child, root, "Work");
      const overrideProfile = await route(future, child);
      assert.equal(overrideProfile.accountId, "Work");
      assert.ok(overrideProfile.revision > firstClearProfile.revision);
      await choose(child, root, null, true);
      const laterClearProfile = await route(future, child);
      assert.ok(laterClearProfile.revision > overrideProfile.revision);
      child.branch = inheritedBranch;
      await scope(child, undefined, () => child.fire("session_tree"));
      const restoredInherited = await route(future, child);
      assert.equal(restoredInherited.accountId, "beta");
      assert.ok(restoredInherited.revision > laterClearProfile.revision,
        "restoring an earlier inherited branch publishes a fresh epoch for existing descendants");
      child.branch = earlierClearBranch;
      await scope(child, undefined, () => child.fire("session_tree"));
      const restoredClear = await route(future, child);
      assert.equal(restoredClear.accountId, "beta");
      assert.ok(restoredClear.revision > restoredInherited.revision,
        "historical clear offset is intent, never a replayable publication epoch");
      await scope(child, undefined, () => child.fire("session_start"));
      const resumedInherited = await route(future, child);
      assert.equal(resumedInherited.ownerSessionId, restoredClear.ownerSessionId);
      assert.equal(resumedInherited.providerId, restoredClear.providerId);
      assert.equal(resumedInherited.accountId, "beta");
      assert.ok(resumedInherited.revision > restoredClear.revision,
        "resume preserves auth scope but advances the restored inheritance epoch");
      assert.equal((await route(grandchild, child)).accountId, null,
        "grandchild explicit default survives parent clear and history restore");
      choices = ["Follow parent account", "Close"];
      await openMenu();
      grandchild.ctx.ui.select = nativeSelect;
      assert.equal((await route(grandchild, child)).accountId, "beta");
      await scope(grandchild, undefined, () => grandchild.fire("session_start"));
      assert.equal((await route(grandchild, child)).accountId, "beta",
        "clear persists through reload");
      await choose(root, undefined, "alpha");
      assert.equal((await route(grandchild, child)).accountId, "alpha",
        "cleared chain follows later ancestor changes");
      await route(child, root);
      const stableRoot = await route(root);
      const rootFile = routingModule.routingProfilePath(root.root, root.sessionId);
      const regressed = { ...stableRoot, revision: stableRoot.revision - 1 };
      routingModule.writeSessionRoutingProfile(rootFile, regressed);
      try {
        const restart = scope(child, undefined, () => child.fire("session_start"));
        await assert.rejects(restart, /regressed/,
          "fresh branch epochs must not mask an actually regressed ancestor descriptor");
      } finally { routingModule.writeSessionRoutingProfile(rootFile, stableRoot); }
      await scope(child, undefined, () => child.fire("session_start"));
      assert.equal((await route(future, child)).accountId, "alpha");
    } finally {
      for (const f of all.reverse()) await dispose(f);
      if (saved.file === undefined) delete process.env[SESSION_ROUTING_FILE_ENV];
      else process.env[SESSION_ROUTING_FILE_ENV] = saved.file;
      if (saved.owner === undefined) delete process.env[SESSION_ROUTING_OWNER_ENV];
      else process.env[SESSION_ROUTING_OWNER_ENV] = saved.owner;
      globalThis.__paeAccountControlsV1 = saved.service;
    }
  });

test("Codex switch preflight leaves account and openai model unchanged without a Codex role model",
  async () => {
    const f = await fixture({ noCodexRoleModel: true });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      const rejected = await switchRequest(f, "Work", "no-matching-codex-role", 0);
      assert.equal(rejected.ok, false);
      assert.equal(rejected.reason, "activation-failed");
      assert.equal(rejected.snapshot.selectionRevision, 0);
      assert.equal(f.ctx.model.provider, "openai");
      assert.equal(routingModule.getSessionRoutingProfile(f.ctx).providerId, "openai");
    } finally { await dispose(f); }
  });

test("/accounts leaves selection unchanged when Codex has no exact role model", async () => {
  const f = await fixture({ noCodexRoleModel: true });
  try {
    const choices = ["Switch account", "Work", "Close"];
    f.ctx.ui.select = async () => choices.shift();
    await f.commands.get("accounts").handler("", f.ctx);
    const snapshot = await snapshotOf(f);
    assert.equal(snapshot.selectionRevision, 0);
    assert.equal(snapshot.currentAccountId, null);
    assert.equal(f.ctx.model.provider, "openai");
    assert.equal(routingModule.getSessionRoutingProfile(f.ctx).providerId, "openai");
  } finally { await dispose(f); }
});

test("/accounts Codex selection moves the session to openai-codex with the same role model ID",
  async () => {
    const f = await fixture({ openaiSession: true });
    try {
      const roleModelId = f.ctx.model.id;
      assert.equal(f.ctx.model.provider, "openai");
      const choices = ["Switch account", "Work", "Close"];
      f.ctx.ui.select = async () => choices.shift();
      await f.commands.get("accounts").handler("", f.ctx);
      assert.equal(f.ctx.model.provider, CODEX, JSON.stringify(f.notices));
      assert.equal(f.ctx.model.id, roleModelId);
      assert.equal(routingModule.getSessionRoutingProfile(f.ctx).providerId, CODEX);
      assert.equal(routingModule.getSessionRoutingProfile(f.ctx).accountId, "Work");
    } finally { await dispose(f); }
  });

test("independent Pi ModelRuntime instances do not share selected credentials", async () => {
  const left = await fixture();
  let right;
  try {
    assert.equal((await switchRequest(left, "alpha", "left-alpha")).ok, true);
    right = await fixture();
    assert.equal((await switchRequest(right, "beta", "right-beta")).ok, true);
    assert.equal((await dispatch(right)).stopReason, "stop");
    assert.equal(right.codexDelegated.at(-1).apiKey, BETA);
    assert.equal((await dispatch(left)).stopReason, "stop");
    assert.equal(left.codexDelegated.at(-1).apiKey, ALPHA);
  } finally {
    if (right) await dispose(right);
    await dispose(left);
  }
});

test("explicit default replays exactly while clear-inheritance reuse is a conflict", async () => {
  const f = await fixture();
  try {
    const first = await switchRequest(f, null, "shared-request-id");
    assert.equal(first.ok, true);
    assert.equal(first.snapshot.currentAccountId, null);
    assert.equal(first.snapshot.selectionRevision, 1);
    assert.equal(first.snapshot.usage.status, "local-binding-confirmed");
    assert.match(first.snapshot.usage.accountKey, /^[a-f0-9]{64}$/);
    assertNoRemovedFields(first.snapshot);
    assert.deepEqual(await switchRequest(f, null, "shared-request-id"), first);
    const clearConflict = await f.service.switchAccount({
      protocol: 1, providerId: CODEX, requestId: "shared-request-id",
      expectedSessionId: f.sessionId, expectedServiceEpoch: f.initial.serviceEpoch,
      expectedSelectionRevision: 0, accountId: null, inherit: true,
    });
    assert.equal(clearConflict.ok, false);
    assert.equal(clearConflict.reason, "request-id-conflict",
      "clear inheritance is not an exact retry of explicit default");
    const stale = await switchRequest(f, null, "stale-codex", 0);
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, "stale-selection");
    assert.equal((await snapshotOf(f)).selectionRevision, 1);
  } finally { await dispose(f); }
});

test("Codex default account proof is withheld under runtime, environment and API-key overrides",
  async () => {
    const registered = await fixture({ codexApiKeyOverride: "fixture-registered-override" });
    let noStored;
    try {
      const snapshot = await snapshotOf(registered);
      assert.equal(snapshot.usage.accountKey, undefined);
      assert.equal(snapshot.usage.status, "unknown");
    } finally { await dispose(registered); }
    const priorKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "fixture-environment-key";
    try {
      noStored = await fixture({ codexPersonalAuth: false });
      await writeFile(join(noStored.root, "models.json"), JSON.stringify({
        providers: { [CODEX]: { apiKey: "${OPENAI_API_KEY}" } },
      }), { mode: 0o600 });
      const environment = await snapshotOf(noStored);
      assert.equal(environment.usage.accountKey, undefined);
      assert.equal(environment.usage.status, "unknown");
      await noStored.runtime.setRuntimeApiKey(CODEX, "fixture-runtime-override");
      const runtime = await snapshotOf(noStored);
      assert.equal(runtime.usage.accountKey, undefined);
      assert.equal(runtime.usage.status, "unknown");
    } finally {
      if (noStored) await dispose(noStored);
      if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = priorKey;
    }
  });

test("Codex native stream dispatch uses the selected Work OAuth grant, not the personal default",
  async () => {
    const f = await fixture();
    try {
      const before = await snapshotOf(f);
      assert.equal(before.usage.status, "local-binding-confirmed");
      const personalKey = before.usage.accountKey;
      const defaultConfig = f.registry.getRegisteredProviderConfig(CODEX);
      const authBefore = await readFile(join(f.root, "auth.json"), "utf8");
      const changed = await switchRequest(f, "Work", "codex-work", 0);
      assert.equal(changed.ok, true, JSON.stringify(changed));
      assert.notEqual(changed.snapshot.usage.accountKey, personalKey);
      const model = f.registry.find(CODEX, f.codexModel.id);
      const result = await dispatch(f, model);
      assert.equal(result.stopReason, "stop", JSON.stringify(result));
      assert.equal(f.codexDelegated.at(-1).apiKey, WORK);
      assert.equal(f.codexDelegated.at(-1).baseUrl, CODEX_URL);
      assert.doesNotMatch(JSON.stringify(changed.snapshot), /fixture-work|fixture-personal/);
      const headers = f.registry.getRegisteredProviderConfig(CODEX).headers;
      assert.equal(headers["X-Codex-Config"], "preserved");
      const restored = await switchRequest(f, null, "codex-default", 1);
      assert.equal(restored.ok, true);
      assert.equal(restored.snapshot.usage.accountKey, personalKey);
      assertNoRemovedFields(restored.snapshot);
      const defaultResult = await dispatch(f, model);
      assert.equal(defaultResult.stopReason, "stop", JSON.stringify(defaultResult));
      assert.equal(f.codexDelegated.at(-1).apiKey, PERSONAL);
      assert.equal(f.registry.getRegisteredProviderConfig(CODEX).baseUrl, CODEX_URL);
      assert.deepEqual(f.registry.getRegisteredProviderConfig(CODEX), defaultConfig);
      assert.equal(await readFile(join(f.root, "auth.json"), "utf8"), authBefore);
    } finally { await dispose(f); }
  });

test("deleted Codex Work account blocks dispatch instead of falling back to the personal grant",
  async () => {
    const f = await fixture();
    try {
      await new Promise((resolve) => setImmediate(resolve));
      const selected = await switchRequest(f, "Work", "codex-select-work", 0);
      assert.equal(selected.ok, true, JSON.stringify(selected));
      const calls = f.codexDelegated.length;
      await f.store.updateProvider(CODEX, (state) => ({ ...state, accounts: {} }));
      const result = await dispatch(f, f.registry.find(CODEX, f.codexModel.id));
      assert.equal(result.stopReason, "error");
      assert.equal(f.codexDelegated.length, calls);
      assert.notEqual(await f.registry.getApiKeyForProvider(CODEX), PERSONAL);
    } finally { await dispose(f); }
  });

test("Codex gate blocks an Authorization override changed during payload validation", async () => {
  const f = await fixture();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await switchRequest(f, "Work", "codex-override-work", 0)).ok, true);
    const calls = f.codexDelegated.length;
    const model = f.registry.find(CODEX, f.codexModel.id);
    const result = await dispatch(f, model, { onPayload: async (payload) => {
      const config = f.registry.getRegisteredProviderConfig(CODEX);
      f.registry.registerProvider(CODEX,
        { ...config, headers: { ...config.headers, Authorization: `Bearer ${PERSONAL}` } });
      return payload;
    } });
    assert.equal(result.stopReason, "error");
    assert.equal(f.codexDelegated.length, calls);
  } finally { await dispose(f); }
});

test("busy Codex dispatch blocks switching without leaking the selected identity", async () => {
  const f = await fixture();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    const selected = await switchRequest(f, "Work", "codex-busy-work", 0);
    assert.equal(selected.ok, true, JSON.stringify(selected));
    const pause = f.pauseFinalAuth();
    const stream = dispatch(f, f.registry.find(CODEX, f.codexModel.id));
    await pause.started;
    const codexSwitch = await switchRequest(f, null, "codex-busy-switch", 1);
    assert.equal(codexSwitch.reason, "busy");
    await assert.rejects(f.service.switchAccount({
      protocol: 1, providerId: "openai", requestId: "openai-busy-switch",
      expectedSessionId: f.sessionId, expectedServiceEpoch: f.initial.serviceEpoch,
      expectedSelectionRevision: 0, accountId: "alpha",
    }), /unsupported-provider/);
    assert.equal((await snapshotOf(f)).currentAccountId, "Work");
    pause.release();
    assert.equal((await stream).stopReason, "stop");
    assert.equal(f.codexDelegated.at(-1).apiKey, WORK);
  } finally { await dispose(f); }
});

test("a separately registered native openai provider is left alone and does not block Codex",
  async () => {
    const f = await fixture({ customNativeProvider: true });
    try {
      assert.equal(f.startupError, undefined);
      assert.equal(f.registry.getRegisteredNativeProvider("openai"), f.nativeBeforeExtension);
      assert.deepEqual(f.registry.getRegisteredProviderConfig("openai"), f.configBeforeExtension);
      assert.equal((await snapshotOf(f)).providerId, CODEX);
    } finally { await dispose(f); }
  });

test("a separately registered native Codex provider is rejected without replacement", async () => {
  const f = await fixture({ customNativeCodexProvider: true });
  try {
    assert.match(f.startupError?.message ?? "",
      /separately registered native OpenAI Codex provider/);
    assert.equal(f.registry.getRegisteredNativeProvider(CODEX), f.codexNativeBeforeExtension);
    assert.deepEqual(f.registry.getRegisteredProviderConfig(CODEX), f.codexConfigBeforeExtension);
    await assert.rejects(snapshotOf(f), /stale-session/);
  } finally { await dispose(f); }
});

test("same-session startup/resume restores its saved selection", async () => {
  const f = await fixture();
  try {
    assert.equal((await switchRequest(f, "alpha", "resume-alpha")).ok, true);
    assert.equal((await snapshotOf(f)).currentAccountId, "alpha");
    await f.fire("session_start");
    await f.fire("before_agent_start", { prompt: "resume" });
    const resumed = await snapshotOf(f);
    assert.equal(resumed.currentAccountId, "alpha");
    assert.equal(resumed.defaultSelected, false);
    assert.equal(JSON.stringify(resumed).includes(ALPHA), false);
  } finally { await dispose(f); }
});

test("an older session's openai selection is ignored on restore", async () => {
  const f = await fixture();
  try {
    f.branch.push({ type: "custom", id: "legacy-selection", customType: "pi-accounts-selection",
      timestamp: new Date().toISOString(),
      data: {
        version: 1, sessionId: f.sessionId, providers: { openai: "alpha", [CODEX]: "Work" },
      } });
    await f.fire("session_tree");
    let restored = await snapshotOf(f);
    for (let attempt = 0; restored.busy && attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      restored = await snapshotOf(f);
    }
    assert.equal(restored.currentAccountId, "Work");
    const switched = await switchRequest(f, "beta", "after-legacy", restored.selectionRevision);
    assert.equal(switched.ok, true, JSON.stringify(switched));
    const latest = f.entries.filter((entry) => entry.customType === "pi-accounts-selection").at(-1);
    assert.deepEqual(Object.keys(latest.data.providers), [CODEX]);
  } finally { await dispose(f); }
});

test("legacy idle alias migration retains the named account and uses ordinary Codex dispatch",
  async () => {
    const { installLegacyMigration } = await load.import("../idle-context-warning/migration.ts");
    const f = await fixture();
    try {
      assert.equal((await switchRequest(f, "alpha", "migration-alpha")).ok, true);
      installLegacyMigration(f.pi, () => ({
        idleMinutes: 30, contextPercent: 20, guardedModels: { astra: `${CODEX}/${ROLE}` },
      }), join(f.root, "aliases.json"));
      f.ctx.model = { provider: "idle-guard", id: "astra", api: "pi-virtual" };
      await f.fire("session_start");
      assert.equal(f.ctx.model.provider, CODEX);
      assert.equal(f.ctx.model.id, ROLE);
      assert.equal((await snapshotOf(f)).currentAccountId, "alpha");
      assert.equal(routingModule.getSessionRoutingProfile(f.ctx).providerId, CODEX);
      const result = await dispatch(f, f.ctx.model);
      assert.equal(result.stopReason, "stop", JSON.stringify(result));
      assert.equal(f.codexDelegated.at(-1).apiKey, ALPHA);
      assert.equal(f.registry.find("idle-guard-proxy", "astra").api, "pi-virtual",
        "legacy proxy is only a closed migration sentinel");
    } finally { await dispose(f); }
  });

test("Codex gate rejects a named grant replaced during pre-dispatch auth resolution", async () => {
  const f = await fixture();
  try {
    assert.equal((await switchRequest(f, "alpha", "replace-alpha")).ok, true);
    const pause = f.pauseDispatchAuth();
    const before = f.codexDelegated.length;
    const pending = dispatch(f);
    await pause.started;
    const replacement = jwtToken("alpha-account", "replacement-subject");
    await f.store.updateProvider(CODEX, (state) => ({
      ...state,
      accounts: Object.assign(Object.create(null), state.accounts,
        { alpha: oauthCredential("alpha", replacement) }),
    }));
    pause.release();
    assert.equal((await pending).stopReason, "error");
    assert.equal(f.codexDelegated.length, before);
    assert.equal(JSON.stringify(await snapshotOf(f)).includes(replacement), false);
  } finally { await dispose(f); }
});

test("an idle-looking direct request in flight still blocks account switching", async () => {
  const f = await fixture();
  try {
    assert.equal((await switchRequest(f, "alpha", "inflight-alpha")).ok, true);
    const pause = f.pauseProvider();
    const streamResult = dispatch(f, f.registry.find(CODEX, CHEAP));
    await pause.started;
    assert.equal(f.idle, true);
    const result = await switchRequest(f, "beta", "inflight-switch", 1);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "busy");
    assert.equal(result.snapshot.selectionRevision, 1);
    pause.release();
    assert.equal((await streamResult).stopReason, "stop");
  } finally { await dispose(f); }
});

test("request gate fails closed when the selected account disappears", async () => {
  const f = await fixture();
  try {
    assert.equal((await switchRequest(f, "alpha", "select-alpha")).ok, true);
    const count = f.codexDelegated.length;
    const replacement = jwtToken("alpha-account", "replacement-not-active");
    await f.store.updateProvider(CODEX, (state) => ({
      ...state,
      accounts: Object.assign(Object.create(null), state.accounts,
        { alpha: oauthCredential("alpha", replacement) }),
    }));
    const replacedSnapshot = await snapshotOf(f);
    assert.equal(replacedSnapshot.currentAccountId, "alpha");
    assert.equal(replacedSnapshot.usage.effectiveCredential, "unavailable");
    await f.store.updateProvider(CODEX, (state) => {
      const accounts = Object.assign(Object.create(null), state.accounts);
      delete accounts.alpha;
      return { ...state, accounts };
    });
    assert.equal((await dispatch(f)).stopReason, "error");
    assert.equal(f.codexDelegated.length, count);
    assert.notEqual(await f.registry.getApiKeyForProvider(CODEX), PERSONAL);
  } finally { await dispose(f); }
});

test("service serializes competing revisions, rejects busy-after-await, replays exact IDs",
  async () => {
    const f = await fixture();
    try {
      let pauseNext = false;
      let entered, release;
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
      let busyEntered, releaseBusy;
      const busyEnteredPromise = new Promise((resolve) => { busyEntered = resolve; });
      const busyGate = new Promise((resolve) => { releaseBusy = resolve; });
      f.store.readProviderAsync = async (...args) => {
        if (pauseBusy) { pauseBusy = false; busyEntered(); await busyGate; }
        return readProvider(...args);
      };
      pauseBusy = true;
      const busySwitch = switchRequest(f, "beta", "became-busy", 1);
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
      await assert.rejects(snapshotOf(f, oldSessionId), /stale-session/);
      const next = await snapshotOf(f, "session-two");
      assert.equal(next.defaultSelected, true);
      const staleReplay = await f.service.switchAccount({
        protocol: 1, providerId: CODEX, requestId: "concurrent-a",
        expectedSessionId: oldSessionId, expectedServiceEpoch: f.initial.serviceEpoch,
        expectedSelectionRevision: 0, accountId: "alpha",
      });
      assert.equal(staleReplay.reason, "stale-session");
    } finally { await dispose(f); }
  });

test("credential management refuses RPC/Paseo UI mode without secret prompts", async () => {
  const f = await fixture();
  try {
    f.ctx.mode = "rpc";
    await f.commands.get("accounts").handler("", f.ctx);
    assert.match(f.notices.at(-1).message, /native Pi TUI/);
    assert.equal(JSON.stringify(f.service).includes(ALPHA), false);
  } finally { await dispose(f); }
});

test("/accounts offers only Codex sign-in when adding an account", async () => {
  const f = await fixture();
  try {
    const choices = ["Add account", "Cancel", "Close"];
    const offered = [];
    f.ctx.ui.input = async () => "gamma";
    f.ctx.ui.select = async (title, options) => {
      offered.push({ title, options });
      return choices.shift();
    };
    await f.commands.get("accounts").handler("", f.ctx);
    assert.equal(offered[0].title, "OpenAI Codex accounts");
    assert.deepEqual(offered[1].options, ["ChatGPT sign-in (OAuth)", "Cancel"]);
  } finally { await dispose(f); }
});

test("/accounts does not reuse a link when the owner snapshot is unavailable", async () => {
  const f = await fixture();
  try {
    usageModule.default(f.pi);
    f.service.getSnapshot = async () => { throw new Error("stale owner"); };
    const choices = ["Credential status and usage link", "Close"];
    f.ctx.ui.select = async (_title, options) => {
      const choice = choices.shift();
      assert.ok(options.includes(choice));
      return choice;
    };
    await f.commands.get("accounts").handler("", f.ctx);
    assert.equal(f.notices.at(-1).message, "OpenAI Codex credential status unavailable.");
    assert.doesNotMatch(f.notices.at(-1).message, /platform\.openai\.com|chatgpt\.com/);
  } finally { await dispose(f); }
});

test("/accounts is local-only and issues no network request", async () => {
  const f = await fixture();
  const beforeFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async (...args) => {
    fetchCalls += 1;
    throw new Error(`unexpected fetch ${args[0]}`);
  };
  try {
    assert.equal((await switchRequest(f, "alpha", "usage-alpha")).ok, true);
    usageModule.default(f.pi);
    const choices = ["Credential status and usage link", "Close"];
    f.ctx.ui.select = async (_title, options) => {
      const choice = choices.shift();
      assert.ok(options.includes(choice));
      return choice;
    };
    await f.commands.get("accounts").handler("", f.ctx);
    assert.equal(f.commands.has("usage"), false);
    assert.equal(fetchCalls, 0);
    assert.match(f.notices.at(-1).message, /OpenAI Codex: ChatGPT grant active/);
    assert.doesNotMatch(f.notices.at(-1).message, /https?:/);
    assert.doesNotMatch(f.notices.at(-1).message, /tokens?\s*[:=]\s*0/i);
  } finally {
    globalThis.fetch = beforeFetch;
    await dispose(f);
  }
});

for (const [credential, url, label] of [
  ["chatgpt-grant-configured", "https://chatgpt.com/settings/usage", "ChatGPT grant configured"],
  ["chatgpt-grant-matched-refreshed", null, "ChatGPT grant active"],
  ["unknown", null, "Credential status unknown"],
  ["unavailable", null, "No effective credential"],
]) test(`/accounts credential status: ${credential}`, async () => {
  const f = await fixture();
  try {
    const choices = ["Credential status and usage link", "Close"];
    f.ctx.ui.select = async (_title, options) => {
      const choice = choices.shift();
      assert.ok(options.includes(choice));
      return choice;
    };
    f.service.getSnapshot = async (request) => {
      assert.equal(request.sessionId, f.sessionId);
      assert.equal(request.providerId, CODEX);
      const usage = { effectiveCredential: credential, settingsUrl: url };
      return { sessionId: f.sessionId, usage };
    };
    await f.commands.get("accounts").handler("", f.ctx);
    const message = f.notices.at(-1).message;
    assert.ok(message.includes(label));
    assert.ok(message.includes("quota, billing and remote entitlement are not queried"));
    if (url) assert.ok(message.includes(url)); else assert.doesNotMatch(message, /https?:/);
  } finally { await dispose(f); }
});

test("/accounts suppresses credential status after session replacement", async () => {
  const f = await fixture();
  try {
    const choices = ["Credential status and usage link"];
    f.ctx.ui.select = async () => choices.shift();
    f.service.getSnapshot = async () => {
      f.sessionId = "replacement";
      await f.fire("session_start");
      return { sessionId: "session-one",
        usage: { effectiveCredential: "chatgpt-grant-configured", settingsUrl: null } };
    };
    const before = f.notices.length;
    await f.commands.get("accounts").handler("", f.ctx);
    assert.equal(f.notices.length, before);
  } finally { await dispose(f); }
});
