import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import goal from "./goal/goal.js";
import worktree from "./worktree/worktree.js";
import {
	createWorktreeSettingsRuntime,
	settingsFilePath,
	type WorktreeSettingsRuntime,
} from "./worktree/settings.js";
import { createWorkflowService } from "./service.js";
import { createDelegatedChildGoalService } from "./delegated-child.ts";
import { bindGoalMutations } from "./goal/mutations.ts";

export default function workflows(
	pi: ExtensionAPI,
	options: {
		goalSettingsPath?: string;
		/** Trusted native worker bootstrap only: installs the existing child engine. */
		delegatedChild?: boolean;
		worktreeSettings?: WorktreeSettingsRuntime;
	} = {},
) {
	let service: ReturnType<typeof createWorkflowService> | undefined,
		childService: ReturnType<typeof createDelegatedChildGoalService> | undefined,
		commandBusy = false;
	const global = globalThis as typeof globalThis & {
		__paeWorkflowsV1?: ReturnType<typeof createWorkflowService>;
		__paeDelegatedChildGoalV1?: ReturnType<typeof createDelegatedChildGoalService>;
	};
	let goalState: ReturnType<typeof goal>;
	let disposeMutations: (() => void) | undefined;
	let pendingPermissions = 0;
	pi.events.on("permission-gate:waiting", () => { pendingPermissions++; });
	pi.events.on("permission-gate:resolved", () => { pendingPermissions = Math.max(0, pendingPermissions - 1); });
	const api = new Proxy(pi, {
		get(target, key) {
			if (key === "registerTool")
				return (definition: any) => target.registerTool(definition.name !== "goal_manage" ? definition : {
					...definition,
					...(options.delegatedChild ? { description: "Inspect this dedicated child's parent-owned goal with action=status. Creating, updating, pausing, resuming or clearing it is restricted to the authenticated parent control path." } : {}),
					execute: async (...args: any[]) => {
						if (options.delegatedChild && args[1]?.action !== "status")
							throw new Error("Dedicated child goal management is owned by its authenticated parent; only goal_manage status is available");
						if (args[1]?.action !== "status" && (commandBusy || service?.hasOperation() || pendingPermissions > 0)) throw new Error("Finish pending permission/workflow operations before changing the goal");
						return definition.execute(...args);
					},
				});
			if (key === "registerCommand")
				return (name: string, definition: any) =>
					target.registerCommand(name, {
						...definition,
						handler: async (args: string, ctx: any) => {
							if (options.delegatedChild && name === "goal" && args.trim() !== "status") {
								if (ctx.hasUI) ctx.ui.notify("Dedicated child goal management is owned by its authenticated parent. Use /goal status for inspection.", "warning");
								return;
							}
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
	goalState = goal(api, { settingsPath: options.goalSettingsPath, restorePaused: options.delegatedChild === true });
	const settings =
		options.worktreeSettings ??
		createWorktreeSettingsRuntime({ path: settingsFilePath });
	if (!options.delegatedChild) worktree(api, { settings });
	function dispose() {
		disposeMutations?.();
		disposeMutations = undefined;
		pendingPermissions = 0;
		childService?.dispose();
		if (global.__paeDelegatedChildGoalV1 === childService) delete global.__paeDelegatedChildGoalV1;
		childService = undefined;
		service?.dispose();
		if (global.__paeWorkflowsV1 === service) delete global.__paeWorkflowsV1;
		service = undefined;
	}
	pi.on("session_start", async (_event, ctx) => {
		dispose();
		disposeMutations = bindGoalMutations(pi, ctx, goalState.runtime, {
			child: options.delegatedChild === true,
			busy: () => commandBusy || !!service?.hasOperation() || pendingPermissions > 0,
		});
		if (options.delegatedChild) {
			childService = createDelegatedChildGoalService(pi, ctx, goalState.runtime, goalState.commands);
			global.__paeDelegatedChildGoalV1 = childService;
			return;
		}
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
	pi.on("model_select", async (_event, ctx) => {
		service?.refreshContext(ctx);
		childService?.refreshContext(ctx);
	});
	pi.on("session_shutdown", async () => dispose());
}
