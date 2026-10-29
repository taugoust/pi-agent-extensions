// Real Pi runtime, deterministic in-process provider; no paid/network requests.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	createAgentSession,
	AgentSessionRuntime,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sdk = dirname(
	fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
);
const { AssistantMessageEventStream } = await import(
	pathToFileURL(
		join(sdk, "../node_modules/@earendil-works/pi-ai/dist/index.js"),
	)
);
test("actual Pi records stamps and progress, exports cache snapshots, then invalidates services on shutdown", {
	timeout: 15000,
}, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-observability-"));
	const originalFetch = globalThis.fetch;
	let network = 0,
		calls = 0,
		session,
		owner;
	globalThis.fetch = async () => {
		network++;
		throw Error("Network forbidden");
	};
	try {
		const runtime = await ModelRuntime.create({
			authPath: join(dir, "auth.json"),
			modelsPath: null,
			modelsStorePath: join(dir, "models"),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		const settings = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		});
		const provider = (pi) =>
			pi.registerProvider("phase1-test", {
				api: "openai-completions",
				apiKey: "test",
				baseUrl: "https://invalid.invalid",
				models: [
					{
						id: "test",
						name: "Test",
						reasoning: false,
						input: ["text"],
						contextWindow: 100000,
						maxTokens: 1000,
						cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
					},
				],
				streamSimple() {
					const stream = new AssistantMessageEventStream();
					calls++;
					const tool = calls === 1;
					const message = {
						role: "assistant",
						provider: "phase1-test",
						model: "test",
						api: "openai-completions",
						timestamp: Date.now(),
						stopReason: tool ? "toolUse" : "stop",
						content: tool
							? [
									{
										type: "toolCall",
										id: "progress-call",
										name: "update_progress",
										arguments: {
											action: "create", objective: "Review fixture progress", request_id: "observability-progress", start: false,
											steps: [
												{ text: "Review implementation", status: "completed" },
												{ text: "Native iOS check", status: "blocked" },
											],
										},
									},
								]
							: [
									{
										type: "text",
										text: "Synthetic result, not exported in metadata.",
									},
								],
						usage: {
							input: 100,
							output: 10,
							cacheRead: 900,
							cacheWrite: 0,
							totalTokens: 1010,
							cost: {
								input: 0.0001,
								output: 0.00002,
								cacheRead: 0.00009,
								cacheWrite: 0,
								total: 0.00021,
							},
						},
					};
					queueMicrotask(() => {
						stream.push({ type: "done", reason: message.stopReason, message });
						stream.end();
					});
					return stream;
				},
			});
		const loader = new DefaultResourceLoader({
			cwd: dir,
			agentDir: dir,
			settingsManager: settings,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			additionalExtensionPaths: ["workflows", "stamp", "progress", "cache-hit-monitor"].map(
				(x) => join(root, x, "index.ts"),
			),
			extensionFactories: [provider],
		});
		await loader.reload();
		const created = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			modelRuntime: runtime,
			settingsManager: settings,
			resourceLoader: loader,
			sessionManager: SessionManager.create(dir, join(dir, "sessions")),
			noTools: "builtin",
		});
		session = created.session;
		owner = new AgentSessionRuntime(
			session,
			{
				cwd: dir,
				agentDir: dir,
				modelRuntime: runtime,
				settingsManager: settings,
				resourceLoader: loader,
				diagnostics: [],
			},
			async () => {
				throw Error("Unexpected replacement");
			},
		);
		const errors = [];
		await session.bindExtensions({ onError: (e) => errors.push(e) });
		await session.setModel(runtime.getModel("phase1-test", "test"));
		await session.prompt("Update the progress then finish.");
		await session.waitForIdle();
		assert.equal(calls, 2);
		assert.deepEqual(errors, []);
		const registry = globalThis.__paeObservabilityV1,
			id = session.sessionManager.getSessionId();
		assert.ok(registry?.stamp && registry.progress && registry.cache);
		const stamps = await registry.stamp.snapshot({ sessionId: id });
		assert.ok(
			stamps.data.records.some(
				(r) => r.role === "assistant" && r.model === "test",
			),
		);
		assert.ok(
			stamps.data.records.some(
				(r) => r.role === "tool" && r.tool === "update_progress",
			),
		);
		assert.ok(!JSON.stringify(stamps).includes("Synthetic result"));
		assert.equal(
			(await registry.progress.snapshot({ sessionId: id })).data.steps[1]
				.status,
			"blocked",
		);
		assert.equal(
			(await registry.cache.snapshot({ sessionId: id })).data.session
				.requestCount,
			2,
		);
		const old = registry.stamp;
		await owner.dispose();
		owner = undefined;
		session = undefined;
		await assert.rejects(old.snapshot({ sessionId: id }));
		assert.equal(network, 0);
	} finally {
		await session?.abort();
		await owner?.dispose();
		globalThis.fetch = originalFetch;
		rmSync(dir, { recursive: true, force: true });
	}
});
