/**
 * Same-session dynamic subagents for Pi + AgentSH.
 *
 * Spawns raw descendant `pi` processes in JSON print mode. Under AgentSH the
 * children inherit the parent process sandbox/session; this extension must not
 * invoke pi-auto, pi-supervised, agentsh wrap, or create nested AgentSH sessions.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentToolResult, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getAgentDir, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  agentSHRuntimeDisposition,
  classifyAgentSHStartup,
  type AgentSHRuntimeState,
} from "../shared/agentsh-mode.js";
import {
  currentSubagentPermissionAuthority,
  currentSubagentPermissionSelection,
  SUBAGENT_PERMISSION_BASH_TOOL,
  SUBAGENT_PERMISSION_NATIVE_TOOLS,
  SUBAGENT_PERMISSION_SOCKET_ENV,
  SUBAGENT_PERMISSION_TOKEN_ENV,
  type SubagentPermissionAuthority,
} from "../shared/subagent-permission.js";
import { adaptiveDispositionError, nativeSubagentRequestSupported, selectSubagentBackend, type AdaptiveSubagentBridge } from "./backend.js";
import {
  BACKGROUND_SUBAGENT_ID_PATTERN,
  MAX_BACKGROUND_SUBAGENTS,
  backgroundSubagentLine,
  isBackgroundSubagentActive,
  sharedBackgroundSubagentManager,
  type BackgroundSubagentRecord,
} from "./background.js";
import { DetachableForegroundExecution } from "./foreground-handoff.js";
import { formatParallelResultContent } from "./parallel-result.js";
import { NativeSubagentPermissionRelay } from "./permission-relay.js";
import { MAX_SUBAGENT_RESULT_PAGE_BYTES, attachRetainedSubagentReports, extractRetainedSubagentReports } from "./result-artifact.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const MAX_TEXT_PREVIEW_BYTES = 50 * 1024;
const CONFIG_FILES = ["settings.json", "models.json", "auth.json", "oauth.json", "AGENTS.md"];
// Resolve once before the model can mutate replaceable Home Manager symlinks.
const LOADED_SUBAGENT_MODULE_PATH = fs.realpathSync(fileURLToPath(import.meta.url));
const INTERNAL_MANAGED_EXECUTION = Symbol("subagent-internal-managed-execution");

type Mode = "single" | "parallel" | "chain";

type SubagentSpec = {
  task: string;
  systemPrompt?: string;
  model?: string;
  tools?: string[];
  cwd?: string;
};

type UsageStats = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
};

type StopReason = "completed" | "error" | "aborted" | "timeout" | string;

type SingleResult = {
  label: string;
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  tools?: string[];
  systemPrompt?: string;
  cwd?: string;
  stopReason?: StopReason;
  errorMessage?: string;
  step?: number;
  command?: string;
  args?: string[];
  childAgentDir?: string;
  warning?: string;
  lastEvent?: unknown;
  lastToolCall?: {
    name: string;
    args: Record<string, unknown>;
  };
  lastToolResult?: string;
};

type SubagentDetails = {
  backend?: "native" | "agentsh";
  failed?: boolean;
  mode: Mode;
  results: SingleResult[];
};

type BackgroundSubagentDetails = {
  background_subagent: true;
  operation: "start" | "list" | "status" | "output" | "wait" | "result" | "cancel";
  job_id?: string;
  status?: BackgroundSubagentRecord["status"];
  backend?: "native" | "agentsh";
  failed?: boolean;
  timed_out?: boolean;
  child?: number;
  offset?: number;
  next_offset?: number;
  bytes?: number;
  total_bytes?: number;
  source_total_bytes?: number;
  complete?: boolean;
  sha256?: string;
  result_children?: Array<{ child: number; label: string; bytes: number; total_bytes: number; complete: boolean; sha256: string }>;
};

type ActiveForegroundSubagent = {
  toolCallId: string;
  sessionId: string;
  backend: "native" | "agentsh";
  mode: Mode;
  summary: string;
  execution: DetachableForegroundExecution<any, any, BackgroundSubagentRecord>;
  detach(): Promise<BackgroundSubagentRecord | undefined>;
};

type AgentSHBridge = AdaptiveSubagentBridge & {
  subagentAdapter?: {
    execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: ((partial: any) => void) | undefined, ctx: any): Promise<any>;
    detailsFailed(details: unknown): boolean;
    renderCall(args: any, theme: any): any;
    renderResult(result: any, options: any, theme: any): any;
  };
};

function agentSHBridge(): AgentSHBridge | undefined {
  return (globalThis as any).__AGENTSH_PI__ as AgentSHBridge | undefined;
}

function bridgeSupervisorState(bridge: AgentSHBridge | undefined): AgentSHRuntimeState | undefined {
  try {
    return bridge && typeof bridge.getSupervisorState !== "function"
      ? { configured: true, active: false }
      : bridge?.getSupervisorState?.();
  } catch {
    return { configured: true, active: false };
  }
}

function withBackend(details: unknown, backend: "native" | "agentsh", failed?: boolean) {
  const source = details && typeof details === "object" && !Array.isArray(details) ? details as Record<string, unknown> : {};
  return { ...source, backend, ...(failed === undefined ? {} : { failed }) };
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };
type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

function usageZero(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(usage: UsageStats | Omit<UsageStats, "contextTokens">, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  const contextTokens = "contextTokens" in usage ? usage.contextTokens : 0;
  if (contextTokens && contextTokens > 0) parts.push(`ctx:${formatTokens(contextTokens)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

function truncateByBytes(text: string, maxBytes = MAX_TEXT_PREVIEW_BYTES): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return text;
  const suffix = Buffer.from(`\n\n… truncated preview at ${formatTokens(maxBytes)}B (${formatTokens(bytes.byteLength)}B total)`, "utf8");
  let prefix = bytes.subarray(0, Math.max(0, maxBytes - suffix.byteLength));
  while (prefix.length > 0) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(prefix);
      break;
    } catch {
      prefix = prefix.subarray(0, -1);
    }
  }
  return Buffer.concat([prefix, suffix]).subarray(0, maxBytes).toString("utf8");
}

function formatToolCall(toolName: string, args: Record<string, unknown>, themeFg: (color: any, text: string) => string): string {
  const shortenPath = (p: string) => {
    const home = os.homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };

  switch (toolName) {
    case "bash": {
      const command = (args.command as string) || "...";
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
    }
    case "read": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      let text = themeFg("accent", shortenPath(rawPath));
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : "";
        text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
      }
      return themeFg("muted", "read ") + text;
    }
    case "write": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const content = (args.content || "") as string;
      const lines = content.split("\n").length;
      let text = themeFg("muted", "write ") + themeFg("accent", shortenPath(rawPath));
      if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
      return text;
    }
    case "edit": {
      const rawPath = (args.file_path || args.path || "...") as string;
      return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
    }
    case "ls": {
      const rawPath = (args.path || ".") as string;
      return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
    }
    case "find": {
      const pattern = (args.pattern || "*") as string;
      const rawPath = (args.path || ".") as string;
      return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
    }
    case "grep": {
      const pattern = (args.pattern || "") as string;
      const rawPath = (args.path || ".") as string;
      return themeFg("muted", "grep ") + themeFg("accent", `/${pattern}/`) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
    }
    default: {
      const argsStr = JSON.stringify(args);
      const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
      return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
    }
  }
}

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

function getLastAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const part = msg.content[j];
      if (part.type === "text" && part.text.trim()) return part.text;
    }
  }
  return "";
}

function getToolResultText(value: any): string {
  const content = Array.isArray(value?.content) ? value.content : Array.isArray(value) ? value : undefined;
  if (!content) return typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
  return content
    .map((part: any) => {
      if (part?.type === "text") return String(part.text ?? "");
      if (part?.type === "image") return `[image: ${part.mimeType ?? "unknown"}]`;
      return JSON.stringify(part);
    })
    .filter(Boolean)
    .join("\n");
}

function stderrTail(stderr = "", maxLines = 8): string {
  return stderr.trim().split("\n").filter(Boolean).slice(-maxLines).join("\n");
}

function resultStatus(result: SingleResult): string {
  if (result.exitCode === -1) return "running";
  if (result.stopReason === "aborted") return "aborted";
  if (result.stopReason === "timeout") return "timed out";
  if (isFailure(result)) return "failed";
  return "completed";
}

function compactResultSummary(result: SingleResult): string {
  const lines: string[] = [];
  const status = resultStatus(result);
  lines.push(`Subagent ${status}.`);
  lines.push(`Task: ${result.task}`);
  if (result.model) lines.push(`Model: ${result.model}`);
  if (result.tools?.length) lines.push(`Tools: ${result.tools.join(", ")}`);
  const lastAssistant = getLastAssistantText(result.messages).trim();
  if (lastAssistant) lines.push(`Last assistant text:\n${truncateByBytes(lastAssistant).split("\n").slice(-8).join("\n")}`);
  if (result.lastToolCall) {
    lines.push(`Last tool call: ${result.lastToolCall.name} ${JSON.stringify(result.lastToolCall.args)}`);
  }
  if (result.lastToolResult) {
    lines.push(`Last tool result:\n${truncateByBytes(result.lastToolResult).split("\n").slice(-6).join("\n")}`);
  }
  const tail = stderrTail(result.stderr);
  if (tail) lines.push(`stderr:\n${tail}`);
  if (result.errorMessage) lines.push(`Error: ${result.errorMessage}`);
  lines.push(`Exit: ${result.exitCode}${result.stopReason ? ` (${result.stopReason})` : ""}`);
  return truncateByBytes(lines.join("\n"));
}

function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const part of msg.content) {
      if (part.type === "text") items.push({ type: "text", text: part.text });
      else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
    }
  }
  return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

async function writePromptToTempFile(label: string, prompt: string): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-prompt-"));
  const safeName = label.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  await fs.promises.chmod(filePath, 0o600).catch(() => undefined);
  return { dir: tmpDir, filePath };
}

function pathOnPath(command: string): string | undefined {
  if (command.includes(path.sep)) return fs.existsSync(command) ? command : undefined;
  const pathEnv = process.env.PATH ?? "";
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, `${command}${ext}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // continue
      }
    }
  }
  return undefined;
}

function installedFinalizerEntrypoint(requireTrusted = false): string | undefined {
  const modulePath = fileURLToPath(import.meta.url);
  const directory = path.dirname(requireTrusted ? LOADED_SUBAGENT_MODULE_PATH : modulePath);
  for (const candidate of [
    path.resolve(directory, "../subagent-finalizer/index.ts"),
    path.resolve(directory, "../subagent-finalizer/index.js"),
  ]) {
    if (requireTrusted) {
      const trusted = trustedNixStoreFile(candidate);
      if (trusted) return trusted;
    } else if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function trustedNixStoreFile(candidate: string, executable = false): string | undefined {
  try {
    const resolved = fs.realpathSync(candidate);
    const info = fs.statSync(resolved);
    if (!resolved.startsWith("/nix/store/") || !info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) return undefined;
    if (executable) fs.accessSync(resolved, fs.constants.X_OK);
    return resolved;
  } catch {
    return undefined;
  }
}

function installedPermissionProxyEntrypoint(): string | undefined {
  // Anchor the proxy to the already-loaded immutable source tree. Do not
  // follow a separately replaceable Home Manager sibling symlink.
  const directory = path.dirname(LOADED_SUBAGENT_MODULE_PATH);
  for (const candidate of [
    path.resolve(directory, "permission-proxy.ts"),
    path.resolve(directory, "permission-proxy.js"),
  ]) {
    const trusted = trustedNixStoreFile(candidate);
    if (trusted) return trusted;
  }
  return undefined;
}

function resolvePiInvocation(args: string[], requireRaw = false): { command: string; args: string[]; warning?: string } {
  if (requireRaw) {
    const trustedExecutable = trustedNixStoreFile("/proc/self/exe", true);
    const execName = trustedExecutable ? path.basename(trustedExecutable).toLowerCase() : "";
    if (!trustedExecutable || /^(node|bun)(\.exe)?$/.test(execName)) {
      throw new Error("Guarded native subagents require the current Pi process to be an immutable Nix-store executable");
    }
    return { command: trustedExecutable, args };
  }

  const configured = process.env.PI_SUBAGENT_BIN;
  if (configured) return { command: configured, args };

  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime && fs.existsSync(process.execPath)) {
    return { command: process.execPath, args };
  }

  const unsafe = pathOnPath("pi-unsafe");
  if (unsafe) return { command: unsafe, args };

  const rawPi = pathOnPath("pi") ?? "pi";
  return {
    command: rawPi,
    args,
    warning:
      "PI_SUBAGENT_BIN is not set and pi-unsafe was not found; falling back to `pi`. In wrapped deployments this may accidentally invoke a wrapper/nested AgentSH session.",
  };
}

async function prepareChildAgentDir(subagentId: string): Promise<string> {
  const parentAgentDir = getAgentDir();
  const childAgentDir = path.join(parentAgentDir, "subagents", subagentId, "agent");
  const childSessionDir = path.join(childAgentDir, "sessions");
  await fs.promises.mkdir(childSessionDir, { recursive: true, mode: 0o700 });

  for (const name of CONFIG_FILES) {
    const src = path.join(parentAgentDir, name);
    const dst = path.join(childAgentDir, name);
    try {
      const stat = await fs.promises.stat(src);
      if (!stat.isFile()) continue;
      await fs.promises.copyFile(src, dst);
      await fs.promises.chmod(dst, stat.mode & 0o777).catch(() => undefined);
    } catch {
      // Missing config/auth files are fine.
    }
  }

  return childAgentDir;
}

function makeSubagentId(label: string): string {
  const safe = label.replace(/[^\w.-]+/g, "_").slice(0, 40) || "subagent";
  return `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 10)}-${safe}`;
}

function killProcessTree(proc: ChildProcessWithoutNullStreams): void {
  if (proc.pid === undefined) return;
  try {
    if (process.platform !== "win32") process.kill(-proc.pid, "SIGTERM");
    else proc.kill("SIGTERM");
  } catch {
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  setTimeout(() => {
    try {
      // Do not signal a process-group ID after Node has reaped the original
      // leader; that numeric ID may already belong to an unrelated process.
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      if (process.platform !== "win32") process.kill(-proc.pid!, "SIGKILL");
      else proc.kill("SIGKILL");
    } catch {
      // already exited
    }
  }, 5000).unref?.();
}

function guardedNativeTools(requested: string[] | undefined): string[] {
  const tools = requested?.length ? requested : [...SUBAGENT_PERMISSION_NATIVE_TOOLS];
  if (new Set(tools).size !== tools.length
    || tools.some((tool) => !SUBAGENT_PERMISSION_NATIVE_TOOLS.includes(tool as typeof SUBAGENT_PERMISSION_NATIVE_TOOLS[number]))) {
    throw new Error(`Guarded native subagents support only these explicitly loaded tools: ${SUBAGENT_PERMISSION_NATIVE_TOOLS.join(", ")}`);
  }
  return [...tools];
}

async function runSingleSubagent(
  defaultCwd: string,
  spec: SubagentSpec,
  label: string,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
  permissionAuthority: SubagentPermissionAuthority | undefined,
): Promise<SingleResult> {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  const permissionTools = permissionAuthority ? guardedNativeTools(spec.tools) : undefined;
  if (permissionAuthority) {
    const permissionProxyEntrypoint = installedPermissionProxyEntrypoint();
    if (!permissionAuthority.active) throw new Error("Parent AgentSH Permission Gate is unavailable; refusing native subagent launch");
    if (!permissionProxyEntrypoint) throw new Error("Native subagent Permission Gate proxy is not installed; refusing native subagent launch");
    args.push("--no-extensions", "--extension", permissionProxyEntrypoint);
  }
  const finalizerEntrypoint = installedFinalizerEntrypoint(Boolean(permissionAuthority));
  if (finalizerEntrypoint) args.push("--extension", finalizerEntrypoint);
  if (spec.model) args.push("--model", spec.model);
  if (permissionTools) {
    // A distinct name prevents a missing/broken proxy from falling back to the
    // built-in Bash implementation under Pi's hard CLI tool allowlist.
    args.push("--tools", permissionTools.map((tool) => tool === "bash" ? SUBAGENT_PERMISSION_BASH_TOOL : tool).join(","));
  } else if (spec.tools?.length) {
    args.push("--tools", spec.tools.join(","));
  }

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;
  let permissionRelay: NativeSubagentPermissionRelay | undefined;
  let permissionRelayFailure: Error | undefined;
  let launchCwd: string | undefined;
  const subagentId = makeSubagentId(label);
  let childAgentDir: string | undefined;
  let childSessionDir: string | undefined;

  const currentResult: SingleResult = {
    label,
    task: spec.task,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: usageZero(),
    model: spec.model,
    tools: spec.tools,
    systemPrompt: spec.systemPrompt,
    cwd: spec.cwd,
    step,
  };

  const emitUpdate = () => {
    onUpdate?.({
      content: [{ type: "text", text: truncateByBytes(getFinalOutput(currentResult.messages) || "(running...)") }],
      details: makeDetails([currentResult]),
    });
  };

  if (signal?.aborted) {
    currentResult.exitCode = 130;
    currentResult.stopReason = "aborted";
    currentResult.errorMessage = "Subagent aborted by user before launch.";
    return currentResult;
  }

  try {
    const requestedCwd = path.resolve(spec.cwd ?? defaultCwd);
    launchCwd = await fs.promises.realpath(requestedCwd);
    const cwdInfo = await fs.promises.stat(launchCwd);
    if (!cwdInfo.isDirectory()) throw new Error(`Native subagent cwd is not a directory: ${requestedCwd}`);
    childAgentDir = await prepareChildAgentDir(subagentId);
    childSessionDir = path.join(childAgentDir, "sessions");
    currentResult.childAgentDir = childAgentDir;

    if (permissionAuthority) {
      permissionRelay = await NativeSubagentPermissionRelay.create({
        authority: permissionAuthority,
        subagentId,
        label,
        task: spec.task,
        cwd: launchCwd,
        tools: permissionTools!,
        signal,
      });
    }

    if (spec.systemPrompt?.trim()) {
      const tmp = await writePromptToTempFile(label, spec.systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
      args.push("--append-system-prompt", tmpPromptPath);
    }

    args.push(permissionTools?.includes("bash")
      ? `Task: ${spec.task}\n\nUse the ${SUBAGENT_PERMISSION_BASH_TOOL} tool for every Bash or shell command.`
      : `Task: ${spec.task}`);
    if (signal?.aborted) {
      currentResult.exitCode = 130;
      currentResult.stopReason = "aborted";
      currentResult.errorMessage = "Subagent aborted by user before launch.";
      return currentResult;
    }

    const invocation = resolvePiInvocation(args, Boolean(permissionAuthority));
    currentResult.command = invocation.command;
    currentResult.args = invocation.args;
    currentResult.warning = invocation.warning;
    if (invocation.warning) currentResult.stderr += `Warning: ${invocation.warning}\n`;

    let wasAborted = false;
    const exitCode = await new Promise<number>((resolve) => {
      if (signal?.aborted) {
        wasAborted = true;
        resolve(130);
        return;
      }
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PI_CODING_AGENT_DIR: childAgentDir,
        PI_CODING_AGENT_SESSION_DIR: childSessionDir,
        PI_SUBAGENT_ID: subagentId,
      };
      delete env[SUBAGENT_PERMISSION_SOCKET_ENV];
      delete env[SUBAGENT_PERMISSION_TOKEN_ENV];
      if (permissionRelay) Object.assign(env, permissionRelay.environment);
      const proc = spawn(invocation.command, invocation.args, {
        cwd: launchCwd,
        env,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "";
      let settled = false;
      permissionRelay?.bindChild(proc.pid);
      if (permissionRelay) {
        void permissionRelay.failure.catch((error) => {
          if (settled) return;
          permissionRelayFailure = error instanceof Error ? error : new Error(String(error));
          currentResult.errorMessage = `Native subagent Permission Gate failed closed: ${permissionRelayFailure.message}`;
          currentResult.stderr += `${currentResult.errorMessage}\n`;
          killProcessTree(proc);
        });
      }
      let activeMessageIndex: number | undefined;

      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        resolve(code);
      };

      const rememberToolCallFromMessage = (msg: Message) => {
        if (msg.role !== "assistant") return;
        for (const part of msg.content) {
          if (part.type === "toolCall") currentResult.lastToolCall = { name: part.name, args: part.arguments };
        }
      };

      const rememberFinalAssistantMetadata = (msg: Message) => {
        if (msg.role !== "assistant") return;
        currentResult.usage.turns++;
        const usage = (msg as any).usage;
        if (usage) {
          currentResult.usage.input += usage.input || 0;
          currentResult.usage.output += usage.output || 0;
          currentResult.usage.cacheRead += usage.cacheRead || 0;
          currentResult.usage.cacheWrite += usage.cacheWrite || 0;
          currentResult.usage.cost += usage.cost?.total || 0;
          currentResult.usage.contextTokens = usage.totalTokens || 0;
        }
        if (!currentResult.model && (msg as any).model) currentResult.model = (msg as any).model;
        if ((msg as any).stopReason) currentResult.stopReason = (msg as any).stopReason;
        if ((msg as any).errorMessage) currentResult.errorMessage = (msg as any).errorMessage;
      };

      const upsertActiveMessage = (msg: Message, final: boolean) => {
        rememberToolCallFromMessage(msg);
        if (msg.role === "toolResult") currentResult.lastToolResult = getToolResultText(msg.content);

        if (activeMessageIndex !== undefined && currentResult.messages[activeMessageIndex]) {
          currentResult.messages[activeMessageIndex] = msg;
        } else {
          currentResult.messages.push(msg);
          activeMessageIndex = currentResult.messages.length - 1;
        }

        if (final) {
          rememberFinalAssistantMetadata(msg);
          activeMessageIndex = undefined;
        }
      };

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          currentResult.stderr += `Non-JSON stdout: ${line}\n`;
          return;
        }

        currentResult.lastEvent = event;

        if (event.type === "message_start" && event.message) {
          upsertActiveMessage(event.message as Message, false);
          emitUpdate();
          return;
        }

        if (event.type === "message_update" && event.message) {
          upsertActiveMessage(event.message as Message, false);
          emitUpdate();
          return;
        }

        if (event.type === "message_end" && event.message) {
          upsertActiveMessage(event.message as Message, true);
          emitUpdate();
          return;
        }

        if (event.type === "tool_execution_start") {
          currentResult.lastToolCall = { name: String(event.toolName ?? "unknown"), args: event.args ?? {} };
          emitUpdate();
          return;
        }

        if (event.type === "tool_execution_update" && event.partialResult) {
          const text = getToolResultText(event.partialResult);
          if (text) currentResult.lastToolResult = text;
          emitUpdate();
          return;
        }

        if (event.type === "tool_execution_end") {
          const toolName = String(event.toolName ?? currentResult.lastToolCall?.name ?? "unknown");
          currentResult.lastToolCall = {
            name: toolName,
            args: event.args ?? (currentResult.lastToolCall?.name === toolName ? currentResult.lastToolCall.args : {}),
          };
          const text = getToolResultText(event.result);
          if (text) currentResult.lastToolResult = text;
          emitUpdate();
          return;
        }

        // Compatibility with older/alternate JSON event names.
        if (event.type === "tool_result_end" && event.message) {
          upsertActiveMessage(event.message as Message, true);
          emitUpdate();
        }
      };

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data) => {
        currentResult.stderr += data.toString();
      });

      proc.on("close", (code, closeSignal) => {
        void (async () => {
          if (buffer.trim()) processLine(buffer);
          if (abortHandler && signal) signal.removeEventListener("abort", abortHandler);
          let exitCode = code !== null && code !== undefined
            ? code
            : closeSignal === "SIGTERM"
              ? 143
              : closeSignal === "SIGKILL"
                ? 137
                : closeSignal
                  ? 1
                  : 0;
          if (permissionRelay && exitCode === 0 && !wasAborted) {
            try {
              await permissionRelay.waitForGracefulShutdown();
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              currentResult.stderr += `${message}\n`;
              currentResult.stopReason = "error";
              currentResult.errorMessage = message;
              exitCode = 1;
            }
          }
          finish(exitCode);
          permissionRelay?.dispose();
        })();
      });

      proc.on("error", (error) => {
        permissionRelay?.close(error instanceof Error ? error : new Error(String(error)));
        const message = error instanceof Error ? error.message : String(error);
        currentResult.stderr += `${message}\n`;
        currentResult.stopReason = wasAborted ? "aborted" : "error";
        currentResult.errorMessage = wasAborted ? "Subagent aborted by user." : message;
        if (abortHandler && signal) signal.removeEventListener("abort", abortHandler);
        finish(wasAborted ? 130 : 1);
      });

      const abortHandler = () => {
        wasAborted = true;
        currentResult.stopReason = "aborted";
        currentResult.errorMessage = "Subagent aborted by user.";
        emitUpdate();
        killProcessTree(proc);
      };
      if (signal?.aborted) abortHandler();
      else signal?.addEventListener("abort", abortHandler, { once: true });
    });

    if (permissionRelay) {
      try {
        await permissionRelay.ready;
      } catch (error) {
        permissionRelayFailure ??= error instanceof Error ? error : new Error(String(error));
      }
    }
    currentResult.exitCode = wasAborted ? exitCode || 130 : exitCode;
    if (permissionRelayFailure) {
      currentResult.exitCode = currentResult.exitCode || 1;
      currentResult.stopReason = "error";
      currentResult.errorMessage = currentResult.errorMessage || `Native subagent Permission Gate failed closed: ${permissionRelayFailure.message}`;
    }
    if (wasAborted) {
      currentResult.stopReason = "aborted";
      currentResult.errorMessage = currentResult.errorMessage || "Subagent aborted by user.";
    } else if (currentResult.exitCode !== 0) {
      currentResult.stopReason = currentResult.stopReason === "aborted" ? "aborted" : "error";
      currentResult.errorMessage = currentResult.errorMessage || `Subagent exited with code ${currentResult.exitCode}.`;
    } else if (!currentResult.stopReason || currentResult.stopReason === "stop") {
      currentResult.stopReason = "completed";
    }
    return currentResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    currentResult.exitCode = signal?.aborted ? 130 : 1;
    currentResult.stopReason = signal?.aborted ? "aborted" : "error";
    currentResult.errorMessage = signal?.aborted ? "Subagent aborted by user." : message;
    currentResult.stderr += `${message}\n`;
    return currentResult;
  } finally {
    permissionRelay?.dispose();
    if (tmpPromptPath) await fs.promises.unlink(tmpPromptPath).catch(() => undefined);
    if (tmpPromptDir) await fs.promises.rm(tmpPromptDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function normalizeStringArray(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  return values.map((value) => String(value).trim()).filter(Boolean);
}

function specFromParams(params: any): SubagentSpec {
  return {
    task: String(params.task ?? ""),
    systemPrompt: typeof params.systemPrompt === "string" ? params.systemPrompt : undefined,
    model: typeof params.model === "string" ? params.model : undefined,
    tools: normalizeStringArray(params.tools),
    cwd: typeof params.cwd === "string" ? params.cwd : undefined,
  };
}

function isFailure(result: SingleResult): boolean {
  return (result.exitCode !== -1 && result.exitCode !== 0)
    || result.stopReason === "error"
    || result.stopReason === "aborted"
    || result.stopReason === "timeout";
}

function resultErrorText(result: SingleResult): string {
  if (isFailure(result)) return compactResultSummary(result);
  return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
}

function agentResultText(result: any): string {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content.filter((part: any) => part?.type === "text").map((part: any) => String(part.text ?? "")).join("\n");
  return truncateByBytes(text || "(no output)");
}

function backgroundOutcome(result: any) {
  const preview = agentResultText(result)
    .split("\n")
    .filter((line) => !line.startsWith("Full subagent result [") && !line.startsWith("Subagent result artifact unavailable ["))
    .join("\n")
    .trim();
  return {
    text: preview || "(no output)",
    failed: result?.isError === true || result?.details?.failed === true,
    reports: extractRetainedSubagentReports(result),
  };
}

function delegationFormCount(params: any): number {
  return Number(typeof params.task === "string" && params.task.trim().length > 0)
    + Number(Array.isArray(params.tasks) && params.tasks.length > 0)
    + Number(Array.isArray(params.chain) && params.chain.length > 0);
}

function isDetachableForegroundRequest(params: any): boolean {
  return params?.background !== true
    && params?.operation === undefined
    && params?.action === undefined
    && delegationFormCount(params) === 1;
}

function requestMode(params: any): Mode {
  return Array.isArray(params.chain) && params.chain.length > 0 ? "chain"
    : Array.isArray(params.tasks) && params.tasks.length > 0 ? "parallel"
      : "single";
}

function requestSummary(params: any): string {
  if (typeof params.task === "string") return truncateByBytes(params.task, 500).replace(/\s+/g, " ");
  const items = Array.isArray(params.tasks) ? params.tasks : Array.isArray(params.chain) ? params.chain : [];
  const first = typeof items[0]?.task === "string" ? items[0].task.replace(/\s+/g, " ") : "subagent work";
  return `${requestMode(params)} ${items.length}: ${truncateByBytes(first, 400)}`;
}

function backgroundRecordText(record: BackgroundSubagentRecord, includeOutput = false): string {
  const artifacts = includeOutput ? (record.artifacts ?? []).map((artifact) =>
    `result child ${artifact.child} [${artifact.label}]: ${artifact.bytes}/${artifact.totalBytes} bytes${artifact.complete ? "" : " (incomplete)"}`
  ) : [];
  return [
    backgroundSubagentLine(record),
    ...(includeOutput ? [record.result ?? record.latest ?? "(no output)"] : []),
    ...artifacts,
    ...(record.error ? [`error: ${record.error}`] : []),
  ].join("\n");
}

function backgroundStartResult(record: BackgroundSubagentRecord, movedFromForeground: boolean) {
  const guidance = movedFromForeground
    ? "Moved to the background by the user without restarting. Continue useful parent work; consume this result before completing dependent work."
    : "Started without blocking. Continue other work; use subagent operation=wait|status|output|result|cancel with this job_id when needed.";
  return {
    content: [{ type: "text" as const, text: `${backgroundSubagentLine(record)}\n${guidance}` }],
    details: {
      background_subagent: true as const,
      operation: "start" as const,
      job_id: record.id,
      status: record.status,
      backend: record.backend,
      failed: false,
    } satisfies BackgroundSubagentDetails,
  };
}

function terminalBackgroundStatus(status: BackgroundSubagentRecord["status"]): boolean {
  return !["running", "cancelling"].includes(status);
}

function stableSessionId(ctx: any): string {
  const value = ctx?.sessionManager?.getSessionId?.();
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 512) {
    throw new Error("background subagents require a stable Pi session ID");
  }
  return value;
}

function persistentAgentDir(ctx: any): string {
  const sessionFile = ctx?.sessionManager?.getSessionFile?.();
  if (typeof sessionFile !== "string" || !path.isAbsolute(sessionFile)) return getAgentDir();
  let directory = path.dirname(sessionFile);
  for (let depth = 0; depth < 8; depth++) {
    if (path.basename(directory) === "sessions") return path.dirname(directory);
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return getAgentDir();
}

function validateBackgroundOperation(params: any): void {
  const operation = typeof params.operation === "string" ? params.operation : undefined;
  if (!operation) return;
  const launchFields = ["task", "tasks", "chain", "systemPrompt", "model", "tools", "cwd", "action", "draft_id", "background", "mode", "timeout_ms"];
  if (launchFields.some((field) => params[field] !== undefined)) throw new Error("A background subagent operation cannot include launch or Draft disposition fields");
  if (operation === "list") {
    if (params.job_id !== undefined || params.wait_ms !== undefined || params.offset !== undefined || params.child !== undefined) throw new Error("Background subagent list accepts only optional limit");
    if (params.limit !== undefined && params.limit > 50) throw new Error("Background subagent list limit cannot exceed 50");
    return;
  }
  if (typeof params.job_id !== "string" || !BACKGROUND_SUBAGENT_ID_PATTERN.test(params.job_id)) throw new Error(`${operation} requires a valid job_id`);
  if (operation === "wait") {
    if (params.limit !== undefined || params.offset !== undefined || params.child !== undefined) throw new Error("Background subagent wait accepts only job_id and wait_ms");
  } else if (operation === "result") {
    if (params.wait_ms !== undefined) throw new Error("Background subagent result does not accept wait_ms");
    if (params.limit !== undefined && params.limit < 4) throw new Error("Background subagent result limit must be at least 4 bytes");
  } else if (params.wait_ms !== undefined || params.limit !== undefined || params.offset !== undefined || params.child !== undefined) {
    throw new Error(`${operation} accepts only job_id`);
  }
}

function validateBackgroundLaunch(params: any): void {
  const lifecycleFields = ["job_id", "wait_ms", "limit", "offset", "child"];
  if (params.background !== true) {
    if (lifecycleFields.some((field) => params[field] !== undefined)) throw new Error("Foreground subagent launch cannot include background lifecycle fields");
    return;
  }
  if (params.operation !== undefined || lifecycleFields.some((field) => params[field] !== undefined)) throw new Error("Background launch cannot include lifecycle operation fields");
  if (params.action !== undefined || params.draft_id !== undefined) throw new Error("Draft review/apply/discard cannot run in the background");
  if (delegationFormCount(params) !== 1) throw new Error("Background launch requires exactly one task, non-empty tasks, or non-empty chain form");
  if (Array.isArray(params.tasks) && params.tasks.length > MAX_PARALLEL_TASKS) throw new Error(`Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`);
  const items = Array.isArray(params.tasks) ? params.tasks : Array.isArray(params.chain) ? params.chain : [];
  if (items.some((item: any) => typeof item?.task !== "string" || item.task.trim().length === 0)) throw new Error("Every background subagent task must be a non-empty string");
}

const SubagentItem = Type.Object({
  task: Type.String({ description: "Task to delegate to this dynamic subagent" }),
  systemPrompt: Type.Optional(Type.String({ description: "Optional additional system prompt for this subagent" })),
  model: Type.Optional(Type.String({ description: "Optional model id for this subagent" })),
  tools: Type.Optional(Type.Array(Type.String(), { description: "Optional tool allowlist, e.g. ['read','grep','find','ls']" })),
  cwd: Type.Optional(Type.String({ description: "Optional working directory for this subagent process" })),
});

function subagentParams() {
  return Type.Object({
  mode: Type.Optional(Type.String({ pattern: "^(shared|draft)$", description: "Execution isolation. Omitted/shared uses AgentSH when configured, otherwise a native child; draft requires AgentSH." })),
  action: Type.Optional(Type.String({ pattern: "^(review|apply|discard)$", description: "AgentSH Draft disposition; use with mode=draft and draft_id instead of task/tasks/chain." })),
  draft_id: Type.Optional(Type.String({ pattern: "^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", description: "Exact retained AgentSH Draft identity." })),
  background: Type.Optional(Type.Boolean({ description: "Return immediately and continue a task/tasks/chain request in the background." })),
  operation: Type.Optional(Type.String({ pattern: "^(list|status|output|wait|result|cancel)$", description: "Background subagent lifecycle operation; use instead of task/tasks/chain." })),
  job_id: Type.Optional(Type.String({ pattern: "^subagent-job-[0-9a-f]{24}$", description: "Opaque background subagent execution ID." })),
  wait_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 30000, description: "Bounded background wait duration; default 1000ms." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SUBAGENT_RESULT_PAGE_BYTES, description: "List count (max 50), or result page byte limit (minimum 4, maximum 48 KiB)." })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "Byte offset for operation=result pagination." })),
  child: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, description: "One-based child report number for parallel or chain results." })),
  task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
  systemPrompt: Type.Optional(Type.String({ description: "Optional additional system prompt (single mode)" })),
  model: Type.Optional(Type.String({ description: "Optional model id (single mode)" })),
  tools: Type.Optional(Type.Array(Type.String(), { description: "Optional tool allowlist (single mode)" })),
  cwd: Type.Optional(Type.String({ description: "Optional working directory (single mode)" })),
  tasks: Type.Optional(Type.Array(SubagentItem, { description: "Parallel subagent tasks. Max 8, up to 4 run concurrently." })),
  chain: Type.Optional(Type.Array(SubagentItem, { description: "Sequential subagent steps. Each task may use {previous}." })),
    ...(process.env.PI_AGENTSH_EXPOSE_SUBAGENT_TIMEOUT === "1" ? {
      timeout_ms: Type.Optional(Type.Number({ minimum: 1, description: "Optional shorter AgentSH execution timeout in milliseconds." })),
    } : {}),
  });
}

export default function (pi: ExtensionAPI) {
  const agentSHStartup = classifyAgentSHStartup(process.env);
  const bridgeDisposition = (bridge: AgentSHBridge | undefined) =>
    agentSHRuntimeDisposition(agentSHStartup, bridgeSupervisorState(bridge));
  let backgroundManager = sharedBackgroundSubagentManager(path.join(getAgentDir(), "state", "background-subagents-v1"));
  let sessionContext: any;
  let sessionGeneration = 0;
  let pollTimer: NodeJS.Timeout | undefined;
  let pollRunning = false;
  let completionCheckArmed = false;
  const idlePending = new Set<string>();
  const idleInFlight = new Set<string>();
  const deliveryClaims = new Set<string>();
  const activeForegroundSubagents = new Map<string, ActiveForegroundSubagent>();
  const pendingForegroundSubagents = new Map<string, string>();
  const requestedForegroundHandoffs = new Set<string>();

  const updateBackgroundStatus = async (ctx: any) => {
    if (!ctx?.hasUI) return;
    try {
      const running = (await backgroundManager.list(stableSessionId(ctx), 1000)).filter(isBackgroundSubagentActive).length;
      ctx.ui.setStatus("background-subagents", running ? ctx.ui.theme.fg("accent", `subagents ${running}`) : undefined);
    } catch {
      ctx.ui.setStatus("background-subagents", ctx.ui.theme.fg("error", "subagents ✗"));
    }
  };

  const sendLifecycle = (ctx: any, content: string, details: Record<string, unknown>) => {
    pi.sendMessage(
      { customType: "background-subagent-lifecycle", content, display: false, details },
      { deliverAs: ctx.isIdle() ? "nextTurn" : "steer" },
    );
  };

  const deliverTerminal = async (ctx: any, record: BackgroundSubagentRecord) => {
    if (!terminalBackgroundStatus(record.status) || idlePending.has(record.id) || idleInFlight.has(record.id) || deliveryClaims.has(record.id)) return;
    deliveryClaims.add(record.id);
    try {
      if (sessionContext !== ctx) return;
      const message = `Notification: subagent ${record.id} ${record.status}. Check its status.`;
      if (ctx.isIdle()) {
        if (await backgroundManager.isNotified(record.id)) return;
        idlePending.add(record.id);
        try { sendLifecycle(ctx, message, { kind: "completion", job_id: record.id, status: record.status }); }
        catch (error) { idlePending.delete(record.id); throw error; }
      } else {
        if (!(await backgroundManager.markNotified(record.id))) return;
        sendLifecycle(ctx, message, { kind: "completion", job_id: record.id, status: record.status });
      }
      if (ctx.hasUI) ctx.ui.notify(message, record.status === "completed" ? "info" : "warning");
    } finally {
      deliveryClaims.delete(record.id);
    }
  };

  const pollBackground = async () => {
    if (pollRunning || !sessionContext) return;
    const ctx = sessionContext;
    const generation = sessionGeneration;
    pollRunning = true;
    try {
      const records = await backgroundManager.list(stableSessionId(ctx), 1000);
      for (const record of records) {
        if (generation !== sessionGeneration || sessionContext !== ctx) return;
        if (terminalBackgroundStatus(record.status)) await deliverTerminal(ctx, record);
      }
      if (generation === sessionGeneration && sessionContext === ctx) await updateBackgroundStatus(ctx);
    } catch {
      if (generation === sessionGeneration && sessionContext === ctx && ctx.hasUI) ctx.ui.setStatus("background-subagents", ctx.ui.theme.fg("error", "subagents ✗"));
    } finally {
      pollRunning = false;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    sessionGeneration += 1;
    sessionContext = ctx;
    backgroundManager = sharedBackgroundSubagentManager(path.join(persistentAgentDir(ctx), "state", "background-subagents-v1"));
    try {
      await backgroundManager.initialize();
      await updateBackgroundStatus(ctx);
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(() => void pollBackground(), 2000);
      pollTimer.unref();
      void pollBackground();
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`Background subagents unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  });

  pi.on("before_agent_start", () => {
    for (const id of idlePending) idleInFlight.add(id);
    idlePending.clear();
  });

  pi.on("agent_end", async (_event, ctx) => {
    const checkCompletions = completionCheckArmed;
    completionCheckArmed = false;
    if (!checkCompletions && idleInFlight.size === 0) return;
    try {
      if (checkCompletions) {
        const records = await backgroundManager.list(stableSessionId(ctx), 1000);
        for (const record of records) if (terminalBackgroundStatus(record.status)) await deliverTerminal(ctx, record);
      }
      for (const id of [...idleInFlight]) {
        await backgroundManager.markNotified(id);
        idleInFlight.delete(id);
      }
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`Could not check background subagents before settling: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    sessionGeneration += 1;
    sessionContext = undefined;
    completionCheckArmed = false;
    idlePending.clear();
    idleInFlight.clear();
    deliveryClaims.clear();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
    try {
      const sessionId = stableSessionId(ctx);
      for (const entry of activeForegroundSubagents.values()) {
        if (entry.sessionId === sessionId) entry.execution.abort(new Error("Owning Pi session shut down"));
      }
      backgroundManager.requestCancelSession(sessionId);
    } catch {}
    activeForegroundSubagents.clear();
    pendingForegroundSubagents.clear();
    requestedForegroundHandoffs.clear();
  });

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "subagent" || !isDetachableForegroundRequest(event.input)) return;
    try { pendingForegroundSubagents.set(event.toolCallId, stableSessionId(ctx)); } catch { /* Tool execution reports the missing session identity. */ }
  });

  pi.registerCommand("background", {
    description: "Move all currently running foreground subagents to the background",
    handler: async (args, ctx) => {
      if (args.trim()) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /background", "warning");
        return;
      }
      try {
        const sessionId = stableSessionId(ctx);
        const targetIds = new Set<string>();
        for (const [toolCallId, pendingSessionId] of pendingForegroundSubagents) {
          if (pendingSessionId === sessionId) targetIds.add(toolCallId);
        }
        for (const entry of activeForegroundSubagents.values()) {
          if (entry.sessionId === sessionId && entry.execution.detachable) targetIds.add(entry.toolCallId);
        }
        if (targetIds.size === 0) {
          if (ctx.hasUI) ctx.ui.notify("No foreground subagents are currently running.", "info");
          return;
        }
        const existing = (await backgroundManager.list(sessionId, 1000)).filter(isBackgroundSubagentActive).length;
        if (existing + targetIds.size > MAX_BACKGROUND_SUBAGENTS) {
          if (ctx.hasUI) {
            ctx.ui.notify(
              `Cannot move ${targetIds.size} foreground subagent execution${targetIds.size === 1 ? "" : "s"}: ${existing} background job${existing === 1 ? " is" : "s are"} already active and the limit is ${MAX_BACKGROUND_SUBAGENTS}.`,
              "warning",
            );
          }
          return;
        }

        for (const toolCallId of targetIds) requestedForegroundHandoffs.add(toolCallId);
        const moved: BackgroundSubagentRecord[] = [];
        const errors: string[] = [];
        for (const toolCallId of targetIds) {
          const entry = activeForegroundSubagents.get(toolCallId);
          if (!entry?.execution.detachable) continue;
          try {
            const record = await entry.detach();
            if (record) moved.push(record);
          } catch (error) {
            requestedForegroundHandoffs.delete(toolCallId);
            errors.push(`${entry.summary}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (moved.length > 0) {
          completionCheckArmed = true;
          await updateBackgroundStatus(ctx);
        }
        if (ctx.hasUI) {
          const queued = targetIds.size - moved.length - errors.length;
          const ids = moved.map((record) => record.id).join(", ");
          const movedText = moved.length > 0 ? ` Moved now: ${ids}.` : "";
          const queuedText = queued > 0 ? ` ${queued} queued tool invocation${queued === 1 ? " will" : "s will"} move as execution starts.` : "";
          ctx.ui.notify(`Background handoff requested for ${targetIds.size} foreground subagent execution${targetIds.size === 1 ? "" : "s"}.${movedText}${queuedText}`, errors.length ? "warning" : "info");
          if (errors.length > 0) ctx.ui.notify(`Could not move: ${errors.join("; ")}`, "warning");
        }
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(`Could not move foreground subagents: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    },
  });

  pi.on("tool_result", (event) => {
    if (event.toolName !== "subagent") return;
    pendingForegroundSubagents.delete(event.toolCallId);
    requestedForegroundHandoffs.delete(event.toolCallId);
    if (event.isError) return;
    const details = event.details as SubagentDetails | BackgroundSubagentDetails | undefined;
    if ((details as BackgroundSubagentDetails | undefined)?.background_subagent) return;
    const foreground = details as SubagentDetails | undefined;
    if (foreground?.failed || (foreground?.backend === "native" && foreground.results.some(isFailure))) return { isError: true };
  });

  let subagentTool: any;
  subagentTool = {
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate focused work through AgentSH when configured, otherwise through native child Pi processes.",
      "Exactly one request form: single task, parallel tasks, chain steps, a background lifecycle operation, or an AgentSH Draft disposition.",
      "Set background=true on task/tasks/chain to continue without blocking; inspect it later with operation and job_id.",
      "In guard-only sessions, native child shell commands use the parent AgentSH Permission Gate and may request approval in the parent UI.",
      "mode defaults to shared; mode=draft requires an active AgentSH supervisor.",
    ].join(" "),
    promptSnippet: "Delegate focused work synchronously or as a durable-in-session background subagent",
    promptGuidelines: [
      "Use background=true when delegated work may take long enough that useful parent work can continue concurrently.",
      "Before claiming dependent work complete, consume a terminal background subagent result; operation=result supports child, offset, and bounded byte-limit pagination, while cancelling a bounded wait does not cancel the subagent.",
      "Use operation=cancel explicitly to stop a background subagent. Running subagents are cancelled when their owning Pi session shuts down.",
    ],
    parameters: subagentParams(),

    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const internalManagedExecution = params[INTERNAL_MANAGED_EXECUTION] === true;
      validateBackgroundOperation(params);
      if (params.operation) {
        const ownerSessionId = stableSessionId(ctx);
        const operation = params.operation as BackgroundSubagentDetails["operation"];
        if (operation === "list") {
          const records = await backgroundManager.list(ownerSessionId, params.limit ?? 20);
          return {
            content: [{ type: "text", text: records.length ? records.map(backgroundSubagentLine).join("\n") : "No background subagents for this Pi session." }],
            details: { background_subagent: true, operation, failed: false, jobs: records.map((record) => ({ job_id: record.id, status: record.status, backend: record.backend, mode: record.mode })) },
          };
        }
        const id = params.job_id as string;
        const owned = async () => {
          const record = await backgroundManager.get(id);
          if (record.sessionId !== ownerSessionId) throw new Error(`Background subagent ${id} belongs to a different Pi session`);
          return record;
        };
        let record = await owned();
        let timedOut = false;
        if (operation === "wait") {
          const waited = await backgroundManager.wait(id, params.wait_ms ?? 1000, signal);
          record = waited.record;
          timedOut = waited.timedOut;
        } else if (operation === "cancel") {
          record = await backgroundManager.cancel(id);
        }
        const discloseOutput = operation === "output" || operation === "wait" || operation === "cancel" || (operation === "status" && terminalBackgroundStatus(record.status));
        if (discloseOutput && terminalBackgroundStatus(record.status)) await backgroundManager.markNotified(id);
        const waiting = timedOut ? "\nWait timed out; the subagent is still running." : "";
        const notReady = operation === "result" && isBackgroundSubagentActive(record) ? "\nResult is not ready; use a bounded wait or continue other work." : "";
        await updateBackgroundStatus(ctx);
        if (operation === "result" && terminalBackgroundStatus(record.status)) {
          const page = await backgroundManager.readResult(id, params.child, params.offset ?? 0, params.limit ?? MAX_SUBAGENT_RESULT_PAGE_BYTES);
          await backgroundManager.markNotified(id);
          const retained = page.complete ? "" : `; retained ${page.totalBytes} of ${page.sourceTotalBytes} source bytes`;
          const continuation = page.nextOffset === undefined ? "" : `\n\n[Use operation=result with job_id=${id}, child=${page.child}, offset=${page.nextOffset} to continue.]`;
          return {
            content: [{ type: "text", text: `[${page.label}] bytes ${page.offset}-${page.offset + page.bytes} of ${page.totalBytes}${retained}\n\n${page.text}${continuation}` }],
            details: {
              background_subagent: true,
              operation,
              job_id: id,
              status: record.status,
              backend: record.backend,
              failed: record.status !== "completed",
              child: page.child,
              offset: page.offset,
              next_offset: page.nextOffset,
              bytes: page.bytes,
              total_bytes: page.totalBytes,
              source_total_bytes: page.sourceTotalBytes,
              complete: page.complete,
              sha256: page.sha256,
            } satisfies BackgroundSubagentDetails,
          };
        }
        return {
          content: [{ type: "text", text: truncateByBytes(`${backgroundRecordText(record, discloseOutput)}${waiting}${notReady}`) }],
          details: {
            background_subagent: true,
            operation,
            job_id: id,
            status: record.status,
            backend: record.backend,
            failed: terminalBackgroundStatus(record.status) && record.status !== "completed",
            timed_out: timedOut,
            result_children: record.artifacts?.map((artifact) => ({ child: artifact.child, label: artifact.label, bytes: artifact.bytes, total_bytes: artifact.totalBytes, complete: artifact.complete, sha256: artifact.sha256 })),
          } satisfies BackgroundSubagentDetails,
        };
      }

      validateBackgroundLaunch(params);
      if (params.background === true) {
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Background subagent launch cancelled");
        const dispositionError = adaptiveDispositionError(params);
        if (dispositionError) throw new Error(dispositionError);
        const permissionSelection = currentSubagentPermissionSelection();
        if (agentSHStartup.kind === "conflict" || permissionSelection?.conflict) {
          throw new Error("Conflicting AgentSH guard-only and full-supervisor authorities were selected; refusing subagent execution");
        }
        const bridge = agentSHBridge();
        const backend = selectSubagentBackend(bridge, agentSHStartup);
        if (backend.kind === "unavailable") throw new Error(backend.message);
        if (backend.kind === "agentsh" && permissionSelection?.selected) {
          throw new Error("Conflicting AgentSH guard-only and full-supervisor authorities were selected; refusing subagent execution");
        }
        if (backend.kind === "native") {
          if (!nativeSubagentRequestSupported(params)) throw new Error("mode=draft requires an active AgentSH supervisor");
          const permissionAuthority = currentSubagentPermissionAuthority();
          if (!permissionAuthority && (agentSHStartup.kind === "guard-only" || permissionSelection?.selected)) {
            throw new Error("Parent AgentSH Permission Gate was selected but its authority is unavailable; refusing native subagent launch");
          }
          if (permissionAuthority && (!permissionAuthority.active || !installedPermissionProxyEntrypoint())) {
            throw new Error("Parent AgentSH Permission Gate or its immutable child proxy is unavailable; refusing native subagent launch");
          }
        }
        const launchedParams = { ...params };
        delete launchedParams.background;
        delete launchedParams.operation;
        delete launchedParams.job_id;
        delete launchedParams.wait_ms;
        delete launchedParams.limit;
        delete launchedParams.offset;
        delete launchedParams.child;
        const record = await backgroundManager.start({
          sessionId: stableSessionId(ctx),
          backend: backend.kind,
          mode: requestMode(params),
          summary: requestSummary(params),
        }, async (backgroundSignal, update) => {
          const result = await subagentTool.execute(toolCallId, { ...launchedParams, [INTERNAL_MANAGED_EXECUTION]: true }, backgroundSignal, (partial: any) => update(agentResultText(partial)), ctx);
          return backgroundOutcome(result);
        });
        completionCheckArmed = true;
        await updateBackgroundStatus(ctx);
        return backgroundStartResult(record, false);
      }

      params = { ...params };
      delete params[INTERNAL_MANAGED_EXECUTION];
      delete params.background;
      delete params.operation;
      delete params.job_id;
      delete params.wait_ms;
      delete params.limit;
      delete params.offset;
      delete params.child;
      const dispositionError = adaptiveDispositionError(params);
      if (dispositionError) throw new Error(dispositionError);

      const permissionSelection = currentSubagentPermissionSelection();
      if (agentSHStartup.kind === "conflict" || permissionSelection?.conflict) {
        throw new Error("Conflicting AgentSH guard-only and full-supervisor authorities were selected; refusing subagent execution");
      }
      const bridge = agentSHBridge();
      const backend = selectSubagentBackend(bridge, agentSHStartup);
      if (backend.kind === "unavailable") throw new Error(backend.message);
      if (backend.kind === "agentsh" && permissionSelection?.selected) {
        throw new Error("Conflicting AgentSH guard-only and full-supervisor authorities were selected; refusing subagent execution");
      }
      if (backend.kind === "native" && !nativeSubagentRequestSupported(params)) {
        throw new Error("mode=draft and Draft dispositions require an active AgentSH supervisor");
      }

      if (!internalManagedExecution && params.action === undefined && delegationFormCount(params) === 1) {
        const sessionId = stableSessionId(ctx);
        if (activeForegroundSubagents.has(toolCallId)) throw new Error(`Duplicate active subagent tool-call ID: ${toolCallId}`);
        let execution!: DetachableForegroundExecution<any, any, BackgroundSubagentRecord>;
        execution = new DetachableForegroundExecution(
          (managedSignal, managedUpdate) => subagentTool.execute(
            toolCallId,
            { ...params, [INTERNAL_MANAGED_EXECUTION]: true },
            managedSignal,
            managedUpdate,
            ctx,
          ),
          onUpdate,
        );
        const abortForeground = () => execution.abort(signal?.reason);
        if (signal?.aborted) abortForeground();
        else signal?.addEventListener("abort", abortForeground, { once: true });

        const entry: ActiveForegroundSubagent = {
          toolCallId,
          sessionId,
          backend: backend.kind,
          mode: requestMode(params),
          summary: requestSummary(params),
          execution,
          detach: () => execution.detach(async (adopted) => await backgroundManager.start({
            sessionId,
            backend: backend.kind,
            mode: requestMode(params),
            summary: requestSummary(params),
          }, async (backgroundSignal, update) => {
            const unsubscribe = adopted.subscribe((partial) => update(agentResultText(partial)));
            const cancelAdopted = () => adopted.abort(backgroundSignal.reason);
            if (backgroundSignal.aborted) cancelAdopted();
            else backgroundSignal.addEventListener("abort", cancelAdopted, { once: true });
            try {
              const result = await adopted.completion;
              return backgroundOutcome(result);
            } finally {
              unsubscribe();
              backgroundSignal.removeEventListener("abort", cancelAdopted);
            }
          })),
        };
        activeForegroundSubagents.set(toolCallId, entry);
        try {
          if (requestedForegroundHandoffs.delete(toolCallId)) {
            try {
              const record = await entry.detach();
              if (record) {
                completionCheckArmed = true;
                await updateBackgroundStatus(ctx);
              }
            } catch (error) {
              if (ctx.hasUI) ctx.ui.notify(`Could not move foreground subagent to the background: ${error instanceof Error ? error.message : String(error)}`, "warning");
            }
          }
          const decision = await execution.waitForDecision();
          if (decision.kind === "completed") return decision.result;
          completionCheckArmed = true;
          await updateBackgroundStatus(ctx);
          return backgroundStartResult(decision.value, true);
        } finally {
          signal?.removeEventListener("abort", abortForeground);
          if (activeForegroundSubagents.get(toolCallId) === entry) activeForegroundSubagents.delete(toolCallId);
        }
      }

      if (backend.kind === "agentsh") {
        const adaptedUpdate = onUpdate
          ? (partial: any) => onUpdate({ ...partial, details: withBackend(partial?.details, "agentsh") })
          : undefined;
        const result = await bridge!.subagentAdapter!.execute(toolCallId, params, signal, adaptedUpdate, ctx);
        const failed = bridge!.subagentAdapter!.detailsFailed(result?.details);
        return attachRetainedSubagentReports({ ...result, details: withBackend(result?.details, "agentsh", failed) }, result);
      }
      const permissionAuthority = currentSubagentPermissionAuthority();
      if (!permissionAuthority && (agentSHStartup.kind === "guard-only" || permissionSelection?.selected)) {
        throw new Error("Parent AgentSH Permission Gate was selected but its authority is unavailable; refusing native subagent launch");
      }
      if (permissionAuthority && !permissionAuthority.active) {
        throw new Error("Parent AgentSH Permission Gate is unavailable; refusing native subagent launch");
      }
      if (permissionAuthority && !installedPermissionProxyEntrypoint()) {
        throw new Error("Native subagent Permission Gate proxy is not installed; refusing native subagent launch");
      }
      const nativeParams = { ...params };
      delete nativeParams.mode;
      delete nativeParams.action;
      delete nativeParams.draft_id;
      params = nativeParams;
      const hasSingle = typeof params.task === "string" && params.task.trim().length > 0;
      const hasTasks = Array.isArray(params.tasks) && params.tasks.length > 0;
      const hasChain = Array.isArray(params.chain) && params.chain.length > 0;
      const modeCount = Number(hasSingle) + Number(hasTasks) + Number(hasChain);
      const mode: Mode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
      const makeDetails = (detailsMode: Mode) => (results: SingleResult[]): SubagentDetails => ({ backend: "native", mode: detailsMode, results });

      if (modeCount !== 1) {
        throw new Error("Invalid parameters. Provide exactly one mode: task, non-empty tasks, or non-empty chain.");
      }

      if (hasChain) {
        const results: SingleResult[] = [];
        let previousOutput = "";

        for (let i = 0; i < params.chain.length; i++) {
          const stepInput = params.chain[i];
          const stepSpec = specFromParams(stepInput);
          stepSpec.task = stepSpec.task.replace(/\{previous\}/g, previousOutput);
          const label = `step ${i + 1}`;

          const chainUpdate: OnUpdateCallback | undefined = onUpdate
            ? (partial) => {
                const currentResult = partial.details?.results[0];
                if (currentResult) onUpdate({ content: partial.content, details: makeDetails("chain")([...results, currentResult]) });
              }
            : undefined;

          const result = await runSingleSubagent(ctx.cwd, stepSpec, label, i + 1, signal, chainUpdate, makeDetails("chain"), permissionAuthority);
          results.push(result);

          if (isFailure(result)) {
            return {
              content: [{ type: "text", text: `Chain stopped at step ${i + 1}: ${truncateByBytes(resultErrorText(result))}` }],
              details: makeDetails("chain")(results),
              isError: true,
            };
          }
          previousOutput = getFinalOutput(result.messages);
        }

        return {
          content: [{ type: "text", text: truncateByBytes(getFinalOutput(results[results.length - 1].messages) || "(no output)") }],
          details: makeDetails("chain")(results),
        };
      }

      if (hasTasks) {
        if (params.tasks.length > MAX_PARALLEL_TASKS) {
          throw new Error(`Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`);
        }

        const specs = params.tasks.map((taskParams: any) => specFromParams(taskParams));
        const allResults: SingleResult[] = specs.map((spec: SubagentSpec, index: number) => ({
          label: `task ${index + 1}`,
          task: spec.task,
          exitCode: -1,
          messages: [],
          stderr: "",
          usage: usageZero(),
          model: spec.model,
          tools: spec.tools,
          systemPrompt: spec.systemPrompt,
          cwd: spec.cwd,
        }));

        const emitParallelUpdate = () => {
          const running = allResults.filter((r) => r.exitCode === -1).length;
          const done = allResults.length - running;
          onUpdate?.({
            content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
            details: makeDetails("parallel")([...allResults]),
          });
        };

        const results = await mapWithConcurrencyLimit(specs, MAX_CONCURRENCY, async (spec, index) => {
          const result = await runSingleSubagent(
            ctx.cwd,
            spec,
            `task ${index + 1}`,
            undefined,
            signal,
            (partial) => {
              if (partial.details?.results[0]) {
                allResults[index] = partial.details.results[0];
                emitParallelUpdate();
              }
            },
            makeDetails("parallel"),
            permissionAuthority,
          );
          allResults[index] = result;
          emitParallelUpdate();
          return result;
        });

        const successCount = results.filter((r) => !isFailure(r)).length;
        const sections = results.map((r) => ({
          label: r.label,
          status: isFailure(r) ? "failed" as const : "completed" as const,
          output: isFailure(r) ? compactResultSummary(r) : getFinalOutput(r.messages) || "(no output)",
        }));
        return {
          content: [{ type: "text", text: formatParallelResultContent(sections, successCount, MAX_TEXT_PREVIEW_BYTES) }],
          details: makeDetails("parallel")(results),
          isError: successCount !== results.length,
        };
      }

      const result = await runSingleSubagent(ctx.cwd, specFromParams(params), "subagent", undefined, signal, onUpdate, makeDetails("single"), permissionAuthority);
      if (isFailure(result)) {
        return {
          content: [{ type: "text", text: `Subagent ${result.stopReason || "failed"}: ${truncateByBytes(resultErrorText(result))}` }],
          details: makeDetails("single")([result]),
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: truncateByBytes(getFinalOutput(result.messages) || "(no output)") }],
        details: makeDetails("single")([result]),
      };
    },

    renderCall(args: any, theme) {
      if (args.operation) {
        return new Text(`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("muted", args.operation)}${args.job_id ? ` ${theme.fg("dim", args.job_id)}` : ""}`, 0, 0);
      }
      if (args.background) {
        const mode = requestMode(args);
        return new Text(`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", `background ${mode}`)}\n  ${theme.fg("dim", requestSummary(args))}`, 0, 0);
      }
      const bridge = agentSHBridge();
      const disposition = bridgeDisposition(bridge);
      if ((disposition.kind === "full" || disposition.kind === "unavailable") && bridge?.subagentAdapter) {
        return bridge.subagentAdapter.renderCall(args, theme);
      }
      if (args.chain && args.chain.length > 0) {
        let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `chain (${args.chain.length} steps)`);
        for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
          const step = args.chain[i];
          const cleanTask = String(step.task ?? "").replace(/\{previous\}/g, "").trim();
          const preview = cleanTask.length > 50 ? `${cleanTask.slice(0, 50)}...` : cleanTask;
          text += `\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("dim", preview)}`;
        }
        if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      if (args.tasks && args.tasks.length > 0) {
        let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `parallel (${args.tasks.length} tasks)`);
        for (const t of args.tasks.slice(0, 3)) {
          const task = String(t.task ?? "");
          const preview = task.length > 50 ? `${task.slice(0, 50)}...` : task;
          text += `\n  ${theme.fg("dim", preview)}`;
        }
        if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }
      const task = String(args.task ?? "...");
      const preview = task.length > 70 ? `${task.slice(0, 70)}...` : task;
      return new Text(`${theme.fg("toolTitle", theme.bold("subagent single"))}\n  ${theme.fg("dim", preview)}`, 0, 0);
    },

    renderResult(result, options, theme) {
      if ((result.details as BackgroundSubagentDetails | undefined)?.background_subagent) {
        const text = result.content.find((part: any) => part?.type === "text")?.text ?? "(no output)";
        return new Text(text, 0, 0);
      }
      const bridge = agentSHBridge();
      const adapter = bridge?.subagentAdapter;
      const backend = (result.details as any)?.backend;
      const disposition = bridgeDisposition(bridge);
      if (adapter && backend !== "native" && (backend === "agentsh" || disposition.kind === "full" || disposition.kind === "unavailable")) {
        return adapter.renderResult(result, options, theme);
      }
      const { expanded } = options;
      const details = result.details as SubagentDetails | undefined;
      if (!details || details.results.length === 0) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }

      const mdTheme = getMarkdownTheme();

      const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
        const toShow = limit ? items.slice(-limit) : items;
        const skipped = limit && items.length > limit ? items.length - limit : 0;
        let text = "";
        if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
        for (const item of toShow) {
          if (item.type === "text") {
            const preview = expanded ? truncateByBytes(item.text) : truncateByBytes(item.text).split("\n").slice(0, 3).join("\n");
            text += `${theme.fg("toolOutput", preview)}\n`;
          } else {
            text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
          }
        }
        return text.trimEnd();
      };

      const renderOneExpanded = (container: Container, r: SingleResult, title: string) => {
        const failed = isFailure(r);
        const icon = failed ? theme.fg("error", "✗") : r.exitCode === -1 ? theme.fg("warning", "⏳") : theme.fg("success", "✓");
        container.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold(title))}`, 0, 0));
        container.addChild(new Text(theme.fg("muted", "Status: ") + theme.fg(failed ? "error" : "dim", `${resultStatus(r)} (exit ${r.exitCode})`), 0, 0));
        container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
        if (r.model) container.addChild(new Text(theme.fg("muted", "Model: ") + theme.fg("dim", r.model), 0, 0));
        if (r.tools?.length) container.addChild(new Text(theme.fg("muted", "Tools: ") + theme.fg("dim", r.tools.join(", ")), 0, 0));
        if (r.cwd) container.addChild(new Text(theme.fg("muted", "Cwd: ") + theme.fg("dim", r.cwd), 0, 0));
        if (r.warning) container.addChild(new Text(theme.fg("warning", `Warning: ${r.warning}`), 0, 0));
        if (failed && r.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
        if (r.lastToolCall) {
          container.addChild(new Text(theme.fg("muted", "Last tool call: ") + formatToolCall(r.lastToolCall.name, r.lastToolCall.args, theme.fg.bind(theme)), 0, 0));
        }
        if (r.lastToolResult) {
          container.addChild(new Text(theme.fg("muted", `Last tool result:\n${truncateByBytes(r.lastToolResult).split("\n").slice(-8).join("\n")}`), 0, 0));
        }

        const displayItems = getDisplayItems(r.messages);
        for (const item of displayItems) {
          if (item.type === "toolCall") container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0));
        }

        const finalOutput = getFinalOutput(r.messages);
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
        if (finalOutput) container.addChild(new Markdown(truncateByBytes(finalOutput.trim()), 0, 0, mdTheme));
        else container.addChild(new Text(theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)"), 0, 0));

        const usageStr = formatUsageStats(r.usage, r.model);
        if (usageStr) container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
        if (r.stderr.trim()) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg(failed ? "error" : "dim", `stderr:\n${truncateByBytes(r.stderr.trim())}`), 0, 0));
        }
      };

      const aggregateUsage = (results: SingleResult[]) => {
        const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
        for (const r of results) {
          total.input += r.usage.input;
          total.output += r.usage.output;
          total.cacheRead += r.usage.cacheRead;
          total.cacheWrite += r.usage.cacheWrite;
          total.cost += r.usage.cost;
          total.turns += r.usage.turns;
        }
        return total;
      };

      if (details.mode === "single" && details.results.length === 1) {
        const r = details.results[0];
        if (expanded) {
          const container = new Container();
          renderOneExpanded(container, r, r.label);
          return container;
        }
        const failed = isFailure(r);
        const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const displayItems = getDisplayItems(r.messages);
        let text = `${icon} ${theme.fg("toolTitle", theme.bold("subagent"))}`;
        if (failed) {
          text += `\n${theme.fg("error", compactResultSummary(r).split("\n").slice(0, 14).join("\n"))}`;
        } else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
        else text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
        const usageStr = formatUsageStats(r.usage, r.model);
        if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
        return new Text(text, 0, 0);
      }

      const running = details.results.filter((r) => r.exitCode === -1).length;
      const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailure(r)).length;
      const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailure(r)).length;
      const icon = running > 0 ? theme.fg("warning", "⏳") : failCount > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✓");
      const noun = details.mode === "chain" ? "steps" : "tasks";
      const status = running > 0 ? `${successCount + failCount}/${details.results.length} done, ${running} running` : `${successCount}/${details.results.length} ${noun}`;

      if (expanded && running === 0) {
        const container = new Container();
        container.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold(`${details.mode} `))}${theme.fg("accent", status)}`, 0, 0));
        for (const r of details.results) {
          container.addChild(new Spacer(1));
          renderOneExpanded(container, r, details.mode === "chain" ? `step ${r.step ?? "?"}` : r.label);
        }
        const usageStr = formatUsageStats(aggregateUsage(details.results));
        if (usageStr) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
        }
        return container;
      }

      let text = `${icon} ${theme.fg("toolTitle", theme.bold(`${details.mode} `))}${theme.fg("accent", status)}`;
      for (const r of details.results) {
        const rIcon = r.exitCode === -1 ? theme.fg("warning", "⏳") : isFailure(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const displayItems = getDisplayItems(r.messages);
        text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", details.mode === "chain" ? `step ${r.step ?? "?"}` : r.label)} ${rIcon}`;
        if (isFailure(r)) text += `\n${theme.fg("error", compactResultSummary(r).split("\n").slice(0, 10).join("\n"))}`;
        else if (displayItems.length === 0) text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
        else text += `\n${renderDisplayItems(displayItems, 5)}`;
      }
      if (running === 0) {
        const usageStr = formatUsageStats(aggregateUsage(details.results));
        if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
      }
      if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
      return new Text(text, 0, 0);
    },
  };
  pi.registerTool(subagentTool);
}
