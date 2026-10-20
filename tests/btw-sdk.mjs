import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createJiti } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
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
		service.handle({
			operation: "start",
			sessionId: service.sessionId,
			serviceEpoch: service.serviceEpoch,
			requestId: randomUUID(),
			threadId,
			question: "Side question",
			model: "openai/gpt-6-luna",
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
