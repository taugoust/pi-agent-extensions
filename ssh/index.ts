/**
 * SSH Remote Execution Extension
 *
 * Dual-mode SSH support:
 * - legacy mode (pi-unsafe --ssh ...): direct raw SSH read/write/edit/bash.
 * - supervised mode (pi/pi-auto --ssh ... wrappers): local Pi talks to a
 *   remote AgentSH supervisor through AGENTSH_SESSION_SUPERVISOR. No tool
 *   calls are sent over raw SSH in this mode.
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	type BashOperations,
	createEditTool,
	createReadTool,
	createWriteTool,
	type EditOperations,
	type ReadOperations,
	type WriteOperations,
} from "@mariozechner/pi-coding-agent";

function env(name: string) {
	const value = process.env[name];
	return value && value.trim() ? value.trim() : "";
}

function supervisedSshMode() {
	return env("PI_AGENTSH_REMOTE") === "ssh";
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
			if (code !== 0) {
				reject(new Error(`SSH failed (${code}): ${Buffer.concat(errChunks).toString()}`));
			} else {
				resolve(Buffer.concat(chunks));
			}
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
				const r = await sshExec(remote, `file --mime-type -b ${JSON.stringify(toRemote(p))}`);
				const m = r.toString().trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
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
	const r = createRemoteReadOps(remote, remoteCwd, localCwd);
	const w = createRemoteWriteOps(remote, remoteCwd, localCwd);
	return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
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
				child.on("error", (e) => {
					if (timer) clearTimeout(timer);
					reject(e);
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

function createSupervisorBashOps(remoteCwd: string): BashOperations {
	return {
		exec: async (command, _cwd, opts) => {
			const api = (globalThis as any).__AGENTSH_PI__;
			if (!api) throw new Error("AgentSH supervisor API unavailable");
			const result = await api.exec(
				{ command, cwd: remoteCwd, timeout_ms: opts.timeout ? opts.timeout * 1000 : undefined },
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

function parseSshArg(arg: string) {
	const colon = arg.indexOf(":");
	if (colon >= 0) return { remote: arg.slice(0, colon), remoteCwd: arg.slice(colon + 1) };
	return { remote: arg, remoteCwd: "" };
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("ssh", { description: "SSH remote: user@host or user@host:/path", type: "string" });

	const localCwd = process.cwd();
	let resolvedSsh: { remote: string; remoteCwd: string } | null = null;
	let legacyToolsRegistered = false;

	const getSsh = () => resolvedSsh;

	function registerLegacyTools() {
		if (legacyToolsRegistered) return;
		legacyToolsRegistered = true;
		const localRead = createReadTool(localCwd);
		const localWrite = createWriteTool(localCwd);
		const localEdit = createEditTool(localCwd);

		pi.registerTool({
			...localRead,
			async execute(id, params, signal, onUpdate) {
				const ssh = getSsh();
				if (ssh) {
					const tool = createReadTool(localCwd, {
						operations: createRemoteReadOps(ssh.remote, ssh.remoteCwd, localCwd),
					});
					return tool.execute(id, params, signal, onUpdate);
				}
				return localRead.execute(id, params, signal, onUpdate);
			},
		});

		pi.registerTool({
			...localWrite,
			async execute(id, params, signal, onUpdate) {
				const ssh = getSsh();
				if (ssh) {
					const tool = createWriteTool(localCwd, {
						operations: createRemoteWriteOps(ssh.remote, ssh.remoteCwd, localCwd),
					});
					return tool.execute(id, params, signal, onUpdate);
				}
				return localWrite.execute(id, params, signal, onUpdate);
			},
		});

		pi.registerTool({
			...localEdit,
			async execute(id, params, signal, onUpdate) {
				const ssh = getSsh();
				if (ssh) {
					const tool = createEditTool(localCwd, {
						operations: createRemoteEditOps(ssh.remote, ssh.remoteCwd, localCwd),
					});
					return tool.execute(id, params, signal, onUpdate);
				}
				return localEdit.execute(id, params, signal, onUpdate);
			},
		});
	}

	pi.on("tool_call", async (event) => {
		if (supervisedSshMode()) return;
		const ssh = getSsh();
		if (!ssh || event.toolName !== "bash") return;

		const command = event.input.command;
		if (typeof command !== "string" || command.length === 0) return;

		event.input.command = wrapBashCommandForSsh(command, ssh.remote, ssh.remoteCwd);
	});

	pi.on("session_start", async (_event, ctx) => {
		if (supervisedSshMode()) {
			const remote = env("PI_AGENTSH_REMOTE_TARGET") || "remote";
			const remoteCwd = env("PI_AGENTSH_REMOTE_CWD") || "/workspace";
			resolvedSsh = { remote, remoteCwd };
			if (ctx.hasUI) {
				ctx.ui.setStatus("ssh", ctx.ui.theme.fg("accent", `SSH+AgentSH: ${remote}:${remoteCwd}`));
				ctx.ui.notify(`SSH+AgentSH mode: ${remote}:${remoteCwd}`, "info");
			}
			return;
		}

		const arg = pi.getFlag("ssh") as string | undefined;
		if (!arg) return;

		const parsed = parseSshArg(arg);
		if (parsed.remoteCwd) {
			resolvedSsh = parsed;
		} else {
			const pwd = (await sshExec(parsed.remote, "pwd")).toString().trim();
			resolvedSsh = { remote: parsed.remote, remoteCwd: pwd };
		}
		registerLegacyTools();

		if (ctx.hasUI) {
			ctx.ui.setStatus("ssh", ctx.ui.theme.fg("accent", `SSH: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`));
			ctx.ui.notify(`SSH mode: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`, "info");
		}
	});

	pi.on("user_bash", () => {
		const ssh = getSsh();
		if (!ssh) return;
		if (supervisedSshMode()) return { operations: createSupervisorBashOps(ssh.remoteCwd) };
		return { operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, localCwd) };
	});

	pi.on("before_agent_start", async (event) => {
		const ssh = getSsh();
		if (!ssh) return;
		const replacement = supervisedSshMode()
			? `Current working directory: ${ssh.remoteCwd} (remote AgentSH over SSH: ${ssh.remote})`
			: `Current working directory: ${ssh.remoteCwd} (via SSH: ${ssh.remote})`;
		const modified = event.systemPrompt.replace(
			`Current working directory: ${localCwd}`,
			replacement,
		);
		return { systemPrompt: modified };
	});
}
