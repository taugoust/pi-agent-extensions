import { readExtensionDefaults, readPreferenceDocument, mergeExtensionSettings } from "../shared/extension-defaults.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBtwService } from "./service";

type CommandHandler = Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];

export default function btw(pi: ExtensionAPI) {
	let service: ReturnType<typeof createBtwService> | undefined;
	let terminal: Promise<CommandHandler> | undefined;
	let generation = 0;
	let terminalBusy = false;
	const terminalSubscriptions: Array<() => void> = [];
	const registry = globalThis as typeof globalThis & { __paeBtwV1?: ReturnType<typeof createBtwService> };
	function dispose() {
		generation++;
		terminal = undefined;
		terminalBusy = false;
		for (const unsubscribe of terminalSubscriptions.splice(0)) unsubscribe();
		service?.dispose();
		if (registry.__paeBtwV1 === service) delete registry.__paeBtwV1;
		service = undefined;
	}
	function start(ctx: ExtensionContext) {
		dispose();
		let model = "openai/gpt-6-luna";
		try {
			const defaults = readExtensionDefaults("btw").paseo;
			if (defaults !== undefined && (!defaults || typeof defaults !== "object" || Array.isArray(defaults))) {
				throw new Error("defaults/btw.json: paseo must be an object");
			}
			const settings = mergeExtensionSettings({ model, ...(defaults as Record<string, unknown> | undefined) },
				readPreferenceDocument(join(getAgentDir(), "btw.json")));
			if (typeof settings.model === "string" && settings.model.length <= 512) model = settings.model;
			else throw new Error("Invalid BTW model");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				if (ctx.hasUI) ctx.ui.notify("Paseo BTW settings are invalid; Paseo side conversations are disabled.", "error");
				return;
			}
		}
		service = createBtwService(ctx, model);
		registry.__paeBtwV1 = service;
	}
	function terminalHandler(): Promise<CommandHandler> {
		if (terminal) return terminal;
		const expected = generation;
		terminal = import("./candidate-runtime").then(({ default: register }) => {
			if (generation !== expected) throw new Error("BTW session changed while loading");
			let handler: CommandHandler | undefined;
			// Keep one command registration while allowing the candidate to own
			// its terminal state. No terminal toolkit is loaded for Paseo-only use.
			const facade = new Proxy(pi, {
				get(target, property) {
					if (property === "registerCommand") return (name: string, command: { handler: CommandHandler }) => {
						if (name !== "btw") throw new Error("Unexpected candidate command");
						handler = command.handler;
					};
					if (property === "on") return (...args: any[]) => {
						const unsubscribe = (target.on as (...values: any[]) => (() => void))(...args);
						if (typeof unsubscribe === "function") terminalSubscriptions.push(unsubscribe);
						return unsubscribe;
					};
					return Reflect.get(target, property, target);
				},
			});
			register(facade);
			if (!handler) throw new Error("Candidate did not register BTW");
			return handler;
		}).catch(error => {
			if (generation === expected) {
				terminal = undefined;
				for (const unsubscribe of terminalSubscriptions.splice(0)) unsubscribe();
			}
			throw error;
		});
		return terminal;
	}
	pi.on("session_start", async (_event, ctx) => start(ctx));
	pi.on("session_shutdown", async () => dispose());
	pi.registerCommand("btw", {
		description: "Open the terminal BTW manager, or ask a side question without changing the main conversation",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			if (ctx.mode === "tui") {
				if (terminalBusy) { ctx.ui.notify("BTW is already open in the terminal.", "info"); return; }
				const expected = generation;
				terminalBusy = true;
				try {
					const handler = await terminalHandler();
					if (generation === expected) await handler(args, ctx);
				} catch (error) {
					if (generation === expected) ctx.ui.notify(`BTW could not open: ${error instanceof Error ? error.message : String(error)}`, "error");
				} finally { if (generation === expected) terminalBusy = false; }
				return;
			}
			// Preserve the existing RPC command path; Paseo's composer chat uses
			// the independent service above, not terminal components.
			if (!args.trim()) { ctx.ui.notify("Open BTW beside the Paseo composer to start or resume a side conversation.", "info"); return; }
			if (!service || service.sessionId !== ctx.sessionManager.getSessionId()) { ctx.ui.notify("BTW is unavailable. Reload Pi and retry.", "error"); return; }
			try {
				const snapshot = service.handle({ operation: "snapshot", sessionId: service.sessionId, serviceEpoch: service.serviceEpoch });
				service.handle({ operation: "start", sessionId: service.sessionId, serviceEpoch: service.serviceEpoch,
					requestId: randomUUID(), threadId: randomUUID(), question: args.trim(), model: snapshot.defaultModel, context: "recent" });
				ctx.ui.notify("BTW started. Open the Paseo BTW panel to follow the answer.", "info");
			} catch { ctx.ui.notify("BTW could not start. Check its model setting or use the Paseo panel.", "error"); }
		},
	});
}
