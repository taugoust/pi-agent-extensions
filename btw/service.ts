import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildConversationContext } from "./conversation-context";
import { bindSessionModelRequest, prepareSessionRoutingRequest, resolveSessionModelSelector } from "../shared/session-routing";
import {
	completeSideThreadTurn,
	createSideThread,
	type CompleteSimpleFunction,
	type SideThread,
} from "./side-thread";

export type BtwRequest =
	| {
			operation: "snapshot";
			sessionId: string;
			serviceEpoch: string;
			threadId?: string;
	  }
	| {
			operation: "start" | "send" | "cancel" | "remove";
			sessionId: string;
			serviceEpoch: string;
			requestId: string;
			threadId: string;
			question?: string;
			model?: string;
			context?: "recent" | "none";
	  };
type Thread = {
	id: string;
	model: string;
	context: "recent" | "none";
	state: "idle" | "running" | "cancelled" | "error";
	question: string;
	partial: string;
	error: string | null;
	thread: SideThread;
	controller?: AbortController;
};
const MAX_THREADS = 8,
	MAX_TURNS = 16,
	MAX_TEXT = 16_000;
const uuid =
	/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

/** In-memory, parent-session-owned side conversations. No main prompt/editor mutations. */
export function createBtwService(
	ctx: ExtensionContext,
	defaultModel = "openai/gpt-6-luna",
) {
	const sessionId = ctx.sessionManager.getSessionId(),
		serviceEpoch = randomUUID();
	const threads = new Map<string, Thread>();
	// Never evict mutation IDs within a service lifetime: exhaustion fails closed.
	const requests = new Map<string, string>();
	let closed = false;
	function dispose() {
		if (closed) return;
		closed = true;
		for (const t of threads.values()) t.controller?.abort();
		threads.clear();
		requests.clear();
	}
	function current() {
		if (!closed && ctx.sessionManager.getSessionId() !== sessionId) dispose();
		if (closed) throw new Error("BTW session changed; refresh.");
	}
	function snapshot(selectedId?: string) {
		current();
		let provider: string | undefined;
		try { provider = resolveSessionModelSelector(ctx, defaultModel).split("/", 1)[0]; } catch { /* unavailable until a physical provider is selected */ }
		const available = ctx.modelRegistry
			.getAvailable()
			.filter((m) => m.provider !== "idle-guard" && m.api !== "pi-virtual" && (!provider || m.provider === provider))
			.map((m) => `${m.provider}/${m.id}`)
			.filter((id) => id.length <= 512);
		const models = [
			...new Set([
				...(available.includes(defaultModel) ? [defaultModel] : []),
				...available,
			]),
		].slice(0, 256);
		return {
			protocol: 1,
			sessionId,
			serviceEpoch,
			defaultModel,
			models,
			threads: [...threads.values()].map((t) => ({
				id: t.id,
				model: (() => { try { return resolveSessionModelSelector(ctx, t.model); } catch { return t.model; } })(),
				context: t.context,
				contextTruncated: t.thread.conversationContext.startsWith(
					"[Earlier context omitted;",
				),
				state: t.state,
				question: t.id === selectedId ? t.question : t.question.slice(0, 120),
				partial: t.id === selectedId ? t.partial : "",
				error: t.error,
				turnCount: t.thread.turns.length,
				turns: (t.id === selectedId ? t.thread.turns : [])
					.filter((turn) => turn.kind === "answered")
					.map((turn) => ({ question: turn.question, answer: turn.answer })),
			})),
		};
	}
	async function run(t: Thread, question: string, controller: AbortController) {
		const timer = setTimeout(() => controller.abort(), 180_000);
		try {
			current();
			const routingProfile = await prepareSessionRoutingRequest(ctx);
			const selector = resolveSessionModelSelector(ctx, t.model, routingProfile);
			const split = selector.indexOf("/");
			const foundModel = ctx.modelRegistry.find(selector.slice(0, split), selector.slice(split + 1));
			const model = foundModel && routingProfile ? bindSessionModelRequest(foundModel, routingProfile) : foundModel;
			if (
				!model ||
				model.provider === "idle-guard" ||
				model.api === "pi-virtual"
			)
				throw new Error("Unavailable side model");
			const complete: CompleteSimpleFunction = async (
				selected,
				context,
				options,
			) => {
				current();
				if (controller.signal.aborted) throw new Error("Cancelled");
				const stream = ctx.modelRegistry.streamSimple(selected, context, {
					...options,
					maxTokens: 4096,
				});
				for await (const event of stream) {
					if (closed || controller.signal.aborted) break;
					if (event.type === "text_delta")
						t.partial = (t.partial + event.delta).slice(0, MAX_TEXT);
				}
				const response = await stream.result();
				current();
				if (JSON.stringify(response).length > 128_000)
					throw new Error("Response exceeded BTW limit");
				return response;
			};
			complete.appliesRequestHeaderTransforms = true;
			const result = await completeSideThreadTurn({
				thread: t.thread,
				model,
				question,
				thinkingLevel: "low",
				completeSimple: complete,
				signal: controller.signal,
				sessionId,
			});
			if (closed || threads.get(t.id) !== t) return;
			t.state =
				result.kind === "answered"
					? "idle"
					: result.kind === "aborted"
						? "cancelled"
						: "error";
			t.error =
				result.kind === "error"
					? "Side-model request failed. Check the selected model and Pi login."
					: null;
			// Bound frontend data without exposing provider response objects or reasoning.
			const last = t.thread.turns.at(-1);
			if (last?.kind === "answered") {
				const notice =
					last.answer.length > MAX_TEXT
						? "\n[Answer truncated at BTW display limit.]"
						: last.response.stopReason === "length"
							? "\n[Response reached the output limit.]"
							: "";
				last.answer = last.answer.slice(0, MAX_TEXT - notice.length) + notice;
			}
			t.partial = "";
		} catch {
			if (!closed) {
				t.state = controller.signal.aborted ? "cancelled" : "error";
				t.partial = "";
				t.error = controller.signal.aborted
					? null
					: "Side-model request failed. Check the selected model and Pi login.";
			}
		} finally {
			clearTimeout(timer);
			if (t.controller === controller) t.controller = undefined;
		}
	}
	function handle(input: unknown) {
		current();
		if (!input || typeof input !== "object" || Array.isArray(input))
			throw new Error("Invalid BTW request");
		const r = input as BtwRequest;
		if (r.sessionId !== sessionId || r.serviceEpoch !== serviceEpoch)
			throw new Error("BTW identity changed");
		const keys = Object.keys(r);
		if (r.operation === "snapshot") {
			if (
				keys.some(
					(k) =>
						!["operation", "sessionId", "serviceEpoch", "threadId"].includes(k),
				) ||
				(r.threadId !== undefined && !uuid.test(r.threadId))
			)
				throw new Error("Invalid snapshot");
			return snapshot(r.threadId);
		}
		if (
			!["start", "send", "cancel", "remove"].includes(r.operation) ||
			keys.some(
				(k) =>
					![
						"operation",
						"sessionId",
						"serviceEpoch",
						"requestId",
						"threadId",
						"question",
						"model",
						"context",
					].includes(k),
			) ||
			!uuid.test(r.requestId ?? "") ||
			!uuid.test(r.threadId ?? "")
		)
			throw new Error("Invalid BTW operation");
		const canonical = JSON.stringify([
			r.operation,
			r.threadId,
			r.question,
			r.model,
			r.context,
		]);
		if (requests.has(r.requestId)) {
			if (requests.get(r.requestId) !== canonical)
				throw new Error("Request ID reused with different intent");
			return snapshot(r.threadId);
		}
		if (requests.size >= 2048)
			throw new Error("BTW request limit reached; reload Pi");
		let t = threads.get(r.threadId);
		if (r.operation === "start" || r.operation === "send") {
			if (
				typeof r.question !== "string" ||
				!r.question.trim() ||
				r.question.length > 8000
			)
				throw new Error("Question must be 1–8000 characters");
			if (r.operation === "start") {
				if (t || threads.size >= MAX_THREADS)
					throw new Error("Thread exists or BTW thread limit reached");
				if (r.context !== "recent" && r.context !== "none")
					throw new Error("Choose a context source");
				const model = r.model ?? defaultModel;
				if (
					typeof model !== "string" ||
					model.length > 512 ||
					!snapshot().models.includes(model)
				)
					throw new Error(
						"Selected side model is unavailable; no fallback was made",
					);
				t = {
					id: r.threadId,
					model,
					context: r.context,
					state: "idle",
					question: "",
					partial: "",
					error: null,
					thread: createSideThread(
						r.context === "recent"
							? buildConversationContext(ctx.sessionManager.getBranch())
							: "",
					),
				};
			} else if (r.model !== undefined || r.context !== undefined)
				throw new Error("Existing thread model/context are fixed");
			if (!t || t.controller || t.thread.turns.length >= MAX_TURNS)
				throw new Error("Thread unavailable, busy, or full");
			requests.set(r.requestId, canonical);
			threads.set(t.id, t);
			t.question = r.question;
			t.partial = "";
			t.error = null;
			t.state = "running";
			const controller = new AbortController();
			t.controller = controller;
			// Reserve synchronously before any provider/auth await. Returning never waits for inference.
			void run(t, r.question, controller);
		} else {
			if (
				!t ||
				r.question !== undefined ||
				r.model !== undefined ||
				r.context !== undefined
			)
				throw new Error("Invalid thread control");
			requests.set(r.requestId, canonical);
			t.controller?.abort();
			if (r.operation === "remove") threads.delete(t.id);
			else if (!t.controller) t.state = "cancelled";
		}
		return snapshot(r.threadId);
	}
	return { protocol: 1, sessionId, serviceEpoch, handle, dispose };
}
