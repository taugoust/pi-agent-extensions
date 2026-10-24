import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const { createJiti } = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("jiti");
const jiti = createJiti(import.meta.url);
const { createBtwService } = await jiti.import("../btw/service.ts");
const { buildConversationContext } = await jiti.import(
	"../btw/conversation-context.ts",
);
const { default: extension } = await jiti.import("../btw/index.ts");
const turn = () => new Promise((resolve) => setImmediate(resolve));
function fixture() {
	const calls = [],
		main = [
			{
				type: "message",
				message: { role: "user", content: "Main task context" },
			},
		];
	const luna = {
			provider: "openai",
			id: "gpt-6-luna",
			api: "openai-responses",
		},
		guard = { provider: "idle-guard", id: "astra" };
	let sessionId = "parent";
	const ctx = {
		hasUI: false,
		sessionManager: { getSessionId: () => sessionId, getBranch: () => main },
		modelRegistry: {
			getAvailable: () => [luna, guard],
			find: (p, id) =>
				p === luna.provider && id === luna.id ? luna : undefined,
			streamSimple(model, context, options) {
				let resolve;
				const ready = new Promise((r) => (resolve = r));
				const response = {
					role: "assistant",
					content: [{ type: "text", text: "Side answer" }],
					stopReason: "stop",
					usage: {},
					timestamp: 1,
				};
				const call = {
					model,
					context,
					options,
					finish: () => resolve(response),
					fail: () =>
						resolve({
							...response,
							stopReason: "error",
							errorMessage: "SECRET_TOKEN",
						}),
				};
				calls.push(call);
				options.signal.addEventListener(
					"abort",
					() => resolve({ ...response, stopReason: "aborted" }),
					{ once: true },
				);
				return {
					[Symbol.asyncIterator]: async function* () {
						yield { type: "text_delta", delta: "Side " };
						await ready;
					},
					result: () => ready,
				};
			},
		},
	};
	const service = createBtwService(ctx);
	const snapshot = (threadId) =>
		service.handle({
			operation: "snapshot",
			sessionId: service.sessionId,
			serviceEpoch: service.serviceEpoch,
			...(threadId ? { threadId } : {}),
		});
	const request = (operation = "start", fields = {}) => ({
		operation,
		sessionId: service.sessionId,
		serviceEpoch: service.serviceEpoch,
		requestId: randomUUID(),
		threadId: randomUUID(),
		...(operation === "start"
			? {
					question: "Side question",
					context: "recent",
					model: "openai/gpt-6-luna",
				}
			: {}),
		...fields,
	});
	return {
		ctx,
		service,
		calls,
		main,
		snapshot,
		request,
		replace: () => {
			sessionId = "replacement";
		},
	};
}
test("copied engine routes only to selected side model, separate routing, no main writes; streamed followups retain context", async () => {
	const f = fixture(),
		before = structuredClone(f.main),
		r = f.request();
	f.service.handle(r);
	await turn();
	assert.equal(f.calls.length, 1);
	assert.equal(f.calls[0].model.id, "gpt-6-luna");
	assert.notEqual(f.calls[0].options.sessionId, "parent");
	assert.equal(f.calls[0].options.reasoning, "low");
	assert.equal(f.calls[0].options.maxTokens, 4096);
	assert.match(JSON.stringify(f.calls[0].context), /Main task context/);
	assert.equal(f.snapshot(r.threadId).threads[0].partial, "Side ");
	f.calls[0].finish();
	await turn();
	assert.equal(
		f.snapshot(r.threadId).threads[0].turns[0].answer,
		"Side answer",
	);
	f.main.push({
		type: "message",
		message: { role: "user", content: "Later main change" },
	});
	f.service.handle(
		f.request("send", { threadId: r.threadId, question: "Follow up" }),
	);
	await turn();
	assert.equal(f.calls[1].options.sessionId, f.calls[0].options.sessionId);
	assert.match(JSON.stringify(f.calls[1].context), /Side answer/);
	assert.doesNotMatch(JSON.stringify(f.calls[1].context), /Later main change/);
	assert.deepEqual(f.main.slice(0, 1), before);
	f.service.dispose();
	await turn();
});
test("mutation replay is idempotent, conflicting replay and concurrent send rejected", async () => {
	const f = fixture(),
		r = f.request();
	f.service.handle(r);
	await turn();
	f.service.handle(r);
	assert.equal(f.calls.length, 1);
	assert.throws(
		() => f.service.handle({ ...r, question: "different" }),
		/different intent/,
	);
	assert.throws(
		() =>
			f.service.handle(
				f.request("send", { threadId: r.threadId, question: "busy" }),
			),
		/busy/,
	);
	f.service.dispose();
	await turn();
});
test("unavailable models and guarded alias never fallback; wrong identity and invalid fields rejected", () => {
	const f = fixture();
	for (const model of ["idle-guard/astra", "missing/model"])
		assert.throws(
			() => f.service.handle(f.request("start", { model })),
			/unavailable/,
		);
	assert.throws(
		() => f.service.handle({ ...f.request(), serviceEpoch: randomUUID() }),
		/identity/,
	);
	assert.throws(
		() => f.service.handle({ ...f.request(), evil: true }),
		/Invalid/,
	);
	assert.equal(f.calls.length, 0);
	f.service.dispose();
});
test("cancel/removal/shutdown abort only side requests and suppress late results", async () => {
	for (const action of ["cancel", "remove", "dispose"]) {
		const f = fixture(),
			r = f.request();
		f.service.handle(r);
		await turn();
		if (action === "dispose") f.service.dispose();
		else f.service.handle(f.request(action, { threadId: r.threadId }));
		assert.equal(f.calls[0].options.signal.aborted, true);
		await turn();
		if (action === "cancel") {
			const t = f.snapshot(r.threadId).threads[0];
			assert.equal(t.state, "cancelled");
			assert.equal(t.turns.length, 0);
		}
		if (action === "remove") assert.equal(f.snapshot().threads.length, 0);
		f.service.dispose();
	}
});
test("errors are sanitized, no context mode imports no main text, independent owners", async () => {
	const a = fixture(),
		b = fixture(),
		r = a.request("start", { context: "none" });
	a.service.handle(r);
	await turn();
	assert.doesNotMatch(JSON.stringify(a.calls[0].context), /Main task context/);
	a.calls[0].fail();
	await turn();
	const output = JSON.stringify(a.snapshot(r.threadId));
	assert.doesNotMatch(output, /SECRET_TOKEN/);
	assert.match(output, /request failed/);
	assert.equal(b.snapshot().threads.length, 0);
	a.replace();
	assert.throws(() => a.snapshot(), /session changed/);
	a.service.dispose();
	b.service.dispose();
});
test("copied context is bounded and explicitly marks truncation", () => {
	const result = buildConversationContext([
		{ type: "message", message: { role: "user", content: "x".repeat(50000) } },
	]);
	assert.match(result, /Earlier context omitted/);
	assert.ok(result.length < 40100);
});
test("factory starts no service until session_start, reload cleanup cannot clear a newer service", async () => {
	const handlers = new Map();
	extension({ on: (name, fn) => handlers.set(name, fn), registerCommand() {} });
	const f = fixture(),
		previous = globalThis.__paeBtwV1;
	delete globalThis.__paeBtwV1;
	try {
		assert.equal(globalThis.__paeBtwV1, undefined);
		await handlers.get("session_start")({}, f.ctx);
		const old = globalThis.__paeBtwV1;
		assert.equal(old.sessionId, "parent");
		const newer = { test: true };
		globalThis.__paeBtwV1 = newer;
		await handlers.get("session_shutdown")({});
		assert.equal(globalThis.__paeBtwV1, newer);
		assert.throws(() => old.handle({}), /changed/);
	} finally {
		f.service.dispose();
		if (previous) globalThis.__paeBtwV1 = previous;
		else delete globalThis.__paeBtwV1;
	}
});
