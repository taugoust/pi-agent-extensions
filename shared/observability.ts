import { truncateUtf8 } from "./harness-readonly.ts";
import { sanitizeTerminalText } from "./terminal-text.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

/** Read-only, session-owned UI data. Never credentials, message text, tool arguments or output. */
export const OBSERVABILITY_KEY = "__paeObservabilityV1";
export type Feature = "stamp" | "progress" | "cache";
export type Snapshot = {
	protocol: 1;
	sessionId: string;
	feature: Feature;
	state: "available";
	lastUpdated: string | null;
	stale: false;
	data: unknown;
};
export type ObservabilityService = {
	protocol: 1;
	sessionId: string;
	snapshot(input: { sessionId: string }): Promise<Snapshot>;
};
export type ObservabilityRegistry = {
	protocol: 1;
	stamp?: ObservabilityService;
	progress?: ObservabilityService;
	cache?: ObservabilityService;
};

export function registerObservation(
	pi: ExtensionAPI,
	feature: Feature,
	collect: (ctx: ExtensionContext) => unknown,
) {
	let service: ObservabilityService | undefined;
	let owner: ExtensionContext["sessionManager"] | undefined;
	const globals = globalThis as Record<string, unknown>;
	const remove = () => {
		const registry = globals[OBSERVABILITY_KEY] as
			| ObservabilityRegistry
			| undefined;
		if (registry && registry[feature] === service) delete registry[feature];
		service = undefined;
		owner = undefined;
	};
	pi.on("session_start", (_event, ctx) => {
		remove();
		const sessionId = ctx.sessionManager.getSessionId();
		owner = ctx.sessionManager;
		const registry = (globals[OBSERVABILITY_KEY] ??= {
			protocol: 1,
		}) as ObservabilityRegistry;
		if (registry.protocol !== 1)
			throw new Error("Unsupported observability registry");
		const current: ObservabilityService = {
			protocol: 1,
			sessionId,
			async snapshot(input) {
				if (
					service !== current ||
					owner !== ctx.sessionManager ||
					input.sessionId !== sessionId ||
					ctx.sessionManager.getSessionId() !== sessionId ||
					registry[feature] !== current
				)
					throw new Error("Observability session changed");
				const data = collect(ctx);
				const branch = ctx.sessionManager.getBranch();
				return {
					protocol: 1,
					sessionId,
					feature,
					state: "available",
					lastUpdated: branch.at(-1)?.timestamp ?? null,
					stale: false,
					data,
				};
			},
		};
		service = current;
		registry[feature] = current;
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (owner === ctx.sessionManager) remove();
	});
}

/** Bound and strip terminal/bidi controls at the external display boundary. */
export function displayText(value: unknown, limit = 256): string {
	if (typeof value !== "string") return "";
	const bounded = truncateUtf8(sanitizeTerminalText(value), limit);
	return bounded.text + (bounded.truncated ? "…" : "");
}
