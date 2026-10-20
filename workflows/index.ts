import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import goal from "./goal/goal.js";
import worktree from "./worktree/worktree.js";
import {
	createWorktreeSettingsRuntime,
	settingsFilePath,
	type WorktreeSettingsRuntime,
} from "./worktree/settings.js";
import { createWorkflowService } from "./service.js";

export default function workflows(
	pi: ExtensionAPI,
	options: {
		goalSettingsPath?: string;
		worktreeSettings?: WorktreeSettingsRuntime;
	} = {},
) {
	let service: ReturnType<typeof createWorkflowService> | undefined,
		commandBusy = false;
	const global = globalThis as typeof globalThis & {
		__paeWorkflowsV1?: ReturnType<typeof createWorkflowService>;
	};
	let goalState: ReturnType<typeof goal>;
	const api = new Proxy(pi, {
		get(target, key) {
			if (key === "registerCommand")
				return (name: string, definition: any) =>
					target.registerCommand(name, {
						...definition,
						handler: async (args: string, ctx: any) => {
							if (
								commandBusy ||
								service?.hasOperation() ||
								(name === "worktree" &&
									goalState?.runtime.activeGoal?.status === "active")
							) {
								if (ctx.hasUI)
									ctx.ui.notify(
										"Finish the current workflow operation, or pause Goal before managing worktrees.",
										"warning",
									);
								return;
							}
							commandBusy = true;
							try {
								return await definition.handler(args, ctx);
							} finally {
								commandBusy = false;
							}
						},
					});
			return Reflect.get(target, key, target);
		},
	});
	goalState = goal(api, { settingsPath: options.goalSettingsPath });
	const settings =
		options.worktreeSettings ??
		createWorktreeSettingsRuntime({ path: settingsFilePath });
	worktree(api, { settings });
	function dispose() {
		service?.dispose();
		if (global.__paeWorkflowsV1 === service) delete global.__paeWorkflowsV1;
		service = undefined;
	}
	pi.on("session_start", async (_event, ctx) => {
		dispose();
		service = createWorkflowService(
			pi,
			ctx,
			goalState.runtime,
			goalState.commands,
			settings,
			() => commandBusy,
		);
		global.__paeWorkflowsV1 = service;
	});
	pi.on("model_select", async (_event, ctx) => service?.refreshContext(ctx));
	pi.on("session_shutdown", async () => dispose());
}
