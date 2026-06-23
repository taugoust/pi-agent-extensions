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
import type { Message } from "@mariozechner/pi-ai";
import type { AgentToolResult, ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getAgentDir, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const MAX_TEXT_PREVIEW_BYTES = 50 * 1024;
const CONFIG_FILES = ["settings.json", "models.json", "auth.json", "oauth.json", "AGENTS.md"];

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
  mode: Mode;
  results: SingleResult[];
};

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
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return text;
  const buf = Buffer.from(text, "utf8");
  return `${buf.subarray(0, maxBytes).toString("utf8")}\n\n… truncated preview at ${formatTokens(maxBytes)}B (${formatTokens(bytes)}B total)`;
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

function stderrTail(stderr: string, maxLines = 8): string {
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

function resolvePiInvocation(args: string[]): { command: string; args: string[]; warning?: string } {
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
      if (process.platform !== "win32") process.kill(-proc.pid!, "SIGKILL");
      else proc.kill("SIGKILL");
    } catch {
      // already exited
    }
  }, 5000).unref?.();
}

async function runSingleSubagent(
  defaultCwd: string,
  spec: SubagentSpec,
  label: string,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => SubagentDetails,
): Promise<SingleResult> {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (spec.model) args.push("--model", spec.model);
  if (spec.tools?.length) args.push("--tools", spec.tools.join(","));

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;
  const subagentId = makeSubagentId(label);
  let childAgentDir: string | undefined;
  let childSessionDir: string | undefined;

  const currentResult: SingleResult = {
    label,
    task: spec.task,
    exitCode: 0,
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

  try {
    childAgentDir = await prepareChildAgentDir(subagentId);
    childSessionDir = path.join(childAgentDir, "sessions");
    currentResult.childAgentDir = childAgentDir;

    if (spec.systemPrompt?.trim()) {
      const tmp = await writePromptToTempFile(label, spec.systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
      args.push("--append-system-prompt", tmpPromptPath);
    }

    args.push(`Task: ${spec.task}`);
    const invocation = resolvePiInvocation(args);
    currentResult.command = invocation.command;
    currentResult.args = invocation.args;
    currentResult.warning = invocation.warning;
    if (invocation.warning) currentResult.stderr += `Warning: ${invocation.warning}\n`;

    let wasAborted = false;
    const exitCode = await new Promise<number>((resolve) => {
      const env = {
        ...process.env,
        PI_CODING_AGENT_DIR: childAgentDir,
        PI_CODING_AGENT_SESSION_DIR: childSessionDir,
      };
      const proc = spawn(invocation.command, invocation.args, {
        cwd: spec.cwd ?? defaultCwd,
        env,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "";
      let settled = false;
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
        if (buffer.trim()) processLine(buffer);
        if (abortHandler && signal) signal.removeEventListener("abort", abortHandler);
        if (code !== null && code !== undefined) finish(code);
        else if (closeSignal === "SIGTERM") finish(143);
        else if (closeSignal === "SIGKILL") finish(137);
        else finish(0);
      });

      proc.on("error", (error) => {
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

    currentResult.exitCode = wasAborted ? exitCode || 130 : exitCode;
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
    currentResult.exitCode = signal?.aborted ? 130 : currentResult.exitCode || 1;
    currentResult.stopReason = signal?.aborted ? "aborted" : "error";
    currentResult.errorMessage = signal?.aborted ? "Subagent aborted by user." : message;
    currentResult.stderr += `${message}\n`;
    return currentResult;
  } finally {
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
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted" || result.stopReason === "timeout";
}

function resultErrorText(result: SingleResult): string {
  if (isFailure(result)) return compactResultSummary(result);
  return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
}

const SubagentItem = Type.Object({
  task: Type.String({ description: "Task to delegate to this dynamic subagent" }),
  systemPrompt: Type.Optional(Type.String({ description: "Optional additional system prompt for this subagent" })),
  model: Type.Optional(Type.String({ description: "Optional model id for this subagent" })),
  tools: Type.Optional(Type.Array(Type.String(), { description: "Optional tool allowlist, e.g. ['read','grep','find','ls']" })),
  cwd: Type.Optional(Type.String({ description: "Optional working directory for this subagent process" })),
});

const SubagentParams = Type.Object({
  task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
  systemPrompt: Type.Optional(Type.String({ description: "Optional additional system prompt (single mode)" })),
  model: Type.Optional(Type.String({ description: "Optional model id (single mode)" })),
  tools: Type.Optional(Type.Array(Type.String(), { description: "Optional tool allowlist (single mode)" })),
  cwd: Type.Optional(Type.String({ description: "Optional working directory (single mode)" })),
  tasks: Type.Optional(Type.Array(SubagentItem, { description: "Parallel subagent tasks. Max 8, up to 4 run concurrently." })),
  chain: Type.Optional(Type.Array(SubagentItem, { description: "Sequential subagent steps. Each task may use {previous}." })),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: [
      "Delegate focused work to same-session dynamic child Pi processes.",
      "Exactly one mode: single task, parallel tasks, or chain steps.",
      "Each child inherits the parent AgentSH sandbox/session as a descendant process; do not use this to spawn pi-auto or AgentSH wrappers.",
    ].join(" "),
    parameters: SubagentParams,

    async execute(_toolCallId, params: any, signal, onUpdate, ctx) {
      const hasSingle = typeof params.task === "string" && params.task.trim().length > 0;
      const hasTasks = Array.isArray(params.tasks) && params.tasks.length > 0;
      const hasChain = Array.isArray(params.chain) && params.chain.length > 0;
      const modeCount = Number(hasSingle) + Number(hasTasks) + Number(hasChain);
      const mode: Mode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
      const makeDetails = (detailsMode: Mode) => (results: SingleResult[]): SubagentDetails => ({ mode: detailsMode, results });

      if (modeCount !== 1) {
        return {
          content: [{ type: "text", text: "Invalid parameters. Provide exactly one mode: task, non-empty tasks, or non-empty chain." }],
          details: makeDetails(mode)([]),
          isError: true,
        };
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

          const result = await runSingleSubagent(ctx.cwd, stepSpec, label, i + 1, signal, chainUpdate, makeDetails("chain"));
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
          return {
            content: [{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
            details: makeDetails("parallel")([]),
            isError: true,
          };
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
          );
          allResults[index] = result;
          emitParallelUpdate();
          return result;
        });

        const successCount = results.filter((r) => !isFailure(r)).length;
        const summaries = results.map((r) => {
          if (isFailure(r)) return `[${r.label}] ${compactResultSummary(r)}`;
          const output = getFinalOutput(r.messages);
          const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
          return `[${r.label}] completed: ${preview || "(no output)"}`;
        });
        return {
          content: [{ type: "text", text: truncateByBytes(`Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`) }],
          details: makeDetails("parallel")(results),
          isError: successCount !== results.length,
        };
      }

      const result = await runSingleSubagent(ctx.cwd, specFromParams(params), "subagent", undefined, signal, onUpdate, makeDetails("single"));
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

    renderResult(result, { expanded }, theme) {
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
  });
}
