/**
 * Sandbox Extension - capability-based sandboxing for bash and native file tools
 *
 * Combines:
 * - OS-level sandboxing for bash commands via @anthropic-ai/sandbox-runtime
 * - Interactive approval prompts for blocked capabilities
 * - Session / project / global grants
 * - Native file-tool policy for read / write / edit
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
 *     "allowRead": ["~/.ssh"],
 *     "denyRead": ["~/.ssh", "~/.aws"],
 *     "allowWrite": [".", "/tmp"],
 *     "denyWrite": [".env"]
 *   },
 *   "git": {
 *     "allowedDangerousCommands": ["force-push"]
 *   },
 *   "github": {
 *     "allowedCommands": ["pr-create"]
 *   }
 * }
 * ```
 *
 * Usage:
 * - `pi -e ./sandbox` - sandbox enabled with default/config settings
 * - `pi -e ./sandbox --no-sandbox` - disable sandboxing
 * - `/sandbox` - show effective config and session grants
 * - `/sandbox-control` - toggle sandbox on/off for this session
 * - `/sandbox-allow <path>` - grant write access to a path for this session
 *
 * Setup:
 * 1. Copy sandbox/ directory to ~/.pi/agent/extensions/
 * 2. Run `npm install` in ~/.pi/agent/extensions/sandbox/
 *
 * Linux also requires: bubblewrap, socat, ripgrep
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type BashOperations, createBashTool } from "@mariozechner/pi-coding-agent";

type GrantScope = "session" | "project" | "global";
type GrantChoice = "once" | GrantScope;
type DangerousGitCommandId =
	| "force-push"
	| "hard-reset"
	| "clean"
	| "checkout-reset-files"
	| "checkout-reset-all"
	| "restore";
type GitHubCommandId =
	| "issue-create"
	| "issue-modify"
	| "pr-create"
	| "pr-modify"
	| "repo-modify"
	| "release-modify";
type SandboxConfigFile = Partial<SandboxConfig>;
type FilesystemConfig = SandboxRuntimeConfig["filesystem"] & { allowRead: string[] };
type NetworkConfig = SandboxRuntimeConfig["network"];

interface GitConfig {
	allowedDangerousCommands: DangerousGitCommandId[];
}

interface GitHubConfig {
	allowedCommands: GitHubCommandId[];
}

interface SandboxConfig extends Omit<SandboxRuntimeConfig, "filesystem" | "network"> {
	enabled?: boolean;
	network: NetworkConfig;
	filesystem: FilesystemConfig;
	git: GitConfig;
	github: GitHubConfig;
}

interface DangerousGitRule {
	id: DangerousGitCommandId;
	label: string;
	pattern: RegExp;
}

interface GitHubCommandRule {
	id: GitHubCommandId;
	label: string;
	pattern: RegExp;
}

interface ActiveOnceGrantBundle {
	domains: string[];
	readPaths: string[];
	unixSockets: string[];
}

interface SandboxState {
	cwd: string;
	enabled: boolean;
	initialized: boolean;
	diskConfig: SandboxConfig;
	sessionDomains: Set<string>;
	sessionReadPaths: Set<string>;
	sessionWritePaths: Set<string>;
	sessionUnixSockets: Set<string>;
	sessionDangerousGitCommands: Set<DangerousGitCommandId>;
	sessionGitHubCommands: Set<GitHubCommandId>;
	onceGrantBundlesByToolCall: Map<string, ActiveOnceGrantBundle>;
	updateQueue: Promise<void>;
}

interface SandboxPromptContext {
	cwd: string;
	hasUI: boolean;
	ui: {
		theme: { fg: (color: string, text: string) => string };
		setStatus: (key: string, value: string | undefined) => void;
		notify: (message: string, level: "info" | "warning" | "error") => void;
		select: (title: string, items: string[]) => Promise<string>;
	};
}

interface CommandCapabilities {
	sshDomains: string[];
	wantsSshConfigRead: boolean;
	wantsSshAgentSocket: boolean;
}

interface PendingPathGrant {
	sessionPath: string;
	storedPath: string;
}

interface PendingSshGrantBundle {
	domains: string[];
	readPath?: PendingPathGrant;
	unixSocket?: PendingPathGrant;
}

const CAPABILITY_GATE_MARKER = "__paeSandboxCapabilityGateActive";
const GLOBAL_CONFIG_PATH = join(homedir(), ".pi", "agent", "sandbox.json");
const SSH_COMMANDS = new Set(["ssh", "scp", "rsync", "sftp"]);
const SHELL_CONTROL_OPERATORS = new Set(["|", "||", "&&", ";", "&", "(", ")"]);
const SSH_VALUE_FLAGS = new Set([
	"-b",
	"-c",
	"-D",
	"-E",
	"-e",
	"-F",
	"-I",
	"-i",
	"-J",
	"-L",
	"-l",
	"-m",
	"-O",
	"-o",
	"-p",
	"-Q",
	"-R",
	"-S",
	"-W",
	"-w",
	"--identity-file",
	"--config",
	"--jump-host",
	"--login-name",
	"--port",
]);

const DANGEROUS_GIT_RULES: DangerousGitRule[] = [
	{ id: "force-push", pattern: /\bgit\s+push\s+.*(-f\b|--force\b)/, label: "force push" },
	{ id: "hard-reset", pattern: /\bgit\s+reset\s+--hard\b/, label: "hard reset" },
	{ id: "clean", pattern: /\bgit\s+clean\s+-[^\s]*f/, label: "git clean" },
	{ id: "checkout-reset-files", pattern: /\bgit\s+checkout\s+(\S+\s+)?--\s/, label: "git checkout (reset files)" },
	{ id: "checkout-reset-all", pattern: /\bgit\s+checkout\s+\.\s*($|[;&|])/, label: "git checkout (reset all files)" },
	{ id: "restore", pattern: /\bgit\s+restore\b/, label: "git restore" },
];

const GITHUB_COMMAND_RULES: GitHubCommandRule[] = [
	{ id: "issue-create", pattern: /\bgh\s+issue\s+create\b/, label: "create GitHub issue" },
	{ id: "issue-modify", pattern: /\bgh\s+issue\s+(close|delete|edit|comment)\b/, label: "modify GitHub issue" },
	{ id: "pr-create", pattern: /\bgh\s+pr\s+create\b/, label: "create GitHub PR" },
	{ id: "pr-modify", pattern: /\bgh\s+pr\s+(close|merge|edit|comment|review)\b/, label: "modify GitHub PR" },
	{ id: "repo-modify", pattern: /\bgh\s+repo\s+(create|delete|rename|archive)\b/, label: "modify GitHub repo" },
	{ id: "release-modify", pattern: /\bgh\s+release\s+(create|delete|edit)\b/, label: "modify GitHub release" },
];

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
		allowUnixSockets: ["/nix/var/nix/daemon-socket/socket", "/nix/var/nix/gc-socket/socket"],
	},
	filesystem: {
		allowRead: [],
		denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
		allowWrite: [".", "/tmp", "~/.cache/nix"],
		denyWrite: [".env", ".env.*", "*.pem", "*.key"],
	},
	git: {
		allowedDangerousCommands: [],
	},
	github: {
		allowedCommands: [],
	},
};

const grantScopeOptions = ["Abort", "Allow for this session", "Allow for this project", "Allow for all projects"];
const grantChoiceOptions = ["Abort", "Allow once", "Allow for this session", "Allow for this project", "Allow for all projects"];

function setCapabilityGateActive(active: boolean): void {
	(globalThis as Record<string, unknown>)[CAPABILITY_GATE_MARKER] = active;
}

function normalizeAtPrefix(filePath: string): string {
	return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

function expandPath(filePath: string): string {
	const normalized = normalizeAtPrefix(filePath);

	if (normalized === "~") {
		return homedir();
	}

	if (normalized.startsWith("~/")) {
		return resolve(homedir(), normalized.slice(2));
	}

	return normalized;
}

function resolveToolPath(cwd: string, filePath: string): string {
	const expanded = expandPath(filePath);
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function isPathInside(baseDir: string, targetPath: string): boolean {
	const relPath = relative(baseDir, targetPath);
	return relPath === "" || (!relPath.startsWith("..") && !isAbsolute(relPath));
}

function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function resolveThroughExistingPath(targetPath: string): Promise<string> {
	const missingSegments: string[] = [];
	let currentPath = resolve(targetPath);

	while (true) {
		try {
			const resolvedPath = await realpath(currentPath);
			return missingSegments.length === 0 ? resolvedPath : resolve(resolvedPath, ...missingSegments.reverse());
		} catch (error) {
			if (!hasErrorCode(error, "ENOENT")) {
				throw error;
			}

			const parentPath = dirname(currentPath);
			if (parentPath === currentPath) {
				return missingSegments.length === 0 ? currentPath : resolve(currentPath, ...missingSegments.reverse());
			}

			missingSegments.push(basename(currentPath));
			currentPath = parentPath;
		}
	}
}

async function resolvePolicyPath(cwd: string, filePath: string) {
	const absolutePath = resolveToolPath(cwd, filePath);
	const resolvedPath = await resolveThroughExistingPath(absolutePath);
	return { absolutePath, resolvedPath };
}

function formatResolvedPath(rawPath: string, absolutePath: string, resolvedPath: string): string {
	if (resolvedPath === absolutePath) {
		return resolvedPath;
	}
	return `${rawPath} → ${resolvedPath}`;
}

function uniqueStrings<T extends string>(values: Iterable<T>): T[] {
	const result: T[] = [];
	const seen = new Set<T>();

	for (const value of values) {
		if (!seen.has(value)) {
			seen.add(value);
			result.push(value);
		}
	}

	return result;
}

function getActiveOnceDomains(state: SandboxState): string[] {
	return uniqueStrings(Array.from(state.onceGrantBundlesByToolCall.values()).flatMap((bundle) => bundle.domains));
}

function getActiveOnceReadPaths(state: SandboxState): string[] {
	return uniqueStrings(Array.from(state.onceGrantBundlesByToolCall.values()).flatMap((bundle) => bundle.readPaths));
}

function getActiveOnceUnixSockets(state: SandboxState): string[] {
	return uniqueStrings(Array.from(state.onceGrantBundlesByToolCall.values()).flatMap((bundle) => bundle.unixSockets));
}

function getDangerousGitRule(ruleId: DangerousGitCommandId): DangerousGitRule | undefined {
	return DANGEROUS_GIT_RULES.find((rule) => rule.id === ruleId);
}

function describeDangerousGitCommandId(ruleId: DangerousGitCommandId): string {
	return getDangerousGitRule(ruleId)?.label ?? ruleId;
}

function describeDangerousGitCommandIds(ruleIds: Iterable<DangerousGitCommandId>): string[] {
	return uniqueStrings(Array.from(ruleIds)).map((ruleId) => describeDangerousGitCommandId(ruleId));
}

function findDangerousGitRules(command: string): DangerousGitRule[] {
	return DANGEROUS_GIT_RULES.filter((rule) => rule.pattern.test(command));
}

function getGitHubCommandRule(ruleId: GitHubCommandId): GitHubCommandRule | undefined {
	return GITHUB_COMMAND_RULES.find((rule) => rule.id === ruleId);
}

function describeGitHubCommandId(ruleId: GitHubCommandId): string {
	return getGitHubCommandRule(ruleId)?.label ?? ruleId;
}

function describeGitHubCommandIds(ruleIds: Iterable<GitHubCommandId>): string[] {
	return uniqueStrings(Array.from(ruleIds)).map((ruleId) => describeGitHubCommandId(ruleId));
}

function findGitHubCommandRules(command: string): GitHubCommandRule[] {
	return GITHUB_COMMAND_RULES.filter((rule) => rule.pattern.test(command));
}

function loadConfigFile(path: string): SandboxConfigFile {
	if (!existsSync(path)) {
		return {};
	}

	try {
		return JSON.parse(readFileSync(path, "utf-8")) as SandboxConfigFile;
	} catch (error) {
		throw new Error(`Could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function deepMerge(base: SandboxConfig, overrides: SandboxConfigFile): SandboxConfig {
	const result: SandboxConfig = {
		...base,
		...overrides,
		network: {
			...base.network,
			...(overrides.network ?? {}),
		},
		filesystem: {
			...base.filesystem,
			...(overrides.filesystem ?? {}),
			allowRead: overrides.filesystem?.allowRead ?? base.filesystem.allowRead,
		},
		git: {
			...base.git,
			...(overrides.git ?? {}),
			allowedDangerousCommands: uniqueStrings([
				...base.git.allowedDangerousCommands,
				...(overrides.git?.allowedDangerousCommands ?? []),
			]),
		},
		github: {
			...base.github,
			...(overrides.github ?? {}),
			allowedCommands: uniqueStrings([...base.github.allowedCommands, ...(overrides.github?.allowedCommands ?? [])]),
		},
	};

	if (overrides.enabled !== undefined) {
		result.enabled = overrides.enabled;
	}

	return result;
}

function getProjectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "sandbox.json");
}

function loadConfig(cwd: string): SandboxConfig {
	const globalConfig = loadConfigFile(GLOBAL_CONFIG_PATH);
	const projectConfig = loadConfigFile(getProjectConfigPath(cwd));
	return deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig);
}

function createSandboxedBashOps(): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout }) {
			if (!existsSync(cwd)) {
				throw new Error(`Working directory does not exist: ${cwd}`);
			}

			const wrappedCommand = await SandboxManager.wrapWithSandbox(command);

			return new Promise((resolveResult, reject) => {
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

				child.on("error", (error) => {
					if (timeoutHandle) clearTimeout(timeoutHandle);
					reject(error);
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
						resolveResult({ exitCode: code });
					}
				});
			});
		},
	};
}

function refreshStatus(state: SandboxState, ctx: SandboxPromptContext): void {
	if (!ctx.hasUI) {
		return;
	}

	if (!state.enabled) {
		ctx.ui.setStatus("sandbox", ctx.ui.theme.fg("warning", "🔓 Sandbox: disabled"));
		return;
	}

	const networkCount = state.diskConfig.network.allowedDomains.length + state.sessionDomains.size;
	const writeCount = state.diskConfig.filesystem.allowWrite.length + state.sessionWritePaths.size;
	const readCount = state.diskConfig.filesystem.allowRead.length + state.sessionReadPaths.size;
	ctx.ui.setStatus(
		"sandbox",
		ctx.ui.theme.fg("accent", `🔒 Sandbox: ${networkCount} domains, ${writeCount} write, ${readCount} read`),
	);
}

function notify(ctx: SandboxPromptContext, message: string, level: "info" | "warning" | "error"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, level);
	}
}

function isPathConfigEntry(entry: string): boolean {
	return (
		entry === "." ||
		entry === ".." ||
		entry === "~" ||
		entry.startsWith("~/") ||
		entry.startsWith("./") ||
		entry.startsWith("../") ||
		entry.startsWith("/") ||
		entry.includes("/")
	);
}

function escapeRegex(text: string): string {
	return text.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegex(pattern: string): RegExp {
	let regex = "^";

	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index];

		if (char === "*") {
			const nextChar = pattern[index + 1];
			if (nextChar === "*") {
				regex += ".*";
				index += 1;
			} else {
				regex += "[^/]*";
			}
			continue;
		}

		regex += escapeRegex(char);
	}

	regex += "$";
	return new RegExp(regex);
}

function normalizeDomain(domain: string): string {
	let value = domain.trim().toLowerCase();
	if (value.startsWith("[") && value.endsWith("]")) {
		value = value.slice(1, -1);
	}
	if (value.endsWith(".")) {
		value = value.slice(0, -1);
	}
	return value;
}

function parseHostPort(raw: string): { host: string; port?: string } {
	if (raw.startsWith("[")) {
		const closing = raw.indexOf("]");
		if (closing >= 0) {
			const host = raw.slice(1, closing);
			const remainder = raw.slice(closing + 1);
			const port = remainder.startsWith(":") ? remainder.slice(1) : undefined;
			return { host, port };
		}
	}

	const colonCount = (raw.match(/:/g) ?? []).length;
	if (colonCount === 1) {
		const [host, port] = raw.split(":");
		return { host, port };
	}

	return { host: raw };
}

function matchesDomainPattern(pattern: string, domain: string): boolean {
	const normalizedPattern = normalizeDomain(pattern);
	const normalizedDomain = normalizeDomain(domain);

	if (normalizedPattern === "*") {
		return true;
	}

	if (normalizedPattern.startsWith("*.")) {
		const suffix = normalizedPattern.slice(2);
		return normalizedDomain === suffix || normalizedDomain.endsWith(`.${suffix}`);
	}

	return normalizedDomain === normalizedPattern;
}

function tokenizeCommand(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;

	const flushCurrent = () => {
		if (current.length > 0) {
			tokens.push(current);
			current = "";
		}
	};

	for (let index = 0; index < command.length; index += 1) {
		const char = command[index];

		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}

		if (char === "\\") {
			escaped = true;
			continue;
		}

		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}

		if (/\s/.test(char)) {
			flushCurrent();
			continue;
		}

		if (char === "|" || char === "&" || char === ";" || char === "(" || char === ")") {
			flushCurrent();
			const nextChar = command[index + 1];
			if ((char === "|" || char === "&") && nextChar === char) {
				tokens.push(`${char}${nextChar}`);
				index += 1;
			} else {
				tokens.push(char);
			}
			continue;
		}

		current += char;
	}

	flushCurrent();
	return tokens;
}

function isShellControlOperator(token: string): boolean {
	return SHELL_CONTROL_OPERATORS.has(token);
}

function extractSshHost(target: string): string | undefined {
	if (!target || target === "-") {
		return undefined;
	}

	const withoutUser = target.includes("@") ? target.slice(target.lastIndexOf("@") + 1) : target;
	if (!withoutUser || withoutUser.startsWith("/") || withoutUser.startsWith(".")) {
		return undefined;
	}

	const { host } = parseHostPort(withoutUser.replace(/:+$/, ""));
	return host ? normalizeDomain(host) : undefined;
}

function isRemotePathSpec(token: string): boolean {
	if (!token || token.startsWith("/") || token.startsWith("./") || token.startsWith("../") || token.startsWith("~")) {
		return false;
	}

	if (token.includes("ssh://")) {
		return false;
	}

	const doubleColon = token.indexOf("::");
	const singleColon = token.indexOf(":");
	const colonIndex = doubleColon >= 0 ? doubleColon : singleColon;
	if (colonIndex <= 0) {
		return false;
	}

	const prefix = token.slice(0, colonIndex);
	return !prefix.includes("/") && prefix !== "." && prefix !== "..";
}

function extractRemotePathHost(token: string): string | undefined {
	if (!isRemotePathSpec(token)) {
		return undefined;
	}

	const prefix = token.split("::", 1)[0].split(":", 1)[0];
	return extractSshHost(prefix);
}

function extractCommandCapabilities(command: string): CommandCapabilities {
	const sshDomains = new Set<string>();
	const tokens = tokenizeCommand(command);
	let wantsSsh = false;
	let atCommandStart = true;

	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (!token) {
			continue;
		}

		if (isShellControlOperator(token)) {
			atCommandStart = true;
			continue;
		}

		if (!atCommandStart) {
			continue;
		}

		atCommandStart = false;
		if (!SSH_COMMANDS.has(token)) {
			continue;
		}

		wantsSsh = true;

		if (token === "ssh" || token === "sftp") {
			for (let offset = index + 1; offset < tokens.length; offset += 1) {
				const candidate = tokens[offset];
				if (!candidate || isShellControlOperator(candidate)) {
					break;
				}
				if (candidate.startsWith("-")) {
					if (SSH_VALUE_FLAGS.has(candidate)) {
						offset += 1;
					}
					continue;
				}
				const host = extractSshHost(candidate);
				if (host) {
					sshDomains.add(host);
				}
				break;
			}
			continue;
		}

		for (let offset = index + 1; offset < tokens.length; offset += 1) {
			const candidate = tokens[offset];
			if (!candidate || isShellControlOperator(candidate)) {
				break;
			}
			if (candidate.startsWith("-")) {
				if (SSH_VALUE_FLAGS.has(candidate)) {
					offset += 1;
				}
				continue;
			}
			const host = extractRemotePathHost(candidate);
			if (host) {
				sshDomains.add(host);
			}
		}
	}

	return {
		sshDomains: Array.from(sshDomains),
		wantsSshConfigRead: wantsSsh,
		wantsSshAgentSocket: wantsSsh && typeof process.env.SSH_AUTH_SOCK === "string" && process.env.SSH_AUTH_SOCK.length > 0,
	};
}

async function matchesAllowPathEntry(cwd: string, entry: string, targetResolvedPath: string): Promise<boolean> {
	const expanded = expandPath(entry);

	if (expanded.includes("*")) {
		if (!isPathConfigEntry(expanded)) {
			return globToRegex(expanded).test(basename(targetResolvedPath));
		}

		const absolutePattern = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
		return globToRegex(absolutePattern).test(targetResolvedPath);
	}

	const resolvedEntry = await resolveThroughExistingPath(resolveToolPath(cwd, expanded));
	return isPathInside(resolvedEntry, targetResolvedPath);
}

async function matchesDenyPathEntry(cwd: string, entry: string, targetResolvedPath: string): Promise<boolean> {
	const expanded = expandPath(entry);

	if (!isPathConfigEntry(expanded)) {
		if (expanded.includes("*")) {
			return globToRegex(expanded).test(basename(targetResolvedPath));
		}
		return basename(targetResolvedPath) === expanded;
	}

	if (expanded.includes("*")) {
		const absolutePattern = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
		return globToRegex(absolutePattern).test(targetResolvedPath);
	}

	const resolvedEntry = await resolveThroughExistingPath(resolveToolPath(cwd, expanded));
	return isPathInside(resolvedEntry, targetResolvedPath);
}

async function findMatchingEntry(
	cwd: string,
	entries: string[],
	targetResolvedPath: string,
	matcher: (cwd: string, entry: string, targetResolvedPath: string) => Promise<boolean>,
): Promise<string | undefined> {
	let bestMatch: string | undefined;

	for (const entry of entries) {
		if (!(await matcher(cwd, entry, targetResolvedPath))) {
			continue;
		}

		if (!bestMatch || entry.length > bestMatch.length) {
			bestMatch = entry;
		}
	}

	return bestMatch;
}

async function isPathGranted(targetResolvedPath: string, grants: Iterable<string>): Promise<boolean> {
	for (const grantPath of grants) {
		if (isPathInside(grantPath, targetResolvedPath)) {
			return true;
		}
	}
	return false;
}

async function resolveGrantedReadRoot(cwd: string, matchedDenyReadEntry: string): Promise<string> {
	return (await resolvePolicyPath(cwd, matchedDenyReadEntry)).resolvedPath;
}

async function serializePathForConfig(cwd: string, resolvedPath: string): Promise<string> {
	const resolvedCwd = await resolveThroughExistingPath(resolve(cwd));
	if (isPathInside(resolvedCwd, resolvedPath)) {
		const relPath = relative(resolvedCwd, resolvedPath);
		return relPath === "" ? "." : relPath;
	}

	const home = homedir();
	const resolvedHome = await resolveThroughExistingPath(home);
	if (isPathInside(resolvedHome, resolvedPath)) {
		const relPath = relative(resolvedHome, resolvedPath);
		return relPath === "" ? "~" : `~/${relPath}`;
	}

	return resolvedPath;
}

function formatList(values: string[]): string {
	return values.length > 0 ? values.join(", ") : "(none)";
}

function formatScope(scope: GrantScope): string {
	if (scope === "session") return "this session";
	if (scope === "project") return "this project";
	return "all projects";
}

function formatGrantChoice(choice: GrantChoice): string {
	if (choice === "once") {
		return "once";
	}
	return `for ${formatScope(choice)}`;
}

interface GrantPromptOptions {
	includeAllowOnce?: boolean;
}

async function promptForGrant(
	pi: ExtensionAPI,
	ctx: SandboxPromptContext,
	title: string,
	options: GrantPromptOptions = {},
): Promise<GrantChoice | undefined> {
	if (!ctx.hasUI) {
		return undefined;
	}

	pi.events.emit("sandbox:waiting", undefined);
	const choice = await ctx.ui.select(title, options.includeAllowOnce ? grantChoiceOptions : grantScopeOptions);
	pi.events.emit("sandbox:resolved", undefined);

	if (choice === "Allow once") return "once";
	if (choice === "Allow for this session") return "session";
	if (choice === "Allow for this project") return "project";
	if (choice === "Allow for all projects") return "global";
	return undefined;
}

function getHeadlessReason(kind: "domain" | "read" | "write" | "socket", requested: string): string {
	if (kind === "domain") {
		return `Sandbox blocked network access to ${requested}. Blocked in headless mode — add it to network.allowedDomains in .pi/sandbox.json or ~/.pi/agent/sandbox.json.`;
	}
	if (kind === "socket") {
		return `Sandbox blocked unix socket access to ${requested}. Blocked in headless mode — add it to network.allowUnixSockets in .pi/sandbox.json or ~/.pi/agent/sandbox.json.`;
	}
	if (kind === "read") {
		return `Sandbox blocked read access to ${requested}. Blocked in headless mode — add it to filesystem.allowRead in .pi/sandbox.json or ~/.pi/agent/sandbox.json.`;
	}
	return `Sandbox blocked write access to ${requested}. Blocked in headless mode — add it to filesystem.allowWrite in .pi/sandbox.json or ~/.pi/agent/sandbox.json.`;
}

function enqueueStateUpdate<T>(state: SandboxState, task: () => Promise<T>): Promise<T> {
	const next = state.updateQueue.then(task, task);
	state.updateQueue = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}

async function buildRuntimeConfig(state: SandboxState): Promise<SandboxRuntimeConfig> {
	const allowReadEntries = [...state.diskConfig.filesystem.allowRead];
	for (const sessionPath of state.sessionReadPaths) {
		allowReadEntries.push(sessionPath);
	}
	for (const oncePath of getActiveOnceReadPaths(state)) {
		allowReadEntries.push(oncePath);
	}

	const denyRead: string[] = [];
	for (const entry of state.diskConfig.filesystem.denyRead) {
		let allowed = false;
		const denyResolved = (await resolvePolicyPath(state.cwd, entry)).resolvedPath;

		for (const allowEntry of allowReadEntries) {
			if (await matchesAllowPathEntry(state.cwd, allowEntry, denyResolved)) {
				allowed = true;
				break;
			}
		}

		if (!allowed) {
			denyRead.push(entry);
		}
	}

	const { enabled: _enabled, filesystem, git: _git, github: _github, ...runtimeBase } = state.diskConfig;
	const { allowRead: _allowRead, ...runtimeFilesystemBase } = filesystem;

	return {
		...runtimeBase,
		network: {
			...state.diskConfig.network,
			allowedDomains: uniqueStrings([
				...state.diskConfig.network.allowedDomains,
				...state.sessionDomains,
				...getActiveOnceDomains(state),
			]),
			deniedDomains: uniqueStrings(state.diskConfig.network.deniedDomains),
			allowUnixSockets: uniqueStrings([
				...(state.diskConfig.network.allowUnixSockets ?? []),
				...state.sessionUnixSockets,
				...getActiveOnceUnixSockets(state),
			]),
		},
		filesystem: {
			...runtimeFilesystemBase,
			denyRead,
			allowWrite: uniqueStrings([...state.diskConfig.filesystem.allowWrite, ...state.sessionWritePaths]),
			denyWrite: uniqueStrings(state.diskConfig.filesystem.denyWrite),
		},
	};
}

async function applyRuntimeConfig(state: SandboxState): Promise<void> {
	if (!state.initialized) {
		return;
	}
	SandboxManager.updateConfig(await buildRuntimeConfig(state));
}

async function writeGrantToConfigFile(
	filePath: string,
	update: (config: SandboxConfigFile) => SandboxConfigFile,
): Promise<void> {
	const current = loadConfigFile(filePath);
	const next = update(current);
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
}

async function grantWritePath(state: SandboxState, scope: GrantScope, pathValue: string): Promise<void> {
	if (scope === "session") {
		state.sessionWritePaths.add(pathValue);
		await applyRuntimeConfig(state);
		return;
	}

	const filePath = scope === "project" ? getProjectConfigPath(state.cwd) : GLOBAL_CONFIG_PATH;
	await writeGrantToConfigFile(filePath, (config) => ({
		...config,
		filesystem: {
			...(config.filesystem ?? {}),
			allowWrite: uniqueStrings([...(config.filesystem?.allowWrite ?? []), pathValue]),
		},
	}));
	state.diskConfig = loadConfig(state.cwd);
	await applyRuntimeConfig(state);
}

async function grantReadPath(state: SandboxState, scope: GrantScope, pathValue: string): Promise<void> {
	if (scope === "session") {
		state.sessionReadPaths.add(pathValue);
		await applyRuntimeConfig(state);
		return;
	}

	const filePath = scope === "project" ? getProjectConfigPath(state.cwd) : GLOBAL_CONFIG_PATH;
	await writeGrantToConfigFile(filePath, (config) => ({
		...config,
		filesystem: {
			...(config.filesystem ?? {}),
			allowRead: uniqueStrings([...(config.filesystem?.allowRead ?? []), pathValue]),
		},
	}));
	state.diskConfig = loadConfig(state.cwd);
	await applyRuntimeConfig(state);
}

async function grantDomain(state: SandboxState, scope: GrantScope, domain: string): Promise<void> {
	if (scope === "session") {
		state.sessionDomains.add(domain);
		await applyRuntimeConfig(state);
		return;
	}

	const filePath = scope === "project" ? getProjectConfigPath(state.cwd) : GLOBAL_CONFIG_PATH;
	await writeGrantToConfigFile(filePath, (config) => ({
		...config,
		network: {
			...(config.network ?? {}),
			allowedDomains: uniqueStrings([...(config.network?.allowedDomains ?? []), domain]),
		},
	}));
	state.diskConfig = loadConfig(state.cwd);
	await applyRuntimeConfig(state);
}

async function grantUnixSocket(state: SandboxState, scope: GrantScope, socketPath: string): Promise<void> {
	if (scope === "session") {
		state.sessionUnixSockets.add(socketPath);
		await applyRuntimeConfig(state);
		return;
	}

	const filePath = scope === "project" ? getProjectConfigPath(state.cwd) : GLOBAL_CONFIG_PATH;
	await writeGrantToConfigFile(filePath, (config) => ({
		...config,
		network: {
			...(config.network ?? {}),
			allowUnixSockets: uniqueStrings([...(config.network?.allowUnixSockets ?? []), socketPath]),
		},
	}));
	state.diskConfig = loadConfig(state.cwd);
	await applyRuntimeConfig(state);
}

function isDangerousGitCommandAllowed(state: SandboxState, commandId: DangerousGitCommandId): boolean {
	return state.sessionDangerousGitCommands.has(commandId) || state.diskConfig.git.allowedDangerousCommands.includes(commandId);
}

function getPendingDangerousGitRules(state: SandboxState, command: string): DangerousGitRule[] {
	return findDangerousGitRules(command).filter((rule) => !isDangerousGitCommandAllowed(state, rule.id));
}

async function grantDangerousGitCommands(
	state: SandboxState,
	scope: GrantScope,
	commandIds: DangerousGitCommandId[],
): Promise<void> {
	const uniqueCommandIds = uniqueStrings(commandIds);
	if (uniqueCommandIds.length === 0) {
		return;
	}

	if (scope === "session") {
		for (const commandId of uniqueCommandIds) {
			state.sessionDangerousGitCommands.add(commandId);
		}
		return;
	}

	const filePath = scope === "project" ? getProjectConfigPath(state.cwd) : GLOBAL_CONFIG_PATH;
	await writeGrantToConfigFile(filePath, (config) => ({
		...config,
		git: {
			...(config.git ?? {}),
			allowedDangerousCommands: uniqueStrings([...(config.git?.allowedDangerousCommands ?? []), ...uniqueCommandIds]),
		},
	}));
	state.diskConfig = loadConfig(state.cwd);
}

function formatDangerousGitRules(rules: DangerousGitRule[]): string {
	return rules.map((rule) => rule.label).join(", ");
}

function getHeadlessDangerousGitReason(command: string, rules: DangerousGitRule[]): string {
	const ids = rules
		.map((rule) => `- ${rule.id} (${rule.label})`)
		.join("\n");
	return `Sandbox blocked dangerous git command (${formatDangerousGitRules(rules)}): ${command}. Blocked in headless mode — add the matching ids to git.allowedDangerousCommands in .pi/sandbox.json or ~/.pi/agent/sandbox.json:\n${ids}`;
}

function isGitHubCommandAllowed(state: SandboxState, commandId: GitHubCommandId): boolean {
	return state.sessionGitHubCommands.has(commandId) || state.diskConfig.github.allowedCommands.includes(commandId);
}

function getPendingGitHubCommandRules(state: SandboxState, command: string): GitHubCommandRule[] {
	return findGitHubCommandRules(command).filter((rule) => !isGitHubCommandAllowed(state, rule.id));
}

async function grantGitHubCommands(state: SandboxState, scope: GrantScope, commandIds: GitHubCommandId[]): Promise<void> {
	const uniqueCommandIds = uniqueStrings(commandIds);
	if (uniqueCommandIds.length === 0) {
		return;
	}

	if (scope === "session") {
		for (const commandId of uniqueCommandIds) {
			state.sessionGitHubCommands.add(commandId);
		}
		return;
	}

	const filePath = scope === "project" ? getProjectConfigPath(state.cwd) : GLOBAL_CONFIG_PATH;
	await writeGrantToConfigFile(filePath, (config) => ({
		...config,
		github: {
			...(config.github ?? {}),
			allowedCommands: uniqueStrings([...(config.github?.allowedCommands ?? []), ...uniqueCommandIds]),
		},
	}));
	state.diskConfig = loadConfig(state.cwd);
}

function formatGitHubCommandRules(rules: GitHubCommandRule[]): string {
	return rules.map((rule) => rule.label).join(", ");
}

function getHeadlessGitHubCommandReason(command: string, rules: GitHubCommandRule[]): string {
	const ids = rules
		.map((rule) => `- ${rule.id} (${rule.label})`)
		.join("\n");
	return `Sandbox blocked GitHub command (${formatGitHubCommandRules(rules)}): ${command}. Blocked in headless mode — add the matching ids to github.allowedCommands in .pi/sandbox.json or ~/.pi/agent/sandbox.json:\n${ids}`;
}

function hasPendingSshGrantBundle(bundle: PendingSshGrantBundle): boolean {
	return bundle.domains.length > 0 || bundle.readPath !== undefined || bundle.unixSocket !== undefined;
}

function describeSshGrantBundle(bundle: PendingSshGrantBundle): string[] {
	const details = bundle.domains.map((domain) => `network access to ${domain}`);
	if (bundle.readPath) {
		details.push(`read access to ${bundle.readPath.storedPath}`);
	}
	if (bundle.unixSocket) {
		details.push(`unix socket access to ${bundle.unixSocket.storedPath}`);
	}
	return details;
}

function formatSshGrantBundle(bundle: PendingSshGrantBundle): string {
	return describeSshGrantBundle(bundle).join(", ");
}

function getHeadlessSshReason(command: string, bundle: PendingSshGrantBundle): string {
	const details = describeSshGrantBundle(bundle)
		.map((detail) => `- ${detail}`)
		.join("\n");
	return `Sandbox blocked SSH access for command: ${command}. Blocked in headless mode — add the required permissions to .pi/sandbox.json or ~/.pi/agent/sandbox.json:\n${details}`;
}

async function collectPendingSshGrantBundle(
	state: SandboxState,
	cwd: string,
	capabilities: CommandCapabilities,
): Promise<PendingSshGrantBundle> {
	const bundle: PendingSshGrantBundle = { domains: [] };

	for (const domain of capabilities.sshDomains) {
		if (await isDomainAllowed(state, domain)) {
			continue;
		}
		bundle.domains.push(domain);
	}
	bundle.domains = uniqueStrings(bundle.domains);

	if (capabilities.wantsSshConfigRead) {
		const resolvedSshConfigPath = (await resolvePolicyPath(cwd, "~/.ssh")).resolvedPath;
		if (!(await isReadAllowed(state, resolvedSshConfigPath))) {
			const matchedDeny = await findMatchingEntry(cwd, state.diskConfig.filesystem.denyRead, resolvedSshConfigPath, matchesDenyPathEntry);
			const grantRoot = matchedDeny ? await resolveGrantedReadRoot(cwd, matchedDeny) : resolvedSshConfigPath;
			bundle.readPath = {
				sessionPath: grantRoot,
				storedPath: await serializePathForConfig(cwd, grantRoot),
			};
		}
	}

	if (capabilities.wantsSshAgentSocket && typeof process.env.SSH_AUTH_SOCK === "string") {
		const resolvedSocketPath = (await resolvePolicyPath(cwd, process.env.SSH_AUTH_SOCK)).resolvedPath;
		if (!(await isUnixSocketAllowed(state, resolvedSocketPath))) {
			bundle.unixSocket = {
				sessionPath: resolvedSocketPath,
				storedPath: await serializePathForConfig(cwd, resolvedSocketPath),
			};
		}
	}

	return bundle;
}

async function grantSshGrantBundle(state: SandboxState, scope: GrantScope, bundle: PendingSshGrantBundle): Promise<void> {
	if (!hasPendingSshGrantBundle(bundle)) {
		return;
	}

	if (scope === "session") {
		for (const domain of bundle.domains) {
			state.sessionDomains.add(domain);
		}
		if (bundle.readPath) {
			state.sessionReadPaths.add(bundle.readPath.sessionPath);
		}
		if (bundle.unixSocket) {
			state.sessionUnixSockets.add(bundle.unixSocket.sessionPath);
		}
		await applyRuntimeConfig(state);
		return;
	}

	const filePath = scope === "project" ? getProjectConfigPath(state.cwd) : GLOBAL_CONFIG_PATH;
	await writeGrantToConfigFile(filePath, (config) => ({
		...config,
		network: {
			...(config.network ?? {}),
			allowedDomains: uniqueStrings([...(config.network?.allowedDomains ?? []), ...bundle.domains]),
			allowUnixSockets: uniqueStrings([
				...(config.network?.allowUnixSockets ?? []),
				...(bundle.unixSocket ? [bundle.unixSocket.storedPath] : []),
			]),
		},
		filesystem: {
			...(config.filesystem ?? {}),
			allowRead: uniqueStrings([...(config.filesystem?.allowRead ?? []), ...(bundle.readPath ? [bundle.readPath.storedPath] : [])]),
		},
	}));
	state.diskConfig = loadConfig(state.cwd);
	await applyRuntimeConfig(state);
}

async function grantSshGrantBundleOnce(state: SandboxState, toolCallId: string, bundle: PendingSshGrantBundle): Promise<void> {
	if (!hasPendingSshGrantBundle(bundle)) {
		return;
	}

	state.onceGrantBundlesByToolCall.set(toolCallId, {
		domains: uniqueStrings(bundle.domains),
		readPaths: bundle.readPath ? [bundle.readPath.sessionPath] : [],
		unixSockets: bundle.unixSocket ? [bundle.unixSocket.sessionPath] : [],
	});
	await applyRuntimeConfig(state);
}

async function clearOnceGrantBundle(state: SandboxState, toolCallId: string): Promise<void> {
	if (!state.onceGrantBundlesByToolCall.has(toolCallId)) {
		return;
	}

	state.onceGrantBundlesByToolCall.delete(toolCallId);
	await applyRuntimeConfig(state);
}

async function isDomainAllowed(state: SandboxState, domain: string): Promise<boolean> {
	const normalizedDomain = normalizeDomain(domain);

	for (const deniedDomain of state.diskConfig.network.deniedDomains) {
		if (matchesDomainPattern(deniedDomain, normalizedDomain)) {
			return false;
		}
	}

	for (const allowedDomain of state.sessionDomains) {
		if (matchesDomainPattern(allowedDomain, normalizedDomain)) {
			return true;
		}
	}

	for (const allowedDomain of getActiveOnceDomains(state)) {
		if (matchesDomainPattern(allowedDomain, normalizedDomain)) {
			return true;
		}
	}

	for (const allowedDomain of state.diskConfig.network.allowedDomains) {
		if (matchesDomainPattern(allowedDomain, normalizedDomain)) {
			return true;
		}
	}

	return false;
}

function isDomainHardDenied(state: SandboxState, domain: string): boolean {
	const normalizedDomain = normalizeDomain(domain);
	return state.diskConfig.network.deniedDomains.some((pattern) => matchesDomainPattern(pattern, normalizedDomain));
}

function formatNetworkTarget(domain: string, port?: number): string {
	return port === undefined ? domain : `${domain}:${port}`;
}

async function handleRuntimeNetworkGrant(
	pi: ExtensionAPI,
	state: SandboxState,
	ctx: SandboxPromptContext | undefined,
	host: string,
	port?: number,
): Promise<boolean> {
	if (!state.enabled) {
		return false;
	}

	const domain = normalizeDomain(host);
	if (isDomainHardDenied(state, domain)) {
		return false;
	}

	if (await isDomainAllowed(state, domain)) {
		return true;
	}

	if (!ctx?.hasUI) {
		return false;
	}

	const target = formatNetworkTarget(domain, port);
	const portLine = port === undefined ? "" : `\nPort:\n  ${port}\n`;
	const choice = await promptForGrant(
		pi,
		ctx,
		`🔒 Sandbox blocked network access\n\nHost:\n  ${domain}${portLine}\nAllow access to ${target}?`,
		{ includeAllowOnce: true },
	);
	if (!choice) {
		return false;
	}

	if (choice === "once") {
		notify(ctx, `Network access granted once: ${domain}`, "info");
		return true;
	}

	await enqueueStateUpdate(state, () => grantDomain(state, choice, domain));
	refreshStatus(state, ctx);
	notify(ctx, `Network access granted ${formatGrantChoice(choice)}: ${domain}`, "info");
	return true;
}

async function isUnixSocketAllowed(state: SandboxState, socketPath: string): Promise<boolean> {
	const resolvedSocketPath = (await resolvePolicyPath(state.cwd, socketPath)).resolvedPath;
	for (const grantedSocket of state.sessionUnixSockets) {
		if (isPathInside(grantedSocket, resolvedSocketPath)) {
			return true;
		}
	}

	for (const grantedSocket of getActiveOnceUnixSockets(state)) {
		if (isPathInside(grantedSocket, resolvedSocketPath)) {
			return true;
		}
	}

	for (const configuredSocket of state.diskConfig.network.allowUnixSockets ?? []) {
		if (await matchesAllowPathEntry(state.cwd, configuredSocket, resolvedSocketPath)) {
			return true;
		}
	}

	return false;
}

async function isReadAllowed(state: SandboxState, targetResolvedPath: string): Promise<boolean> {
	if (await isPathGranted(targetResolvedPath, state.sessionReadPaths)) {
		return true;
	}

	if (await isPathGranted(targetResolvedPath, getActiveOnceReadPaths(state))) {
		return true;
	}

	const configAllowRead = state.diskConfig.filesystem.allowRead;
	if ((await findMatchingEntry(state.cwd, configAllowRead, targetResolvedPath, matchesAllowPathEntry)) !== undefined) {
		return true;
	}

	const denyRead = state.diskConfig.filesystem.denyRead;
	return (await findMatchingEntry(state.cwd, denyRead, targetResolvedPath, matchesDenyPathEntry)) === undefined;
}

async function isWriteAllowed(state: SandboxState, targetResolvedPath: string): Promise<boolean> {
	if (await isPathGranted(targetResolvedPath, state.sessionWritePaths)) {
		return true;
	}

	const configAllowWrite = state.diskConfig.filesystem.allowWrite;
	return (await findMatchingEntry(state.cwd, configAllowWrite, targetResolvedPath, matchesAllowPathEntry)) !== undefined;
}

async function findWriteDenyMatch(state: SandboxState, targetResolvedPath: string): Promise<string | undefined> {
	return findMatchingEntry(state.cwd, state.diskConfig.filesystem.denyWrite, targetResolvedPath, matchesDenyPathEntry);
}

function buildSandboxSummary(state: SandboxState): string {
	return [
		`Sandbox: ${state.enabled ? "enabled" : "disabled"}${state.initialized ? "" : " (not initialized)"}`,
		"",
		`Global config: ${GLOBAL_CONFIG_PATH}`,
		`Project config: ${getProjectConfigPath(state.cwd)}`,
		"",
		"Network:",
		`  Allowed domains: ${formatList(state.diskConfig.network.allowedDomains)}`,
		`  Denied domains: ${formatList(state.diskConfig.network.deniedDomains)}`,
		`  Allowed unix sockets: ${formatList(state.diskConfig.network.allowUnixSockets ?? [])}`,
		"",
		"Filesystem:",
		`  Allow read: ${formatList(state.diskConfig.filesystem.allowRead)}`,
		`  Deny read: ${formatList(state.diskConfig.filesystem.denyRead)}`,
		`  Allow write: ${formatList(state.diskConfig.filesystem.allowWrite)}`,
		`  Deny write: ${formatList(state.diskConfig.filesystem.denyWrite)}`,
		"",
		"Git:",
		`  Allowed dangerous commands: ${formatList(describeDangerousGitCommandIds(state.diskConfig.git.allowedDangerousCommands))}`,
		"",
		"GitHub:",
		`  Allowed commands: ${formatList(describeGitHubCommandIds(state.diskConfig.github.allowedCommands))}`,
		"",
		"Session grants:",
		`  Domains: ${formatList(Array.from(state.sessionDomains))}`,
		`  Read paths: ${formatList(Array.from(state.sessionReadPaths))}`,
		`  Write paths: ${formatList(Array.from(state.sessionWritePaths))}`,
		`  Unix sockets: ${formatList(Array.from(state.sessionUnixSockets))}`,
		`  Dangerous git commands: ${formatList(describeDangerousGitCommandIds(state.sessionDangerousGitCommands))}`,
		`  GitHub commands: ${formatList(describeGitHubCommandIds(state.sessionGitHubCommands))}`,
	].join("\n");
}

export default function sandbox(pi: ExtensionAPI) {
	setCapabilityGateActive(false);

	pi.registerFlag("no-sandbox", {
		description: "Disable sandboxing and capability prompts for this session",
		type: "boolean",
		default: false,
	});

	const localCwd = process.cwd();
	const localBash = createBashTool(localCwd);
	const state: SandboxState = {
		cwd: localCwd,
		enabled: false,
		initialized: false,
		diskConfig: DEFAULT_CONFIG,
		sessionDomains: new Set(),
		sessionReadPaths: new Set(),
		sessionWritePaths: new Set(),
		sessionUnixSockets: new Set(),
		sessionDangerousGitCommands: new Set(),
		sessionGitHubCommands: new Set(),
		onceGrantBundlesByToolCall: new Map(),
		updateQueue: Promise.resolve(),
	};
	let promptContext: SandboxPromptContext | undefined;

	pi.registerTool({
		...localBash,
		label: "bash (sandboxed)",
		async execute(id, params, signal, onUpdate) {
			if (!state.enabled || !state.initialized) {
				return localBash.execute(id, params, signal, onUpdate);
			}

			const sandboxedBash = createBashTool(localCwd, {
				operations: createSandboxedBashOps(),
			});
			return sandboxedBash.execute(id, params, signal, onUpdate);
		},
	});

	pi.on("user_bash", () => {
		if (!state.enabled || !state.initialized) {
			return undefined;
		}
		return { operations: createSandboxedBashOps() };
	});

	pi.on("session_start", async (_event, ctx) => {
		promptContext = ctx;
		state.cwd = ctx.cwd;
		state.sessionDomains.clear();
		state.sessionReadPaths.clear();
		state.sessionWritePaths.clear();
		state.sessionUnixSockets.clear();
		state.sessionDangerousGitCommands.clear();
		state.sessionGitHubCommands.clear();
		state.onceGrantBundlesByToolCall.clear();
		setCapabilityGateActive(false);

		if (state.initialized) {
			try {
				await SandboxManager.reset();
			} catch {
				// Ignore reset errors before reinitializing.
			}
			state.initialized = false;
		}

		try {
			state.diskConfig = loadConfig(ctx.cwd);
		} catch (error) {
			state.enabled = false;
			refreshStatus(state, ctx);
			notify(ctx, `Sandbox configuration failed to load: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}

		if (pi.getFlag("no-sandbox") === true) {
			state.enabled = false;
			notify(ctx, "Sandbox disabled via --no-sandbox", "warning");
			refreshStatus(state, ctx);
			return;
		}

		if (!state.diskConfig.enabled) {
			state.enabled = false;
			notify(ctx, "Sandbox disabled via config", "info");
			refreshStatus(state, ctx);
			return;
		}

		const platform = process.platform;
		if (platform !== "darwin" && platform !== "linux") {
			state.enabled = false;
			notify(ctx, `Sandbox not supported on ${platform}`, "warning");
			refreshStatus(state, ctx);
			return;
		}

		try {
			await SandboxManager.initialize(await buildRuntimeConfig(state), async ({ host, port }) =>
				handleRuntimeNetworkGrant(pi, state, promptContext, host, port),
			);
			state.enabled = true;
			state.initialized = true;
			setCapabilityGateActive(true);
			refreshStatus(state, ctx);
			notify(ctx, "Sandbox initialized", "info");
		} catch (error) {
			state.enabled = false;
			state.initialized = false;
			setCapabilityGateActive(false);
			refreshStatus(state, ctx);
			notify(ctx, `Sandbox initialization failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		promptContext = undefined;
		setCapabilityGateActive(false);
		state.enabled = false;
		state.sessionDangerousGitCommands.clear();
		state.sessionGitHubCommands.clear();
		state.onceGrantBundlesByToolCall.clear();
		if (!state.initialized) {
			return;
		}
		state.initialized = false;
		try {
			await SandboxManager.reset();
		} catch {
			// Ignore cleanup errors.
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!state.onceGrantBundlesByToolCall.has(event.toolCallId)) {
			return undefined;
		}

		await enqueueStateUpdate(state, () => clearOnceGrantBundle(state, event.toolCallId));
		refreshStatus(state, ctx);
		return undefined;
	});

	pi.registerCommand("sandbox", {
		description: "Show effective sandbox config and session grants",
		handler: async (_args, ctx) => {
			state.cwd = ctx.cwd;
			try {
				state.diskConfig = loadConfig(ctx.cwd);
			} catch (error) {
				notify(ctx, `Sandbox configuration failed to load: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			notify(ctx, buildSandboxSummary(state), "info");
		},
	});

	pi.registerCommand("sandbox-control", {
		description: "Toggle sandbox on/off for the current session",
		handler: async (_args, ctx) => {
			if (state.enabled) {
				state.enabled = false;
				setCapabilityGateActive(false);
				refreshStatus(state, ctx);
				notify(ctx, "Sandbox disabled for this session — bash commands and native file tools are now unconfined", "warning");
				return;
			}

			if (!state.initialized) {
				notify(
					ctx,
					"Sandbox cannot be re-enabled — it was never successfully initialized this session",
					"error",
				);
				return;
			}

			state.enabled = true;
			setCapabilityGateActive(true);
			await enqueueStateUpdate(state, () => applyRuntimeConfig(state));
			refreshStatus(state, ctx);
			notify(ctx, "Sandbox re-enabled", "info");
		},
	});

	pi.registerCommand("sandbox-allow", {
		description: "Grant write access to a path for this session: /sandbox-allow <path>",
		handler: async (args, ctx) => {
			if (!state.enabled) {
				notify(ctx, "Sandbox is not active", "warning");
				return;
			}

			const rawPath = args?.trim();
			if (!rawPath) {
				notify(ctx, "Usage: /sandbox-allow <path>", "warning");
				return;
			}

			let resolvedPath: string;
			let storedPath: string;
			try {
				resolvedPath = (await resolvePolicyPath(ctx.cwd, rawPath)).resolvedPath;
				storedPath = await serializePathForConfig(ctx.cwd, resolvedPath);
			} catch (error) {
				notify(ctx, `Could not resolve path safely: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}

			await enqueueStateUpdate(state, () => grantWritePath(state, "session", resolvedPath));
			refreshStatus(state, ctx);
			notify(ctx, `Write access granted for this session: ${storedPath}`, "info");
		},
	});

	pi.registerTool({
		name: "sandbox_allow_path",
		label: "Request sandbox write access",
		description:
			"Request write access to a filesystem path within the sandbox. " +
			"Use this when a command needs permission to write outside the configured allowlist.",
		parameters: Type.Object({
			path: Type.String({ description: "The filesystem path to allow write access to" }),
			reason: Type.String({ description: "Why write access is needed" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!state.enabled) {
				return { content: [{ type: "text", text: "Sandbox is not active; no permission change is needed." }] };
			}

			let resolvedPath: string;
			let displayPath: string;
			let storedPath: string;
			try {
				const { absolutePath, resolvedPath: canonicalPath } = await resolvePolicyPath(ctx.cwd, params.path);
				resolvedPath = canonicalPath;
				displayPath = formatResolvedPath(params.path, absolutePath, canonicalPath);
				storedPath = await serializePathForConfig(ctx.cwd, canonicalPath);
			} catch (error) {
				return {
					content: [{ type: "text", text: `Sandbox could not resolve the path safely: ${error instanceof Error ? error.message : String(error)}` }],
					isError: true,
				};
			}

			if (await isWriteAllowed(state, resolvedPath)) {
				return { content: [{ type: "text", text: `Write access is already allowed: ${displayPath}` }] };
			}

			const scope = await promptForGrant(
				pi,
				ctx,
				`🔒 Sandbox blocked write access\n\nTarget:\n  ${displayPath}\n\nReason:\n  ${params.reason}\n\nAllow?`,
			);
			if (!scope) {
				return { content: [{ type: "text", text: `Write access was denied: ${displayPath}` }] };
			}
			if (scope === "once") {
				return {
					content: [{ type: "text", text: "Allow once is only available when approving the blocked operation directly. Retry the original write to allow it once." }],
					isError: true,
				};
			}

			await enqueueStateUpdate(state, () => grantWritePath(state, scope, scope === "session" ? resolvedPath : storedPath));
			refreshStatus(state, ctx);
			return {
				content: [{ type: "text", text: `Write access granted for ${formatScope(scope)}: ${storedPath}` }],
			};
		},
	});

	pi.registerTool({
		name: "sandbox_allow_read_path",
		label: "Request sandbox read access",
		description:
			"Request read access to a protected filesystem path within the sandbox. " +
			"Use this when a command needs access to a denied read path such as ~/.ssh.",
		parameters: Type.Object({
			path: Type.String({ description: "The filesystem path to allow read access to" }),
			reason: Type.String({ description: "Why read access is needed" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!state.enabled) {
				return { content: [{ type: "text", text: "Sandbox is not active; no permission change is needed." }] };
			}

			let resolvedPath: string;
			let displayPath: string;
			let storedPath: string;
			try {
				const { absolutePath, resolvedPath: canonicalPath } = await resolvePolicyPath(ctx.cwd, params.path);
				resolvedPath = canonicalPath;
				displayPath = formatResolvedPath(params.path, absolutePath, canonicalPath);
				storedPath = await serializePathForConfig(ctx.cwd, canonicalPath);
			} catch (error) {
				return {
					content: [{ type: "text", text: `Sandbox could not resolve the path safely: ${error instanceof Error ? error.message : String(error)}` }],
					isError: true,
				};
			}

			if (await isReadAllowed(state, resolvedPath)) {
				return { content: [{ type: "text", text: `Read access is already allowed: ${displayPath}` }] };
			}

			const scope = await promptForGrant(
				pi,
				ctx,
				`🔒 Sandbox blocked read access\n\nTarget:\n  ${displayPath}\n\nReason:\n  ${params.reason}\n\nAllow?`,
			);
			if (!scope) {
				return { content: [{ type: "text", text: `Read access was denied: ${displayPath}` }] };
			}
			if (scope === "once") {
				return {
					content: [{ type: "text", text: "Allow once is only available when approving the blocked operation directly. Retry the original read to allow it once." }],
					isError: true,
				};
			}

			await enqueueStateUpdate(state, () => grantReadPath(state, scope, scope === "session" ? resolvedPath : storedPath));
			refreshStatus(state, ctx);
			return {
				content: [{ type: "text", text: `Read access granted for ${formatScope(scope)}: ${storedPath}` }],
			};
		},
	});

	pi.registerTool({
		name: "sandbox_allow_domain",
		label: "Request sandbox domain access",
		description: "Request network access to a domain within the sandbox.",
		parameters: Type.Object({
			domain: Type.String({ description: "The domain to allow" }),
			reason: Type.String({ description: "Why network access is needed" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!state.enabled) {
				return { content: [{ type: "text", text: "Sandbox is not active; no permission change is needed." }] };
			}

			const domain = normalizeDomain(params.domain);
			if (await isDomainAllowed(state, domain)) {
				return { content: [{ type: "text", text: `Network access is already allowed: ${domain}` }] };
			}

			if (isDomainHardDenied(state, domain)) {
				return {
					content: [{ type: "text", text: `Network access is denied by policy: ${domain}` }],
					isError: true,
				};
			}

			const scope = await promptForGrant(
				pi,
				ctx,
				`🔒 Sandbox blocked network access\n\nDomain:\n  ${domain}\n\nReason:\n  ${params.reason}\n\nAllow?`,
			);
			if (!scope) {
				return { content: [{ type: "text", text: `Network access was denied: ${domain}` }] };
			}
			if (scope === "once") {
				return {
					content: [{ type: "text", text: "Allow once is only available when approving the blocked operation directly. Retry the original network operation to allow it once." }],
					isError: true,
				};
			}

			await enqueueStateUpdate(state, () => grantDomain(state, scope, domain));
			refreshStatus(state, ctx);
			return {
				content: [{ type: "text", text: `Network access granted for ${formatScope(scope)}: ${domain}` }],
			};
		},
	});

	pi.registerTool({
		name: "sandbox_allow_unix_socket",
		label: "Request sandbox unix socket access",
		description: "Request unix socket access within the sandbox, for example SSH_AUTH_SOCK.",
		parameters: Type.Object({
			path: Type.String({ description: "The unix socket path to allow" }),
			reason: Type.String({ description: "Why socket access is needed" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!state.enabled) {
				return { content: [{ type: "text", text: "Sandbox is not active; no permission change is needed." }] };
			}

			let resolvedPath: string;
			let storedPath: string;
			try {
				resolvedPath = (await resolvePolicyPath(ctx.cwd, params.path)).resolvedPath;
				storedPath = await serializePathForConfig(ctx.cwd, resolvedPath);
			} catch (error) {
				return {
					content: [{ type: "text", text: `Sandbox could not resolve the socket safely: ${error instanceof Error ? error.message : String(error)}` }],
					isError: true,
				};
			}

			if (await isUnixSocketAllowed(state, resolvedPath)) {
				return { content: [{ type: "text", text: `Unix socket access is already allowed: ${storedPath}` }] };
			}

			const scope = await promptForGrant(
				pi,
				ctx,
				`🔒 Sandbox blocked unix socket access\n\nSocket:\n  ${storedPath}\n\nReason:\n  ${params.reason}\n\nAllow?`,
			);
			if (!scope) {
				return { content: [{ type: "text", text: `Unix socket access was denied: ${storedPath}` }] };
			}
			if (scope === "once") {
				return {
					content: [{ type: "text", text: "Allow once is only available when approving the blocked operation directly. Retry the original socket operation to allow it once." }],
					isError: true,
				};
			}

			await enqueueStateUpdate(state, () => grantUnixSocket(state, scope, scope === "session" ? resolvedPath : storedPath));
			refreshStatus(state, ctx);
			return {
				content: [{ type: "text", text: `Unix socket access granted for ${formatScope(scope)}: ${storedPath}` }],
			};
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!state.enabled) {
			return undefined;
		}

		promptContext = ctx;

		if (event.toolName === "read") {
			const rawPath = event.input.path;
			if (typeof rawPath !== "string" || rawPath.length === 0) {
				return undefined;
			}

			let absoluteTarget: string;
			let resolvedTarget: string;
			try {
				({ absolutePath: absoluteTarget, resolvedPath: resolvedTarget } = await resolvePolicyPath(ctx.cwd, rawPath));
			} catch (error) {
				return {
					block: true,
					reason:
						`Sandbox could not resolve the read target safely: ${rawPath}. ` +
						`Blocked until the path can be reviewed (${error instanceof Error ? error.message : String(error)}).`,
				};
			}

			if (await isReadAllowed(state, resolvedTarget)) {
				return undefined;
			}

			const matchedDeny = await findMatchingEntry(state.cwd, state.diskConfig.filesystem.denyRead, resolvedTarget, matchesDenyPathEntry);
			const grantRoot = matchedDeny ? await resolveGrantedReadRoot(ctx.cwd, matchedDeny) : resolvedTarget;
			const grantPath = await serializePathForConfig(ctx.cwd, grantRoot);
			const displayTarget = formatResolvedPath(rawPath, absoluteTarget, resolvedTarget);

			if (!ctx.hasUI) {
				return { block: true, reason: getHeadlessReason("read", displayTarget) };
			}

			const choice = await promptForGrant(
				pi,
				ctx,
				`🔒 Sandbox blocked read access\n\nTarget:\n  ${displayTarget}\n\nGrant read access to:\n  ${grantPath}\n\nAllow?`,
				{ includeAllowOnce: true },
			);
			if (!choice) {
				return { block: true, reason: `Blocked by user — read access denied: ${displayTarget}` };
			}

			if (choice === "once") {
				notify(ctx, `Read access granted once: ${displayTarget}`, "info");
				return undefined;
			}

			await enqueueStateUpdate(state, () => grantReadPath(state, choice, choice === "session" ? grantRoot : grantPath));
			refreshStatus(state, ctx);
			notify(ctx, `Read access granted ${formatGrantChoice(choice)}: ${grantPath}`, "info");
			return undefined;
		}

		if (event.toolName === "write" || event.toolName === "edit") {
			const rawPath = event.input.path;
			if (typeof rawPath !== "string" || rawPath.length === 0) {
				return undefined;
			}

			let absoluteTarget: string;
			let resolvedTarget: string;
			try {
				({ absolutePath: absoluteTarget, resolvedPath: resolvedTarget } = await resolvePolicyPath(ctx.cwd, rawPath));
			} catch (error) {
				return {
					block: true,
					reason:
						`Sandbox could not resolve the target path safely: ${rawPath}. ` +
						`Blocked until the path can be reviewed (${error instanceof Error ? error.message : String(error)}).`,
				};
			}

			const denyMatch = await findWriteDenyMatch(state, resolvedTarget);
			if (denyMatch) {
				return {
					block: true,
					reason: `Sandbox policy forbids writes to ${formatResolvedPath(rawPath, absoluteTarget, resolvedTarget)} (matched denyWrite: ${denyMatch}).`,
				};
			}

			if (await isWriteAllowed(state, resolvedTarget)) {
				return undefined;
			}

			const displayTarget = formatResolvedPath(rawPath, absoluteTarget, resolvedTarget);
			const storedPath = await serializePathForConfig(ctx.cwd, resolvedTarget);

			if (!ctx.hasUI) {
				return { block: true, reason: getHeadlessReason("write", displayTarget) };
			}

			const choice = await promptForGrant(
				pi,
				ctx,
				`🔒 Sandbox blocked write access\n\nTarget:\n  ${displayTarget}\n\nAllow?`,
				{ includeAllowOnce: true },
			);
			if (!choice) {
				return { block: true, reason: `Blocked by user — write access denied: ${displayTarget}` };
			}

			if (choice === "once") {
				notify(ctx, `Write access granted once: ${displayTarget}`, "info");
				return undefined;
			}

			await enqueueStateUpdate(state, () => grantWritePath(state, choice, choice === "session" ? resolvedTarget : storedPath));
			refreshStatus(state, ctx);
			notify(ctx, `Write access granted ${formatGrantChoice(choice)}: ${storedPath}`, "info");
			return undefined;
		}

		if (event.toolName !== "bash") {
			return undefined;
		}

		const command = typeof event.input.command === "string" ? event.input.command : "";
		if (command.length === 0) {
			return undefined;
		}

		const pendingDangerousGitRules = getPendingDangerousGitRules(state, command);
		if (pendingDangerousGitRules.length > 0) {
			if (!ctx.hasUI) {
				return { block: true, reason: getHeadlessDangerousGitReason(command, pendingDangerousGitRules) };
			}

			const choice = await promptForGrant(
				pi,
				ctx,
				`⚠️ Sandbox blocked dangerous git command (${formatDangerousGitRules(pendingDangerousGitRules)})\n\nCommand:\n  ${command}\n\nAllow?`,
				{ includeAllowOnce: true },
			);
			if (!choice) {
				return {
					block: true,
					reason: `Blocked by user — dangerous git command denied (${formatDangerousGitRules(pendingDangerousGitRules)})`,
				};
			}

			if (choice === "once") {
				notify(ctx, `Dangerous git command granted once: ${formatDangerousGitRules(pendingDangerousGitRules)}`, "info");
			} else {
				await enqueueStateUpdate(state, () =>
					grantDangerousGitCommands(
						state,
						choice,
						pendingDangerousGitRules.map((rule) => rule.id),
					),
				);
				refreshStatus(state, ctx);
				notify(
					ctx,
					`Dangerous git command granted ${formatGrantChoice(choice)}: ${formatDangerousGitRules(pendingDangerousGitRules)}`,
					"info",
				);
			}
		}

		const pendingGitHubCommandRules = getPendingGitHubCommandRules(state, command);
		if (pendingGitHubCommandRules.length > 0) {
			if (!ctx.hasUI) {
				return { block: true, reason: getHeadlessGitHubCommandReason(command, pendingGitHubCommandRules) };
			}

			const choice = await promptForGrant(
				pi,
				ctx,
				`⚠️ Sandbox blocked GitHub command (${formatGitHubCommandRules(pendingGitHubCommandRules)})\n\nCommand:\n  ${command}\n\nAllow?`,
				{ includeAllowOnce: true },
			);
			if (!choice) {
				return {
					block: true,
					reason: `Blocked by user — GitHub command denied (${formatGitHubCommandRules(pendingGitHubCommandRules)})`,
				};
			}

			if (choice === "once") {
				notify(ctx, `GitHub command granted once: ${formatGitHubCommandRules(pendingGitHubCommandRules)}`, "info");
			} else {
				await enqueueStateUpdate(state, () =>
					grantGitHubCommands(
						state,
						choice,
						pendingGitHubCommandRules.map((rule) => rule.id),
					),
				);
				refreshStatus(state, ctx);
				notify(
					ctx,
					`GitHub command granted ${formatGrantChoice(choice)}: ${formatGitHubCommandRules(pendingGitHubCommandRules)}`,
					"info",
				);
			}
		}

		const capabilities = extractCommandCapabilities(command);

		for (const domain of capabilities.sshDomains) {
			if (isDomainHardDenied(state, domain)) {
				return { block: true, reason: `Sandbox policy forbids SSH access to ${domain} (matched deniedDomains).` };
			}
		}

		const sshGrantBundle = await collectPendingSshGrantBundle(state, ctx.cwd, capabilities);
		if (hasPendingSshGrantBundle(sshGrantBundle)) {
			if (!ctx.hasUI) {
				return { block: true, reason: getHeadlessSshReason(command, sshGrantBundle) };
			}

			const requestedAccess = describeSshGrantBundle(sshGrantBundle)
				.map((detail) => `  • ${detail}`)
				.join("\n");
			const choice = await promptForGrant(
				pi,
				ctx,
				`🔒 Sandbox blocked SSH access\n\nCommand:\n  ${command}\n\nThis command needs:\n${requestedAccess}\n\nAllow all of the above?`,
				{ includeAllowOnce: true },
			);
			if (!choice) {
				return { block: true, reason: `Blocked by user — SSH access denied: ${formatSshGrantBundle(sshGrantBundle)}` };
			}

			if (choice === "once") {
				await enqueueStateUpdate(state, () => grantSshGrantBundleOnce(state, event.toolCallId, sshGrantBundle));
				refreshStatus(state, ctx);
				notify(ctx, `SSH access granted once: ${formatSshGrantBundle(sshGrantBundle)}`, "info");
				return undefined;
			}

			await enqueueStateUpdate(state, () => grantSshGrantBundle(state, choice, sshGrantBundle));
			refreshStatus(state, ctx);
			notify(ctx, `SSH access granted ${formatGrantChoice(choice)}: ${formatSshGrantBundle(sshGrantBundle)}`, "info");
		}

		return undefined;
	});
}
