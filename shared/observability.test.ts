import { test, expect } from "bun:test";
import { DEFAULT_STAMP_SETTINGS } from '../stamp/format.js';
import stamp, { stampRecords } from "../stamp/index.ts";
import progress from "../progress/index.ts";
import cache from "../cache-hit-monitor/index.ts";
import { OBSERVABILITY_KEY, displayText } from "./observability.ts";
import {
	prepareProgressArguments,
	reconstructProgress,
	reconcileProgressContext,
} from "../progress/progress-state.ts";

function fixture(mode = "rpc") {
	const handlers = new Map<string, Function[]>(),
		tools = new Map<string, any>(),
		commands = new Map<string, any>();
	let branch: any[] = [];
	let id = "session-1";
	const manager = { getBranch: () => branch, getSessionId: () => id };
	const ctx: any = {
		mode,
		hasUI: mode !== "json",
		thinkingLevel: "low",
		sessionManager: manager,
		modelRegistry: { find: () => undefined },
		ui: {
			setWidget() {},
			notify() {},
			theme: { fg: (_: string, s: string) => s, bold: (s: string) => s },
		},
	};
	const pi: any = {
		on: (name: string, fn: Function) => {
			handlers.set(name, [...(handlers.get(name) ?? []), fn]);
		},
		registerTool: (t: any) => tools.set(t.name, t),
		registerCommand: (n: string, c: any) => commands.set(n, c),
		registerEntryRenderer() {},
		appendEntry: (customType: string, data: any) =>
			branch.push({
				id: `entry-${branch.length}`,
				type: "custom",
				timestamp: new Date().toISOString(),
				customType,
				data,
			}),
	};
	return {
		pi,
		ctx,
		tools,
		commands,
		get branch() {
			return branch;
		},
		setBranch: (b: any[]) => (branch = b),
		setId: (s: string) => (id = s),
		async emit(name: string, event: any = {}) {
			const results = [];
			for (const fn of handlers.get(name) ?? [])
				results.push(await fn(event, ctx));
			return results;
		},
		get service() {
			return (globalThis as any)[OBSERVABILITY_KEY];
		},
	};
}
const message = () => ({
	role: "assistant",
	timestamp: Date.now() - 100,
	provider: "openai",
	model: "gpt-6-astra",
	api: "openai-responses",
	stopReason: "stop",
	content: [{ type: "text", text: "SECRET RESPONSE" }],
	responseId: "SECRET ID",
	usage: {
		input: 100,
		output: 5,
		cacheRead: 900,
		cacheWrite: 0,
		totalTokens: 1005,
		cost: {
			input: 0.1,
			output: 0.01,
			cacheRead: 0.01,
			cacheWrite: 0,
			total: 0.12,
		},
	},
});
for (const mode of ["rpc", "json"])
	test(`stamp captures metadata in ${mode} without exposing content/IDs`, async () => {
		const f = fixture(mode);
		stamp(f.pi);
		await f.emit("session_start");
		try {
			const m = message();
			await f.emit("turn_start");
			await f.emit("message_start", { message: m });
			await f.emit("message_end", { message: m });
			await f.emit("turn_end", { message: m, toolResults: [] });
			const s = await f.service.stamp.snapshot({ sessionId: "session-1" });
			expect(s.data.records).toHaveLength(1);
			expect(s.data.records[0].model).toBe("gpt-6-astra");
			expect(s.data.records[0].thinking).toBe("low");
			expect(JSON.stringify(s)).not.toContain("SECRET");
			const old = f.service.stamp;
			await f.emit("session_shutdown");
			await expect(old.snapshot({ sessionId: "session-1" })).rejects.toThrow();
		} finally {
			await f.emit("session_shutdown");
		}
	});
test("progress persists via validated tool results and restores active branch without waking a model", async () => {
	const f = fixture();
	progress(f.pi);
	await f.emit("session_start");
	try {
		const tool = f.tools.get("update_progress");
		const params = { steps: [{ text: "wait for review", status: "blocked" }] };
		const result = await tool.execute(
			"call",
			params,
			undefined,
			undefined,
			f.ctx,
		);
		f.branch.push({
			type: "message",
			message: {
				role: "toolResult",
				toolName: "update_progress",
				isError: false,
				details: result.details,
			},
		});
		expect(
			(await f.service.progress.snapshot({ sessionId: "session-1" })).data
				.steps,
		).toEqual(params.steps);
		expect(() =>
			prepareProgressArguments({
				steps: [
					{ text: "one", status: "in_progress" },
					{ text: "two", status: "in_progress" },
				],
			}),
		).toThrow();
		f.setBranch([]);
		await f.emit("session_tree");
		expect(
			(await f.service.progress.snapshot({ sessionId: "session-1" })).data
				.steps,
		).toEqual([]);
	} finally {
		await f.emit("session_shutdown");
	}
});
test("progress context remains untouched without a leading summary and is restored once after compaction", () => {
	const steps = [{ text: "verify", status: "blocked" as const }];
	const original: any = [{ role: "user", content: "hello", timestamp: 1 }];
	expect(reconcileProgressContext(original, steps)).toBe(original);
	const summarized: any = [
		{
			role: "compactionSummary",
			summary: "earlier work",
			tokensBefore: 1000,
			timestamp: 2,
		},
	];
	const restored = reconcileProgressContext(summarized, steps);
	expect(restored.length).toBe(2);
	expect(reconcileProgressContext(restored, steps)).toBe(restored);
	expect(
		reconstructProgress([
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "update_progress",
					isError: true,
					details: { version: 5, steps },
				},
			},
		] as any),
	).toEqual([]);
});
test("cache snapshots are available while widget hidden, branch-aware, and include summary costs", async () => {
	const f = fixture("json");
	cache(f.pi);
	f.branch.push({ type: "message", message: message() });
	await f.emit("session_start");
	try {
		const first = await f.service.cache.snapshot({ sessionId: "session-1" });
		expect(first.data.latest.hitRatePercent).toBe(90);
		expect(first.data.session.requestCount).toBe(1);
		f.branch.push({ type: "compaction", usage: message().usage });
		const next = await f.service.cache.snapshot({ sessionId: "session-1" });
		expect(next.data.session.requestCount).toBe(2);
		await expect(
			f.service.cache.snapshot({ sessionId: "other" }),
		).rejects.toThrow();
		const old = f.service.cache;
		f.setId("session-2");
		await f.emit("session_start");
		await expect(old.snapshot({ sessionId: "session-1" })).rejects.toThrow();
	} finally {
		await f.emit("session_shutdown");
	}
});
test("stamp output is bounded and terminal sequences cannot enter snapshot labels", () => {
	const entries = Array.from({ length: 100 }, (_, i) => ({
		id: String(i),
		type: "custom",
		customType: "pi-stamp",
		data: { version: 2, role: "user", timestamp: i },
	}));
	expect(stampRecords(entries)).toHaveLength(50);
	expect(displayText("\x1b]52;c;secret\x07hello\u202e")).toBe("hello");
});
test('Paseo stamp projection honors metadata/thinking/timing visibility preferences', () => {
 const entries = [{id:'s',type:'custom',customType:'pi-stamp',data:{version:5,role:'assistant',timestamp:1,completedAt:2,thinkingLevel:'low',metadata:{api:'openai-responses',provider:'openai',model:'astra',stopReason:'stop'}}}];
 expect(stampRecords(entries)[0].model).toBe('astra');
 const hidden = stampRecords(entries,{...DEFAULT_STAMP_SETTINGS,assistantMetadata:'off',responseTiming:'off'})[0];
 expect(hidden.model).toBeUndefined();expect(hidden.thinking).toBeUndefined();expect(hidden.completedAt).toBeUndefined();
});
