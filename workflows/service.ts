import { randomUUID } from "node:crypto";
import { DelegatedGoalRegistry, type DelegatedGoalExecutor } from "./delegated-goals.ts";
import { resolveGoalLimits } from "../shared/delegated-goal-policy.ts";
import { delegatedGoalStore } from "./delegated-goal-store.ts";
import { basename, isAbsolute, relative, sep } from "node:path";
import { workspaceRepositories } from "./worktree/repositories.js";
import { ownedWorktrees, recordedWorktreeOwner, worktreeGit } from "../shared/subagent-worktrees.ts";
import { harnessReadOnlyRegistry } from "../shared/harness-readonly.ts";
import { readGoalTasks, addGoalTask } from "../shared/goal-progress.ts";
import { readGoalHistory } from "./goal/history.js";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { addFlow, removeFlow, pruneFlow } from "./worktree/command.js";
import { stat } from "node:fs/promises";
import {
	currentWorktreePath,
	listWorktrees,
	runGit,
	pathsEqual,
	pathIdentity,
	stripTerminalControls,
} from "./worktree/git.js";
import type { WorktreeSettingsRuntime } from "./worktree/settings.js";
import {
	createGoal,
	transitionGoal,
	type GoalRuntime,
} from "./goal/runtime.js";
import { currentTokenTotal } from "./goal/accounting.js";
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
	worktreeCwd?: string;
	dialog?: Dialog;
	reply?: (value: unknown) => void;
	reject?: (error: Error) => void;
};
const actions = [
	"goals.create", "goals.start", "goals.pause", "goals.resume", "goals.edit", "goals.limits", "goals.clear", "goals.add_task", "goals.answer",
	"worktree.add",
	"worktree.remove",
	"worktree.prune",
	"worktree.open",
	"worktree.complete",
	"worktree.cleanup",
	"goal.start",
	"goal.create_paused",
	"goal.edit",
	"goal.limits",
	"goal.pause",
	"goal.resume",
	"goal.clear",
	"goal.add_task",
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
	function childExecutor(): DelegatedGoalExecutor {
		current();
		const executor = (globalThis as any).__paeDelegatedGoalExecutorV1;
		if (executor?.protocol !== 1 || executor.sessionId !== sessionId ||
			!["start", "resume", "pause"].every(method => typeof executor[method] === "function"))
			throw new Error("Dedicated goal child execution is unavailable for this session");
		return executor;
	}
	function executionUnavailableReason(): string | null {
		try {
			const executor = childExecutor();
			if (executor.executionAvailable?.() !== true)
				return executor.executionUnavailableReason?.()?.slice(0, 1000) || "Dedicated goal execution is unavailable: required child goal/progress tools or execution policy are not enabled. Paused metadata remains available.";
			return delegated.blockedReason();
		} catch { return "Dedicated goal child execution is unavailable for this session; paused goal metadata remains available."; }
	}
	const delegatedStore = delegatedGoalStore(sessionId);
	const delegated = new DelegatedGoalRegistry(sessionId, {
		executionAvailable: () => executionUnavailableReason() === null,
		executionUnavailableReason,
		start: entry => childExecutor().start({ ...entry, continuationLimits: resolveGoalLimits(entry.continuationLimits, runtime.settings.continuationLimits) }),
		resume: entry => childExecutor().resume({ ...entry, continuationLimits: resolveGoalLimits(entry.continuationLimits, runtime.settings.continuationLimits) }),
		pause: entry => childExecutor().pause(entry),
		updateLimits: entry => {
			const executor = childExecutor();
			if (!executor.updateLimits) throw new Error("Worker does not support limit editing; reload required");
			return executor.updateLimits({ ...entry, continuationLimits: resolveGoalLimits(entry.continuationLimits, runtime.settings.continuationLimits) });
		},
		answer: (entry, reply, requestId) => {
			const executor = childExecutor();
			if (!executor.answer) throw new Error("Goal answers unavailable in this runtime");
			return executor.answer(entry, reply, requestId);
		},
		verifyStopped: entry => {
			const executor = childExecutor();
			if (!executor.verifyStopped) throw new Error("Owned child stop verification is unavailable");
			return executor.verifyStopped(entry);
		},
		observe: entry => {
			try { const executor = childExecutor(); return executor.observe?.(entry) ?? Promise.resolve(null); }
			catch { return Promise.resolve(null); }
		},
	}, state => { current(); delegatedStore.save(state); }, delegatedStore.load(), {
		initial: delegatedStore.loadIntent(),
		save: intent => { current(); delegatedStore.saveIntent(intent); },
	});
	const lifetime = new AbortController();
	let worktreeCache:
		| {
				rows: any[];
				error: string | null;
				at: number;
				repositoryCount?: number;
				container?: boolean;
		  }
		| undefined;
	let reading: Promise<void> | undefined;
	let repositoryCache:
		| {
				cwd: string;
				at: number;
				value: Awaited<ReturnType<typeof workspaceRepositories>>;
		  }
		| undefined;
	async function filesystemIdentity(path: string) {
		const item = await stat(path);
		return { dev: String(item.dev), ino: String(item.ino), birthtimeMs: String(item.birthtimeMs) };
	}
	async function repositories() {
		const cwd = ctx.cwd;
		if (
			repositoryCache?.cwd === cwd &&
			Date.now() - repositoryCache.at < 30_000
		)
			return repositoryCache.value;
		const value = await workspaceRepositories(pi, cwd, lifetime.signal);
		current();
		if (cwd !== ctx.cwd)
			throw new Error("Workspace changed during repository discovery");
		repositoryCache = { cwd, at: Date.now(), value };
		return value;
	}
	let completionLeaf: string | null | undefined;
	let completedGoalsKey: string | undefined;
	let completedGoalsCache: ReturnType<typeof readGoalHistory> = [];
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
	function completedGoals(activeGoalId: string | null) {
		const key = `${ctx.sessionManager.getLeafId() ?? ""}/${activeGoalId ?? ""}`;
		if (key === completedGoalsKey) return completedGoalsCache;
		completedGoalsKey = key;
		completedGoalsCache = readGoalHistory(ctx);
		return completedGoalsCache;
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
	async function worktreeRepository(path: string, signal: AbortSignal) {
		const mine = await ownedWorktrees(sessionId);
		const tracked = await allSessionCreatedRecords();
		const owned = mine.find((record) => pathsEqual(record.path, path));
		if (tracked.some((record) => record.ownerSessionId === sessionId && pathsEqual(record.path, path)) && !owned) {
			const found = await locateTrackedWorktree(path, tracked, signal);
			if (found) return found;
		}
		if (owned) return owned.commonDir;
		const roots = new Set(mine.map((record) => record.commonDir));
		const lookup = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
		const discovered = await workspaceRepositories(pi, ctx.cwd, lookup);
		current();
		for (const root of discovered.roots) roots.add(root);
		for (const root of roots) {
			try {
				if (
					(await listWorktrees(pi, root, lookup)).some((record) =>
						pathsEqual(record.path, path),
					)
				)
					return root;
			} catch {
				lookup.throwIfAborted();
			}
		}
		throw new Error(
			"Worktree is no longer available in this session's repositories",
		);
	}
	function sessionCreatedRecords() {
		const entries = ctx.sessionManager.getEntries?.() ?? ctx.sessionManager.getBranch?.() ?? [];
		return (entries as any[]).flatMap((entry) => {
			const data = entry?.type === "custom" && entry.customType === "workflow-worktree-created" ? entry.data : undefined;
			return data?.version === 1 && data.ownerSessionId === sessionId && [data.path, data.commonDir, data.gitDir].every((value: unknown) => typeof value === "string") && validPhysicalIdentity(data.identity) ? [data] : [];
		});
	}
	function validPhysicalIdentity(value: any) {
		return value && typeof value.dev === "string" && typeof value.ino === "string" && typeof value.birthtimeMs === "string";
	}
	function samePhysicalIdentity(actual: any, expected: any) {
		return validPhysicalIdentity(expected) && actual.dev === expected.dev && actual.ino === expected.ino && actual.birthtimeMs === expected.birthtimeMs;
	}
	async function allSessionCreatedRecords() {
		const manual = sessionCreatedRecords();
		const owned = (await ownedWorktrees(sessionId)).filter(record => record.ownerSessionId === sessionId && validPhysicalIdentity(record.physicalIdentity));
		return [...manual, ...owned.map(record => ({ ownerSessionId: record.ownerSessionId, path: record.path, commonDir: record.commonDir, identity: record.physicalIdentity }))];
	}
	async function locateTrackedWorktree(path: string, tracked: any[], signal: AbortSignal) {
		for (const item of tracked) {
			try {
				const records = await listWorktrees(pi, item.commonDir, signal);
				const record = records.find((row) => pathsEqual(row.path, path));
				if (record) return item.commonDir;
			} catch {}
		}
		return undefined;
	}
	async function refreshWorktrees() {
		if (reading) return reading;
		if (worktreeCache && Date.now() - worktreeCache.at < 5000) return;
		reading = (async () => {
			try {
				const ownership = await ownedWorktrees();
				const mine = ownership.filter(
					(record) => record.ownerSessionId === sessionId,
				);
				const createdRecords = await allSessionCreatedRecords();
				const roots = new Set(mine.map((record) => record.commonDir));
				for (const item of createdRecords) roots.add(item.commonDir);
				const discovered = await repositories();
				const active = discovered.active;
				for (const root of discovered.roots) roots.add(root);
				const warnings = [...discovered.warnings];
				if (discovered.limited || roots.size > 64)
					warnings.push(
						"Repository discovery is limited to two directory levels and 64 repository roots; open a repository directly to inspect more.",
					);
				const repositoryPaths = new Set<string>();
				const service = harnessReadOnlyRegistry()?.subagents;
				const workers =
					service?.sessionId === sessionId
						? await service
								.list({ sessionId, limit: 50 })
								.catch(() => undefined)
						: undefined;
				const sessionCreated = new Map<string, any[]>();
				for (const record of createdRecords) {
					const key = pathIdentity(record.path);
					sessionCreated.set(key, [...(sessionCreated.get(key) ?? []), record]);
				}
				const rows: any[] = [];
				const inventorySignal = AbortSignal.any([
					lifetime.signal,
					AbortSignal.timeout(15_000),
				]);
				for (const root of [...roots].slice(0, 64)) {
					if (inventorySignal.aborted) {
						lifetime.signal.throwIfAborted();
						warnings.push(
							"Worktree inventory timed out; open a repository directly for a narrower view.",
						);
						break;
					}
					current();
					if (rows.length >= 100) break;
					let records;
					try {
						records = await listWorktrees(pi, root, inventorySignal);
					} catch {
						lifetime.signal.throwIfAborted();
						warnings.push(`Cannot list worktrees for ${root}`);
						continue;
					}
					const repositoryPath =
						records.find((record) => record.isMain)?.path ?? root;
					repositoryPaths.add(repositoryPath);
					const relativeName = relative(ctx.cwd, repositoryPath);
					const repositoryLabel = stripTerminalControls(
						!relativeName ||
							relativeName === ".." ||
							relativeName.startsWith(`..${sep}`)
							? basename(repositoryPath)
							: relativeName,
					);
					for (const record of records) {
						if (rows.length >= 100 || inventorySignal.aborted) break;
						if (rows.some((row) => pathsEqual(row.path, record.path))) continue;
						const owned = ownership.find(
							(row) => pathsEqual(row.path, record.path) && row.branch === record.branch,
						);
						if (record.bare || (active && record.isMain && !owned)) continue;
						let changedFiles: number | null = null;
						try {
							const fields = (
								await worktreeGit(
									[
										"status",
										"--porcelain=v1",
										"-z",
										"--untracked-files=all",
										"--ignore-submodules=none",
									],
									record.path,
									inventorySignal,
								)
							).split("\0");
							changedFiles = 0;
							for (let i = 0; i < fields.length; i++)
								if (fields[i]) {
									changedFiles++;
									if (/^[RC]|^.[RC]/.test(fields[i])) i++;
								}
						} catch {}
						let createdInSession = false;
						const candidates = sessionCreated.get(pathIdentity(record.path));
						if (candidates?.length) {
							try {
								const [commonDir, gitDir] = await Promise.all([
									runGit(pi, ["rev-parse", "--path-format=absolute", "--git-common-dir"], record.path, inventorySignal),
									runGit(pi, ["rev-parse", "--path-format=absolute", "--git-dir"], record.path, inventorySignal),
								]);
								const identity = await filesystemIdentity(gitDir.stdout.trim());
								createdInSession = candidates.some(created => created.ownerSessionId === sessionId && pathIdentity(commonDir.stdout.trim()) === pathIdentity(created.commonDir) && (!created.gitDir || pathIdentity(gitDir.stdout.trim()) === pathIdentity(created.gitDir)) && samePhysicalIdentity(identity, created.identity));
							} catch {}
						}
						// Path/branch matches preserve legacy fields, but are not proof of ownership.
						let recordedOwner;
						if (owned && validPhysicalIdentity(owned.physicalIdentity)) {
							try {
								const [commonDir, gitDir] = await Promise.all([
									runGit(pi, ["rev-parse", "--path-format=absolute", "--git-common-dir"], record.path, inventorySignal),
									runGit(pi, ["rev-parse", "--path-format=absolute", "--git-dir"], record.path, inventorySignal),
								]);
								if (pathIdentity(commonDir.stdout.trim()) === pathIdentity(owned.commonDir) && samePhysicalIdentity(await filesystemIdentity(gitDir.stdout.trim()), owned.physicalIdentity))
									recordedOwner = recordedWorktreeOwner(owned);
							} catch {}
						}
						const worker =
							owned?.ownerSessionId === sessionId &&
							workers?.state === "available"
								? workers.items.find((row) => row.childId === owned.childId)
								: undefined;
						rows.push({
							repositoryPath,
							repositoryLabel,
							path: record.path,
							createdInSession,
							branch: record.branch ?? null,
							head: record.head ?? null,
							main: record.isMain,
							current: !!active && pathsEqual(record.path, active),
							locked: record.lockedReason !== undefined,
							stale: record.prunableReason !== undefined,
							detached: record.detached,
							changedFiles,
							...(recordedOwner ? { recordedOwner } : {}),
							ownerTaskId: owned?.taskId,
							ownerTitle: owned?.title,
							workerStatus: worker?.status,
							inUse: !!owned && !owned.released,
							includedChanges:
								owned?.state === "ready" && owned.includedChanges,
							setupError:
								owned?.state === "failed"
									? (owned.error ?? "Worker launch failed")
									: undefined,
						});
					}
				}
				current();
				if (
					inventorySignal.aborted &&
					!warnings.some((warning) =>
						warning.startsWith("Worktree inventory timed out"),
					)
				)
					warnings.push(
						"Worktree inventory timed out; open a repository directly for a narrower view.",
					);
				if (rows.length >= 100)
					warnings.push(
						"Showing the first 100 worktrees; open a repository directly to inspect more.",
					);
				rows.sort(
					(a, b) =>
						a.repositoryPath.localeCompare(b.repositoryPath) ||
						Number(b.main) - Number(a.main) ||
						a.path.localeCompare(b.path),
				);
				worktreeCache = {
					at: Date.now(),
					error: warnings.length
						? stripTerminalControls(warnings.join("\n")).slice(0, 2000)
						: null,
					rows: rows.slice(0, 100),
					repositoryCount: repositoryPaths.size,
					container: !active,
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
		try { await delegated.refresh(); } catch { /* Child unavailability must not hide durable metadata. */ }
		current();
		void refreshWorktrees();
		let worktreeCompletionError: string | null = null;
		const completionRecords = await ownedWorktrees(sessionId).catch(error => {
			worktreeCompletionError = stripTerminalControls(error instanceof Error ? error.message : String(error)).slice(0, 2000);
			return [];
		});
		current();
		const goal = runtime.activeGoal,
			terminal = runtime.snapshotSettingsApplicationState().terminalDetails;
		return {
			protocol: 1,
			capabilities: { goalLimitEditing: true, ownedWorktreeCompletion: true, createPausedGoal: false, delegatedGoals: true, delegatedGoalExecution: executionUnavailableReason() === null },
			delegatedGoals: delegated.snapshot(),
			sessionId,
			serviceEpoch,
			cwd: ctx.cwd,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
			busy: !!operation || externalBusy(),
			idle: ctx.isIdle() && !ctx.hasPendingMessages(),
			notice: notice ?? delegated.blockedReason() ?? executionUnavailableReason(),
			operationId: operation?.id ?? null,
			operationAction: operation?.action ?? null,
			protectedPaths: operation?.protectedPaths ?? [],
			dialog: operation?.dialog ?? null,
			worktreeCompletions: completionRecords.flatMap(record => record.completion ? [{ ...record.completion, path: record.path, branch: record.branch, retained: record.retain === true || record.state === "failed" || !!record.error }] : []),
			worktreeCompletionError,
			worktrees: worktreeCache?.rows ?? [],
			worktreeError: worktreeCache?.error ?? null,
			// Cached inventories remain usable during silent background refreshes.
			worktreeLoading: !worktreeCache,
			worktreeRepositoryCount: worktreeCache?.repositoryCount ?? 0,
			worktreeContainer: worktreeCache?.container ?? false,
			goal: goal
				? {
						id: goal.id,
						activationId: goal.activationId ?? goal.id,
						revision: goal.revision,
						policyRevision: runtime.policyRevision,
						continuationLimits: goal.continuationLimits,
						effectiveLimits: runtime.continuationLimits,
						text: goal.text,
						status: goal.status,
						tasks: readGoalTasks(ctx, goal),
						waiting: goal.waiting?.reason ?? null,
						iteration: goal.iteration,
						tokensUsed: goal.tokensUsed,
						tokenBudget: goal.tokenBudget ?? null,
						automaticTurns: goal.automaticModelTurns,
						noProgressTurns: goal.toolFreeRepeatCount,
						safetyPauseCause: goal.safetyPauseCause ?? null,
						summary:
							terminal?.goalId === goal.id
								? (terminal.summary ?? terminal.reason ?? null)
								: null,
					}
				: null,
			lastCompletion: completion(),
			completedGoals: completedGoals(goal?.id ?? null),
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
				if (key === "cwd") return op.worktreeCwd ?? target.cwd;
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
					return async (command: string, args: string[], options: any) => {
						current(op);
						if (
							command === "git" &&
							args[0] === "worktree" &&
							args[1] === "remove"
						) {
							const path = args[2];
							const inside = relative(
								pathIdentity(path),
								pathIdentity(ctx.cwd),
							);
							if (
								!inside ||
								(inside !== ".." &&
									!inside.startsWith(`..${sep}`) &&
									!isAbsolute(inside))
							)
								throw new Error("Cannot remove the current working directory");
							if (
								(await ownedWorktrees()).some(
									(record) => pathsEqual(record.path, path) && !record.released,
								)
							)
								throw new Error(
									"Worktree still has an attached worker; reap the worker before removal",
								);
							current(op);
						}
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
			if (r.action.startsWith("goals.")) {
				const entry = delegated.snapshot().entries.find(e => e.id === r.expectedGoalId);
				if (r.action === "goals.pause") childExecutor();
				if (["goals.start", "goals.resume"].includes(r.action)) {
					const unavailable = executionUnavailableReason();
					if (unavailable) throw new Error(unavailable);
					if (!entry || entry.revision !== r.expectedEntryRevision) throw new Error("Goal changed");
					const workspace = ctx.cwd;
					const limits = resolveGoalLimits(entry.continuationLimits, runtime.settings.continuationLimits);
					const approvedLimits = JSON.stringify(limits);
					op.policyCheck = () => ctx.cwd === workspace && JSON.stringify(resolveGoalLimits(entry.continuationLimits, runtime.settings.continuationLimits)) === approvedLimits;
					if (!(await commandCtx.ui.confirm(r.action === "goals.start" ? "Start dedicated Goal child?" : "Resume dedicated Goal child?",
						`${entry.text}\n\nWorkspace: ${workspace}\nRole: coordinator (default gpt-6.1-sol; Resume retains the recorded model)\nExecution: independent dedicated child; the parent never executes this goal.\nIt may edit this workspace and make paid model calls.\nDedicated automatic limit: ${limits.automaticTurns ?? "unlimited"} responses.\nDedicated no-progress limit: ${limits.noProgressTurns ?? "unlimited"} repeated runs.\nUnset limits inherit the configured defaults; this execution uses the values shown above.\nToken budget: ${entry.tokenBudget ?? "unlimited"}; the final request can exceed it.`))) return;
					current(op);
					const changedAvailability = executionUnavailableReason();
					if (changedAvailability) throw new Error(changedAvailability);
				}
				await delegated.mutate(sessionId, r);
			} else if (["worktree.complete", "worktree.cleanup"].includes(r.action)) {
				current(op);
				if (!ctx.isIdle() || ctx.hasPendingMessages() || runtime.activeGoal?.status === "active") throw new Error("Wait until Pi is idle before worktree completion/cleanup");
				op.policyCheck = () => ctx.sessionManager.getSessionId() === sessionId && ctx.isIdle() && !ctx.hasPendingMessages() && runtime.activeGoal?.status !== "active";
				const { completionFlow } = await import("./worktree/completion.ts");
				await completionFlow(commandCtx, r.action === "worktree.complete" ? "complete" : "cleanup", r.taskId, r.reason, () => {
					current(op);
					if (!op.policyCheck?.()) throw new Error("Worktree completion/cleanup context became active or changed");
				});
			} else if (r.action.startsWith("worktree.")) {
				if (
					!ctx.isIdle() ||
					ctx.hasPendingMessages() ||
					runtime.activeGoal?.status === "active"
				)
					throw new Error(
						"Pause Goal and wait until Pi is idle before changing worktrees",
					);
				if (typeof r.path === "string")
					op.worktreeCwd = await worktreeRepository(
						r.path,
						op.controller.signal,
					);
				if (
					!op.worktreeCwd &&
					!(await workspaceRepositories(pi, ctx.cwd, op.controller.signal))
						.active
				)
					throw new Error(
						"Select a repository checkout before changing its worktrees.",
					);
				const repository = op.worktreeCwd ?? ctx.cwd;
				const records = await listWorktrees(
					pi,
					repository,
					op.controller.signal,
				);
				if (
					r.path &&
					!records.some((record) => pathsEqual(record.path, r.path))
				)
					throw new Error("Worktree is no longer registered");
				current(op);
				const path =
					r.action === "worktree.remove"
						? await currentWorktreePath(
								pi,
								ctx.cwd,
								op.controller.signal,
							).catch(() => ctx.cwd)
						: await currentWorktreePath(pi, repository, op.controller.signal);
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
						r.path,
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
							`${r.objective ?? runtime.activeGoal?.text ?? ""}\n\nWorkspace: ${ctx.cwd}\nUses ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "the current Pi model"} with ${ctx.thinkingLevel ?? "current"} thinking and its active tools. It may edit this workspace and make paid model calls. Automatic limit: ${runtime.settings.continuationLimits.automaticTurns ?? "unlimited"} responses. Token budget: ${r.tokenBudget ?? runtime.activeGoal?.tokenBudget ?? "unlimited"}; the final request can exceed it.`,
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
						"expectedEntryRevision",
						"expectedPolicyRevision",
						"expectedActivationId",
						"expectedGoalRevision",
						"expectedRegistryRevision",
						"objective",
						"text",
						"tokenBudget",
						"continuationLimits",
						"questionId",
						"questionRevision",
						"workerEpoch",
						"answer",
						"operationId",
						"dialogId",
						"value",
						"path",
						"taskId",
						"reason",
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
		if (operation || (!r.action?.startsWith("goals.") && r.action !== "goal.limits" && externalBusy()) || !actions.includes(r.action))
			throw new Error("Workflow busy or invalid action");
		if (["goal.start", "goal.create_paused", "goal.resume", "goal.edit"].includes(r.action))
			throw new Error("Use dedicated delegated goals; legacy parent goal execution is read-only");
		if (["worktree.complete", "worktree.cleanup"].includes(r.action)) {
			if (typeof r.taskId !== "string" || !/^subagent-task-[a-f0-9]{24}$/.test(r.taskId) || r.path !== undefined) throw new Error("Completion/cleanup requires an owned task ID, not a path");
			if (r.action === "worktree.complete" && (typeof r.reason !== "string" || !r.reason.trim() || r.reason.length > 2000)) throw new Error("Completion rationale required (1–2000 characters)");
			if (r.action === "worktree.cleanup" && r.reason !== undefined) throw new Error("Cleanup cannot replace completion rationale");
		}
		if (r.action === "goal.limits") {
			const fields = ["operation", "sessionId", "serviceEpoch", "requestId", "action", "expectedGoalId", "expectedActivationId", "expectedPolicyRevision", "tokenBudget", "continuationLimits"];
			if (Object.keys(r).some(key => !fields.includes(key)) || typeof r.expectedGoalId !== "string" || !Number.isSafeInteger(r.expectedPolicyRevision))
				throw new Error("Invalid goal limit request");
			if (r.expectedActivationId !== (runtime.activeGoal?.activationId ?? runtime.activeGoal?.id)) throw new Error("Goal activation changed");
			runtime.updateGoalLimits(ctx, r.expectedGoalId, r.expectedPolicyRevision, r.tokenBudget, r.continuationLimits);
			requests.set(r.requestId, fingerprint);
			notice = null;
			return snapshot();
		}
		if (r.action.startsWith("goal.")) {
			if ((runtime.activeGoal?.id ?? null) !== r.expectedGoalId || (runtime.activeGoal && (r.expectedActivationId !== (runtime.activeGoal.activationId ?? runtime.activeGoal.id) || r.expectedGoalRevision !== runtime.activeGoal.revision)))
				throw new Error("Goal identity, activation or revision changed");
			if (r.action === "goal.create_paused") {
				if (runtime.activeGoal)
					throw new Error(
						"A goal already exists; clear it before creating another",
					);
				if (!ctx.isIdle() || ctx.hasPendingMessages())
					throw new Error("Wait until Pi is idle before saving a goal");
				const budget = r.tokenBudget;
				if (
					typeof r.objective !== "string" ||
					!r.objective.trim() ||
					r.objective.length > 4000 ||
					(budget !== undefined &&
						(!Number.isSafeInteger(budget) || budget < 1 || budget > 1_000_000))
				)
					throw new Error(
						"Provide an objective of 1–4000 characters and an optional budget between 1 and 1000000",
					);
			}
			if (r.action === "goal.add_task") {
				if (!runtime.activeGoal || runtime.activeGoal.status === "complete")
					throw new Error("There is no current goal to add a task to");
				if (
					!ctx.isIdle() ||
					ctx.hasPendingMessages() ||
					runtime.activeGoal.status === "active"
				)
					throw new Error(
						"Pause the goal and wait for the current turn before adding a task",
					);
				if (
					typeof r.text !== "string" ||
					!r.text.trim() ||
					[...r.text.trim()].length > 503
				)
					throw new Error("Provide a task of at most 503 characters");
			}
			if (
				["goal.start", "goal.edit"].includes(r.action) &&
				(typeof r.objective !== "string" ||
					!r.objective.trim() ||
					r.objective.length > 4000 ||
					(r.tokenBudget !== undefined &&
						(!Number.isSafeInteger(r.tokenBudget) || r.tokenBudget < 1 || r.tokenBudget > 1_000_000)))
			)
				throw new Error(
					"Provide an objective and an optional token budget between 1 and 1000000",
				);
		}
		if (r.action.startsWith("goals.")) {
			if (r.action === "goals.create") {
				await delegated.mutate(sessionId, r);
				requests.set(r.requestId, fingerprint);
				notice = null;
				return snapshot();
			}
			const expectedRevision = r.action === "goals.limits" ? r.expectedPolicyRevision : r.expectedEntryRevision;
			if (typeof r.expectedGoalId !== "string" || !uuid.test(r.expectedGoalId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
				throw new Error("Expected delegated goal identity and revision");
			if (["goals.edit", "goals.limits", "goals.add_task", "goals.clear", "goals.answer"].includes(r.action)) {
				// Definitive metadata result: rejected edits retain the caller's draft.
				// Cache at service level only AFTER success; failed retries must reach
				// the registry's retained rejection instead of looking applied.
				await delegated.mutate(sessionId, r);
				requests.set(r.requestId, fingerprint);
				notice = null;
				return snapshot();
			}
		}
		requests.set(r.requestId, fingerprint);
		if (r.action === "goal.create_paused") {
			current();
			const goal = transitionGoal(
				createGoal(
					r.objective.trim(),
					r.tokenBudget,
					currentTokenTotal(ctx),
				),
				"paused",
			);
			runtime.clearGoalWaitTimer();
			runtime.cancelContinuationWork();
			runtime.clearGoalRecovery();
			runtime.clearBudgetWrapUp();
			runtime.clearStaleGoalToolCallBlock();
			runtime.activeGoal = goal;
			try {
				runtime.persistGoal(goal);
			} catch (error) {
				runtime.activeGoal = undefined;
				try {
					runtime.clearPersistedGoal(ctx.cwd);
				} catch {}
				throw error;
			}
			runtime.ensureInactiveGoalContextContract(ctx);
			runtime.updateStatus(ctx, goal);
			notice = null;
			return snapshot();
		}
		if (r.action === "goal.add_task") {
			addGoalTask(pi, ctx, runtime.activeGoal!, r.expectedGoalId, r.text);
			notice = null;
			return snapshot();
		}
		if (r.action === "worktree.open") {
			if (typeof r.path !== "string" || r.path.length > 4096)
				throw new Error("Invalid worktree path");
			const repository = await worktreeRepository(r.path, lifetime.signal);
			const records = await listWorktrees(pi, repository, lifetime.signal);
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
