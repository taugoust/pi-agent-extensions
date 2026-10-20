import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { addFlow, removeFlow, pruneFlow } from "./worktree/command.js";
import {
	currentWorktreePath,
	listWorktrees,
	pathsEqual,
	stripTerminalControls,
} from "./worktree/git.js";
import type { WorktreeSettingsRuntime } from "./worktree/settings.js";
import type { GoalRuntime } from "./goal/runtime.js";
import type { GoalCommandController } from "./goal/commands.js";

type Dialog = {
	id: string;
	operationId: string;
	kind: "input" | "select" | "confirm";
	title: string;
	message: string;
	options: string[];
};
type Operation = {
	id: string;
	action: string;
	protectedPaths: string[];
	expectedGoalId: string | null;
	wasWaiting: boolean;
	controller: AbortController;
	policyCheck?: () => boolean;
	dialog?: Dialog;
	reply?: (value: unknown) => void;
	reject?: (error: Error) => void;
};
const actions = [
	"worktree.add",
	"worktree.remove",
	"worktree.prune",
	"worktree.open",
	"goal.start",
	"goal.edit",
	"goal.pause",
	"goal.resume",
	"goal.clear",
];
const uuid =
	/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export function createWorkflowService(
	pi: ExtensionAPI,
	initialContext: ExtensionContext,
	runtime: GoalRuntime,
	commands: GoalCommandController,
	settings: WorktreeSettingsRuntime,
	externalBusy: () => boolean = () => false,
) {
	let ctx = initialContext,
		closed = false,
		operation: Operation | undefined,
		notice: string | null = null;
	const sessionId = ctx.sessionManager.getSessionId(),
		serviceEpoch = randomUUID();
	const requests = new Map<string, string>();
	const lifetime = new AbortController();
	let worktreeCache:
		| { rows: any[]; error: string | null; at: number }
		| undefined;
	let reading: Promise<void> | undefined;
	let completionLeaf: string | null | undefined;
	let lastCompletion: {
		id: string;
		text: string;
		summary: string | null;
	} | null = null;
	function completion() {
		const leaf = ctx.sessionManager.getLeafId();
		if (leaf === completionLeaf) return lastCompletion;
		completionLeaf = leaf;
		lastCompletion = null;
		const entries = ctx.sessionManager.getBranch();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as any;
			const goal =
				entry.type === "custom" && entry.customType === "goal-state"
					? entry.data?.goal
					: undefined;
			if (
				goal?.status !== "complete" ||
				typeof goal.id !== "string" ||
				typeof goal.text !== "string"
			)
				continue;
			let summary: string | null = null;
			for (const later of entries.slice(i + 1) as any[]) {
				const message = later.type === "message" ? later.message : undefined;
				if (
					message?.role === "toolResult" &&
					message.toolName === "goal_complete" &&
					!message.isError &&
					message.details?.goal_id === goal.id &&
					typeof message.details.summary === "string" &&
					message.content?.some(
						(part: any) =>
							part.type === "text" && part.text?.startsWith("Goal complete:"),
					)
				) {
					summary = message.details.summary.slice(0, 4000);
					break;
				}
			}
			lastCompletion = { id: goal.id, text: goal.text.slice(0, 4000), summary };
			break;
		}
		return lastCompletion;
	}
	function current(op?: Operation) {
		if (
			closed ||
			ctx.sessionManager.getSessionId() !== sessionId ||
			(op && (operation !== op || op.controller.signal.aborted))
		)
			throw new Error("Workflow session changed or operation cancelled");
	}
	function cancel() {
		const op = operation;
		if (
			!closed &&
			op?.action.startsWith("goal.") &&
			runtime.activeGoal?.status === "active" &&
			(runtime.activeGoal.id !== op.expectedGoalId ||
				(op.wasWaiting && !runtime.activeGoal.waiting))
		)
			commands.pauseGoal(ctx);
		op?.controller.abort();
		op?.reject?.(new Error("Operation cancelled"));
		if (op) {
			op.dialog = undefined;
			op.reply = undefined;
			op.reject = undefined;
		}
	}
	async function refreshWorktrees() {
		if (reading) return reading;
		if (worktreeCache && Date.now() - worktreeCache.at < 2000) return;
		reading = (async () => {
			try {
				const records = await listWorktrees(pi, ctx.cwd, lifetime.signal);
				current();
				const active = await currentWorktreePath(pi, ctx.cwd, lifetime.signal);
				current();
				worktreeCache = {
					at: Date.now(),
					error: null,
					rows: records.slice(0, 100).map((record) => ({
						path: record.path,
						branch: record.branch ?? null,
						head: record.head ?? null,
						main: record.isMain,
						current: pathsEqual(record.path, active),
						locked: record.lockedReason !== undefined,
						stale: record.prunableReason !== undefined,
						detached: record.detached,
					})),
				};
			} catch (error) {
				if (!closed)
					worktreeCache = {
						at: Date.now(),
						rows: [],
						error: stripTerminalControls(
							error instanceof Error ? error.message : "Git unavailable",
						).slice(0, 2000),
					};
			}
		})().finally(() => {
			reading = undefined;
		});
		return reading;
	}
	async function snapshot() {
		current();
		void refreshWorktrees();
		const goal = runtime.activeGoal,
			terminal = runtime.snapshotSettingsApplicationState().terminalDetails;
		return {
			protocol: 1,
			sessionId,
			serviceEpoch,
			cwd: ctx.cwd,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
			busy: !!operation || externalBusy(),
			idle: ctx.isIdle() && !ctx.hasPendingMessages(),
			notice,
			operationId: operation?.id ?? null,
			operationAction: operation?.action ?? null,
			protectedPaths: operation?.protectedPaths ?? [],
			dialog: operation?.dialog ?? null,
			worktrees: worktreeCache?.rows ?? [],
			worktreeError: worktreeCache?.error ?? null,
			worktreeLoading: !worktreeCache || !!reading,
			goal: goal
				? {
						id: goal.id,
						text: goal.text,
						status: goal.status,
						waiting: goal.waiting?.reason ?? null,
						iteration: goal.iteration,
						tokensUsed: goal.tokensUsed,
						tokenBudget: goal.tokenBudget ?? null,
						automaticTurns: goal.automaticModelTurns,
						noProgressTurns: goal.toolFreeRepeatCount,
						safetyPauseCause: goal.safetyPauseCause ?? null,
						summary:
							terminal?.goalId === goal.id
								? (terminal.summary ?? null)
								: null,
					}
				: null,
			lastCompletion: completion(),
			limits: {
				automaticTurns: runtime.settings.continuationLimits.automaticTurns,
				noProgressTurns: runtime.settings.continuationLimits.noProgressTurns,
			},
		};
	}
	function ask(
		op: Operation,
		kind: Dialog["kind"],
		title: string,
		message = "",
		options: string[] = [],
	) {
		current(op);
		if (
			title.length + message.length + options.join("").length > 48_000 ||
			options.length > 200
		)
			throw new Error(
				"Preview too large for remote confirmation; use the terminal",
			);
		return new Promise<unknown>((resolve, reject) => {
			op.dialog = {
				id: randomUUID(),
				operationId: op.id,
				kind,
				title,
				message,
				options,
			};
			op.reply = resolve;
			op.reject = reject;
		}).then((value) => {
			current(op);
			if (op.policyCheck && !op.policyCheck())
				throw new Error(
					"The model, thinking, tools or limits changed. Review the goal again.",
				);
			return value;
		});
	}
	function context(op: Operation): ExtensionCommandContext {
		// These Git-only flows use cwd, signal and public UI methods. Session switching is
		// deliberately disabled here; native Paseo opens a separate workspace instead.
		const ui = {
			...ctx.ui,
			input: async (title: string, placeholder?: string) => {
				const value = await ask(op, "input", title, placeholder);
				return value === null ? undefined : String(value);
			},
			select: async (title: string, options: string[]) => {
				const value = await ask(op, "select", title, "", options);
				return value === null ? undefined : String(value);
			},
			confirm: async (title: string, message: string) =>
				(await ask(op, "confirm", title, message)) === true,
			notify: (message: string) => {
				if (!closed && operation === op)
					notice = stripTerminalControls(message).slice(0, 6000);
			},
			setStatus: ctx.ui.setStatus.bind(ctx.ui),
		};
		return new Proxy(ctx, {
			get(target, key) {
				if (key === "ui") return ui;
				if (key === "signal") return op.controller.signal;
				if (key === "hasUI") return true;
				if (key === "mode") return "rpc";
				return Reflect.get(target, key, target);
			},
		}) as unknown as ExtensionCommandContext;
	}
	async function run(op: Operation, r: any) {
		const commandCtx = context(op);
		const gitPi = new Proxy(pi, {
			get(target, key) {
				if (key === "exec")
					return (command: string, args: string[], options: any) => {
						current(op);
						if (
							command === "git" &&
							args[0] === "worktree" &&
							["add", "remove", "prune"].includes(args[1]) &&
							!args.includes("--dry-run") &&
							(!ctx.isIdle() ||
								ctx.hasPendingMessages() ||
								runtime.activeGoal?.status === "active")
						)
							throw new Error(
								"Pi or Goal became active; worktree mutation refused",
							);
						return target.exec(command, args, options);
					};
				return Reflect.get(target, key, target);
			},
		});
		try {
			current(op);
			if (r.action.startsWith("worktree.")) {
				if (
					!ctx.isIdle() ||
					ctx.hasPendingMessages() ||
					runtime.activeGoal?.status === "active"
				)
					throw new Error(
						"Pause Goal and wait until Pi is idle before changing worktrees",
					);
				const records = await listWorktrees(pi, ctx.cwd, op.controller.signal);
				current(op);
				const path = await currentWorktreePath(
					pi,
					ctx.cwd,
					op.controller.signal,
				);
				current(op);
				if (r.action === "worktree.add")
					await addFlow(
						gitPi,
						commandCtx,
						records,
						settings.get().effectiveRoot,
						false,
					);
				else if (r.action === "worktree.remove")
					await removeFlow(
						gitPi,
						commandCtx,
						records,
						path,
						op.controller.signal,
						(path) => {
							current(op);
							op.protectedPaths = [path];
						},
					);
				else if (r.action === "worktree.prune")
					await pruneFlow(gitPi, commandCtx, records);
			} else {
				const expected = r.expectedGoalId;
				const checkGoal = () => {
					current(op);
					if ((runtime.activeGoal?.id ?? null) !== expected)
						throw new Error("Goal changed; refresh before acting");
				};
				checkGoal();
				if (["goal.start", "goal.edit", "goal.resume"].includes(r.action)) {
					if (
						!ctx.model ||
						ctx.model.provider === "unknown" ||
						!ctx.modelRegistry.find(ctx.model.provider, ctx.model.id)
					)
						throw new Error(
							"Select a configured Pi model before starting Goal",
						);
					if (!ctx.isIdle() || ctx.hasPendingMessages())
						throw new Error(
							"Wait until Pi is idle before starting, editing or resuming Goal",
						);
					const policy = () =>
						JSON.stringify([
							ctx.cwd,
							ctx.model?.provider,
							ctx.model?.id,
							ctx.thinkingLevel,
							pi.getActiveTools?.() ?? [],
							runtime.settings.continuationLimits,
						]);
					const approvedPolicy = policy();
					op.policyCheck = () => policy() === approvedPolicy;
					if (
						!(await commandCtx.ui.confirm(
							r.action === "goal.resume"
								? "Resume Goal?"
								: r.action === "goal.edit"
									? "Update Goal?"
									: "Start Goal?",
							`${r.objective ?? runtime.activeGoal?.text ?? ""}\n\nWorkspace: ${ctx.cwd}\nUses ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "the current Pi model"} with ${ctx.thinkingLevel ?? "current"} thinking and its active tools. It may edit this workspace and make paid model calls. Automatic limit: ${runtime.settings.continuationLimits.automaticTurns ?? "unlimited"} responses. Token budget: ${r.tokenBudget ?? runtime.activeGoal?.tokenBudget ?? 250000}; the final request can exceed it.`,
						))
					)
						return;
					checkGoal();
					if (policy() !== approvedPolicy)
						throw new Error(
							"The model, thinking, tools or limits changed. Review the goal again.",
						);
					if (!ctx.isIdle() || ctx.hasPendingMessages())
						throw new Error("Pi became busy; review again when idle");
				}
				if (r.action === "goal.start")
					await commands.startGoal(
						r.objective,
						r.tokenBudget,
						commandCtx,
						undefined,
						undefined,
						() => !closed && operation === op && !op.controller.signal.aborted,
					);
				else if (r.action === "goal.edit")
					await commands.editGoal(r.objective, r.tokenBudget, commandCtx);
				else if (r.action === "goal.pause") commands.pauseGoal(commandCtx);
				else if (r.action === "goal.resume")
					await commands.resumeGoal(commandCtx);
				else if (r.action === "goal.clear") {
					if (
						await commandCtx.ui.confirm(
							"Clear Goal?",
							"Clear this goal and its pending continuation?",
						)
					) {
						checkGoal();
						commands.clearGoal(commandCtx);
					}
				}
			}
		} catch (error) {
			if (!closed && !op.controller.signal.aborted)
				notice = stripTerminalControls(
					error instanceof Error ? error.message : "Workflow failed",
				).slice(0, 6000);
		} finally {
			if (operation === op) operation = undefined;
			worktreeCache = undefined;
		}
	}
	async function handle(input: unknown): Promise<any> {
		current();
		if (!input || typeof input !== "object" || Array.isArray(input))
			throw new Error("Invalid workflow request");
		const r = input as any;
		if (r.sessionId !== sessionId || r.serviceEpoch !== serviceEpoch)
			throw new Error("Stale workflow identity");
		const allowed =
			r.operation === "snapshot"
				? ["operation", "sessionId", "serviceEpoch"]
				: [
						"operation",
						"sessionId",
						"serviceEpoch",
						"requestId",
						"action",
						"expectedGoalId",
						"objective",
						"tokenBudget",
						"operationId",
						"dialogId",
						"value",
						"path",
					];
		if (Object.keys(r).some((key) => !allowed.includes(key)))
			throw new Error("Unknown workflow fields");
		if (r.operation === "snapshot") return snapshot();
		if (
			!uuid.test(r.requestId ?? "") ||
			!["start", "send", "cancel"].includes(r.operation)
		)
			throw new Error("Invalid workflow mutation");
		const fingerprint = JSON.stringify(
			Object.keys(r)
				.sort()
				.map((key) => [key, r[key]]),
		);
		if (requests.has(r.requestId)) {
			if (requests.get(r.requestId) !== fingerprint)
				throw new Error("Request ID conflict");
			return snapshot();
		}
		if (requests.size >= 2048)
			throw new Error("Workflow request limit reached; reload Pi");
		if (r.operation === "cancel") {
			if (!operation || r.operationId !== operation.id)
				throw new Error("Operation changed");
			requests.set(r.requestId, fingerprint);
			cancel();
			notice =
				"Operation cancelled. Refresh and inspect the current state before retrying; an applied change is retained.";
			return snapshot();
		}
		if (r.operation === "send") {
			const op = operation,
				dialog = op?.dialog;
			if (
				!op ||
				!dialog ||
				op.id !== r.operationId ||
				dialog.id !== r.dialogId ||
				!op.reply
			)
				throw new Error("Dialog changed");
			if (
				dialog.kind === "confirm"
					? typeof r.value !== "boolean"
					: r.value !== null &&
						(typeof r.value !== "string" ||
							r.value.length > 8000 ||
							(dialog.kind === "select" && !dialog.options.includes(r.value)))
			)
				throw new Error("Invalid dialog answer");
			requests.set(r.requestId, fingerprint);
			const reply = op.reply;
			op.reply = undefined;
			op.reject = undefined;
			op.dialog = undefined;
			reply(r.value);
			return snapshot();
		}
		if (operation || externalBusy() || !actions.includes(r.action))
			throw new Error("Workflow busy or invalid action");
		if (r.action.startsWith("goal.")) {
			if ((runtime.activeGoal?.id ?? null) !== r.expectedGoalId)
				throw new Error("Goal changed");
			if (
				["goal.start", "goal.edit"].includes(r.action) &&
				(typeof r.objective !== "string" ||
					!r.objective.trim() ||
					r.objective.length > 4000 ||
					!Number.isSafeInteger(r.tokenBudget) ||
					r.tokenBudget < 1 ||
					r.tokenBudget > 1_000_000)
			)
				throw new Error(
					"Provide an objective and a token budget between 1 and 1000000",
				);
		}
		requests.set(r.requestId, fingerprint);
		if (r.action === "worktree.open") {
			if (typeof r.path !== "string" || r.path.length > 4096)
				throw new Error("Invalid worktree path");
			const records = await listWorktrees(pi, ctx.cwd, lifetime.signal);
			current();
			const match = records.find(
				(record) =>
					record.path === r.path &&
					!record.bare &&
					record.prunableReason === undefined,
			);
			if (!match) throw new Error("Worktree is no longer available");
			return { ...(await snapshot()), openPath: match.path };
		}
		const op: Operation = {
			id: r.requestId,
			action: r.action,
			protectedPaths: [],
			expectedGoalId: runtime.activeGoal?.id ?? null,
			wasWaiting: !!runtime.activeGoal?.waiting,
			controller: new AbortController(),
		};
		operation = op;
		notice = null;
		void run(op, r);
		return snapshot();
	}
	return {
		protocol: 1,
		sessionId,
		serviceEpoch,
		handle,
		hasOperation: () => !!operation,
		refreshContext(next: ExtensionContext) {
			if (!closed && next.sessionManager.getSessionId() === sessionId)
				ctx = next;
		},
		dispose() {
			if (closed) return;
			closed = true;
			lifetime.abort();
			cancel();
			operation = undefined;
			requests.clear();
		},
	};
}
