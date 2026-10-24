import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const { createJiti } = createRequire(
	import.meta.resolve("@earendil-works/pi-coding-agent"),
)("jiti");

import {
	createAgentSession,
	AgentSessionRuntime,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
const { default: btw } = await createJiti(import.meta.url).import(
	"../btw/index.ts",
);
const { registerSessionRouting, getSessionModelRequestProfile } = await createJiti(import.meta.url).import(
	"../shared/session-routing.ts",
);
test("actual Pi SDK binds BTW, dispatches only the side stream, preserves main state and disposes ownership", async () => {
	const root = await mkdtemp(join(tmpdir(), "btw-sdk-")),
		oldDir = process.env.PI_CODING_AGENT_DIR,
		oldFetch = globalThis.fetch;
	let session,
		owner,
		network = 0,
		calls = 0,
		providerReady;
	const started = new Promise((resolve) => (providerReady = resolve));
	process.env.PI_CODING_AGENT_DIR = root;
	globalThis.fetch = async () => {
		network++;
		throw Error("Live HTTP forbidden in BTW SDK test");
	};
	try {
		const runtime = await ModelRuntime.create({
			authPath: join(root, "auth.json"),
			modelsPath: null,
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		const settings = SettingsManager.inMemory({
			defaultProvider: "openai",
			defaultModel: "gpt-6-astra",
			compaction: { enabled: false },
			retry: { enabled: false },
		});
		const factory = (pi) => {
			pi.registerProvider("openai", {
				api: "openai-responses",
				apiKey: "fake-btw-key",
				baseUrl: "https://example.invalid",
				streamSimple: (model, _context, options) => {
					calls++;
					assert.equal(model.id, "gpt-6-luna");
					assert.notEqual(
						options.sessionId,
						session.sessionManager.getSessionId(),
					);
					const stream = createAssistantMessageEventStream(),
						response = {
							role: "assistant",
							api: "openai-responses",
							provider: "openai",
							model: model.id,
							content: [{ type: "text", text: "SDK side answer" }],
							stopReason: "stop",
							timestamp: 1,
							usage: {
								input: 1,
								output: 1,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 2,
								cost: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									total: 0,
								},
							},
						};
					queueMicrotask(() => {
						stream.end(response);
						providerReady();
					});
					return stream;
				},
			});
			btw(pi);
		};
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: root,
			settingsManager: settings,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [factory],
		});
		await loader.reload();
		({ session } = await createAgentSession({
			cwd: root,
			agentDir: root,
			modelRuntime: runtime,
			settingsManager: settings,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(root),
			noTools: "builtin",
		}));
		owner = new AgentSessionRuntime(
			session,
			{
				cwd: root,
				agentDir: root,
				modelRuntime: runtime,
				settingsManager: settings,
				resourceLoader: loader,
				diagnostics: [],
			},
			async () => {
				throw Error("No replacement requested");
			},
		);
		const errors = [];
		await session.bindExtensions({ onError: (error) => errors.push(error) });
		assert.deepEqual(errors, []);
		const service = globalThis.__paeBtwV1;
		assert.equal(service?.sessionId, session.sessionManager.getSessionId());
		const entries = structuredClone(session.sessionManager.getEntries()),
			mainModel = session.model,
			thinking = session.thinkingLevel;
		const threadId = randomUUID();
		const initialSnapshot = service.handle({ operation: "snapshot", sessionId: service.sessionId, serviceEpoch: service.serviceEpoch });
		assert.equal(initialSnapshot.defaultModel, "openai/gpt-6-luna");
		service.handle({
			operation: "start",
			sessionId: service.sessionId,
			serviceEpoch: service.serviceEpoch,
			requestId: randomUUID(),
			threadId,
			question: "Side question",
			model: initialSnapshot.defaultModel,
			context: "none",
		});
		let deadline;
		try {
			await Promise.race([
				started,
				new Promise((_, reject) => {
					deadline = setTimeout(
						() => reject(Error("Side provider did not start")),
						10000,
					);
				}),
			]);
		} finally {
			clearTimeout(deadline);
		}
		await new Promise((resolve) => setImmediate(resolve));
		const snapshot = service.handle({
			operation: "snapshot",
			sessionId: service.sessionId,
			serviceEpoch: service.serviceEpoch,
			threadId,
		});
		assert.equal(snapshot.threads[0].turns[0].answer, "SDK side answer");
		assert.equal(calls, 1);
		assert.equal(network, 0);
		assert.equal(session.model, mainModel);
		assert.equal(session.thinkingLevel, thinking);
		assert.deepEqual(session.sessionManager.getEntries(), entries);
		await owner.dispose();
		owner = undefined;
		session = undefined;
		assert.equal(globalThis.__paeBtwV1, undefined);
		assert.throws(() => service.handle({}), /changed/);
	} finally {
		if (owner) await owner.dispose();
		else await session?.dispose();
		globalThis.fetch = oldFetch;
		if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldDir;
		await rm(root, { recursive: true, force: true });
	}
});

test("actual Pi SDK BTW snapshots route defaults across a virtual guard owner without fallback", { timeout: 30000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "btw-routing-sdk-"));
	const saved = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_SESSION_ROUTING_FILE", "PI_SESSION_ROUTING_OWNER_SESSION"].map((key) => [key, process.env[key]]));
	const oldFetch = globalThis.fetch;
	let session, owner, unregisterRouting, ownerProfile, network = 0;
	const calls = [];
	process.env.PI_CODING_AGENT_DIR = root;
	delete process.env.PI_SESSION_ROUTING_FILE;
	delete process.env.PI_SESSION_ROUTING_OWNER_SESSION;
	globalThis.fetch = async () => { network++; throw Error("Live HTTP forbidden in BTW routing SDK test"); };
	try {
		const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
		for (const provider of ["openai", "openai-codex"]) runtime.registerProvider(provider, {
			api: provider === "openai" ? "openai-responses" : "openai-codex-responses",
			apiKey: `fake-${provider}-key`,
			baseUrl: "https://example.invalid",
			models: [{ id: "gpt-6-luna", name: "Fixture Luna", reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
			streamSimple(model, _context, options) {
				calls.push({ provider: model.provider, requestProfile: getSessionModelRequestProfile(model) });
				const stream = createAssistantMessageEventStream();
				const response = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "text", text: "routed SDK answer" }], stopReason: "stop", timestamp: 1, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
				queueMicrotask(() => { stream.end(response); });
				return stream;
			},
		});
		runtime.registerVirtualModel({ provider: "idle-guard", id: "astra", name: "Fixture Guard", thinkingLevels: ["low"], route() { throw Error("BTW must not dispatch through the virtual parent"); } });
		const settings = SettingsManager.inMemory({ defaultProvider: "idle-guard", defaultModel: "astra", defaultThinkingLevel: "low", compaction: { enabled: false }, retry: { enabled: false } });
		const factory = (pi) => {
			pi.on("session_start", (_event, ctx) => {
				ownerProfile = { version: 1, ownerSessionId: ctx.sessionManager.getSessionId(), providerId: "openai-codex", accountId: "Work", revision: 1 };
				unregisterRouting = registerSessionRouting(ctx, { file: join(root, "routing.json"), getProfile: () => ownerProfile, prepareRequest: async () => ({ ...ownerProfile }) });
			});
			btw(pi);
		};
		const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [factory] });
		await loader.reload();
		({ session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(root), noTools: "builtin" }));
		const virtualGuard = runtime.getModel("idle-guard", "astra");
		assert.ok(virtualGuard);
		await session.setModel(virtualGuard);
		owner = new AgentSessionRuntime(session, { cwd: root, agentDir: root, modelRuntime: runtime, settingsManager: settings, resourceLoader: loader, diagnostics: [] }, async () => { throw Error("No replacement requested"); });
		await session.bindExtensions({ onError: (error) => { throw error; } });
		// The extension's session_start callback registered the owning profile.
		const service = globalThis.__paeBtwV1;
		assert.ok(service);
		assert.equal(session.model.provider, "idle-guard");
		assert.equal(ownerProfile.providerId, "openai-codex");
		const snapshot = (threadId) => service.handle({ operation: "snapshot", sessionId: service.sessionId, serviceEpoch: service.serviceEpoch, ...(threadId ? { threadId } : {}) });
		const waitForCalls = async (count) => {
			const end = Date.now() + 5000;
			while (calls.length < count && Date.now() < end) await new Promise((resolve) => setImmediate(resolve));
			assert.ok(calls.length >= count, `expected ${count} side provider calls`);
		};
		const waitForThreadState = async (threadId, state) => {
			const end = Date.now() + 5000;
			while (snapshot(threadId).threads[0]?.state !== state && Date.now() < end) await new Promise((resolve) => setImmediate(resolve));
			assert.equal(snapshot(threadId).threads[0]?.state, state);
		};
		const start = (model, question) => {
			const threadId = randomUUID();
			service.handle({ operation: "start", sessionId: service.sessionId, serviceEpoch: service.serviceEpoch, requestId: randomUUID(), threadId, question, model, context: "none" });
			return threadId;
		};
		const codexDefault = snapshot().defaultModel;
		assert.equal(codexDefault, "openai-codex/gpt-6-luna");
		assert.ok(snapshot().models.includes(codexDefault));
		const retainedThread = start(codexDefault, "Codex owner");
		await waitForCalls(1);
		assert.equal(calls[0].provider, "openai-codex");
		const legacyThread = start("openai/gpt-6-luna", "Legacy configured selector under Codex owner");
		await waitForCalls(2);
		assert.equal(calls[1].provider, "openai-codex");
		assert.equal(snapshot(legacyThread).threads[0].model, codexDefault);
		ownerProfile.providerId = "openai"; ownerProfile.accountId = "Personal"; ownerProfile.revision++;
		const openaiDefault = snapshot().defaultModel;
		assert.equal(openaiDefault, "openai/gpt-6-luna");
		assert.ok(snapshot().models.includes(openaiDefault));
		start(openaiDefault, "OpenAI owner");
		await waitForCalls(3);
		assert.equal(calls[2].provider, "openai");
		assert.equal(snapshot(retainedThread).threads[0].model, openaiDefault);
		const cachedCodexThread = start(codexDefault, "Cached Codex-qualified selector under OpenAI owner");
		await waitForCalls(4);
		assert.equal(calls[3].provider, "openai", "cached selectors cannot override owner provider authority");
		assert.equal(snapshot(cachedCodexThread).threads[0].model, openaiDefault);
		service.handle({ operation: "send", sessionId: service.sessionId, serviceEpoch: service.serviceEpoch, requestId: randomUUID(), threadId: retainedThread, question: "Continue on OpenAI" });
		await waitForCalls(5);
		ownerProfile.providerId = "openai-codex"; ownerProfile.accountId = "Work"; ownerProfile.revision++;
		assert.equal(snapshot().defaultModel, codexDefault);
		assert.equal(snapshot(retainedThread).threads[0].model, codexDefault);
		start(snapshot().defaultModel, "Back to Codex");
		await waitForCalls(6);
		service.handle({ operation: "send", sessionId: service.sessionId, serviceEpoch: service.serviceEpoch, requestId: randomUUID(), threadId: retainedThread, question: "Continue back on Codex" });
		await waitForCalls(7);
		assert.deepEqual(calls.map((call) => call.provider), ["openai-codex", "openai-codex", "openai", "openai", "openai", "openai-codex", "openai-codex"]);
		assert.deepEqual(calls.map((call) => call.requestProfile?.accountId), ["Work", "Work", "Personal", "Personal", "Personal", "Work", "Work"]);
		await waitForThreadState(retainedThread, "idle");
		ownerProfile.providerId = "missing-provider"; ownerProfile.revision++;
		const unavailableSnapshot = snapshot(retainedThread);
		const unavailableDefault = "missing-provider/gpt-6-luna";
		assert.equal(unavailableSnapshot.defaultModel, unavailableDefault);
		assert.ok(!unavailableSnapshot.models.includes(unavailableDefault));
		assert.equal(unavailableSnapshot.threads[0].id, retainedThread, "existing threads remain inspectable");
		const rejectedThread = randomUUID();
		assert.throws(() => service.handle({ operation: "start", sessionId: service.sessionId, serviceEpoch: service.serviceEpoch, requestId: randomUUID(), threadId: rejectedThread, question: "Must not fallback", model: unavailableDefault, context: "none" }), /unavailable; no fallback was made/);
		assert.ok(!snapshot().threads.some((thread) => thread.id === rejectedThread), "unavailable starts do not create phantom threads");
		const control = (operation) => service.handle({ operation, sessionId: service.sessionId, serviceEpoch: service.serviceEpoch, requestId: randomUUID(), threadId: retainedThread });
		assert.equal(control("cancel").threads.find((thread) => thread.id === retainedThread)?.state, "cancelled");
		assert.ok(!control("remove").threads.some((thread) => thread.id === retainedThread));
		assert.equal(session.model.provider, "idle-guard", "the parent virtual selection is unchanged");
		assert.equal(network, 0);
		service.dispose();
		unregisterRouting?.(); unregisterRouting = undefined;
		await owner.dispose(); owner = undefined; session = undefined;
	} finally {
		unregisterRouting?.();
		if (owner) await owner.dispose(); else await session?.dispose();
		globalThis.fetch = oldFetch;
		for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		await rm(root, { recursive: true, force: true });
	}
});
