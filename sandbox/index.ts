/**
 * Sandbox Extension - OS-level sandboxing for bash commands
 *
 * Uses @anthropic-ai/sandbox-runtime to enforce filesystem and network
 * restrictions on bash commands at the OS level (sandbox-exec on macOS,
 * bubblewrap on Linux).
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/sandbox.json (global)
 * - <cwd>/.pi/sandbox.json (project-local)
 *
 * Example .pi/sandbox.json:
 * ```json
 * {
 *   "enabled": true,
 *   "network": {
 *     "allowedDomains": ["github.com", "*.github.com"],
 *     "deniedDomains": []
 *   },
 *   "filesystem": {
 *     "denyRead": ["~/.ssh", "~/.aws"],
 *     "allowWrite": [".", "/tmp"],
 *     "denyWrite": [".env"]
 *   }
 * }
 * ```
 *
 * Usage:
 * - `pi -e ./sandbox` - sandbox enabled with default/config settings
 * - `pi -e ./sandbox --no-sandbox` - disable sandboxing
 * - `/sandbox` - show current (live) sandbox configuration
 * - `/sandbox-control` - toggle sandbox on/off for this session
 * - `/sandbox-allow <path>` - grant write access to a path for this session
 * - `sandbox_allow_path` tool - agent can request write access (requires user approval)
 *
 * Dynamic path access:
 *   Both `/sandbox-allow` and the `sandbox_allow_path` tool call
 *   `SandboxManager.updateConfig()` which takes effect immediately for
 *   the next sandboxed command — no reset/re-initialization required.
 *
 * Setup:
 * 1. Copy sandbox/ directory to ~/.pi/agent/extensions/
 * 2. Run `npm install` in ~/.pi/agent/extensions/sandbox/
 *
 * Linux also requires: bubblewrap, socat, ripgrep
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type BashOperations, createBashTool } from "@mariozechner/pi-coding-agent";

interface SandboxConfig extends SandboxRuntimeConfig {
	enabled?: boolean;
}

const DEFAULT_CONFIG: SandboxConfig = {
	enabled: true,
	network: {
		allowedDomains: [
			"npmjs.org",
			"*.npmjs.org",
			"registry.npmjs.org",
			"registry.yarnpkg.com",
			"pypi.org",
			"*.pypi.org",
			"github.com",
			"*.github.com",
			"api.github.com",
			"raw.githubusercontent.com",
			"cache.nixos.org",
		],
		deniedDomains: [],
		allowUnixSockets: [
			"/nix/var/nix/daemon-socket/socket",
			"/nix/var/nix/gc-socket/socket",
		],
	},
	filesystem: {
		denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
		allowWrite: [".", "/tmp", "~/.cache/nix"],
		denyWrite: [".env", ".env.*", "*.pem", "*.key"],
	},
};

function loadConfig(cwd: string): SandboxConfig {
	const projectConfigPath = join(cwd, ".pi", "sandbox.json");
	const globalConfigPath = join(homedir(), ".pi", "agent", "sandbox.json");

	let globalConfig: Partial<SandboxConfig> = {};
	let projectConfig: Partial<SandboxConfig> = {};

	if (existsSync(globalConfigPath)) {
		try {
			globalConfig = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
		} catch (e) {
			console.error(`Warning: Could not parse ${globalConfigPath}: ${e}`);
		}
	}

	if (existsSync(projectConfigPath)) {
		try {
			projectConfig = JSON.parse(readFileSync(projectConfigPath, "utf-8"));
		} catch (e) {
			console.error(`Warning: Could not parse ${projectConfigPath}: ${e}`);
		}
	}

	return deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig);
}

function deepMerge(base: SandboxConfig, overrides: Partial<SandboxConfig>): SandboxConfig {
	const result: SandboxConfig = { ...base };

	if (overrides.enabled !== undefined) result.enabled = overrides.enabled;
	if (overrides.network) {
		result.network = { ...base.network, ...overrides.network };
	}
	if (overrides.filesystem) {
		result.filesystem = { ...base.filesystem, ...overrides.filesystem };
	}

	const extOverrides = overrides as {
		ignoreViolations?: Record<string, string[]>;
		enableWeakerNestedSandbox?: boolean;
	};
	const extResult = result as { ignoreViolations?: Record<string, string[]>; enableWeakerNestedSandbox?: boolean };

	if (extOverrides.ignoreViolations) {
		extResult.ignoreViolations = extOverrides.ignoreViolations;
	}
	if (extOverrides.enableWeakerNestedSandbox !== undefined) {
		extResult.enableWeakerNestedSandbox = extOverrides.enableWeakerNestedSandbox;
	}

	return result;
}

function createSandboxedBashOps(): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout }) {
			if (!existsSync(cwd)) {
				throw new Error(`Working directory does not exist: ${cwd}`);
			}

			const wrappedCommand = await SandboxManager.wrapWithSandbox(command);

			return new Promise((resolve, reject) => {
				const child = spawn("bash", ["-c", wrappedCommand], {
					cwd,
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
				});

				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;

				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) {
							try {
								process.kill(-child.pid, "SIGKILL");
							} catch {
								child.kill("SIGKILL");
							}
						}
					}, timeout * 1000);
				}

				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);

				child.on("error", (err) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					reject(err);
				});

				const onAbort = () => {
					if (child.pid) {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch {
							child.kill("SIGKILL");
						}
					}
				};

				signal?.addEventListener("abort", onAbort, { once: true });

				child.on("close", (code) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					signal?.removeEventListener("abort", onAbort);

					if (signal?.aborted) {
						reject(new Error("aborted"));
					} else if (timedOut) {
						reject(new Error(`timeout:${timeout}`));
					} else {
						resolve({ exitCode: code });
					}
				});
			});
		},
	};
}

/** Expand ~ and resolve relative paths against cwd. */
function normalizePath(inputPath: string, cwd: string): string {
	if (inputPath.startsWith("~/") || inputPath === "~") {
		return join(homedir(), inputPath.slice(1));
	}
	if (!isAbsolute(inputPath)) {
		return resolve(cwd, inputPath);
	}
	return inputPath;
}

/** Update the sandbox footer status to reflect the current live config. */
function refreshStatus(
	config: SandboxRuntimeConfig,
	ctx: { ui: { setStatus: (key: string, value: string | undefined) => void; theme: { fg: (color: string, text: string) => string } } },
): void {
	const networkCount = config.network?.allowedDomains?.length ?? 0;
	const writeCount = config.filesystem?.allowWrite?.length ?? 0;
	ctx.ui.setStatus(
		"sandbox",
		ctx.ui.theme.fg("accent", `🔒 Sandbox: ${networkCount} domains, ${writeCount} write paths`),
	);
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-sandbox", {
		description: "Disable OS-level sandboxing for bash commands",
		type: "boolean",
		default: false,
	});

	const localCwd = process.cwd();
	const localBash = createBashTool(localCwd);

	let sandboxEnabled = false;
	let sandboxInitialized = false;

	pi.registerTool({
		...localBash,
		label: "bash (sandboxed)",
		async execute(id, params, signal, onUpdate, _ctx) {
			if (!sandboxEnabled || !sandboxInitialized) {
				return localBash.execute(id, params, signal, onUpdate);
			}

			const sandboxedBash = createBashTool(localCwd, {
				operations: createSandboxedBashOps(),
			});
			return sandboxedBash.execute(id, params, signal, onUpdate);
		},
	});

	pi.on("user_bash", () => {
		if (!sandboxEnabled || !sandboxInitialized) return;
		return { operations: createSandboxedBashOps() };
	});

	pi.on("session_start", async (_event, ctx) => {
		const noSandbox = pi.getFlag("no-sandbox") as boolean;

		if (noSandbox) {
			sandboxEnabled = false;
			ctx.ui.notify("Sandbox disabled via --no-sandbox", "warning");
			return;
		}

		const config = loadConfig(ctx.cwd);

		if (!config.enabled) {
			sandboxEnabled = false;
			ctx.ui.notify("Sandbox disabled via config", "info");
			return;
		}

		const platform = process.platform;
		if (platform !== "darwin" && platform !== "linux") {
			sandboxEnabled = false;
			ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
			return;
		}

		try {
			const configExt = config as unknown as {
				ignoreViolations?: Record<string, string[]>;
				enableWeakerNestedSandbox?: boolean;
			};

			await SandboxManager.initialize({
				network: config.network,
				filesystem: config.filesystem,
				ignoreViolations: configExt.ignoreViolations,
				enableWeakerNestedSandbox: configExt.enableWeakerNestedSandbox,
			});

			sandboxEnabled = true;
			sandboxInitialized = true;

			const networkCount = config.network?.allowedDomains?.length ?? 0;
			const writeCount = config.filesystem?.allowWrite?.length ?? 0;
			ctx.ui.setStatus(
				"sandbox",
				ctx.ui.theme.fg("accent", `🔒 Sandbox: ${networkCount} domains, ${writeCount} write paths`),
			);
			ctx.ui.notify("Sandbox initialized", "info");
		} catch (err) {
			sandboxEnabled = false;
			ctx.ui.notify(`Sandbox initialization failed: ${err instanceof Error ? err.message : err}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		if (sandboxInitialized) {
			try {
				await SandboxManager.reset();
			} catch {
				// Ignore cleanup errors
			}
		}
	});

	pi.registerCommand("sandbox", {
		description: "Show current (live) sandbox configuration",
		handler: async (_args, ctx) => {
			if (!sandboxEnabled) {
				ctx.ui.notify("Sandbox is disabled", "info");
				return;
			}

			// Use the live config from SandboxManager so dynamic changes are reflected.
			const config = SandboxManager.getConfig() ?? loadConfig(ctx.cwd);
			const lines = [
				"Sandbox Configuration (live):",
				"",
				"Network:",
				`  Allowed: ${config.network?.allowedDomains?.join(", ") || "(none)"}`,
				`  Denied: ${config.network?.deniedDomains?.join(", ") || "(none)"}`,
				"",
				"Filesystem:",
				`  Deny Read: ${config.filesystem?.denyRead?.join(", ") || "(none)"}`,
				`  Allow Write: ${config.filesystem?.allowWrite?.join(", ") || "(none)"}`,
				`  Deny Write: ${config.filesystem?.denyWrite?.join(", ") || "(none)"}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("sandbox-control", {
		description: "Toggle sandbox on/off for the current session",
		handler: async (_args, ctx) => {
			if (sandboxEnabled) {
				// Disable: bash falls back to localBash (unconfined)
				sandboxEnabled = false;
				ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("warning", "🔓 Sandbox: disabled"));
				ctx.ui.notify("Sandbox disabled for this session — bash commands are now unconfined", "warning");
			} else {
				// Re-enable: only possible if SandboxManager was successfully initialized
				if (!sandboxInitialized) {
					ctx.ui.notify(
						"Sandbox cannot be re-enabled — it was never successfully initialized this session " +
						"(check --no-sandbox flag, config enabled:false, or initialization error)",
						"error",
					);
					return;
				}

				sandboxEnabled = true;
				const config = SandboxManager.getConfig() ?? loadConfig(ctx.cwd);
				refreshStatus(config, ctx);
				ctx.ui.notify("Sandbox re-enabled", "info");
			}
		},
	});

	pi.registerCommand("sandbox-allow", {
		description: "Grant write access to a path for this session: /sandbox-allow <path>",
		handler: async (args, ctx) => {
			if (!sandboxEnabled || !sandboxInitialized) {
				ctx.ui.notify("Sandbox is not active", "warning");
				return;
			}

			const raw = args?.trim();
			if (!raw) {
				ctx.ui.notify("Usage: /sandbox-allow <path>", "warning");
				return;
			}

			const normalized = normalizePath(raw, ctx.cwd);
			const current = SandboxManager.getConfig();
			if (!current) {
				ctx.ui.notify("Sandbox config not available", "error");
				return;
			}

			if (current.filesystem.allowWrite.includes(normalized)) {
				ctx.ui.notify(`Already allowed: ${normalized}`, "info");
				return;
			}

			const newConfig = {
				...current,
				filesystem: {
					...current.filesystem,
					allowWrite: [...current.filesystem.allowWrite, normalized],
				},
			};
			SandboxManager.updateConfig(newConfig);
			refreshStatus(newConfig, ctx);
			ctx.ui.notify(`Write access granted: ${normalized}`, "info");
		},
	});

	pi.registerTool({
		name: "sandbox_allow_path",
		label: "Request Sandbox Path Access",
		description:
			"Request write access to a filesystem path within the sandbox. " +
			"Requires user approval. Use this when a command fails due to sandbox write restrictions.",
		parameters: Type.Object({
			path: Type.String({
				description: "The filesystem path to allow write access to (absolute or relative to cwd)",
			}),
			reason: Type.String({
				description: "Why write access to this path is needed",
			}),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!sandboxEnabled || !sandboxInitialized) {
				return {
					content: [{ type: "text", text: "Sandbox is not active; no permission change needed." }],
				};
			}

			const normalized = normalizePath(params.path, ctx.cwd);
			const current = SandboxManager.getConfig();
			if (!current) {
				return {
					content: [{ type: "text", text: "Sandbox config not available." }],
					isError: true,
				};
			}

			if (current.filesystem.allowWrite.includes(normalized)) {
				return {
					content: [{ type: "text", text: `Write access to ${normalized} is already allowed.` }],
				};
			}

			const approved = await ctx.ui.confirm(
				"Sandbox: Allow write access?",
				`The agent requests write access to:\n  ${normalized}\n\nReason: ${params.reason}`,
			);

			if (!approved) {
				return {
					content: [{ type: "text", text: `Write access to ${normalized} was denied.` }],
				};
			}

			const newConfig = {
				...current,
				filesystem: {
					...current.filesystem,
					allowWrite: [...current.filesystem.allowWrite, normalized],
				},
			};
			SandboxManager.updateConfig(newConfig);
			refreshStatus(newConfig, ctx);
			return {
				content: [{ type: "text", text: `Write access granted: ${normalized}` }],
			};
		},
	});
}
