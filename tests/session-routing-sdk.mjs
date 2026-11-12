import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  createAgentSession, AgentSessionRuntime, DefaultResourceLoader, ModelRuntime, SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
const { createJiti } =
  createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("jiti");
const load = createJiti(import.meta.url, { fsCache: false });
const { default: accounts } = await load.import("../openai-accounts/accounts.ts");
const oauth = await load.import("../openai-accounts/oauth.ts");
const { AccountStore, InMemoryAccountStorageBackend } =
  await load.import("../openai-accounts/account-store.ts");
const routing = await load.import("../shared/session-routing.ts");
const CODEX = "openai-codex";
const claims = (id) => ({ sub: id, "https://api.openai.com/auth": { chatgpt_account_id: id } });
const token = (id) => [
  Buffer.from('{"alg":"none"}').toString("base64url"),
  Buffer.from(JSON.stringify(claims(id))).toString("base64url"),
  "fixture",
].join(".");
const oauthCredential = (id) => ({
  type: "oauth", access: token(id), refresh: `fixture-${id}-refresh`,
  expires: Date.now() + 86400000, accountId: id,
});
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const usage = (n) => ({
  ...zero, input: n, output: n, totalTokens: 2 * n, cost: { ...zero, total: 0 },
});

test("actual AgentSession startup order and retained follower use coherent account snapshots",
  { timeout: 30000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "routing-sdk-"));
    const keys =
      ["PI_CODING_AGENT_DIR", "PI_SESSION_ROUTING_FILE", "PI_SESSION_ROUTING_OWNER_SESSION"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const oldFetch = globalThis.fetch, owners = [], calls = [], errors = [];
    let network = 0, release, started;
    const held = new Promise((resolve) => { release = resolve; });
    const dispatched = new Promise((resolve) => { started = resolve; });
    process.env.PI_CODING_AGENT_DIR = root;
    delete process.env.PI_SESSION_ROUTING_FILE;
    delete process.env.PI_SESSION_ROUTING_OWNER_SESSION;
    globalThis.fetch = async () => {
      network++;
      throw new Error("Live HTTP forbidden in routing SDK test");
    };
    try {
      const personal = token("personal"), work = token("work"), alpha = token("alpha");
      await writeFile(join(root, "auth.json"), JSON.stringify({
        openai: { type: "api_key", key: "fixture-default" },
        [CODEX]: oauthCredential("personal"),
      }), { mode: 0o600 });
      const store = new AccountStore(new InMemoryAccountStorageBackend());
      await store.updateProvider(CODEX, (state) => ({
        ...state, active: "Alpha",
        accounts: { Alpha: oauthCredential("alpha"), Work: oauthCredential("work") },
      }));
      const text = (context) => context.messages.filter((m) => m.role === "user").at(-1)?.content;
      const factory = (refs) => (pi) => {
        for (const provider of ["openai", CODEX]) pi.registerProvider(provider, {
          api: provider === "openai" ? "openai-responses" : "openai-codex-responses",
          baseUrl: provider === "openai"
            ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api",
          models: ["main-fixture", "small-fixture"].map((id) => ({
            id, name: id, reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 4096,
            cost: zero,
          })),
          streamSimple(model, context, options) {
            const stream = createAssistantMessageEventStream();
            const base = {
              role: "assistant", provider: model.provider, api: model.api, model: model.id,
            };
            queueMicrotask(async () => {
              try {
                await options?.onPayload?.({ fixture: true }, model);
                calls.push({ provider: model.provider, model: model.id, key: options.apiKey });
                const hold = JSON.stringify(text(context)).includes("hold");
                if (model.id === "small-fixture" && hold) {
                  started();
                  await held;
                }
                const message = {
                  ...base, content: [{ type: "text", text: "offline answer" }], stopReason: "stop",
                  timestamp: Date.now(), usage: usage(1),
                };
                stream.push({ type: "done", reason: "stop", message });
                stream.end();
              } catch (error) {
                const message = {
                  ...base, content: [], stopReason: "error", errorMessage: String(error),
                  timestamp: Date.now(), usage: usage(0),
                };
                stream.push({ type: "error", reason: "error", error: message });
                stream.end();
              }
            });
            return stream;
          },
        });
        pi.on("session_start", (_e, ctx) => { refs.ctx = ctx; });
      };
      async function session(child = false) {
        const refs = {};
        const runtime = await ModelRuntime.create({
          authPath: join(root, "auth.json"), modelsPath: null, allowModelNetwork: false,
          refreshOnCreate: false,
        });
        // Like the CLI, select an explicit model before binding session events.
        // SDK sessions with caller-supplied runtimes do not infer a late factory's model.
        factory({})({
          registerProvider: (provider, config) => runtime.registerProvider(provider, config),
          on() {},
        });
        const [provider, modelId] = child ? [CODEX, "small-fixture"] : [CODEX, "main-fixture"];
        const config = SettingsManager.inMemory({
          defaultProvider: provider, defaultModel: modelId, defaultThinkingLevel: "low",
          compaction: { enabled: false }, retry: { enabled: false },
        });
        const factories = [
          factory(refs),
          (pi) => accounts(pi, { store, providers: oauth.createBuiltinProviderAdapters() }),
        ];
        const loader = new DefaultResourceLoader({
          cwd: root, agentDir: root, settingsManager: config, noExtensions: true, noSkills: true,
          noPromptTemplates: true, noThemes: true, noContextFiles: true,
          extensionFactories: factories,
        });
        await loader.reload();
        const { session } = await createAgentSession({
          cwd: root, agentDir: root, modelRuntime: runtime, settingsManager: config,
          resourceLoader: loader, sessionManager: SessionManager.inMemory(root), noTools: "builtin",
        });
        const initial = runtime.getModel(provider, modelId);
        assert.ok(initial, "explicit fixture model is available before session binding");
        await session.setModel(initial);
        const services = {
          cwd: root, agentDir: root, modelRuntime: runtime, settingsManager: config,
          resourceLoader: loader, diagnostics: [],
        };
        const owner = new AgentSessionRuntime(session, services, async () => {
          throw new Error("No replacement requested");
        });
        owners.push(owner);
        await session.bindExtensions({ onError: (error) => errors.push(error) });
        return { session, owner, ctx: refs.ctx, controls: globalThis.__paeAccountControlsV1 };
      }
      const parent = await session();
      assert.equal(parent.session.model.provider, CODEX);
      assert.equal(routing.getSessionRoutingProfile(parent.ctx).providerId, CODEX);
      await parent.session.prompt("warm");
      assert.equal(calls.at(-1).key, alpha);
      const rootId = parent.session.sessionManager.getSessionId();
      process.env.PI_SESSION_ROUTING_FILE = routing.routingProfilePath(root, rootId);
      process.env.PI_SESSION_ROUTING_OWNER_SESSION = rootId;
      const child = await session(true);
      assert.equal(child.session.model.provider, CODEX);
      const pending = child.session.prompt("hold");
      await dispatched;
      async function select(accountId) {
        // Real workers live in separate Pi processes. Temporarily select the
        // parent's service slot to model that process-local singleton faithfully.
        const active = globalThis.__paeAccountControlsV1;
        globalThis.__paeAccountControlsV1 = parent.controls;
        try {
          const snapshot =
            await parent.controls.getSnapshot({ sessionId: rootId, providerId: CODEX });
          const result = await parent.controls.switchAccount({
            protocol: 1, providerId: CODEX, requestId: randomUUID(), expectedSessionId: rootId,
            expectedServiceEpoch: snapshot.serviceEpoch,
            expectedSelectionRevision: snapshot.selectionRevision, accountId,
          });
          assert.equal(result.ok, true, JSON.stringify(result));
        } finally { globalThis.__paeAccountControlsV1 = active; }
      }
      await select("Work");
      release();
      await pending;
      assert.equal(calls.at(-1).key, alpha,
        "already dispatched child request retained its old account");
      const childService = globalThis.__paeAccountControlsV1;
      globalThis.__paeAccountControlsV1 = parent.controls;
      try { await parent.session.prompt("still warm after account switch"); }
      finally { globalThis.__paeAccountControlsV1 = childService; }
      assert.notEqual(parent.session.messages.at(-1)?.stopReason, "error",
        JSON.stringify(parent.session.messages.at(-1)));
      assert.equal(calls.at(-1).provider, CODEX);
      assert.equal(calls.at(-1).key, work);
      await child.session.prompt("next");
      assert.equal(calls.at(-1).model, "small-fixture");
      assert.equal(calls.at(-1).provider, CODEX);
      assert.equal(calls.at(-1).key, work);
      await select(null);
      await child.session.prompt("default account");
      assert.equal(calls.at(-1).key, personal);
      await select("Alpha");
      await child.session.prompt("named account again");
      assert.equal(calls.at(-1).provider, CODEX);
      assert.equal(calls.at(-1).key, alpha);
      await parent.owner.dispose();
      owners.splice(owners.indexOf(parent.owner), 1);
      await child.session.prompt("retained after parent exits");
      assert.equal(calls.at(-1).key, alpha);
      assert.equal(calls.some((call) => call.provider === "openai"), false);
      assert.deepEqual(errors, []);
      assert.equal(network, 0);
    } finally {
      release();
      for (const owner of owners.reverse()) await owner.dispose();
      globalThis.fetch = oldFetch;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
