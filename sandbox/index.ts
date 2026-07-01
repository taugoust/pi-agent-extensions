/**
 * Sandbox Extension v2 — trusted Pi-side AgentSH supervisor client.
 *
 * In the detached-supervisor architecture the top-level Pi process is trusted
 * UI/control-plane code. This extension attaches to or starts an AgentSH
 * per-session supervisor, routes side-effecting tools through it, and renders
 * approval events in Pi.
 */

import { spawn } from "node:child_process";
import * as http from "node:http";
import { createConnection, type Socket } from "node:net";
import { posix as posixPath } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

type JsonObject = Record<string, unknown>;
type ProtocolMode = "mock-ndjson" | "rest" | "legacy-approval-ui" | "";
type SupervisorSource = "agentsh-env" | "agentsh-started" | "agentsh-approval-ui" | "mock" | "";
type SupervisorStatus = "inactive" | "starting" | "connecting" | "connected" | "pending" | "error";

type Actor = {
  kind: "parent" | "subagent" | "tool";
  label?: string;
  subagent_id?: string;
  subagent_depth?: number;
  tool_call_id?: string;
  task?: string;
};

type WorkspaceRoot = {
  name?: string;
  real?: string;
  work?: string;
};

type SupervisorMetadata = {
  session_id?: string;
  sessionId?: string;
  protocol_version?: number;
  supervisor_sock?: string;
  supervisorSock?: string;
  worktree?: string;
  real_workspace?: string;
  workspace_mode?: string;
  virtual_root?: string;
  workspace_roots?: WorkspaceRoot[];
  runtime_home?: string;
  runtime_tmp?: string;
  policy?: string;
  supported_ops?: string[];
  [key: string]: unknown;
};

type SupervisorMessage = {
  id?: string;
  ok?: boolean;
  error?: string;
  event?: string;
  data?: unknown;
  result?: unknown;
  approval?: ApprovalRequest;
  [key: string]: unknown;
};

type ApprovalRequest = {
  id: string;
  created_at?: string;
  expires_at?: string;
  session_id?: string;
  command_id?: string;
  kind?: string;
  target?: string;
  rule?: string;
  message?: string;
  actor?: Actor | JsonObject;
  fields?: Record<string, unknown>;
};

type ApprovalResolution = {
  decision: "approve" | "deny";
  scope?: "once" | "session";
  reason?: string;
  scope_kind?: string;
  scope_key?: string;
  scope_label?: string;
  scope_operation?: string;
  scope_path?: string;
  scope_rule?: string;
  scope_prefix?: boolean;
};

type ApprovalChoice = { label: string } & ApprovalResolution;

type ExecOptions = {
  cwd?: string;
  timeout?: number;
  timeout_ms?: number;
  actor?: Actor;
  tool_call_id?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  signal?: AbortSignal;
};

type ExecResult = { exitCode?: number | null; signal?: string | null; stdout?: string; stderr?: string; [key: string]: unknown };
type ReadFileOptions = { offset?: number; limit?: number; cwd?: string; actor?: Actor; signal?: AbortSignal };
type WriteFileOptions = { cwd?: string; actor?: Actor; signal?: AbortSignal };
type Edit = { oldText: string; newText: string };
type EditFileOptions = { cwd?: string; actor?: Actor; signal?: AbortSignal };
type SpawnSubagentOptions = { actor?: Actor; signal?: AbortSignal; onUpdate?: (message: SupervisorMessage) => void };
type ApprovalClient = {
  listApprovals(): Promise<ApprovalRequest[]>;
  resolveApproval(approvalId: string, resolution: ApprovalResolution): Promise<unknown>;
};
type SupervisorClient = MockSupervisorClient | RestSupervisorClient | LegacyApprovalUIClient;
type ApprovalWatcher = MockApprovalWatcher | RestApprovalWatcher;
type RestToolResponse<T = unknown> = { ok?: boolean; result?: T; error?: string };

type AgentSHPiAPI = {
  exec(command: string | { command: string; cwd?: string; timeout_ms?: number; actor?: Actor }, options?: ExecOptions): Promise<ExecResult>;
  readFile(path: string, options?: ReadFileOptions): Promise<unknown>;
  writeFile(path: string, content: string, options?: WriteFileOptions): Promise<unknown>;
  editFile(path: string, edits: Edit[], options?: EditFileOptions): Promise<unknown>;
  spawnSubagent(params: JsonObject, options?: SpawnSubagentOptions): Promise<unknown>;
  resolveApproval(approvalId: string, resolution: ApprovalResolution): Promise<unknown>;
  getSupervisorMetadata(): SupervisorMetadata | undefined;
  getSupervisorState(): {
    active: boolean;
    status: SupervisorStatus;
    source: SupervisorSource;
    socketPath: string;
    sessionId: string;
    metadata?: SupervisorMetadata;
    lastError?: string;
  };
};

declare global {
  // Shared convention for owned Pi extensions. This is discipline-based; trusted
  // parent-Pi extensions must use this for side effects.
  // eslint-disable-next-line no-var
  var __AGENTSH_PI__: AgentSHPiAPI | undefined;
}

type SupervisorState = {
  active: boolean;
  mode: ProtocolMode;
  activeMode: ProtocolMode;
  source: SupervisorSource;
  socketPath: string;
  status: SupervisorStatus;
  lastError: string;
  sessionId: string;
  metadata?: SupervisorMetadata;
  pendingCount: number;
  pendingIds: Set<string>;
  seenApprovals: Set<string>;
  resolving: Set<string>;
  promptAbortControllers: Map<string, AbortController>;
  promptChain: Promise<void>;
  client?: SupervisorClient;
  approvalClient?: ApprovalClient;
  watcher?: ApprovalWatcher;
  ctx?: ExtensionContext;
  attachInFlight?: Promise<void>;
};

const PROTOCOL_VERSION = 1;
const CONNECT_TIMEOUT_MS = Number(process.env.PI_AGENTSH_CONNECT_TIMEOUT_MS || "10000");
const START_TIMEOUT_MS = Number(process.env.PI_AGENTSH_START_TIMEOUT_MS || "30000");
const WATCH_RECONNECT_MS = Number(process.env.PI_AGENTSH_WATCH_RECONNECT_MS || "1500");
const APPROVAL_POLL_MS = Number(process.env.PI_AGENTSH_APPROVAL_POLL_MS || "1500");
const TOOL_REQUEST_TIMEOUT_MS = Number(process.env.PI_AGENTSH_TOOL_REQUEST_TIMEOUT_MS || "600000");
const SUBAGENT_REQUEST_TIMEOUT_MS = Number(process.env.PI_AGENTSH_SUBAGENT_REQUEST_TIMEOUT_MS || "1800000");
const VALID_POLICIES = new Set(["pi-autonomous", "pi-supervised"]);
const VALID_STAGE1_WORKSPACE_MODES = new Set(["shadow", "direct"]);

const BashParams = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

const ReadParams = Type.Object({
  path: Type.String({ description: "Path to the file to read" }),
  offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

const WriteParams = Type.Object({
  path: Type.String({ description: "Path to the file to write" }),
  content: Type.String({ description: "Content to write to the file" }),
});

const EditParams = Type.Object({
  path: Type.String({ description: "Path to the file to edit" }),
  edits: Type.Array(Type.Object({
    oldText: Type.String({ description: "Exact text to replace" }),
    newText: Type.String({ description: "Replacement text" }),
  }), { description: "Exact, non-overlapping replacements" }),
});

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

function env(name: string) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : "";
}

function effectiveSupervisorCwd(ctx?: ExtensionContext) {
  return env("PI_AGENTSH_REMOTE_CWD") || ctx?.cwd || process.cwd();
}

function normalizeSocketPath(value: string) {
  if (!value) return "";
  return value.startsWith("unix://") ? value.slice("unix://".length) : value;
}

function policyEnv() {
  const value = env("PI_AGENTSH_POLICY") || "pi-autonomous";
  return VALID_POLICIES.has(value) ? value : "pi-autonomous";
}

function workspaceModeEnv() {
  const value = env("PI_AGENTSH_WORKSPACE_MODE") || "shadow";
  return VALID_STAGE1_WORKSPACE_MODES.has(value) ? value : "shadow";
}

function centralApprovalBridgeURL() {
  return (env("AGENTSH_SESSION_EVENT_URL") || env("AGENTSH_DETACHED_EVENT_URL")).replace(/\/+$/, "");
}

function centralApprovalBridgeToken() {
  return env("AGENTSH_SESSION_EVENT_TOKEN") || env("AGENTSH_DETACHED_EVENT_TOKEN");
}

function centralApprovalBridgeEnabled() {
  return Boolean(centralApprovalBridgeURL() && centralApprovalBridgeToken());
}

function centralApprovalBridgeRequested() {
  return env("PI_AGENTSH_APPROVAL_CLIENT").toLowerCase() === "central";
}

function protocolModeFromEnv(): ProtocolMode {
  if (env("PI_AGENTSH_MOCK_SUPERVISOR")) return "mock-ndjson";
  if (env("AGENTSH_SESSION_SUPERVISOR") || shouldStartSupervisor()) return "rest";
  if (env("AGENTSH_APPROVAL_UI_SOCKET")) return "legacy-approval-ui";
  return "";
}

function integrationRequested() {
  return protocolModeFromEnv() !== "";
}

function supervisorToolIntegrationRequested() {
  const mode = protocolModeFromEnv();
  return mode === "mock-ndjson" || mode === "rest";
}

function agentshBinEnv() {
  return env("PI_AGENTSH_BIN") || "agentsh";
}

function shouldStartSupervisor() {
  return env("PI_AGENTSH_ENABLE") === "1";
}

function truncate(text: string, max = 1800) {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function stringifyData(data: unknown) {
  if (typeof data === "string") return data;
  if (data instanceof Uint8Array) return Buffer.from(data).toString("utf8");
  if (data === undefined || data === null) return "";
  return String(data);
}

function parentActor(toolCallId?: string, label?: string): Actor {
  const subagentId = env("AGENTSH_SUBAGENT_ID");
  const depth = Number(env("AGENTSH_SUBAGENT_DEPTH") || "0");
  return {
    kind: subagentId && !toolCallId ? "subagent" : toolCallId ? "tool" : "parent",
    label: label || (toolCallId ? "Pi supervised tool" : subagentId ? "Pi subagent" : "top-level Pi"),
    subagent_id: subagentId || undefined,
    subagent_depth: Number.isFinite(depth) && depth > 0 ? depth : undefined,
    tool_call_id: toolCallId,
  };
}

function metadataSessionId(metadata?: SupervisorMetadata) {
  return String(metadata?.session_id || metadata?.sessionId || metadata?.id || env("AGENTSH_SESSION_ID") || env("PI_AUTO_SESSION_ID") || "");
}

function metadataSocket(metadata?: SupervisorMetadata) {
  return normalizeSocketPath(String(metadata?.supervisor_sock || metadata?.supervisorSock || ""));
}

function normalizeStartMetadata(raw: unknown): SupervisorMetadata {
  if (!raw || typeof raw !== "object") throw new Error("agentsh session start returned non-object JSON");
  const obj = raw as JsonObject;
  const metadata = (obj.metadata && typeof obj.metadata === "object" ? obj.metadata : obj) as SupervisorMetadata;
  const supervisorSock = metadataSocket(metadata) || normalizeSocketPath(String(obj.supervisor_sock || obj.supervisorSock || ""));
  if (supervisorSock) metadata.supervisor_sock = supervisorSock;
  if (!metadata.session_id && typeof obj.session_id === "string") metadata.session_id = obj.session_id;
  return metadata;
}

function parseJsonFromOutput(output: string) {
  const trimmed = output.trim();
  if (!trimmed) throw new Error("agentsh session start produced no JSON output");
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).reverse();
    for (const line of lines) {
      try { return JSON.parse(line); } catch { /* try earlier line */ }
    }
    throw new Error(`agentsh session start did not produce parseable JSON: ${truncate(trimmed, 1000)}`);
  }
}

async function runAgentSHSessionStart(ctx: ExtensionContext) {
  const bin = agentshBinEnv();
  const policy = policyEnv();
  const workspaceMode = workspaceModeEnv();
  const args = [
    "session", "start",
    "--detach",
    "--policy", policy,
    "--workspace", effectiveSupervisorCwd(ctx),
    "--workspace-mode", workspaceMode,
    "--json",
  ];

  return await new Promise<SupervisorMetadata>((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: effectiveSupervisorCwd(ctx),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Timed out starting AgentSH supervisor after ${START_TIMEOUT_MS}ms`));
    }, START_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`agentsh session start failed with code ${code}${stderr ? `: ${truncate(stderr, 1200)}` : ""}`));
        return;
      }
      try {
        const metadata = normalizeStartMetadata(parseJsonFromOutput(stdout));
        if (!metadataSocket(metadata)) throw new Error(`agentsh session start JSON missing supervisor_sock: ${truncate(stdout, 1000)}`);
        resolve(metadata);
      } catch (error) {
        reject(asError(error));
      }
    });
  });
}

function approvalTitle(a: ApprovalRequest) {
  const kind = a.kind || "approval";
  const target = a.target || a.command_id || a.id;
  return `${kind}: ${target}`;
}

function formatActor(actor: ApprovalRequest["actor"]) {
  if (!actor || typeof actor !== "object") return "-";
  const label = typeof actor.label === "string" ? actor.label : undefined;
  const kind = typeof actor.kind === "string" ? actor.kind : "actor";
  const subagent = typeof actor.subagent_id === "string" ? ` (${actor.subagent_id})` : "";
  const tool = typeof actor.tool_call_id === "string" ? ` tool=${actor.tool_call_id}` : "";
  return `${label || kind}${subagent}${tool}`;
}

function formatApproval(a: ApprovalRequest) {
  const lines = [
    "AgentSH approval requested",
    "",
    `ID:      ${a.id}`,
    `Kind:    ${a.kind || "unknown"}`,
    `Target:  ${a.target || "-"}`,
    `Actor:   ${formatActor(a.actor)}`,
    `Rule:    ${a.rule || "-"}`,
    `Message: ${a.message || "-"}`,
  ];
  if (a.command_id) lines.push(`Command: ${a.command_id}`);
  if (a.session_id) lines.push(`Session: ${a.session_id}`);
  if (a.expires_at) lines.push(`Expires: ${a.expires_at}`);
  if (a.fields && Object.keys(a.fields).length > 0) lines.push("", "Fields:", truncate(JSON.stringify(a.fields, null, 2), 2200));
  return lines.join("\n");
}

function scopeFromObject(value: unknown): ApprovalResolution | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const kind = typeof obj.scope_kind === "string" ? obj.scope_kind.trim() : "";
  const key = typeof obj.scope_key === "string" ? obj.scope_key.trim() : "";
  if (!kind || !key) return undefined;
  return {
    decision: "approve",
    scope: "session",
    reason: "approved for session in parent Pi",
    scope_kind: kind,
    scope_key: key,
    scope_label: typeof obj.scope_label === "string" ? obj.scope_label : undefined,
    scope_operation: typeof obj.scope_operation === "string" ? obj.scope_operation : undefined,
    scope_path: typeof obj.scope_path === "string" ? obj.scope_path : undefined,
    scope_rule: typeof obj.scope_rule === "string" ? obj.scope_rule : undefined,
    scope_prefix: typeof obj.scope_prefix === "boolean" ? obj.scope_prefix : undefined,
  };
}

function sessionScopeOptions(approval: ApprovalRequest): ApprovalResolution[] {
  const fields = approval.fields || {};
  const rawOptions = Array.isArray(fields.scope_options) ? fields.scope_options : [];
  const options = rawOptions.map(scopeFromObject).filter((value): value is ApprovalResolution => Boolean(value));
  if (options.length > 0) return options;
  const fallback = scopeFromObject(fields);
  return fallback ? [fallback] : [];
}

function approvalChoices(approval: ApprovalRequest): ApprovalChoice[] {
  const title = approvalTitle(approval);
  const approveOnce: ApprovalChoice = { label: `Approve ${title}`, decision: "approve", scope: "once", reason: "approved in parent Pi" };
  const denyOnce: ApprovalChoice = { label: `Deny ${title}`, decision: "deny", scope: "once", reason: "denied in parent Pi" };
  const choices: ApprovalChoice[] = [approveOnce];
  for (const option of sessionScopeOptions(approval)) {
    const scopeTarget = option.scope_label || option.scope_key || title;
    const label = option.scope_kind ? `${option.scope_kind}: ${scopeTarget}` : scopeTarget;
    choices.push({ ...option, decision: "approve", scope: "session", reason: `approved for session ${label} in parent Pi`, label: `Approve for session ${label}` });
  }
  choices.push(denyOnce);
  for (const option of sessionScopeOptions(approval)) {
    const scopeTarget = option.scope_label || option.scope_key || title;
    const label = option.scope_kind ? `${option.scope_kind}: ${scopeTarget}` : scopeTarget;
    choices.push({ ...option, decision: "deny", scope: "session", reason: `denied for session ${label} in parent Pi`, label: `Deny for session ${label}` });
  }
  return choices;
}

function resolveChoice(choices: ApprovalChoice[], choice: string | undefined): ApprovalResolution {
  const selected = choices.find((candidate) => candidate.label === choice);
  return selected || { decision: "deny", scope: "once", reason: "denied in parent Pi" };
}

function setStatus(state: SupervisorState, ctx = state.ctx) {
  if (!ctx?.hasUI) return;
  const theme = ctx.ui.theme;
  if (!state.active) return ctx.ui.setStatus("sandbox", theme.fg("muted", "agentsh inactive"));
  if (state.status === "starting") return ctx.ui.setStatus("sandbox", theme.fg("muted", "agentsh start…"));
  if (state.status === "connecting") return ctx.ui.setStatus("sandbox", theme.fg("muted", "agentsh …"));
  if (state.status === "error") return ctx.ui.setStatus("sandbox", theme.fg("error", "agentsh ✗"));
  if (state.pendingCount > 0) return ctx.ui.setStatus("sandbox", theme.fg("warning", `agentsh ? ${state.pendingCount}`));
  ctx.ui.setStatus("sandbox", theme.fg("success", "agentsh ✓"));
}

function notify(ctx: ExtensionContext | undefined, message: string, level: "info" | "warning" | "error" = "info") {
  if (!ctx?.hasUI) return;
  ctx.ui.notify(message, level);
}

class MockSupervisorClient {
  #nextId = 1;
  readonly mode = "mock-ndjson" as const;
  constructor(readonly socketPath: string) {}

  async request<T = unknown>(op: string, params: JsonObject = {}, options: { signal?: AbortSignal; onEvent?: (message: SupervisorMessage) => void; timeoutMs?: number } = {}): Promise<T> {
    const id = `pi-${process.pid}-${this.#nextId++}`;
    const request = { id, op, params };
    return await new Promise<T>((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath });
      let buffer = "";
      let settled = false;
      let connected = false;
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      const done = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        if (connectTimer) clearTimeout(connectTimer);
        if (options.signal) options.signal.removeEventListener("abort", onAbort);
        socket.destroy();
        if (error) reject(error); else resolve(value as T);
      };
      const onAbort = () => done(new Error("AgentSH supervisor request aborted"));
      socket.setEncoding("utf8");
      connectTimer = setTimeout(() => {
        if (!connected) done(new Error(`Timed out connecting to supervisor socket ${this.socketPath}`));
      }, options.timeoutMs || CONNECT_TIMEOUT_MS);
      socket.on("connect", () => {
        connected = true;
        if (connectTimer) clearTimeout(connectTimer);
        connectTimer = undefined;
        socket.write(JSON.stringify(request) + "\n");
      });
      socket.on("data", (chunk) => {
        buffer += chunk;
        for (;;) {
          const nl = buffer.indexOf("\n");
          if (nl === -1) break;
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let message: SupervisorMessage;
          try { message = JSON.parse(line) as SupervisorMessage; } catch (error) { done(asError(error)); return; }
          if (message.id && message.id !== id) continue;
          if (message.event) { options.onEvent?.(message); continue; }
          if (typeof message.ok === "boolean") {
            if (message.ok) done(undefined, message.result as T);
            else done(new Error(message.error || `${op} failed`));
          }
        }
      });
      socket.on("error", (error) => done(error));
      socket.on("end", () => { if (!settled) done(new Error(`Supervisor socket closed before ${op} completed`)); });
      if (options.signal) {
        if (options.signal.aborted) onAbort();
        else options.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  async hello() {
    const result = await this.request<JsonObject>("hello", { client: "pi-sandbox-extension", protocol_version: PROTOCOL_VERSION });
    const metadata = normalizeStartMetadata(result.metadata && typeof result.metadata === "object" ? result : { metadata: result });
    const supported = Array.isArray(result.supported_ops) ? result.supported_ops : metadata.supported_ops;
    if (supported) metadata.supported_ops = supported as string[];
    return metadata;
  }

  async exec(command: string, options: ExecOptions = {}) {
    const timeoutMs = options.timeout_ms ?? (options.timeout ? Math.max(0, options.timeout) * 1000 : undefined);
    return await this.request<ExecResult>("exec_bash", {
      command,
      cwd: options.cwd || effectiveSupervisorCwd(),
      timeout_ms: timeoutMs,
      actor: options.actor || parentActor(options.tool_call_id, "Pi bash tool"),
    }, {
      signal: options.signal,
      onEvent: (message) => {
        if (message.event !== "stdout" && message.event !== "stderr") return;
        const stream = message.event;
        const chunk = stringifyData(message.data);
        if (stream === "stdout") options.onStdout?.(chunk); else options.onStderr?.(chunk);
        options.onOutput?.(chunk, stream);
      },
    });
  }

  async readFile(path: string, options: ReadFileOptions = {}) {
    return await this.request("read_file", { path, cwd: options.cwd, offset: options.offset, limit: options.limit, actor: options.actor || parentActor(undefined, "Pi read tool") }, { signal: options.signal });
  }

  async writeFile(path: string, content: string, options: WriteFileOptions = {}) {
    return await this.request("write_file", { path, cwd: options.cwd, content, actor: options.actor || parentActor(undefined, "Pi write tool") }, { signal: options.signal });
  }

  async editFile(path: string, edits: Edit[], options: EditFileOptions = {}) {
    const first = edits[0];
    return await this.request("edit_file", {
      path,
      cwd: options.cwd,
      edits,
      oldText: edits.length === 1 ? first?.oldText : undefined,
      newText: edits.length === 1 ? first?.newText : undefined,
      actor: options.actor || parentActor(undefined, "Pi edit tool"),
    }, { signal: options.signal });
  }

  async spawnSubagent(params: JsonObject, options: SpawnSubagentOptions = {}) {
    return await this.request("spawn_subagent", { ...params, actor: options.actor || params.actor || parentActor(undefined, "Pi subagent tool") }, {
      signal: options.signal,
      onEvent: options.onUpdate,
    });
  }

  async resolveApproval(approvalId: string, resolution: ApprovalResolution) {
    return await this.request("resolve_approval", {
      approval_id: approvalId,
      decision: resolution.decision,
      scope: resolution.scope || "once",
      reason: resolution.reason || `${resolution.decision}d in parent Pi`,
      scope_kind: resolution.scope_kind,
      scope_key: resolution.scope_key,
      scope_label: resolution.scope_label,
      scope_operation: resolution.scope_operation,
      scope_path: resolution.scope_path,
      scope_rule: resolution.scope_rule,
      scope_prefix: resolution.scope_prefix,
    });
  }

  async stop() {
    try { return await this.request("stop", {}); } catch { return undefined; }
  }
}

class MockApprovalWatcher {
  #socket?: Socket;
  #stopped = false;
  #reconnectTimer?: ReturnType<typeof setTimeout>;
  #requestId = `watch-${process.pid}-${Date.now()}`;

  constructor(private readonly client: MockSupervisorClient, private readonly onApproval: (approval: ApprovalRequest) => void, private readonly onError: (error: Error) => void) {}

  start() { this.#stopped = false; this.#connect(); }
  stop() {
    this.#stopped = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#socket?.destroy();
    this.#socket = undefined;
  }
  #scheduleReconnect() {
    if (this.#stopped || this.#reconnectTimer) return;
    this.#reconnectTimer = setTimeout(() => { this.#reconnectTimer = undefined; this.#connect(); }, WATCH_RECONNECT_MS);
  }
  #connect() {
    if (this.#stopped) return;
    const socket = createConnection({ path: this.client.socketPath });
    this.#socket = socket;
    let buffer = "";
    let connected = false;
    const connectTimer = setTimeout(() => {
      if (!connected) socket.destroy(new Error(`Timed out connecting to approval watcher ${this.client.socketPath}`));
    }, CONNECT_TIMEOUT_MS);
    let closed = false;
    const handleClose = () => {
      if (closed) return;
      closed = true;
      clearTimeout(connectTimer);
      if (this.#socket === socket) this.#socket = undefined;
      this.#scheduleReconnect();
    };
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      connected = true;
      clearTimeout(connectTimer);
      socket.write(JSON.stringify({ id: this.#requestId, op: "watch_approvals", params: { include_existing: true } }) + "\n");
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let message: SupervisorMessage;
        try { message = JSON.parse(line) as SupervisorMessage; } catch (error) { this.onError(asError(error)); continue; }
        if (message.id && message.id !== this.#requestId) continue;
        if (message.event === "approval_pending" && message.approval?.id) this.onApproval(message.approval);
        else if (message.ok === false) this.onError(new Error(message.error || "watch_approvals failed"));
      }
    });
    socket.on("error", (error) => this.onError(error));
    socket.on("close", handleClose);
    socket.on("end", handleClose);
  }
}

function abortSignalFrom(optionsSignal?: AbortSignal, timeoutMs = CONNECT_TIMEOUT_MS) {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (optionsSignal) {
    if (optionsSignal.aborted) controller.abort();
    else optionsSignal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup() {
      if (timeout) clearTimeout(timeout);
      timeout = undefined;
      if (optionsSignal) optionsSignal.removeEventListener("abort", onAbort);
    },
  };
}

function restUnsupported(op: string): never {
  throw new Error(`AgentSH REST supervisor does not implement ${op} yet. This requires a newer AgentSH supervisor tool API or the mock NDJSON protocol.`);
}

function unwrapRestToolResponse<T>(op: string, raw: unknown): T {
  const obj = (raw && typeof raw === "object" ? raw : undefined) as RestToolResponse<T> | undefined;
  if (!obj || typeof obj.ok !== "boolean") return raw as T;
  if (!obj.ok) throw new Error(obj.error || `${op} failed`);
  return obj.result as T;
}

function numericField(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function lineWindow(content: string, offset?: number, limit?: number) {
  const normalizedOffset = typeof offset === "number" && offset > 0 ? Math.floor(offset) : 1;
  const normalizedLimit = typeof limit === "number" && limit >= 0 ? Math.floor(limit) : undefined;
  if (normalizedOffset === 1 && normalizedLimit === undefined) return content;
  const lines = content.split(/\r?\n/);
  const start = Math.max(0, normalizedOffset - 1);
  const selected = normalizedLimit === undefined ? lines.slice(start) : lines.slice(start, start + normalizedLimit);
  return selected.join("\n");
}

function toSlashPath(path: string) {
  return path.replace(/\\/g, "/");
}

function cleanPosix(path: string) {
  const cleaned = posixPath.normalize(toSlashPath(path));
  return cleaned === "." ? "" : cleaned;
}

function isUnderPath(path: string, root: string) {
  const cleanPath = cleanPosix(path);
  const cleanRoot = cleanPosix(root);
  return cleanPath === cleanRoot || cleanPath.startsWith(`${cleanRoot}/`);
}

function relativeToRoot(path: string, root: string) {
  const cleanPath = cleanPosix(path);
  const cleanRoot = cleanPosix(root);
  if (cleanPath === cleanRoot) return "";
  return cleanPath.slice(cleanRoot.length + 1);
}

function stringField(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeWorkspaceRoots(value: unknown): WorkspaceRoot[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const obj = candidate as JsonObject;
    const root: WorkspaceRoot = {
      name: stringField(obj.name),
      real: stringField(obj.real),
      work: stringField(obj.work),
    };
    return root.name || root.real || root.work ? [root] : [];
  });
}

function metadataVirtualRoot(metadata?: SupervisorMetadata) {
  return stringField(metadata?.virtual_root) || "/workspace";
}

function virtualForRoot(vroot: string, root: WorkspaceRoot, rel: string) {
  const parts = [vroot, root.name || "", rel].filter(Boolean);
  return cleanPosix(parts.join("/"));
}

function absoluteToVirtual(metadata: SupervisorMetadata | undefined, path: string) {
  if (!path.startsWith("/")) return undefined;
  const abs = cleanPosix(path);
  const vroot = metadataVirtualRoot(metadata);
  if (isUnderPath(abs, vroot)) return abs;

  const roots = metadata?.workspace_roots || [];
  const singleFlatRoot = roots.length === 1 && roots[0].work && metadata?.worktree && cleanPosix(roots[0].work) === cleanPosix(metadata.worktree);
  if (singleFlatRoot) {
    const root = roots[0];
    for (const candidate of [root.work, root.real]) {
      if (candidate && isUnderPath(abs, candidate)) {
        return cleanPosix(`${vroot}/${relativeToRoot(abs, candidate)}`);
      }
    }
  }

  for (const root of roots) {
    for (const candidate of [root.work, root.real]) {
      if (candidate && isUnderPath(abs, candidate)) {
        return virtualForRoot(vroot, root, relativeToRoot(abs, candidate));
      }
    }
  }

  if (metadata?.worktree && isUnderPath(abs, metadata.worktree)) {
    return cleanPosix(`${vroot}/${relativeToRoot(abs, metadata.worktree)}`);
  }
  if (metadata?.real_workspace && isUnderPath(abs, metadata.real_workspace)) {
    return cleanPosix(`${vroot}/${relativeToRoot(abs, metadata.real_workspace)}`);
  }
  return undefined;
}

function firstPathComponent(path: string) {
  return cleanPosix(path).split("/").find(Boolean) || "";
}

function restFileRequest(metadata: SupervisorMetadata | undefined, path: string, cwd = effectiveSupervisorCwd()) {
  const directVirtual = absoluteToVirtual(metadata, toSlashPath(path));
  if (directVirtual) return { path: directVirtual };

  cwd = toSlashPath(cwd);
  const virtualCwd = absoluteToVirtual(metadata, cwd);
  if (virtualCwd) return { path, cwd: virtualCwd };

  const first = firstPathComponent(path);
  if (first && (metadata?.workspace_roots || []).some((root) => root.name === first)) {
    return { path, cwd: metadataVirtualRoot(metadata) };
  }

  return { path };
}

function sessionMetadataFromRest(raw: unknown, socketPath: string, seed?: SupervisorMetadata): SupervisorMetadata {
  const obj = (raw && typeof raw === "object" ? raw : {}) as JsonObject;
  const session = (obj.session && typeof obj.session === "object" ? obj.session : obj) as JsonObject;
  const shadow = (session.shadow && typeof session.shadow === "object" ? session.shadow : {}) as JsonObject;
  const sessionId = String(obj.session_id || obj.id || session.id || seed?.session_id || seed?.sessionId || env("AGENTSH_SESSION_ID") || "");
  const roots = normalizeWorkspaceRoots(obj.workspace_roots || session.workspace_roots || shadow.roots || seed?.workspace_roots);
  const metadata: SupervisorMetadata = {
    ...seed,
    session_id: sessionId || undefined,
    id: sessionId || undefined,
    supervisor_sock: socketPath,
    protocol_version: Number(obj.protocol_version || seed?.protocol_version || PROTOCOL_VERSION),
    policy: String(obj.policy || session.policy || seed?.policy || "") || undefined,
    real_workspace: String(obj.real_workspace || session.workspace || seed?.real_workspace || "") || undefined,
    workspace_mode: String(obj.workspace_mode || session.workspace_mode || seed?.workspace_mode || "") || undefined,
    virtual_root: String(obj.virtual_root || session.virtual_root || seed?.virtual_root || "") || undefined,
    workspace_roots: roots.length ? roots : seed?.workspace_roots,
    runtime_home: String(obj.runtime_home || session.runtime_home || seed?.runtime_home || "") || undefined,
    runtime_tmp: String(obj.runtime_tmp || session.runtime_tmp || seed?.runtime_tmp || "") || undefined,
    worktree: String(obj.worktree || session.workspace_mount || session.project_root || seed?.worktree || "") || undefined,
    supported_ops: [
      "REST /api/v1/sessions",
      "REST /api/v1/approvals",
      "REST /api/v1/sessions/{id}/tools/exec_bash",
      "REST /api/v1/sessions/{id}/tools/read_file",
      "REST /api/v1/sessions/{id}/tools/write_file",
      "REST /api/v1/sessions/{id}/tools/edit_file",
      "REST /api/v1/sessions/{id}/tools/spawn_subagent",
    ],
  };
  return metadata;
}

class RestSupervisorClient {
  readonly mode = "rest" as const;
  #sessionId: string;
  #metadata?: SupervisorMetadata;

  constructor(readonly socketPath: string, seedMetadata?: SupervisorMetadata) {
    this.#metadata = seedMetadata;
    this.#sessionId = metadataSessionId(seedMetadata);
  }

  get sessionId() { return this.#sessionId; }

  async request<T = unknown>(method: string, path: string, body?: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const { signal, cleanup } = abortSignalFrom(options.signal, options.timeoutMs || CONNECT_TIMEOUT_MS);
    return await new Promise<T>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({
        socketPath: this.socketPath,
        host: "unix",
        method,
        path,
        signal,
        headers: payload === undefined ? { Accept: "application/json" } : {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          cleanup();
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
            reject(new Error(`${method} ${path}: HTTP ${res.statusCode}${text.trim() ? `: ${truncate(text.trim(), 1000)}` : ""}`));
            return;
          }
          if (!text.trim()) { resolve(undefined as T); return; }
          try { resolve(JSON.parse(text) as T); } catch (error) { reject(asError(error)); }
        });
      });
      req.on("error", (error) => { cleanup(); reject(error); });
      req.setTimeout(options.timeoutMs || CONNECT_TIMEOUT_MS, () => req.destroy(new Error(`Timed out connecting to AgentSH REST supervisor socket ${this.socketPath}`)));
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  async hello() {
    let metadata: SupervisorMetadata | undefined;
    let lastError: Error | undefined;
    const sessionId = this.#sessionId || env("AGENTSH_SESSION_ID");
    if (sessionId) {
      try { metadata = sessionMetadataFromRest(await this.request("GET", `/api/v1/sessions/${encodeURIComponent(sessionId)}`), this.socketPath, this.#metadata); } catch (error) { lastError = asError(error); }
    }
    if (!metadata) {
      try {
        const sessions = await this.request<unknown[]>("GET", "/api/v1/sessions");
        const match = sessions.find((candidate) => {
          const obj = (candidate && typeof candidate === "object" ? candidate : {}) as JsonObject;
          return sessionId ? String(obj.id || obj.session_id || "") === sessionId : true;
        });
        if (match) metadata = sessionMetadataFromRest(match, this.socketPath, this.#metadata);
      } catch (error) { lastError = asError(error); }
    }
    if (!metadata && lastError) throw lastError;
    metadata ||= sessionMetadataFromRest(this.#metadata || {}, this.socketPath, this.#metadata);
    this.#metadata = metadata;
    this.#sessionId = metadataSessionId(metadata);
    return metadata;
  }

  async listApprovals() {
    const approvals = await this.request<ApprovalRequest[]>("GET", "/api/v1/approvals");
    if (!this.#sessionId) return approvals;
    return approvals.filter((approval) => !approval.session_id || approval.session_id === this.#sessionId);
  }

  toolPath(op: string) {
    if (!this.#sessionId) throw new Error("AgentSH REST supervisor session id is unknown; set AGENTSH_SESSION_ID or start through PI_AGENTSH_ENABLE=1");
    return `/api/v1/sessions/${encodeURIComponent(this.#sessionId)}/tools/${op}`;
  }

  async exec(command: string, options: ExecOptions = {}) {
    const timeoutMs = options.timeout_ms ?? (options.timeout ? Math.max(0, options.timeout) * 1000 : undefined);
    const raw = await this.request("POST", this.toolPath("exec_bash"), {
      command,
      cwd: options.cwd || effectiveSupervisorCwd(),
      timeout_ms: timeoutMs,
      actor: options.actor || parentActor(options.tool_call_id, "Pi bash tool"),
    }, { signal: options.signal, timeoutMs: timeoutMs ? Math.max(TOOL_REQUEST_TIMEOUT_MS, timeoutMs + CONNECT_TIMEOUT_MS) : TOOL_REQUEST_TIMEOUT_MS });
    const result = unwrapRestToolResponse<JsonObject>("exec_bash", raw);
    const stdout = String(result.stdout ?? "");
    const stderr = String(result.stderr ?? "");
    if (stdout) {
      options.onStdout?.(stdout);
      options.onOutput?.(stdout, "stdout");
    }
    if (stderr) {
      options.onStderr?.(stderr);
      options.onOutput?.(stderr, "stderr");
    }
    const exitCode = numericField(result.exitCode) ?? numericField(result.exit_code) ?? 0;
    return { ...result, exitCode, stdout, stderr } as ExecResult;
  }

  async readFile(path: string, options: ReadFileOptions = {}) {
    const file = restFileRequest(this.#metadata, path, options.cwd);
    const raw = await this.request("POST", this.toolPath("read_file"), {
      ...file,
      actor: options.actor || parentActor(undefined, "Pi read tool"),
    }, { signal: options.signal, timeoutMs: TOOL_REQUEST_TIMEOUT_MS });
    const result = unwrapRestToolResponse<JsonObject>("read_file", raw);
    if (result.encoding === "utf-8" && typeof result.content === "string") {
      return { ...result, content: lineWindow(result.content, options.offset, options.limit) };
    }
    return result;
  }

  async writeFile(path: string, content: string, options: WriteFileOptions = {}) {
    const file = restFileRequest(this.#metadata, path, options.cwd);
    const raw = await this.request("POST", this.toolPath("write_file"), {
      ...file,
      content,
      encoding: "utf-8",
      create_dirs: true,
      actor: options.actor || parentActor(undefined, "Pi write tool"),
    }, { signal: options.signal, timeoutMs: TOOL_REQUEST_TIMEOUT_MS });
    return unwrapRestToolResponse("write_file", raw);
  }

  async editFile(path: string, edits: Edit[], options: EditFileOptions = {}) {
    if (!edits.length) throw new Error("edit_file requires at least one edit");
    const results: unknown[] = [];
    for (const edit of edits) {
      const file = restFileRequest(this.#metadata, path, options.cwd);
      const raw = await this.request("POST", this.toolPath("edit_file"), {
        ...file,
        oldText: edit.oldText,
        newText: edit.newText,
        actor: options.actor || parentActor(undefined, "Pi edit tool"),
      }, { signal: options.signal, timeoutMs: TOOL_REQUEST_TIMEOUT_MS });
      results.push(unwrapRestToolResponse("edit_file", raw));
    }
    if (results.length === 1) return results[0];
    const diff = results
      .map((result: any) => typeof result?.details?.diff === "string" ? result.details.diff : typeof result?.diff === "string" ? result.diff : "")
      .filter(Boolean)
      .join("\n");
    return { path, replacements: results.length, results, ...(diff ? { diff, details: { diff } } : {}) };
  }

  async spawnSubagent(params: JsonObject, options: SpawnSubagentOptions = {}) {
    try {
      const body: JsonObject = { ...params };
      const normalizeCwd = (item: JsonObject) => {
        const cwd = typeof item.cwd === "string" ? item.cwd : "";
        const virtualCwd = cwd ? absoluteToVirtual(this.#metadata, toSlashPath(cwd)) : undefined;
        if (virtualCwd) item.cwd = virtualCwd;
      };
      normalizeCwd(body);
      for (const key of ["tasks", "chain"]) {
        if (Array.isArray(body[key])) body[key] = (body[key] as unknown[]).map((item) => {
          const obj = item && typeof item === "object" ? { ...(item as JsonObject) } : item;
          if (obj && typeof obj === "object") normalizeCwd(obj as JsonObject);
          return obj;
        });
      }
      const raw = await this.request("POST", this.toolPath("spawn_subagent"), body, { signal: options.signal, timeoutMs: SUBAGENT_REQUEST_TIMEOUT_MS });
      return unwrapRestToolResponse("spawn_subagent", raw);
    } catch (error) {
      const message = asError(error).message;
      if (message.includes("HTTP 404")) throw new Error("AgentSH supervisor does not support spawn_subagent; rebuild/deploy a newer AgentSH or disable sandbox subagent registration.");
      throw error;
    }
  }

  async resolveApproval(approvalId: string, resolution: ApprovalResolution) {
    return await this.request("POST", `/api/v1/approvals/${encodeURIComponent(approvalId)}`, approvalResolutionBody(resolution));
  }

  async stop() {
    const id = this.#sessionId;
    if (!id) return undefined;
    return await this.request("DELETE", `/api/v1/sessions/${encodeURIComponent(id)}`, undefined).catch(() => undefined);
  }
}

function approvalResolutionBody(resolution: ApprovalResolution) {
  return {
    decision: resolution.decision,
    scope: resolution.scope || "once",
    reason: resolution.reason || `${resolution.decision}d in parent Pi`,
    scope_kind: resolution.scope_kind,
    scope_key: resolution.scope_key,
    scope_label: resolution.scope_label,
    scope_operation: resolution.scope_operation,
    scope_path: resolution.scope_path,
    scope_rule: resolution.scope_rule,
    scope_prefix: resolution.scope_prefix,
  };
}

class CentralApprovalClient implements ApprovalClient {
  constructor(readonly baseURL: string, readonly sessionId: string, readonly token: string) {}

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const { signal, cleanup } = abortSignalFrom(undefined, CONNECT_TIMEOUT_MS);
    return await new Promise<T>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const url = new URL(path, `${this.baseURL}/`);
      const req = http.request(url, {
        method,
        signal,
        headers: payload === undefined ? {
          Accept: "application/json",
          "X-AgentSH-Session-Event-Token": this.token,
        } : {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "X-AgentSH-Session-Event-Token": this.token,
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          cleanup();
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
            reject(new Error(`${method} ${url.pathname}: HTTP ${res.statusCode}${text.trim() ? `: ${truncate(text.trim(), 1000)}` : ""}`));
            return;
          }
          if (!text.trim()) { resolve(undefined as T); return; }
          try { resolve(JSON.parse(text) as T); } catch (error) { reject(asError(error)); }
        });
      });
      req.on("error", (error) => { cleanup(); reject(error); });
      req.setTimeout(CONNECT_TIMEOUT_MS, () => req.destroy(new Error(`Timed out connecting to AgentSH central approvals at ${this.baseURL}`)));
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  async listApprovals() {
    return await this.request<ApprovalRequest[]>("GET", `/api/v1/detached-sessions/${encodeURIComponent(this.sessionId)}/approvals`);
  }

  async resolveApproval(approvalId: string, resolution: ApprovalResolution) {
    return await this.request("POST", `/api/v1/detached-sessions/${encodeURIComponent(this.sessionId)}/approvals/${encodeURIComponent(approvalId)}/resolution`, approvalResolutionBody(resolution));
  }
}

class LegacyApprovalUIClient {
  readonly mode = "legacy-approval-ui" as const;
  #sessionId: string;

  constructor(readonly socketPath: string) {
    this.#sessionId = env("AGENTSH_SESSION_ID") || env("PI_AUTO_SESSION_ID") || "";
  }

  get sessionId() { return this.#sessionId; }

  async request<T = unknown>(request: JsonObject): Promise<T> {
    if (!this.socketPath) throw new Error("AgentSH approval UI socket is not configured");
    return await new Promise<T>((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath });
      let buffer = "";
      let settled = false;
      const done = (err?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (err) reject(err);
        else resolve(value as T);
      };
      socket.setEncoding("utf8");
      socket.setTimeout(CONNECT_TIMEOUT_MS, () => done(new Error("approval UI socket timeout")));
      socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
      socket.on("data", (chunk) => {
        buffer += chunk;
        const nl = buffer.indexOf("\n");
        if (nl === -1) return;
        const line = buffer.slice(0, nl).trim();
        if (!line) return;
        try {
          const response = JSON.parse(line) as { ok?: boolean; error?: string } & T;
          if (!response.ok) return done(new Error(response.error || "approval UI request failed"));
          done(undefined, response as T);
        } catch (error) {
          done(asError(error));
        }
      });
      socket.on("error", (error) => done(error));
      socket.on("end", () => { if (!settled) done(new Error("approval UI socket closed before response")); });
    });
  }

  async hello() {
    return {
      session_id: this.#sessionId || undefined,
      id: this.#sessionId || undefined,
      supervisor_sock: this.socketPath,
      protocol_version: PROTOCOL_VERSION,
      supported_ops: ["legacy AGENTSH_APPROVAL_UI_SOCKET approvals"],
    } satisfies SupervisorMetadata;
  }

  async listApprovals() {
    const response = await this.request<{ approvals?: ApprovalRequest[] }>({ op: "list" });
    const approvals = response.approvals || [];
    if (!this.#sessionId) return approvals;
    return approvals.filter((approval) => !approval.session_id || approval.session_id === this.#sessionId);
  }

  async resolveApproval(approvalId: string, resolution: ApprovalResolution) {
    return await this.request({
      op: "resolve",
      id: approvalId,
      ...approvalResolutionBody(resolution),
    });
  }

  async exec(_command: string, _options: ExecOptions = {}) { return restUnsupported("exec_bash"); }
  async readFile(_path: string, _options: ReadFileOptions = {}) { return restUnsupported("read_file"); }
  async writeFile(_path: string, _content: string, _options: WriteFileOptions = {}) { return restUnsupported("write_file"); }
  async editFile(_path: string, _edits: Edit[], _options: EditFileOptions = {}) { return restUnsupported("edit_file"); }
  async spawnSubagent(_params: JsonObject, _options: SpawnSubagentOptions = {}) { return restUnsupported("spawn_subagent"); }
  async stop() { return undefined; }
}

class RestApprovalWatcher {
  #stopped = false;
  #timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly client: ApprovalClient, private readonly onApprovals: (approvals: ApprovalRequest[]) => void, private readonly onError: (error: Error) => void) {}

  start() { this.#stopped = false; void this.#poll(); }
  stop() {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
  async #poll() {
    if (this.#stopped) return;
    try { this.onApprovals(await this.client.listApprovals()); }
    catch (error) { this.onError(asError(error)); }
    finally {
      if (!this.#stopped) this.#timer = setTimeout(() => void this.#poll(), APPROVAL_POLL_MS);
    }
  }
}

function requireClient(state: SupervisorState) {
  if (!state.client || !state.active) throw new Error("AgentSH supervisor is not attached. Set PI_AGENTSH_MOCK_SUPERVISOR for mock NDJSON, or AGENTSH_SESSION_SUPERVISOR/PI_AGENTSH_ENABLE=1 for real Stage 1 REST before starting Pi.");
  return state.client;
}

function requireApprovalClient(state: SupervisorState) {
  if (!state.approvalClient || !state.active) throw new Error("AgentSH approval client is not attached.");
  return state.approvalClient;
}

function updatePending(state: SupervisorState, delta: number) {
  state.pendingCount = Math.max(0, state.pendingCount + delta);
  if (state.status !== "error") state.status = state.pendingCount > 0 ? "pending" : "connected";
  setStatus(state);
}

function removePending(state: SupervisorState, approvalId: string) {
  if (state.pendingIds.delete(approvalId)) updatePending(state, -1);
}

function syncPendingApprovals(state: SupervisorState, approvals: ApprovalRequest[]) {
  const current = new Set(approvals.map((approval) => approval.id).filter(Boolean));
  for (const id of Array.from(state.pendingIds)) {
    if (!current.has(id)) {
      state.promptAbortControllers.get(id)?.abort();
      notify(state.ctx, `AgentSH approval already handled externally: ${id}`, "info");
      removePending(state, id);
    }
  }
  for (const approval of approvals) enqueueApproval(state, approval);
}

async function promptApproval(state: SupervisorState, approval: ApprovalRequest) {
  const ctx = state.ctx;
  if (!ctx?.hasUI || state.resolving.has(approval.id)) return;
  state.resolving.add(approval.id);
  const controller = new AbortController();
  state.promptAbortControllers.set(approval.id, controller);
  try {
    const choices = approvalChoices(approval);
    const choice = await ctx.ui.select(formatApproval(approval), choices.map((candidate) => candidate.label), { signal: controller.signal });
    if (controller.signal.aborted) return;
    const resolution = resolveChoice(choices, choice);
    await requireApprovalClient(state).resolveApproval(approval.id, resolution);
    const approved = resolution.decision === "approve";
    notify(ctx, `${approved ? "Approved" : "Denied"}${resolution.scope === "session" ? " for session" : ""}: ${approvalTitle(approval)}`, approved ? "info" : "warning");
    removePending(state, approval.id);
  } catch (error) {
    if (/approval not found|HTTP 404/i.test(asError(error).message)) {
      notify(ctx, `AgentSH approval already handled externally: ${approvalTitle(approval)}`, "info");
      removePending(state, approval.id);
      return;
    }
    state.status = "error";
    state.lastError = asError(error).message;
    notify(ctx, `AgentSH approval handling failed: ${state.lastError}`, "error");
    setStatus(state);
  } finally {
    state.promptAbortControllers.delete(approval.id);
    state.resolving.delete(approval.id);
  }
}

function enqueueApproval(state: SupervisorState, approval: ApprovalRequest) {
  if (state.seenApprovals.has(approval.id) || state.resolving.has(approval.id)) return;
  state.seenApprovals.add(approval.id);
  state.pendingIds.add(approval.id);
  updatePending(state, 1);
  if (!state.ctx?.hasUI) return;
  state.promptChain = state.promptChain.catch(() => undefined).then(() => promptApproval(state, approval));
}

function resetConnection(state: SupervisorState) {
  state.watcher?.stop();
  state.watcher = undefined;
  state.client = undefined;
  state.approvalClient = undefined;
  state.metadata = undefined;
  state.active = false;
  state.activeMode = "";
  state.status = "inactive";
  state.socketPath = "";
  state.source = "";
  state.sessionId = "";
  state.pendingCount = 0;
  state.pendingIds.clear();
  state.seenApprovals.clear();
  for (const controller of state.promptAbortControllers.values()) controller.abort();
  state.promptAbortControllers.clear();
  state.resolving.clear();
}

async function attachToSocket(state: SupervisorState, mode: ProtocolMode, source: SupervisorSource, socketPath: string, ctx: ExtensionContext, seedMetadata?: SupervisorMetadata) {
  state.active = true;
  state.activeMode = mode;
  state.source = source;
  state.socketPath = socketPath;
  state.metadata = seedMetadata;
  state.sessionId = metadataSessionId(seedMetadata);
  state.status = "connecting";
  setStatus(state, ctx);

  const client: SupervisorClient = mode === "mock-ndjson"
    ? new MockSupervisorClient(socketPath)
    : mode === "legacy-approval-ui"
      ? new LegacyApprovalUIClient(socketPath)
      : new RestSupervisorClient(socketPath, seedMetadata);
  state.client = client;
  state.approvalClient = client;
  const metadata = await client.hello();
  state.metadata = { ...seedMetadata, ...metadata, supervisor_sock: socketPath };
  state.sessionId = metadataSessionId(state.metadata);
  state.status = "connected";
  setStatus(state, ctx);

  if (mode === "rest" && centralApprovalBridgeRequested() && centralApprovalBridgeEnabled() && state.sessionId) {
    state.approvalClient = new CentralApprovalClient(centralApprovalBridgeURL(), state.sessionId, centralApprovalBridgeToken());
  }

  state.watcher = mode === "mock-ndjson"
    ? new MockApprovalWatcher(client as MockSupervisorClient, (approval) => enqueueApproval(state, approval), (error) => {
      state.lastError = error.message;
      if (state.status !== "pending") state.status = "error";
      setStatus(state);
    })
    : new RestApprovalWatcher(client as RestSupervisorClient | LegacyApprovalUIClient, (approvals) => syncPendingApprovals(state, approvals), (error) => {
      state.lastError = error.message;
      if (state.status !== "pending") state.status = "error";
      setStatus(state);
    });
  state.watcher.start();
}

async function attachOrStart(state: SupervisorState, ctx: ExtensionContext, options: { forceStart?: boolean; notifyOnSuccess?: boolean } = {}) {
  if (state.attachInFlight) return await state.attachInFlight;
  state.attachInFlight = (async () => {
    state.ctx = ctx;
    state.mode = protocolModeFromEnv();
    resetConnection(state);
    state.ctx = ctx;
    state.mode = protocolModeFromEnv();
    state.lastError = "";

    const mockSock = normalizeSocketPath(env("PI_AGENTSH_MOCK_SUPERVISOR"));
    if (mockSock && !options.forceStart) {
      await attachToSocket(state, "mock-ndjson", "mock", mockSock, ctx);
      if (options.notifyOnSuccess) notify(ctx, `AgentSH mock supervisor attached: ${state.sessionId || mockSock}`, "info");
      return;
    }

    const envSock = normalizeSocketPath(env("AGENTSH_SESSION_SUPERVISOR"));
    if (envSock && !options.forceStart) {
      await attachToSocket(state, "rest", "agentsh-env", envSock, ctx);
      if (options.notifyOnSuccess) notify(ctx, `AgentSH REST supervisor attached: ${state.sessionId || envSock}`, "info");
      return;
    }

    const approvalUISock = normalizeSocketPath(env("AGENTSH_APPROVAL_UI_SOCKET"));
    if (approvalUISock && !options.forceStart) {
      await attachToSocket(state, "legacy-approval-ui", "agentsh-approval-ui", approvalUISock, ctx);
      if (options.notifyOnSuccess) notify(ctx, `AgentSH approval UI socket attached: ${state.sessionId || approvalUISock}`, "info");
      return;
    }

    if (shouldStartSupervisor() || options.forceStart) {
      state.active = true;
      state.source = "agentsh-started";
      state.status = "starting";
      setStatus(state, ctx);
      const started = await runAgentSHSessionStart(ctx);
      const sock = metadataSocket(started);
      if (!sock) throw new Error("Started AgentSH session did not report supervisor_sock");
      await attachToSocket(state, "rest", "agentsh-started", sock, ctx, started);
      if (options.notifyOnSuccess) notify(ctx, `AgentSH REST supervisor started: ${state.sessionId || sock}`, "info");
      return;
    }

    state.status = "inactive";
    state.active = false;
    setStatus(state, ctx);
  })().catch((error) => {
    state.active = true;
    state.status = "error";
    state.lastError = asError(error).message;
    setStatus(state, ctx);
    throw error;
  }).finally(() => { state.attachInFlight = undefined; });
  return await state.attachInFlight;
}

function helpText(state: SupervisorState) {
  if (!state.active) {
    return [
      "AgentSH supervisor client is inactive.",
      "",
      "Attach with AGENTSH_SESSION_SUPERVISOR=<supervisor.sock>, use legacy AGENTSH_APPROVAL_UI_SOCKET=<ui.sock>,",
      "test with PI_AGENTSH_MOCK_SUPERVISOR=<mock.sock>, or start a detached supervisor with PI_AGENTSH_ENABLE=1.",
      "",
      "Optional env: PI_AGENTSH_POLICY=pi-autonomous|pi-supervised, PI_AGENTSH_WORKSPACE_MODE=shadow|direct, PI_AGENTSH_BIN=agentsh.",
    ].join("\n");
  }
  return [
    "AgentSH supervisor client status",
    "",
    `Source:   ${state.source}`,
    `Mode:     ${state.activeMode || state.mode || "-"}`,
    `Socket:   ${state.socketPath}`,
    `Session:  ${state.sessionId || "-"}`,
    `Status:   ${state.status}`,
    `Pending:  ${state.pendingCount}`,
    state.metadata?.policy ? `Policy:   ${state.metadata.policy}` : "",
    state.metadata?.workspace_mode ? `Workspace: ${state.metadata.workspace_mode}` : "",
    state.metadata?.worktree ? `Worktree: ${state.metadata.worktree}` : "",
    state.metadata?.real_workspace ? `Real:     ${state.metadata.real_workspace}` : "",
    state.metadata?.protocol_version ? `Protocol: ${state.metadata.protocol_version}` : `Protocol: ${PROTOCOL_VERSION}`,
    Array.isArray(state.metadata?.supported_ops) ? `Ops:      ${state.metadata.supported_ops.join(", ")}` : "",
    state.lastError ? `Error:    ${state.lastError}` : "",
  ].filter(Boolean).join("\n");
}

function grantGuidance(kind: string, target: string, reason: string, state: SupervisorState) {
  const active = state.active ? `attached to ${state.source} supervisor ${state.sessionId || state.socketPath}` : "inactive (missing supervisor socket/start env)";
  return [
    `AgentSH owns ${kind} grants; this extension does not mutate local sandbox policy.`,
    `Supervisor client: ${active}`,
    target ? `Target: ${target}` : "",
    reason ? `Reason: ${reason}` : "",
    "",
    "Retry the blocked operation. If AgentSH policy requires approval, the supervisor should emit approval_pending and this extension will prompt the user.",
  ].filter(Boolean).join("\n");
}

function createGlobalAPI(state: SupervisorState): AgentSHPiAPI {
  return {
    async exec(commandOrParams, options = {}) {
      const client = requireClient(state);
      if (typeof commandOrParams === "string") return await client.exec(commandOrParams, options);
      return await client.exec(commandOrParams.command, { ...options, cwd: commandOrParams.cwd ?? options.cwd, timeout_ms: commandOrParams.timeout_ms ?? options.timeout_ms, actor: commandOrParams.actor ?? options.actor });
    },
    async readFile(path, options = {}) { return await requireClient(state).readFile(path, options); },
    async writeFile(path, content, options = {}) { return await requireClient(state).writeFile(path, content, options); },
    async editFile(path, edits, options = {}) { return await requireClient(state).editFile(path, edits, options); },
    async spawnSubagent(params, options = {}) { return await requireClient(state).spawnSubagent(params, options); },
    async resolveApproval(approvalId, resolution) { return await requireApprovalClient(state).resolveApproval(approvalId, resolution); },
    getSupervisorMetadata() { return state.metadata; },
    getSupervisorState() {
      return { active: state.active, status: state.status, source: state.source, socketPath: state.socketPath, sessionId: state.sessionId, metadata: state.metadata, lastError: state.lastError || undefined };
    },
  };
}

function textFromResult(result: any, fallback = "") {
  if (typeof result === "string") return result;
  if (typeof result?.text === "string") return result.text;
  if (typeof result?.content === "string") return result.content;
  if (Array.isArray(result?.content)) return result.content.map((item: any) => typeof item?.text === "string" ? item.text : "").filter(Boolean).join("\n");
  return fallback;
}

function contentFromReadResult(result: any) {
  if (Array.isArray(result?.content)) return result.content;
  if (typeof result?.base64 === "string" && typeof result?.mimeType === "string" && result.mimeType.startsWith("image/")) {
    return [{ type: "image", source: { type: "base64", media_type: result.mimeType, data: result.base64 } }];
  }
  return [{ type: "text", text: textFromResult(result, "") }];
}

function renderSandboxFileToolCall(toolName: string, args: any, theme: any) {
  const path = typeof args?.path === "string" && args.path ? args.path : "(unknown path)";
  return new Text(`${theme.fg("toolTitle", toolName)} ${theme.fg("accent", path)}`, 0, 0);
}

function renderSandboxFileToolResult(result: any, _options: any, theme: any) {
  const details = result?.details && typeof result.details === "object" ? result.details : {};
  const diff = typeof details.diff === "string" && details.diff ? details.diff : undefined;
  const text = textFromResult(result, "");
  const output = diff ? `${text ? `${text}\n\n` : ""}${diff}` : text;
  return new Text(theme.fg("toolOutput", output || "(no output)"), 0, 0);
}

function subagentText(result: any) {
  return textFromResult(result, result?.final || result?.summary || result?.stdout || JSON.stringify(result ?? {}, null, 2));
}

export default function sandbox(pi: ExtensionAPI) {
  const state: SupervisorState = {
    active: false,
    mode: protocolModeFromEnv(),
    activeMode: "",
    source: "",
    socketPath: "",
    status: "inactive",
    lastError: "",
    sessionId: "",
    pendingCount: 0,
    pendingIds: new Set(),
    seenApprovals: new Set(),
    resolving: new Set(),
    promptAbortControllers: new Map(),
    promptChain: Promise.resolve(),
  };

  globalThis.__AGENTSH_PI__ = createGlobalAPI(state);

  pi.on("session_start", async (_event, ctx) => {
    try {
      await attachOrStart(state, ctx, { notifyOnSuccess: false });
    } catch {
      // Status bar carries the error. Avoid startup notification spam.
    }
  });

  pi.on("session_shutdown", async () => {
    resetConnection(state);
    if (state.ctx?.hasUI) state.ctx.ui.setStatus("sandbox", undefined);
    state.ctx = undefined;
  });

  pi.registerCommand("sandbox", {
    description: "Show AgentSH supervisor-client status",
    handler: async (_args, ctx) => notify(ctx, helpText(state), state.status === "error" ? "error" : "info"),
  });

  pi.registerCommand("sandbox-control", {
    description: "Control AgentSH supervisor client: status, reconnect, start, stop",
    handler: async (args, ctx) => {
      const action = (args || "status").trim() || "status";
      try {
        if (action === "reconnect") {
          await attachOrStart(state, ctx, { notifyOnSuccess: true });
          return;
        }
        if (action === "start") {
          await attachOrStart(state, ctx, { forceStart: true, notifyOnSuccess: true });
          return;
        }
        if (action === "stop") {
          if (state.client) {
            try { await state.client.stop(); } catch { /* older/mock supervisors may not support stop */ }
          }
          resetConnection(state);
          setStatus(state, ctx);
          notify(ctx, "AgentSH supervisor client stopped/detached", "info");
          return;
        }
        notify(ctx, helpText(state), state.status === "error" ? "error" : "info");
      } catch (error) {
        state.status = "error";
        state.lastError = asError(error).message;
        setStatus(state, ctx);
        notify(ctx, `sandbox-control ${action} failed: ${state.lastError}`, "error");
      }
    },
  });

  pi.registerCommand("sandbox-allow", {
    description: "Explain AgentSH approval flow for a target path/domain",
    handler: async (args, ctx) => notify(ctx, grantGuidance("access", args?.trim?.() || "", "manual request", state), "info"),
  });

  if (supervisorToolIntegrationRequested()) {
    pi.registerTool({
      name: "bash",
    label: "bash",
    description: "Execute a bash command through the AgentSH session supervisor. Streams stdout/stderr and returns the final exit code.",
    parameters: BashParams,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const client = requireClient(state);
      let output = "";
      const emit = () => onUpdate?.({ content: output ? [{ type: "text", text: output }] : [], details: undefined });
      onUpdate?.({ content: [], details: undefined });
      const result = await client.exec(params.command, { cwd: effectiveSupervisorCwd(ctx), timeout: params.timeout, tool_call_id: toolCallId, signal, onOutput: (chunk) => { output += chunk; emit(); } });
      const exitCode = typeof result.exitCode === "number" ? result.exitCode : 0;
      const finalText = output || "(no output)";
      if (exitCode !== 0) throw new Error(`${finalText}\n\nCommand exited with code ${exitCode}`);
      return { content: [{ type: "text", text: finalText }], details: { exitCode } };
    },
  });

  if (env("PI_AGENTSH_READ_MODE") === "supervised") {
    pi.registerTool({
      name: "read",
      label: "read",
      description: "Read a file through the AgentSH session supervisor. Ordinary project reads are native unless PI_AGENTSH_READ_MODE=supervised.",
      parameters: ReadParams,
      async execute(toolCallId, params, signal, _onUpdate, ctx) {
        const result = await requireClient(state).readFile(params.path, { cwd: effectiveSupervisorCwd(ctx), offset: params.offset, limit: params.limit, actor: parentActor(toolCallId, "Pi read tool"), signal });
        return { content: contentFromReadResult(result), details: (result as any)?.details };
      },
    });
  }

  pi.registerTool({
    name: "write",
    label: "write",
    description: "Write content to a file through the AgentSH session supervisor.",
    parameters: WriteParams,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const result = await requireClient(state).writeFile(params.path, params.content, { cwd: effectiveSupervisorCwd(ctx), actor: parentActor(toolCallId, "Pi write tool"), signal });
      return { content: [{ type: "text", text: textFromResult(result, `Wrote ${params.path}`) }], details: undefined };
    },
  });

  pi.registerTool({
    name: "edit",
    label: "edit",
    description: "Edit a file through the AgentSH session supervisor using exact text replacements.",
    parameters: EditParams,
    renderCall(args, theme) {
      return renderSandboxFileToolCall("edit", args, theme);
    },
    renderResult(result, options, theme) {
      return renderSandboxFileToolResult(result, options, theme);
    },
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const result = await requireClient(state).editFile(params.path, params.edits, { cwd: effectiveSupervisorCwd(ctx), actor: parentActor(toolCallId, "Pi edit tool"), signal });
      return { content: [{ type: "text", text: textFromResult(result, `Edited ${params.path}`) }], details: (result as any)?.details || { diff: (result as any)?.diff } };
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Delegate focused work to an AgentSH-supervised sandboxed subagent in the same detached supervisor session.",
    parameters: SubagentParams,
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const hasSingle = typeof params.task === "string" && params.task.trim().length > 0;
      const hasTasks = Array.isArray(params.tasks) && params.tasks.length > 0;
      const hasChain = Array.isArray(params.chain) && params.chain.length > 0;
      if (Number(hasSingle) + Number(hasTasks) + Number(hasChain) !== 1) {
        throw new Error("Invalid parameters. Provide exactly one mode: task, non-empty tasks, or non-empty chain.");
      }
      let latest = "";
      const result = await requireClient(state).spawnSubagent({ ...params, cwd: params.cwd || effectiveSupervisorCwd(ctx), actor: parentActor(toolCallId, "Pi subagent tool") }, {
        signal,
        onUpdate: (message) => {
          if (message.event === "stdout" || message.event === "stderr" || message.event === "message" || message.event === "subagent_update") {
            latest += stringifyData(message.data || message.result || "");
            if (latest) onUpdate?.({ content: [{ type: "text", text: latest }], details: { lastEvent: message } });
          } else if (message.event === "tool_update") {
            onUpdate?.({ content: latest ? [{ type: "text", text: latest }] : [], details: { lastEvent: message } });
          }
        },
      });
      const text = subagentText(result);
      return { content: [{ type: "text", text }], details: result as any };
    },
  });

  }

  pi.registerTool({
    name: "sandbox_allow_path",
    label: "Request AgentSH write approval",
    description: "Request write access guidance. AgentSH owns enforcement; retry the blocked operation to trigger an approval prompt.",
    parameters: Type.Object({ path: Type.String({ description: "The filesystem path to allow write access to" }), reason: Type.String({ description: "Why write access is needed" }) }),
    async execute(_id, params) { return { content: [{ type: "text", text: grantGuidance("write", params.path, params.reason, state) }], details: undefined }; },
  });

  pi.registerTool({
    name: "sandbox_allow_read_path",
    label: "Request AgentSH read approval",
    description: "Request read access guidance. AgentSH owns enforcement; retry the blocked operation to trigger an approval prompt.",
    parameters: Type.Object({ path: Type.String({ description: "The filesystem path to allow read access to" }), reason: Type.String({ description: "Why read access is needed" }) }),
    async execute(_id, params) { return { content: [{ type: "text", text: grantGuidance("read", params.path, params.reason, state) }], details: undefined }; },
  });

  pi.registerTool({
    name: "sandbox_allow_domain",
    label: "Request AgentSH network approval",
    description: "Request network access guidance. AgentSH owns enforcement; retry the blocked operation to trigger an approval prompt.",
    parameters: Type.Object({ domain: Type.String({ description: "The domain to allow" }), reason: Type.String({ description: "Why network access is needed" }) }),
    async execute(_id, params) { return { content: [{ type: "text", text: grantGuidance("network", params.domain, params.reason, state) }], details: undefined }; },
  });

  pi.registerTool({
    name: "sandbox_allow_unix_socket",
    label: "Request AgentSH Unix socket approval",
    description: "Request Unix socket access guidance. AgentSH owns enforcement; retry the blocked operation to trigger an approval prompt.",
    parameters: Type.Object({ path: Type.String({ description: "The unix socket path to allow" }), reason: Type.String({ description: "Why socket access is needed" }) }),
    async execute(_id, params) { return { content: [{ type: "text", text: grantGuidance("unix socket", params.path, params.reason, state) }], details: undefined }; },
  });
}
