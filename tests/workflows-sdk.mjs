import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtemp,
	mkdir,
	writeFile,
	readFile,
	rm,
	access,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
const suite = await mkdtemp(join(tmpdir(), "workflows-sdk-")),
	oldDir = process.env.PI_CODING_AGENT_DIR,
	oldFetch = globalThis.fetch;
process.env.PI_CODING_AGENT_DIR = join(suite, "agent");
let network = 0;
globalThis.fetch = async () => {
	network++;
	throw Error("HTTP forbidden in deterministic workflow tests");
};
const { createJiti } = createRequire(
	import.meta.resolve("@earendil-works/pi-coding-agent"),
)("jiti");
const sdk = await import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await import(
	"@earendil-works/pi-ai"
);
const jiti = createJiti(import.meta.url),
	{ default: workflows } = await jiti.import("../workflows/index.ts");
const { createWorktreeSettingsRuntime } = await jiti.import(
	"../workflows/worktree/settings.ts",
);
after(async () => {
	globalThis.fetch = oldFetch;
	if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = oldDir;
	await rm(suite, { recursive: true, force: true });
});
const git = (cwd, ...args) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
async function until(read, predicate, label) {
	const deadline = Date.now() + 10000;
	let last;
	while (Date.now() < deadline) {
		last = await read();
		if (predicate(last)) return last;
		await delay(10);
	}
	throw Error(`Timed out: ${label}: ${JSON.stringify(last)}`);
}
async function fixture(mode = "text", existing) {
	const root = existing?.root ?? (await mkdtemp(join(suite, "case-"))),
		cwd = join(root, "repo"),
		agentDir = join(root, "agent");
	if (!existing) {
		await mkdir(cwd);
		await mkdir(agentDir);
		git(cwd, "init", "--template=", "--initial-branch=main");
		git(cwd, "config", "core.hooksPath", "/dev/null");
		git(cwd, "config", "user.name", "Workflow test");
		git(cwd, "config", "user.email", "test@example.invalid");
		await writeFile(join(cwd, "seed.txt"), "fixture\n");
		await writeFile(join(cwd, ".gitignore"), "ignored*\n");
		git(cwd, "add", ".");
		git(cwd, "-c", "commit.gpgsign=false", "commit", "-m", "Fixture");
	}
	const goalSettingsPath = join(agentDir, "goal.json"),
		worktreeSettingsPath = join(agentDir, "worktree.json");
	await writeFile(
		goalSettingsPath,
		JSON.stringify({
			continuationLimits: { automaticTurns: 3, noProgressTurns: 2 },
			rpc: { enabled: false },
		}),
	);
	await writeFile(
		worktreeSettingsPath,
		JSON.stringify({ worktreeRoot: join(root, "trees") }),
	);
	const runtime = await sdk.ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const settings = sdk.SettingsManager.inMemory({
		defaultProvider: "openai",
		defaultModel: "gpt-6-luna",
		defaultThinkingLevel: "low",
		compaction: { enabled: false },
		retry: { enabled: false },
	});
	const calls = [],
		errors = [];
	let session, release, extensionApi;
	const factory = (pi) => {
		extensionApi = pi;
		pi.registerProvider("openai", {
			api: "openai-responses",
			apiKey: "fake-workflow-key",
			baseUrl: "https://example.invalid",
			streamSimple: (model, context, options) => {
				const stream = createAssistantMessageEventStream();
				calls.push({ model, context, options });
				const goal = session.sessionManager
					.getBranch()
					.findLast((e) => e.type === "custom" && e.customType === "goal-state")
					?.data?.goal;
				const response = {
					role: "assistant",
					api: "openai-responses",
					provider: "openai",
					model: model.id,
					timestamp: Date.now(),
					stopReason: "stop",
					content: [
						{
							type: "text",
							text:
								mode === "repeat"
									? "same progress"
									: `Progress ${calls.length}`,
						},
					],
					usage: {
						input: 10,
						output: 10,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 20,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
				};
				if (mode === "complete") {
					response.stopReason = "toolUse";
					response.content = [
						{
							type: "toolCall",
							id: randomUUID(),
							name: "goal_complete",
							arguments: {
								goal_id: goal.id,
								summary:
									"Verified the requested deterministic fixture outcome.",
							},
						},
					];
				}
				if (mode === "wait") {
					response.stopReason = "toolUse";
					response.content = [{ type: "toolCall", id: randomUUID(), name: "goal_wait", arguments: { goal_id: goal.id, reason: "Waiting for explicit test wake" } }];
				}
				if (calls.length > 8) {
					response.stopReason = "error";
					response.errorMessage = "Fixture runaway guard";
				}
				let finished = false;
				const finish = () => {
					if (finished) return;
					finished = true;
					if (
						response.stopReason === "error" ||
						response.stopReason === "aborted"
					)
						stream.push({
							type: "error",
							reason: response.stopReason,
							error: response,
						});
					else
						stream.push({
							type: "done",
							reason: response.stopReason,
							message: response,
						});
					stream.end(response);
				};
				options.signal?.addEventListener(
					"abort",
					() => {
						response.stopReason = "aborted";
						finish();
					},
					{ once: true },
				);
				if (mode === "hold") release = finish;
				else queueMicrotask(finish);
				return stream;
			},
		});
		workflows(pi, {
			goalSettingsPath,
			worktreeSettings: createWorktreeSettingsRuntime({
				path: worktreeSettingsPath,
			}),
		});
	};
	const loader = new sdk.DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: settings,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [factory],
	});
	await loader.reload();
	({ session } = await sdk.createAgentSession({
		cwd,
		agentDir,
		modelRuntime: runtime,
		settingsManager: settings,
		resourceLoader: loader,
		sessionManager: existing?.sessionFile
			? sdk.SessionManager.open(existing.sessionFile)
			: sdk.SessionManager.create(cwd, join(root, "sessions")),
		noTools: "builtin",
	}));
	const owner = new sdk.AgentSessionRuntime(
		session,
		{
			cwd,
			agentDir,
			modelRuntime: runtime,
			settingsManager: settings,
			resourceLoader: loader,
			diagnostics: [],
		},
		async () => {
			throw Error("Unexpected session replacement");
		},
	);
	await session.bindExtensions({ onError: (error) => errors.push(error) });
	assert.deepEqual(errors, []);
	const selectedModel = runtime.getModel("openai", "gpt-6-luna");
	assert.ok(selectedModel);
	await session.setModel(selectedModel);
	const service = globalThis.__paeWorkflowsV1;
	assert.ok(service);
	const snapshot = () =>
		service.handle({
			operation: "snapshot",
			sessionId: service.sessionId,
			serviceEpoch: service.serviceEpoch,
		});
	const request = (fields) => ({
		sessionId: service.sessionId,
		serviceEpoch: service.serviceEpoch,
		requestId: randomUUID(),
		...fields,
	});
	const start = async (action, fields = {}) =>
		service.handle(
			request({
				operation: "start",
				action,
				expectedGoalId: (await snapshot()).goal?.id ?? null,
				...fields,
			}),
		);
	const dialog = () => until(snapshot, (s) => !!s.dialog, "dialog");
	const answer = async (value) => {
		const s = await dialog();
		return service.handle(
			request({
				operation: "send",
				operationId: s.dialog.operationId,
				dialogId: s.dialog.id,
				value,
			}),
		);
	};
	return {
		root,
		cwd,
		runtime,
		session,
		owner,
		service,
		snapshot,
		request,
		start,
		dialog,
		answer,
		calls,
		errors,
		release: () => release?.(),
		setMode: value => { mode = value; },
		sendCustom: (message, options) => extensionApi.sendMessage(message, options),
		async dispose() {
			await owner.dispose();
			await rm(root, { recursive: true, force: true });
		},
	};
}
test("copied Git flows create at approved OID, refuse dirty/removal races, preserve branches, and never switch the caller session", async () => {
	const f = await fixture();
	try {
		const initial = f.session.sessionManager.getSessionId(),
			target = join(f.root, "trees", "native"),
			head = git(f.cwd, "rev-parse", "HEAD");
		await f.start("worktree.add");
		await f.answer("feature/native");
		await f.answer("");
		await f.answer(target);
		const preview = await f.dialog();
		assert.equal(preview.dialog.kind, "confirm");
		assert.match(preview.dialog.message, new RegExp(head));
		await f.answer(true);
		await until(
			f.snapshot,
			(s) => !s.busy && s.worktrees.some((t) => t.path === target),
			"created tree",
		);
		assert.equal(git(target, "rev-parse", "HEAD"), head);
		assert.equal(f.session.sessionManager.getSessionId(), initial);
		assert.equal(f.calls.length, 0);
		await writeFile(join(target, "untracked.txt"), "must survive");
		await f.start("worktree.remove");
		let select = await f.dialog();
		await f.answer(select.dialog.options.find((o) => o.includes(target)));
		let stopped = await until(f.snapshot, (s) => !s.busy, "dirty refusal");
		assert.match(stopped.notice, /Removal refused/);
		await access(join(target, "untracked.txt"));
		await rm(join(target, "untracked.txt"));
		await writeFile(join(target, "ignored.txt"), "approved only explicitly");
		await f.start("worktree.remove");
		select = await f.dialog();
		await f.answer(select.dialog.options.find((o) => o.includes(target)));
		const removal = await f.dialog();
		assert.match(removal.dialog.message, /ignored.txt/);
		await writeFile(join(target, "ignored-new.txt"), "changed after preview");
		await f.answer(true);
		stopped = await until(f.snapshot, (s) => !s.busy, "inventory race refusal");
		assert.match(stopped.notice, /ignored data changed/);
		await access(target);
		await f.start("worktree.remove");
		select = await f.dialog();
		await f.answer(select.dialog.options.find((o) => o.includes(target)));
		await f.dialog();
		await f.answer(true);
		await until(
			f.snapshot,
			(s) => !s.busy && !s.worktrees.some((t) => t.path === target),
			"removed tree",
		);
		await assert.rejects(access(target));
		assert.ok(git(f.cwd, "show-ref", "refs/heads/feature/native"));
		assert.equal(network, 0);
	} finally {
		await f.dispose();
	}
});
test("workflow IDs, dialogs and cancellation are idempotent and stale-safe", async () => {
	const f = await fixture();
	try {
		const r = f.request({
			operation: "start",
			action: "worktree.add",
			expectedGoalId: null,
		});
		await f.service.handle(r);
		await f.service.handle(r);
		let s = await f.dialog();
		assert.equal(s.operationId, r.requestId);
		await assert.rejects(
			f.service.handle({ ...r, action: "worktree.prune" }),
			/conflict/,
		);
		await assert.rejects(
			f.service.handle(
				f.request({
					operation: "send",
					operationId: s.operationId,
					dialogId: randomUUID(),
					value: "bad",
				}),
			),
			/Dialog changed/,
		);
		await f.service.handle(
			f.request({ operation: "cancel", operationId: s.operationId }),
		);
		await until(f.snapshot, (s) => !s.busy, "cancelled");
		assert.equal(git(f.cwd, "branch", "--list").trim(), "* main");
		await assert.rejects(
			f.service.handle({
				...r,
				requestId: randomUUID(),
				serviceEpoch: randomUUID(),
			}),
			/Stale/,
		);
		await f.start("worktree.add");
		s = await f.dialog();
		await f.owner.dispose();
		await assert.rejects(
			f.service.handle(
				f.request({
					operation: "send",
					operationId: s.operationId,
					dialogId: s.dialog.id,
					value: "late",
				}),
			),
			/changed/,
		);
	} finally {
		await f.dispose();
	}
});
test("Goal remains off until native confirmation and completes through the actual Pi tool pipeline", async () => {
	const f = await fixture("complete");
	try {
		assert.equal((await f.snapshot()).goal, null);
		assert.equal(f.calls.length, 0);
		await f.start("goal.start", {
			objective: "Produce the deterministic fixture outcome",
			tokenBudget: 1000,
		});
		await f.dialog();
		assert.equal(f.calls.length, 0);
		await f.answer(true);
		const s = await until(
			f.snapshot,
			(s) => !!s.lastCompletion?.summary,
			"goal complete",
		);
		assert.equal(f.calls.length, 1);
		assert.equal(s.goal, null);
		assert.match(s.lastCompletion.summary, /Verified/);
		assert.equal(network, 0);
		assert.deepEqual(f.errors, []);
	} finally {
		await f.dispose();
	}
});
for (const [mode, cause, maxCalls] of [
	["text", "continuation_limit", 4],
	["repeat", "no_progress", 3],
])
	test(`Goal ${cause} stops repeated actual SDK turns`, async () => {
		const f = await fixture(mode);
		try {
			await f.start("goal.start", {
				objective: "Continue until explicitly verified complete",
				tokenBudget: 10000,
			});
			await f.answer(true);
			const s = await until(
				f.snapshot,
				(s) => s.goal?.status === "paused",
				"safety pause",
			);
			assert.equal(s.goal.safetyPauseCause, cause);
			const branch = f.session.sessionManager.getBranch();
			const continuations = branch.filter((entry) => entry.type === "custom_message" && entry.customType === "goal-continuation");
			assert.ok(continuations.length > 0, "automatic continuation is stored as a custom message");
			assert.ok(continuations.every((entry) => entry.display === false));
			assert.ok(!branch.some((entry) => entry.type === "message" && entry.message?.role === "user" && String(entry.message.content).includes("pi-goal-continuation:")), "continuation markers must not be user-role messages");
			const stale = continuations.at(-1);
			const callsAtPause = f.calls.length;
			f.sendCustom({ customType: "goal-continuation", content: stale.content, display: false, details: stale.details }, { triggerTurn: true });
			await f.session.waitForIdle();
			assert.equal(f.calls.length, callsAtPause, "a stale continuation must not start model work after Goal stops");
			assert.ok(f.calls.length <= maxCalls, `${f.calls.length} calls`);
			assert.deepEqual(f.errors, []);
			const before = f.calls.length;
			await f.session.waitForIdle();
			assert.equal(f.calls.length, before);
		} finally {
			await f.dispose();
		}
	});
test("Goal token budget stops without a summary request; Pause aborts its current stream", async () => {
	for (const mode of ["text", "complete"]) {
		const budget = await fixture(mode);
		try {
			await budget.start("goal.start", {
				objective: "Budget-limited fixture",
				tokenBudget: 1,
			});
			await budget.answer(true);
			const limited = await until(
				budget.snapshot,
				(s) =>
					mode === "complete"
						? !!s.lastCompletion?.summary
						: s.goal?.status === "budget_limited",
				"budget boundary",
			);
			// The last response may overshoot. An accepted terminal completion needs
			// no further work; otherwise the budget-limited state stops continuation.
			if (mode === "complete") assert.equal(limited.goal, null);
			else assert.equal(limited.lastCompletion, null);
			assert.equal(budget.calls.length, 1);
		} finally {
			await budget.dispose();
		}
	}
	const f = await fixture("hold");
	try {
		await f.start("goal.start", {
			objective: "Wait for cancellation",
			tokenBudget: 1000,
		});
		await f.answer(true);
		await until(
			f.snapshot,
			(s) => f.calls.length === 1 && !s.busy,
			"provider started",
		);
		await f.start("worktree.add");
		const refused = await until(
			f.snapshot,
			(s) => !s.busy,
			"active Goal worktree refusal",
		);
		assert.match(refused.notice, /Pause Goal/);
		assert.equal(git(f.cwd, "branch", "--list").trim(), "* main");
		await f.start("goal.pause");
		await until(
			f.snapshot,
			(s) => s.goal?.status === "paused" && !s.busy,
			"paused",
		);
		assert.equal(f.calls[0].options.signal.aborted, true);
		assert.equal(f.calls.length, 1);
	} finally {
		f.release();
		await f.dispose();
	}
});
test("paused Goal limits and token usage survive real session reopen without automatic model work", async () => {
	const first = await fixture("text");
	let resumed;
	try {
		await first.start("goal.start", {
			objective: "Persist bounded work",
			tokenBudget: 10000,
		});
		await first.answer(true);
		const before = await until(
			first.snapshot,
			(s) => s.goal?.status === "paused",
			"initial pause",
		);
		await first.session.waitForIdle();
		const sessionFile = first.session.sessionManager.getSessionFile();
		assert.ok(sessionFile);
		const oldEpoch = first.service.serviceEpoch;
		await first.owner.dispose();
		resumed = await fixture("text", { root: first.root, sessionFile });
		const after = await resumed.snapshot();
		assert.equal(after.goal.status, "paused");
		assert.equal(after.goal.id, before.goal.id);
		assert.equal(after.goal.automaticTurns, before.goal.automaticTurns);
		assert.equal(after.goal.tokensUsed, before.goal.tokensUsed);
		assert.equal(resumed.calls.length, 0);
		assert.notEqual(resumed.service.serviceEpoch, oldEpoch);
		await assert.rejects(
			resumed.service.handle({
				...resumed.request({
					operation: "start",
					action: "goal.resume",
					expectedGoalId: after.goal.id,
				}),
				serviceEpoch: oldEpoch,
			}),
			/Stale/,
		);
		assert.equal(resumed.calls.length, 0);
	} finally {
		if (resumed) await resumed.dispose();
		else await first.dispose();
	}
});
test("Pi becoming busy after a Git preview blocks the mutation without aborting unrelated model work", async () => {
	const f = await fixture("hold");
	let running;
	try {
		const target = join(f.root, "busy-preview");
		await f.start("worktree.add");
		await f.answer("busy-preview");
		await f.answer("");
		await f.answer(target);
		await f.dialog();
		running = f.session.prompt("Hold this unrelated model request.");
		await until(
			f.snapshot,
			() => f.calls.length === 1,
			"unrelated model started",
		);
		await f.answer(true);
		const result = await until(
			f.snapshot,
			(s) => !s.busy,
			"busy mutation refused",
		);
		assert.match(result.notice, /became active/);
		await assert.rejects(access(target));
		assert.equal(git(f.cwd, "branch", "--list").trim(), "* main");
		assert.equal(f.calls[0].options.signal.aborted, false);
	} finally {
		await f.session.abort();
		f.release();
		await running?.catch(() => {});
		await f.dispose();
	}
});
test("changing the selected model invalidates an outstanding Goal approval without reverting the user's selection", async () => {
	const f = await fixture("complete");
	try {
		await f.start("goal.start", {
			objective: "Stale model approval",
			tokenBudget: 1000,
		});
		await f.dialog();
		const replacement = f.runtime.getModel("openai", "gpt-6-astra");
		assert.ok(replacement);
		await f.session.setModel(replacement);
		await f.answer(true);
		const state = await until(
			f.snapshot,
			(s) => !s.busy,
			"stale model rejected",
		);
		assert.equal(state.goal, null);
		assert.equal(f.calls.length, 0);
		assert.match(state.notice, /model, thinking, tools or limits changed/);
		assert.equal(f.session.model.id, "gpt-6-astra");
	} finally {
		await f.dispose();
	}
});
test("Goal waits without polling; incidental prompts stay quiet, explicit resume and custom external wakes work", async () => {
  const f = await fixture("wait");
  try {
    await f.start("goal.start", { objective: "Wait for explicit wake", tokenBudget: 1000 }); await f.answer(true);
    const waiting = await until(f.snapshot, s => !!s.goal?.waiting && !s.busy, "quiet wait");
    await f.session.waitForIdle(); for (let i = 0; i < 5; i++) await f.snapshot(); assert.equal(f.calls.length, 1);
    f.setMode("repeat");
    await f.session.prompt("Can you answer an unrelated question?");
    await f.session.waitForIdle();
    const stillWaiting = await f.snapshot();
    assert.ok(stillWaiting.goal?.waiting, "an incidental user prompt must not clear the wait");
    assert.equal(f.calls.length, 2);
    for (let i = 0; i < 5; i++) await f.snapshot();
    assert.equal(f.calls.length, 2, "an incidental prompt must not authorize automatic continuation");
    f.setMode("complete"); await f.start("goal.resume"); await f.dialog(); assert.equal(f.calls.length, 2);
    await f.answer(true); const done = await until(f.snapshot, s => !!s.lastCompletion?.summary, "resumed completion");
    assert.equal(done.lastCompletion.id, waiting.goal.id); assert.equal(f.calls.length, 3);
  } finally { await f.dispose(); }
});
test("A custom external wake clears a Goal wait and runs the active goal", async () => {
  const f = await fixture("wait");
  try {
    await f.start("goal.start", { objective: "Wait for a custom external wake", tokenBudget: 1000 });
    await f.answer(true);
    const waiting = await until(f.snapshot, s => !!s.goal?.waiting && !s.busy, "quiet wait before external wake");
    f.setMode("complete");
    f.sendCustom({ customType: "fixture-external-wake", content: "The external condition is ready.", display: false }, { triggerTurn: true });
    const done = await until(f.snapshot, s => !!s.lastCompletion?.summary, "external wake completion");
    assert.equal(done.lastCompletion.id, waiting.goal.id);
    assert.equal(f.calls.length, 2);
  } finally { await f.dispose(); }
});
