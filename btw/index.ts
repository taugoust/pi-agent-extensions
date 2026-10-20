import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createBtwService } from "./service";

export default function btw(pi: ExtensionAPI) {
	let service: ReturnType<typeof createBtwService> | undefined;
	const registry = globalThis as typeof globalThis & {
		__paeBtwV1?: ReturnType<typeof createBtwService>;
	};
	function dispose() {
		service?.dispose();
		if (registry.__paeBtwV1 === service) delete registry.__paeBtwV1;
		service = undefined;
	}
	function start(ctx: ExtensionContext) {
		dispose();
		let model = "openai/gpt-6-luna";
		try {
			const settings = JSON.parse(
				readFileSync(
					join(
						process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"),
						"btw.json",
					),
					"utf8",
				),
			);
			if (typeof settings.model === "string" && settings.model.length <= 512)
				model = settings.model;
			else throw new Error("Invalid BTW model");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				if (ctx.hasUI)
					ctx.ui.notify(
						"BTW settings are invalid; side conversations are disabled.",
						"error",
					);
				return;
			}
		}
		service = createBtwService(ctx, model);
		registry.__paeBtwV1 = service;
	}
	pi.on("session_start", async (_event, ctx) => start(ctx));
	pi.on("session_shutdown", async () => dispose());
	pi.registerCommand("btw", {
		description: "Start a side question or find the Paseo BTW panel",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			if (!args.trim()) {
				ctx.ui.notify(
					"Open BTW beside the Paseo composer to start or resume a side conversation.",
					"info",
				);
				return;
			}
			if (!service || service.sessionId !== ctx.sessionManager.getSessionId()) {
				ctx.ui.notify("BTW is unavailable. Reload Pi and retry.", "error");
				return;
			}
			try {
				const snapshot = service.handle({
					operation: "snapshot",
					sessionId: service.sessionId,
					serviceEpoch: service.serviceEpoch,
				});
				service.handle({
					operation: "start",
					sessionId: service.sessionId,
					serviceEpoch: service.serviceEpoch,
					requestId: randomUUID(),
					threadId: randomUUID(),
					question: args.trim(),
					model: snapshot.defaultModel,
					context: "recent",
				});
				ctx.ui.notify(
					"BTW started. Open the Paseo BTW panel to follow the answer.",
					"info",
				);
			} catch {
				ctx.ui.notify(
					"BTW could not start. Check its model setting or use the Paseo panel.",
					"error",
				);
			}
		},
	});
}
