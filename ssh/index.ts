/**
 * SSH target-routing extension.
 *
 * The extension owns target selection in both execution modes:
 * - legacy mode (pi-unsafe): file and command operations use raw SSH;
 * - supervised mode: operations use the optional AgentSH sandbox backend.
 *
 * The trusted pi-supervised wrapper provisions supervised local/remote AgentSH
 * sessions. A /retarget request asks that wrapper to replace the sandbox and
 * resume the same Pi conversation. The SSH extension never falls back to raw
 * SSH when supervised integration was requested but failed.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import {
	type BashOperations,
	createEditTool,
	createReadTool,
	createWriteTool,
	type EditOperations,
	type ReadOperations,
	type WriteOperations,
} from "@mariozechner/pi-coding-agent";
import {
	applyBashCommandTransforms,
	registerBashCommandTransform,
} from "../shared/bash-command-transform.js";
import {
	agentSHRuntimeDisposition,
	classifyAgentSHStartup,
	type AgentSHRuntimeState,
} from "../shared/agentsh-mode.js";
import type { AgentSHExecutionTarget, AgentSHPiAPI } from "../sandbox/api.js";

type LocalTarget = { kind: "local"; cwd: string };
type SshTarget = { kind: "ssh"; remote: string; remoteCwd: string };
type ExecutionTarget = LocalTarget | SshTarget;

function env(name: string) {
	const value = process.env[name];
	return value && value.trim() ? value.trim() : "";
}

function sandboxAPI(): AgentSHPiAPI | undefined {
	return globalThis.__AGENTSH_PI__;
}

function sshExec(remote: string, command: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn("ssh", [remote, command], { stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		child.stdout.on("data", (data) => chunks.push(data));
		child.stderr.on("data", (data) => errChunks.push(data));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) reject(new Error(`SSH failed (${code}): ${Buffer.concat(errChunks).toString()}`));
			else resolve(Buffer.concat(chunks));
		});
	});
}

function createRemoteReadOps(remote: string, remoteCwd: string, localCwd: string): ReadOperations {
	const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
	return {
		readFile: (p) => sshExec(remote, `cat ${JSON.stringify(toRemote(p))}`),
		access: (p) => sshExec(remote, `test -r ${JSON.stringify(toRemote(p))}`).then(() => {}),
		detectImageMimeType: async (p) => {
			try {
				const result = await sshExec(remote, `file --mime-type -b ${JSON.stringify(toRemote(p))}`);
				const mime = result.toString().trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime) ? mime : null;
			} catch {
				return null;
			}
		},
	};
}

function createRemoteWriteOps(remote: string, remoteCwd: string, localCwd: string): WriteOperations {
	const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
	return {
		writeFile: async (p, content) => {
			const b64 = Buffer.from(content).toString("base64");
			await sshExec(remote, `echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(toRemote(p))}`);
		},
		mkdir: (dir) => sshExec(remote, `mkdir -p ${JSON.stringify(toRemote(dir))}`).then(() => {}),
	};
}

function createRemoteEditOps(remote: string, remoteCwd: string, localCwd: string): EditOperations {
	const read = createRemoteReadOps(remote, remoteCwd, localCwd);
	const write = createRemoteWriteOps(remote, remoteCwd, localCwd);
	return { readFile: read.readFile, access: read.access, writeFile: write.writeFile };
}

function createRemoteBashOps(remote: string, remoteCwd: string, localCwd: string): BashOperations {
	const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
	return {
		exec: (command, cwd, { onData, signal, timeout }) =>
			new Promise((resolve, reject) => {
				const cmd = `cd ${JSON.stringify(toRemote(cwd))} && ${command}`;
				const child = spawn("ssh", [remote, cmd], { stdio: ["ignore", "pipe", "pipe"] });
				let timedOut = false;
				const timer = timeout
					? setTimeout(() => {
							timedOut = true;
							child.kill();
						}, timeout * 1000)
					: undefined;
				child.stdout.on("data", onData);
				child.stderr.on("data", onData);
				child.on("error", (error) => {
					if (timer) clearTimeout(timer);
					reject(error);
				});
				const onAbort = () => child.kill();
				signal?.addEventListener("abort", onAbort, { once: true });
				child.on("close", (code) => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolve({ exitCode: code });
				});
			}),
	};
}

function createSupervisorBashOps(targetCwd: string): BashOperations {
	return {
		exec: async (command, _cwd, opts) => {
			const api = sandboxAPI();
			if (!api) throw new Error("AgentSH sandbox backend is unavailable; refusing raw execution");
			const result = await api.exec(
				{ command, cwd: targetCwd, timeout_ms: opts.timeout ? opts.timeout * 1000 : undefined },
				{
					signal: opts.signal,
					onOutput: (chunk: string) => opts.onData(Buffer.from(chunk)),
				},
			);
			return { exitCode: result.exitCode ?? 0 };
		},
	};
}

function shellSingleQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function wrapBashCommandForSsh(command: string, remote: string, remoteCwd: string): string {
	const remoteCommand = `cd ${shellSingleQuote(remoteCwd)} && ${command}`;
	return `ssh ${shellSingleQuote(remote)} ${shellSingleQuote(remoteCommand)}`;
}

export function parseSshArg(arg: string) {
	const value = arg.trim();
	if (!value || /[\0\r\n]/.test(value)) throw new Error("SSH target must be a non-empty single-line value");
	const colon = value.indexOf(":");
	const remote = colon >= 0 ? value.slice(0, colon) : value;
	if (!remote) throw new Error("SSH target must include a host");
	return { remote, remoteCwd: colon >= 0 ? value.slice(colon + 1) : "" };
}

function targetCwd(target: ExecutionTarget) {
	return target.kind === "ssh" ? target.remoteCwd : target.cwd;
}

function sandboxTarget(target: ExecutionTarget): AgentSHExecutionTarget {
	return target.kind === "ssh"
		? { kind: "ssh", cwd: target.remoteCwd, remote: target.remote, displayName: target.remote }
		: { kind: "local", cwd: target.cwd, displayName: "local" };
}

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "error" = "info") {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function writeRetargetRequest(requestPath: string, target: string | null, sessionFile: string | null) {
	if (!isAbsolute(requestPath)) throw new Error("The wrapper retarget request path is not absolute");
	const parent = lstatSync(dirname(requestPath));
	if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) {
		throw new Error("The wrapper retarget request directory is not private");
	}
	if (typeof process.getuid === "function" && parent.uid !== process.getuid()) {
		throw new Error("The wrapper retarget request directory has the wrong owner");
	}
	const temporary = `${requestPath}.tmp-${process.pid}-${randomUUID()}`;
	try {
		writeFileSync(temporary, `${JSON.stringify({ schema_version: 1, target, session_file: sessionFile })}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		renameSync(temporary, requestPath);
	} finally {
		rmSync(temporary, { force: true });
	}
}

export default function sshTargetExtension(pi: ExtensionAPI) {
	pi.registerFlag("ssh", { description: "SSH remote: user@host or user@host:/path", type: "string" });

	const agentSHStartup = classifyAgentSHStartup(process.env);
	const sandboxDisposition = () => {
		const api = sandboxAPI();
		let state: AgentSHRuntimeState | undefined;
		try {
			state = api && typeof api.getSupervisorState !== "function"
				? { configured: true, active: false }
				: api?.getSupervisorState?.();
		} catch {
			state = { configured: true, active: false };
		}
		const disposition = agentSHRuntimeDisposition(agentSHStartup, state);
		if (disposition.kind === "full" && typeof api?.exec !== "function") {
			return { kind: "unavailable" as const, protocol: disposition.protocol };
		}
		return disposition;
	};
	const sandboxBackendSelected = () => {
		const disposition = sandboxDisposition();
		return disposition.kind === "full" || disposition.kind === "unavailable";
	};

	const localCwd = process.cwd();
	let target: ExecutionTarget = { kind: "local", cwd: localCwd };
	let legacyToolsRegistered = false;
	const transformBashForTarget = (command: string) => {
		if (sandboxBackendSelected() || target.kind !== "ssh") return command;
		return wrapBashCommandForSsh(command, target.remote, target.remoteCwd);
	};
	let unregisterBashTransform = registerBashCommandTransform("ssh-target", transformBashForTarget);
	const ensureBashTransform = () => {
		unregisterBashTransform();
		unregisterBashTransform = registerBashCommandTransform("ssh-target", transformBashForTarget);
	};

	const publishTarget = () => sandboxAPI()?.setExecutionTarget(sandboxTarget(target));

	function setStatus(ctx: { hasUI: boolean; ui: any }) {
		if (!ctx.hasUI) return;
		if (sandboxBackendSelected()) {
			const label = target.kind === "ssh"
				? `SSH+AgentSH: ${target.remote}:${target.remoteCwd}`
				: `AgentSH target: local:${target.cwd}`;
			ctx.ui.setStatus("ssh", ctx.ui.theme.fg("accent", label));
			return;
		}
		if (target.kind === "ssh") {
			ctx.ui.setStatus("ssh", ctx.ui.theme.fg("accent", `SSH: ${target.remote}:${target.remoteCwd}`));
		} else {
			ctx.ui.setStatus("ssh", undefined);
		}
	}

	function registerLegacyTools() {
		if (legacyToolsRegistered || sandboxBackendSelected()) return;
		legacyToolsRegistered = true;
		const localRead = createReadTool(localCwd);
		const localWrite = createWriteTool(localCwd);
		const localEdit = createEditTool(localCwd);

		pi.registerTool({
			...localRead,
			async execute(id, params, signal, onUpdate) {
				if (target.kind === "ssh") {
					const tool = createReadTool(localCwd, { operations: createRemoteReadOps(target.remote, target.remoteCwd, localCwd) });
					return tool.execute(id, params, signal, onUpdate);
				}
				return localRead.execute(id, params, signal, onUpdate);
			},
		});

		pi.registerTool({
			...localWrite,
			async execute(id, params, signal, onUpdate) {
				if (target.kind === "ssh") {
					const tool = createWriteTool(localCwd, { operations: createRemoteWriteOps(target.remote, target.remoteCwd, localCwd) });
					return tool.execute(id, params, signal, onUpdate);
				}
				return localWrite.execute(id, params, signal, onUpdate);
			},
		});

		pi.registerTool({
			...localEdit,
			async execute(id, params, signal, onUpdate) {
				if (target.kind === "ssh") {
					const tool = createEditTool(localCwd, { operations: createRemoteEditOps(target.remote, target.remoteCwd, localCwd) });
					return tool.execute(id, params, signal, onUpdate);
				}
				return localEdit.execute(id, params, signal, onUpdate);
			},
		});
	}

	async function resolveRemote(value: string): Promise<SshTarget> {
		const parsed = parseSshArg(value);
		if (parsed.remoteCwd) return { kind: "ssh", ...parsed };
		const pwd = (await sshExec(parsed.remote, "pwd")).toString().trim();
		if (!pwd) throw new Error(`SSH target ${parsed.remote} returned an empty working directory`);
		return { kind: "ssh", remote: parsed.remote, remoteCwd: pwd };
	}

	if (!env("PI_AUTO_SESSION_ID") && !env("PI_AUTO_WORK_DIR")) {
		pi.registerCommand("retarget", {
			description: "Switch execution to local or to host[:path] while preserving this conversation",
			handler: async (args, ctx) => {
				const requested = (args || "").trim();
				try {
					if (requested) parseSshArg(requested);
					await ctx.waitForIdle();

					if (sandboxBackendSelected()) {
						if (!requested && target.kind === "local") {
							notify(ctx, `Already using the sandboxed local target ${target.cwd}`);
							return;
						}
						if (!requested && env("PI_AGENTSH_RETARGET_LOCAL_SUPPORTED") !== "1") {
							throw new Error("This supervised wrapper cannot provision a sandboxed local target");
						}
						const requestPath = env("PI_AGENTSH_RETARGET_REQUEST");
						if (!requestPath) throw new Error("The supervised wrapper did not expose retarget control");
						const sessionFile = ctx.sessionManager.getSessionFile();
						if (!sessionFile) throw new Error("Retargeting is unavailable with --no-session");
						// Pi deliberately delays creating a new session file until the first
						// assistant message. An immediate /retarget therefore has a reserved
						// path but nothing to resume yet; relaunch a fresh empty session.
						writeRetargetRequest(requestPath, requested || null, existsSync(sessionFile) ? sessionFile : null);
						notify(ctx, requested ? `Retargeting to ${requested}…` : "Retargeting to the sandboxed local system…");
						ctx.shutdown();
						return;
					}

					if (!requested) {
						target = { kind: "local", cwd: localCwd };
						setStatus(ctx);
						notify(ctx, `Execution target is now local:${localCwd}`);
						return;
					}

					const next = await resolveRemote(requested);
					registerLegacyTools();
					target = next;
					setStatus(ctx);
					notify(ctx, `Execution target is now SSH:${next.remote}:${next.remoteCwd}`);
				} catch (error) {
					notify(ctx, `Retarget failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			},
		});
	}

	pi.on("tool_call", async (event) => {
		const disposition = sandboxDisposition();
		if (disposition.kind === "unavailable" && ["bash", "write", "edit", "read"].includes(event.toolName)) {
			return {
				block: true,
				reason: `Full AgentSH mode is selected but its supervisor is unavailable; refusing native ${event.toolName} execution`,
			};
		}
		if (disposition.kind === "full" || target.kind !== "ssh" || event.toolName !== "bash") return;
		const command = event.input.command;
		if (typeof command !== "string" || command.length === 0) return;
		try {
			applyBashCommandTransforms(event.input);
		} catch (error) {
			return {
				block: true,
				reason: `SSH Bash routing failed closed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		ensureBashTransform();
		if (sandboxBackendSelected()) {
			const kind = env("PI_AGENTSH_TARGET_KIND") || (env("PI_AGENTSH_REMOTE") === "ssh" ? "ssh" : "local");
			if (kind === "ssh") {
				target = {
					kind: "ssh",
					remote: env("PI_AGENTSH_REMOTE_TARGET") || "remote",
					remoteCwd: env("PI_AGENTSH_REMOTE_CWD") || "/workspace",
				};
			} else {
				target = { kind: "local", cwd: env("PI_AGENTSH_REMOTE_CWD") || localCwd };
			}
			publishTarget();
			setStatus(ctx);
			if (ctx.hasUI) {
				const label = target.kind === "ssh" ? `${target.remote}:${target.remoteCwd}` : `local:${target.cwd}`;
				ctx.ui.notify(`AgentSH execution target: ${label}`, "info");
			}
			return;
		}

		const arg = pi.getFlag("ssh") as string | undefined;
		if (!arg) {
			setStatus(ctx);
			return;
		}
		target = await resolveRemote(arg);
		registerLegacyTools();
		setStatus(ctx);
		if (ctx.hasUI && target.kind === "ssh") ctx.ui.notify(`SSH mode: ${target.remote}:${target.remoteCwd}`, "info");
	});

	pi.on("session_shutdown", () => {
		unregisterBashTransform();
	});

	pi.on("user_bash", () => {
		if (sandboxBackendSelected()) return { operations: createSupervisorBashOps(targetCwd(target)) };
		if (target.kind === "ssh") return { operations: createRemoteBashOps(target.remote, target.remoteCwd, localCwd) };
	});

	pi.on("before_agent_start", async (event) => {
		if (!sandboxBackendSelected() && target.kind === "local") return;
		const replacement = target.kind === "ssh"
			? sandboxBackendSelected()
				? `Current working directory: ${target.remoteCwd} (remote AgentSH sandbox over SSH: ${target.remote})`
				: `Current working directory: ${target.remoteCwd} (via SSH: ${target.remote})`
			: `Current working directory: ${target.cwd} (local AgentSH sandbox)`;
		return {
			systemPrompt: event.systemPrompt.replace(`Current working directory: ${localCwd}`, replacement),
		};
	});
}
