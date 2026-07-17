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
import { homedir } from "node:os";
import { posix as posixPath } from "node:path";
import { Type } from "@sinclair/typebox";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, getMarkdownTheme, renderDiff, truncateHead, truncateTail, type ExtensionAPI, type ExtensionContext, type TruncationResult } from "@mariozechner/pi-coding-agent";
import { Box, Container, Key, Markdown, matchesKey, Spacer, Text, truncateToWidth, type Component } from "@mariozechner/pi-tui";
import { inheritSubagentModels } from "./subagent-model.js";
import { abortSubagentProtocolStream, appendSubagentProtocolChunk, createSubagentProtocolState, finishSubagentProtocolStream } from "./subagent-protocol.js";
import { boundSubagentProgressCapsules, createSubagentProgressCapsule, sanitizeSubagentParentText } from "./subagent-result.js";
import { appendSubagentPrefix, appendSubagentRawText, appendSubagentStdoutChunk, createSubagentStreamState, flushSubagentStdout, parseSubagentPiJsonStdout, subagentLiveToolStatus, tailByBytes, truncateByBytes, usageNumber, usageZero, type SubagentStreamState } from "./subagent-stream.js";
import { normalizeSubagentTerminal, subagentTerminalFailed } from "./subagent-terminal.js";
import type { AgentSHDirenvAPI, DirenvRefreshOptions, DirenvRefreshResult, DirenvRefreshState } from "./api.js";

type JsonObject = Record<string, unknown>;
type ProtocolMode = "mock-ndjson" | "rest" | "legacy-approval-ui" | "";
type SupervisorSource = "agentsh-env" | "agentsh-started" | "agentsh-approval-ui" | "mock" | "";
type SupervisorStatus = "inactive" | "starting" | "connecting" | "connected" | "pending" | "error";

type Actor = {
  kind: "parent" | "subagent" | "tool" | "extension";
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

type NetworkEnforcement = {
  requested?: "none" | "best-effort" | "strict" | string;
  readiness?: "none" | "degraded" | "ready" | "active" | "failed" | string;
  status?: "none" | "degraded" | "ready" | "active" | "failed" | string;
  tier?: string;
  network_policy_enforced?: boolean;
  checked_at?: string;
  detail?: string;
  warning?: string;
  [key: string]: unknown;
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
  network_enforcement?: NetworkEnforcement;
  networkEnforcement?: NetworkEnforcement;
  network_enforcement_live?: boolean;
  network_enforcement_error?: string;
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
  persist_output_over_bytes?: number;
  persist_output_over_lines?: number;
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
type RestConnectionEvents = {
  onReconnecting?(error: Error, deadline: number): void;
  onReconnected?(metadata: SupervisorMetadata): void;
  onReconnectFailed?(error: Error): void;
  onSessionLost?(error: Error): void;
};

export type AgentSHPiAPI = AgentSHDirenvAPI & {
  exec(command: string | { command: string; cwd?: string; timeout_ms?: number; persist_output_over_bytes?: number; persist_output_over_lines?: number; actor?: Actor }, options?: ExecOptions): Promise<ExecResult>;
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
  terminalError: boolean;
};

const PROTOCOL_VERSION = 1;
const CONNECT_TIMEOUT_MS = Number(process.env.PI_AGENTSH_CONNECT_TIMEOUT_MS || "10000");
const START_TIMEOUT_MS = Number(process.env.PI_AGENTSH_START_TIMEOUT_MS || "30000");
const WATCH_RECONNECT_MS = Number(process.env.PI_AGENTSH_WATCH_RECONNECT_MS || "1500");
const SUPERVISOR_RECONNECT_TIMEOUT_MS = Number(process.env.PI_AGENTSH_RECONNECT_TIMEOUT_MS || "30000");
const SUPERVISOR_RECONNECT_INITIAL_MS = Number(process.env.PI_AGENTSH_RECONNECT_INITIAL_MS || "100");
const APPROVAL_POLL_MS = Number(process.env.PI_AGENTSH_APPROVAL_POLL_MS || "1500");
const TOOL_REQUEST_TIMEOUT_MS = Number(process.env.PI_AGENTSH_TOOL_REQUEST_TIMEOUT_MS || "600000");
const APPROVAL_REQUEST_TIMEOUT_SLACK_MS = Number(process.env.PI_AGENTSH_APPROVAL_TIMEOUT_SLACK_MS || "300000");
const CONFIGURED_SUBAGENT_EXECUTION_TIMEOUT_MS = optionalPositiveTimeoutEnv("PI_AGENTSH_SUBAGENT_EXECUTION_TIMEOUT_MS");
const LEGACY_SUBAGENT_EXECUTION_TIMEOUT_MS = CONFIGURED_SUBAGENT_EXECUTION_TIMEOUT_MS === undefined
  ? optionalPositiveTimeoutEnv("PI_AGENTSH_SUBAGENT_REQUEST_TIMEOUT_MS")
  : undefined;
const SUBAGENT_EXECUTION_TIMEOUT_MS = CONFIGURED_SUBAGENT_EXECUTION_TIMEOUT_MS ?? LEGACY_SUBAGENT_EXECUTION_TIMEOUT_MS ?? 7_200_000;
const SUBAGENT_TRANSPORT_SLACK_MS = optionalPositiveTimeoutEnv("PI_AGENTSH_SUBAGENT_TRANSPORT_SLACK_MS") ?? 300_000;
const SUBAGENT_TRANSPORT_TIMEOUT_FLOOR_MS = optionalPositiveTimeoutEnv("PI_AGENTSH_SUBAGENT_TRANSPORT_TIMEOUT_MS");
const MAX_NODE_TIMEOUT_MS = 2_147_483_647;
const VALID_POLICIES = new Set(["pi-autonomous", "pi-supervised"]);
const VALID_STAGE1_WORKSPACE_MODES = new Set(["shadow", "direct"]);

function supervisorErrorCode(error: unknown) {
  const candidate = error && typeof error === "object" ? error as { code?: unknown } : undefined;
  return typeof candidate?.code === "string" ? candidate.code : "";
}

// These connect(2) failures prove that no request reached the Unix listener.
// Do not broaden this to message matching: HTTP bodies and post-dispatch errors
// can contain the same words without being safe to replay.
function supervisorSocketUnavailable(error: unknown) {
  const code = supervisorErrorCode(error);
  return code === "ECONNREFUSED" || code === "ENOENT";
}

class SafeSupervisorConnectError extends Error {
  readonly code: "ECONNREFUSED" | "ENOENT";

  constructor(error: unknown) {
    const cause = asError(error);
    super(cause.message);
    this.name = "SafeSupervisorConnectError";
    this.code = supervisorErrorCode(error) as "ECONNREFUSED" | "ENOENT";
  }
}

class RestHTTPError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly statusCode: number,
    readonly body: string,
  ) {
    super(`${method} ${path}: HTTP ${statusCode}${body.trim() ? `: ${truncate(body.trim(), 1000)}` : ""}`);
    this.name = "RestHTTPError";
  }
}

class SupervisorRequestTimeoutError extends Error {
  constructor(readonly timeoutMs: number, operation: string) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = "SupervisorRequestTimeoutError";
  }
}

class SubagentTransportTimeoutError extends Error {
  constructor(readonly executionTimeoutMs: number, readonly transportTimeoutMs: number) {
    super(`AgentSH subagent transport timed out after ${transportTimeoutMs}ms while waiting for the server terminal event (execution deadline ${executionTimeoutMs}ms)`);
    this.name = "SubagentTransportTimeoutError";
  }
}

class SupervisorSessionLostError extends Error {
  constructor(readonly sessionId: string, detail: string) {
    super(`AgentSH session ${sessionId || "(unknown)"} was not found or changed while reconnecting. The detached remote session is no longer safe to use. ${detail}`);
    this.name = "SupervisorSessionLostError";
  }
}

function supervisorRequestAborted() {
  const error = new Error("AgentSH supervisor request aborted");
  error.name = "AbortError";
  return error;
}

function supervisorRequestWasAborted(error: unknown, signal?: AbortSignal) {
  return Boolean(signal?.aborted || (error instanceof Error && error.name === "AbortError"));
}

async function reconnectDelay(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) throw supervisorRequestAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(supervisorRequestAborted());
    };
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function awaitReconnectForCaller<T>(promise: Promise<T>, signal: AbortSignal | undefined, deadline: number): Promise<T> {
  if (signal?.aborted) throw supervisorRequestAborted();
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`Timed out waiting ${SUPERVISOR_RECONNECT_TIMEOUT_MS}ms for the AgentSH supervisor tunnel to reconnect`);
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`Timed out waiting ${SUPERVISOR_RECONNECT_TIMEOUT_MS}ms for the AgentSH supervisor tunnel to reconnect`))),
      remaining,
    );
    const onAbort = () => finish(() => reject(supervisorRequestAborted()));
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

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
  timeout_ms: Type.Optional(Type.Number({ minimum: 1, description: "Optional shorter execution timeout in milliseconds; defaults to the two-hour configured ceiling" })),
});

function optionalPositiveTimeoutEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer number of milliseconds`);
  }
  return value;
}

function effectiveSubagentExecutionTimeoutMs(value: unknown): number {
  const maxExecutionTimeout = MAX_NODE_TIMEOUT_MS - SUBAGENT_TRANSPORT_SLACK_MS;
  if (!Number.isSafeInteger(SUBAGENT_EXECUTION_TIMEOUT_MS) || SUBAGENT_EXECUTION_TIMEOUT_MS < 1 || SUBAGENT_EXECUTION_TIMEOUT_MS > maxExecutionTimeout) {
    throw new Error(`configured subagent execution timeout must be between 1 and ${maxExecutionTimeout}ms`);
  }
  if (value === undefined || value === null || value === 0) return SUBAGENT_EXECUTION_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("spawn_subagent timeout_ms must be a positive integer");
  }
  if (value > maxExecutionTimeout) {
    throw new Error(`spawn_subagent timeout_ms must not exceed ${maxExecutionTimeout}`);
  }
  return Math.min(value, SUBAGENT_EXECUTION_TIMEOUT_MS);
}

function subagentTransportTimeoutMs(executionTimeoutMs: number): number {
  const derived = executionTimeoutMs + SUBAGENT_TRANSPORT_SLACK_MS;
  const timeout = Math.max(derived, SUBAGENT_TRANSPORT_TIMEOUT_FLOOR_MS ?? 0);
  if (!Number.isSafeInteger(timeout) || timeout > MAX_NODE_TIMEOUT_MS) {
    throw new Error(`spawn_subagent transport timeout must not exceed ${MAX_NODE_TIMEOUT_MS}`);
  }
  return timeout;
}

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

function strictNetworkEvidenceRequired() {
  return ["1", "true", "yes", "strict"].includes(env("PI_AGENTSH_REQUIRE_NETWORK_ENFORCEMENT").toLowerCase());
}

function metadataNetworkEnforcement(metadata?: SupervisorMetadata) {
  return metadata?.network_enforcement || metadata?.networkEnforcement;
}

function networkEnforcementProven(report?: NetworkEnforcement) {
  return Boolean(
    report?.network_policy_enforced === true
    && report.readiness === "ready"
    && (report.status === "ready" || report.status === "active")
    && report.tier === "helper-ebpf-proxy-required",
  );
}

function networkEnforcementRequirement(metadata?: SupervisorMetadata) {
  const report = metadataNetworkEnforcement(metadata);
  return strictNetworkEvidenceRequired() || report?.requested === "strict";
}

function assertNetworkEnforcementReady(metadata?: SupervisorMetadata) {
  if (!networkEnforcementRequirement(metadata)) return;
  const report = metadataNetworkEnforcement(metadata);
  if (metadata?.network_enforcement_live !== true) {
    throw new Error(`AgentSH strict network enforcement requires live supervisor evidence${metadata?.network_enforcement_error ? `: ${metadata.network_enforcement_error}` : ""}`);
  }
  if (!networkEnforcementProven(report)) {
    const status = report?.status || report?.readiness || "unknown";
    const tier = report?.tier || "unknown";
    const detail = report?.detail || report?.warning || "runtime evidence is incomplete";
    throw new Error(`AgentSH strict network enforcement is not ready (status=${status}, tier=${tier}): ${detail}`);
  }
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

type OutputSnapshot = {
  content: string;
  truncation: TruncationResult;
  fullOutputPath?: string;
};

function byteLength(text: string) {
  return Buffer.byteLength(text, "utf-8");
}

class StringOutputAccumulator {
  private readonly decoder = new TextDecoder();
  private tailText = "";
  private tailBytes = 0;
  private tailStartsAtLineBoundary = true;
  private totalDecodedBytes = 0;
  private completedLines = 0;
  private totalLines = 0;
  private currentLineBytes = 0;
  private hasOpenLine = false;
  private finished = false;

  append(text: string): void {
    if (this.finished) throw new Error("Cannot append to a finished output accumulator");
    if (!text) return;

    const data = Buffer.from(text, "utf-8");
    this.appendDecodedText(this.decoder.decode(data, { stream: true }));
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.appendDecodedText(this.decoder.decode());
  }

  snapshot(_options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
    const tailTruncation = truncateTail(this.getSnapshotText(), {
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    });
    const truncated = this.totalLines > DEFAULT_MAX_LINES || this.totalDecodedBytes > DEFAULT_MAX_BYTES;
    const truncation: TruncationResult = {
      ...tailTruncation,
      truncated,
      truncatedBy: truncated ? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > DEFAULT_MAX_BYTES ? "bytes" : "lines")) : null,
      totalLines: this.totalLines,
      totalBytes: this.totalDecodedBytes,
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    };

    return {
      content: truncation.content,
      truncation,
    };
  }

  async closeTempFile(): Promise<void> {
    // Supervised overflow artifacts are owned by remote AgentSH. Retain this
    // no-op during the compatibility transition so existing finally blocks do
    // not create local-Pi filesystem capabilities.
  }

  getLastLineBytes(): number {
    return this.currentLineBytes;
  }

  private appendDecodedText(text: string): void {
    if (!text) return;

    const bytes = byteLength(text);
    this.totalDecodedBytes += bytes;
    this.tailText += text;
    this.tailBytes += bytes;
    if (this.tailBytes > DEFAULT_MAX_BYTES * 4) this.trimTail();

    let newlines = 0;
    let lastNewline = -1;
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
      newlines++;
      lastNewline = i;
    }
    if (newlines === 0) {
      this.currentLineBytes += bytes;
      this.hasOpenLine = true;
    } else {
      this.completedLines += newlines;
      const tail = text.slice(lastNewline + 1);
      this.currentLineBytes = byteLength(tail);
      this.hasOpenLine = tail.length > 0;
    }
    this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
  }

  private trimTail(): void {
    const buffer = Buffer.from(this.tailText, "utf-8");
    const maxRollingBytes = DEFAULT_MAX_BYTES * 2;
    if (buffer.length <= maxRollingBytes) {
      this.tailBytes = buffer.length;
      return;
    }

    let start = buffer.length - maxRollingBytes;
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;

    this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
    this.tailText = buffer.subarray(start).toString("utf-8");
    this.tailBytes = byteLength(this.tailText);
  }

  private getSnapshotText(): string {
    if (this.tailStartsAtLineBoundary) return this.tailText;
    const firstNewline = this.tailText.indexOf("\n");
    return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
  }

}

function execResultBoolean(result: ExecResult | undefined, key: string) {
  return result?.[key] === true;
}

function execResultNumber(result: ExecResult | undefined, key: string) {
  const value = result?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

type RemoteOutputArtifact = {
  path?: string;
  bytes?: number;
  totalBytes?: number;
  complete?: boolean;
  error?: string;
};

function remoteOutputArtifact(result: ExecResult | undefined): RemoteOutputArtifact | undefined {
  if (!result) return undefined;
  const nested = result.output_artifact && typeof result.output_artifact === "object" ? result.output_artifact as JsonObject : undefined;
  const path = typeof result.full_output_path === "string" ? result.full_output_path : typeof nested?.path === "string" ? nested.path : undefined;
  const bytes = execResultNumber(result, "artifact_bytes") ?? numericField(nested?.bytes);
  const totalBytes = execResultNumber(result, "artifact_total_bytes") ?? numericField(nested?.total_bytes);
  const completeValue = typeof result.artifact_complete === "boolean" ? result.artifact_complete : nested?.complete;
  const error = typeof result.artifact_error === "string" ? result.artifact_error : typeof nested?.error === "string" ? nested.error : undefined;
  if (!path && !error && bytes === undefined && totalBytes === undefined) return undefined;
  return { path, bytes, totalBytes, complete: typeof completeValue === "boolean" ? completeValue : undefined, error };
}

function agentSHOutputWarnings(result: ExecResult | undefined, artifact?: RemoteOutputArtifact) {
  const warnings: string[] = [];
  const sessionID = typeof result?.session_id === "string" ? result.session_id : "";
  const commandID = typeof result?.command_id === "string" ? result.command_id : "";
  for (const stream of ["stdout", "stderr"] as const) {
    if (!execResultBoolean(result, `${stream}_truncated`)) continue;
    const total = execResultNumber(result, `${stream}_total_bytes`);
    const totalText = total === undefined ? "" : ` at ${formatSize(total)}`;
    let hint = "";
    if (artifact?.path && artifact.complete) hint = " Complete output is available in the remote artifact.";
    else if (artifact?.path) hint = " The remote artifact is also bounded; its byte counts are shown above.";
    else if (sessionID && commandID) hint = ` The retained AgentSH prefix can be paged with: agentsh output ${sessionID} ${commandID} --stream ${stream}`;
    warnings.push(`AgentSH response truncated ${stream}${totalText}.${hint}`);
  }
  return warnings;
}

function formatAccumulatedOutput(snapshot: OutputSnapshot, output: StringOutputAccumulator, result?: ExecResult, emptyText = "(no output)") {
  const truncation = snapshot.truncation;
  let text = snapshot.content || emptyText;
  const artifact = remoteOutputArtifact(result);
  const warnings = agentSHOutputWarnings(result, artifact);
  if (truncation.truncated) {
    const startLine = truncation.totalLines - truncation.outputLines + 1;
    const endLine = truncation.totalLines;
    let shown: string;
    if (truncation.lastLinePartial) {
      const lastLineSize = formatSize(output.getLastLineBytes());
      shown = `Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}).`;
    } else if (truncation.truncatedBy === "lines") {
      shown = `Showing lines ${startLine}-${endLine} of ${truncation.totalLines}.`;
    } else {
      shown = `Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit).`;
    }
    if (artifact?.path) {
      const retained = artifact.complete === false
        ? ` Retained remote output: ${artifact.path} (${formatSize(artifact.bytes ?? 0)} of ${formatSize(artifact.totalBytes ?? 0)}).`
        : ` Full output: ${artifact.path}`;
      shown += retained;
    } else if (artifact?.error) {
      shown += ` Remote output artifact unavailable: ${artifact.error}`;
    } else if (result) {
      shown += " Remote output artifact unavailable from this supervisor.";
    } else {
      shown += " Remote output artifact pending command completion.";
    }
    warnings.unshift(shown);
  }
  if (warnings.length > 0) text += `\n\n[${warnings.join(" ")}]`;
  return text;
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

function commandScopeTarget(option: ApprovalResolution, fallback: string) {
  if (option.scope_label) return option.scope_label;
  const key = option.scope_key || "";
  for (const prefix of ["command-executable:", "command-invocation:"]) {
    if (key.startsWith(prefix)) return key.slice(prefix.length) || key;
  }
  return key || fallback;
}

function sessionScopeLabels(option: ApprovalResolution, fallback: string) {
  const scopeTarget = option.scope_label || option.scope_key || fallback;
  const reasonLabel = option.scope_kind ? `${option.scope_kind}: ${scopeTarget}` : scopeTarget;
  if (option.scope_kind === "command") {
    const target = commandScopeTarget(option, fallback);
    const subject = option.scope_key?.startsWith("command-invocation:") ? "this exact invocation" : "this command";
    return {
      reasonLabel,
      approveLabel: `Approve ${subject} for session: ${target}`,
      denyLabel: `Deny ${subject} for session: ${target}`,
    };
  }
  return {
    reasonLabel,
    approveLabel: `Approve for session ${reasonLabel}`,
    denyLabel: `Deny for session ${reasonLabel}`,
  };
}

function approvalChoices(approval: ApprovalRequest): ApprovalChoice[] {
  const title = approvalTitle(approval);
  const approveOnce: ApprovalChoice = { label: `Approve ${title}`, decision: "approve", scope: "once", reason: "approved in parent Pi" };
  const denyOnce: ApprovalChoice = { label: `Deny ${title}`, decision: "deny", scope: "once", reason: "denied in parent Pi" };
  const sessionOptions = sessionScopeOptions(approval);
  const choices: ApprovalChoice[] = [approveOnce];
  for (const option of sessionOptions) {
    const labels = sessionScopeLabels(option, title);
    choices.push({ ...option, decision: "approve", scope: "session", reason: `approved for session ${labels.reasonLabel} in parent Pi`, label: labels.approveLabel });
  }
  choices.push(denyOnce);
  for (const option of sessionOptions) {
    const labels = sessionScopeLabels(option, title);
    choices.push({ ...option, decision: "deny", scope: "session", reason: `denied for session ${labels.reasonLabel} in parent Pi`, label: labels.denyLabel });
  }
  return choices;
}

function resolveChoice(choices: ApprovalChoice[], choice: string | undefined): ApprovalResolution {
  const selected = choices.find((candidate) => candidate.label === choice);
  return selected || { decision: "deny", scope: "once", reason: "denied in parent Pi" };
}

function showApprovalPrompt(ctx: ExtensionContext, approval: ApprovalRequest, choices: ApprovalChoice[], signal: AbortSignal): Promise<string | undefined> {
  if (typeof ctx.ui.custom !== "function") return ctx.ui.select(formatApproval(approval), choices.map((candidate) => candidate.label), { signal });
  return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
    let selectedIndex = 0;
    let scrollOffset = 0;
    let cachedLines: string[] | undefined;
    let cachedWidth = 0;
    let lastGPress = 0;
    const detailLines = formatApproval(approval).split(/\r?\n/);

    const visibleDetailLines = () => Math.max(3, tui.terminal.rows - choices.length - 12);
    const maxScroll = () => Math.max(0, detailLines.length - visibleDetailLines());
    const clampScroll = (offset: number) => {
      scrollOffset = Math.max(0, Math.min(maxScroll(), offset));
    };
    const refresh = () => {
      cachedLines = undefined;
      tui.requestRender();
    };
    const abort = () => done(undefined);
    signal.addEventListener("abort", abort, { once: true });

    const component: Component & { dispose(): void } = {
      dispose() {
        signal.removeEventListener("abort", abort);
      },
      invalidate() {
        cachedLines = undefined;
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.enter)) {
          done(choices[selectedIndex]?.label);
          return;
        }
        if (matchesKey(data, Key.escape)) {
          done(undefined);
          return;
        }
        if (matchesKey(data, Key.up) || data === "k") {
          selectedIndex = Math.max(0, selectedIndex - 1);
          refresh();
          return;
        }
        if (matchesKey(data, Key.down) || data === "j") {
          selectedIndex = Math.min(choices.length - 1, selectedIndex + 1);
          refresh();
          return;
        }
        if (matchesKey(data, Key.pageUp) || data === "u") {
          clampScroll(scrollOffset - Math.max(1, Math.floor(visibleDetailLines() / 2)));
          refresh();
          return;
        }
        if (matchesKey(data, Key.pageDown) || data === "d") {
          clampScroll(scrollOffset + Math.max(1, Math.floor(visibleDetailLines() / 2)));
          refresh();
          return;
        }
        if (data === "g") {
          const now = Date.now();
          if (now - lastGPress < 500) {
            scrollOffset = 0;
            lastGPress = 0;
            refresh();
          } else {
            lastGPress = now;
          }
          return;
        }
        if (data === "G") {
          scrollOffset = maxScroll();
          refresh();
        }
      },
      render(width: number) {
        if (cachedLines && cachedWidth === width) return cachedLines;
        clampScroll(scrollOffset);
        const lines: string[] = [];
        const add = (line: string) => lines.push(truncateToWidth(line, width, ""));
        const detailVisible = visibleDetailLines();
        const visible = detailLines.slice(scrollOffset, scrollOffset + detailVisible);

        add(theme.fg("accent", "─".repeat(width)));
        add(theme.fg("accent", theme.bold(" AgentSH approval requested")));
        lines.push("");
        for (const line of visible) add(line ? ` ${theme.fg("text", line)}` : "");
        if (detailLines.length > detailVisible) {
          const end = Math.min(scrollOffset + detailVisible, detailLines.length);
          add(theme.fg("dim", ` lines ${scrollOffset + 1}–${end} of ${detailLines.length} • PgUp/PgDn scroll`));
        }
        lines.push("");
        for (let i = 0; i < choices.length; i++) {
          const prefix = i === selectedIndex ? theme.fg("accent", "→ ") : "  ";
          const color = choices[i]?.decision === "deny" ? "warning" : "success";
          add(`${prefix}${theme.fg(color, choices[i]?.label || "")}`);
        }
        lines.push("");
        add(theme.fg("dim", " ↑↓/j/k select • Enter choose • Esc deny once • u/d/PgUp/PgDn scroll"));
        add(theme.fg("accent", "─".repeat(width)));
        cachedWidth = width;
        cachedLines = lines;
        return lines;
      },
    };

    return component;
  }, {
    overlay: true,
    overlayOptions: { width: "100%", anchor: "bottom-center" },
  });
}

function setStatus(state: SupervisorState, ctx = state.ctx) {
  if (!ctx?.hasUI) return;
  const theme = ctx.ui.theme;
  if (!state.active) return ctx.ui.setStatus("sandbox", theme.fg("muted", "agentsh inactive"));
  if (state.status === "starting") return ctx.ui.setStatus("sandbox", theme.fg("muted", "agentsh start…"));
  if (state.status === "connecting") return ctx.ui.setStatus("sandbox", theme.fg("muted", "agentsh …"));
  if (state.status === "error") return ctx.ui.setStatus("sandbox", theme.fg("error", "agentsh ✗"));
  if (state.pendingCount > 0) return ctx.ui.setStatus("sandbox", theme.fg("warning", `agentsh ? ${state.pendingCount}`));
  if (networkEnforcementProven(metadataNetworkEnforcement(state.metadata)) && state.metadata?.network_enforcement_live) {
    return ctx.ui.setStatus("sandbox", theme.fg("success", "agentsh net ✓"));
  }
  if (metadataNetworkEnforcement(state.metadata)?.requested && metadataNetworkEnforcement(state.metadata)?.requested !== "none") {
    return ctx.ui.setStatus("sandbox", theme.fg("warning", "agentsh net ?"));
  }
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
      persist_output_over_bytes: options.persist_output_over_bytes,
      persist_output_over_lines: options.persist_output_over_lines,
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

  async refreshDirenv(_options: DirenvRefreshOptions) {
    return restUnsupported("refresh_direnv");
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
    const executionTimeoutMs = effectiveSubagentExecutionTimeoutMs(params.timeout_ms);
    return await this.request("spawn_subagent", { ...params, timeout_ms: executionTimeoutMs, actor: options.actor || params.actor || parentActor(undefined, "Pi subagent tool") }, {
      signal: options.signal,
      timeoutMs: subagentTransportTimeoutMs(executionTimeoutMs),
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

  constructor(
    private readonly client: MockSupervisorClient,
    private readonly onApproval: (approval: ApprovalRequest) => void,
    private readonly onError: (error: Error) => void,
    private readonly onConnected: () => void,
  ) {}

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
      this.onConnected();
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
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (optionsSignal) {
    if (optionsSignal.aborted) controller.abort();
    else optionsSignal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
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

function unwrapDirenvRefreshResponse(raw: unknown): DirenvRefreshResult {
  const envelope = (raw && typeof raw === "object" ? raw : undefined) as RestToolResponse<unknown> | undefined;
  const candidate = envelope && typeof envelope.ok === "boolean" ? envelope.result : raw;
  const result = (candidate && typeof candidate === "object" ? candidate : undefined) as Partial<DirenvRefreshResult> | undefined;
  const states = new Set<DirenvRefreshState>(["no_envrc", "not_allowed", "loaded", "unchanged", "policy_denied", "timed_out", "invalid_output", "unavailable"]);
  if (!result || !states.has(result.state as DirenvRefreshState)) {
    throw new Error("AgentSH refresh_direnv returned an invalid value-free result");
  }
  const number = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return {
    state: result.state as DirenvRefreshState,
    set_count: number(result.set_count),
    unset_count: number(result.unset_count),
    rejected_count: number(result.rejected_count),
    generation: number(result.generation),
    duration_ms: number(result.duration_ms),
  };
}

function unwrapRestSubagentResponse(raw: unknown): unknown {
  const obj = (raw && typeof raw === "object" ? raw : undefined) as RestToolResponse<any> | undefined;
  if (!obj || typeof obj.ok !== "boolean") return raw;
  if (!obj.ok && obj.result && typeof obj.result === "object") {
    return { ...obj.result, error: obj.error || "spawn_subagent failed" };
  }
  if (!obj.ok) throw new Error(obj.error || "spawn_subagent failed");
  return obj.result;
}

function numericField(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
  const networkEnforcement = (obj.network_enforcement || session.network_enforcement || seed?.network_enforcement || seed?.networkEnforcement) as NetworkEnforcement | undefined;
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
    network_enforcement: networkEnforcement,
    supported_ops: [
      "REST /api/v1/sessions",
      "REST /api/v1/approvals",
      "REST /api/v1/sessions/{id}/tools/exec_bash",
      "REST /api/v1/sessions/{id}/tools/refresh_direnv",
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
  #expectedSessionId: string;
  #metadata?: SupervisorMetadata;
  #reconnectInFlight?: Promise<SupervisorMetadata>;

  constructor(readonly socketPath: string, seedMetadata?: SupervisorMetadata, private readonly connectionEvents: RestConnectionEvents = {}) {
    this.#metadata = seedMetadata;
    this.#sessionId = metadataSessionId(seedMetadata);
    this.#expectedSessionId = this.#sessionId;
  }

  get sessionId() { return this.#sessionId; }

  #sessionPath(sessionId = this.#expectedSessionId) {
    return `/api/v1/sessions/${encodeURIComponent(sessionId)}`;
  }

  #sessionLost(detail: string) {
    const error = new SupervisorSessionLostError(this.#expectedSessionId, detail);
    this.connectionEvents.onSessionLost?.(error);
    return error;
  }

  #validateExpectedSession(raw: unknown) {
    const obj = (raw && typeof raw === "object" ? raw : {}) as JsonObject;
    const session = (obj.session && typeof obj.session === "object" ? obj.session : obj) as JsonObject;
    const actual = String(obj.session_id || obj.id || session.session_id || session.id || "");
    if (!this.#expectedSessionId) {
      if (!actual) throw this.#sessionLost("The supervisor response did not include a session ID.");
      this.#expectedSessionId = actual;
    }
    if (actual !== this.#expectedSessionId) {
      throw this.#sessionLost(`Expected ${this.#expectedSessionId}, but the supervisor returned ${actual || "no session ID"}.`);
    }
    const metadata = sessionMetadataFromRest(raw, this.socketPath, this.#metadata);
    metadata.session_id = actual;
    metadata.id = actual;
    this.#metadata = metadata;
    this.#sessionId = actual;
    return metadata;
  }

  async #pollForExpectedSession(deadline: number, initialError: SafeSupervisorConnectError) {
    if (!this.#expectedSessionId) {
      throw this.#sessionLost("AGENTSH_SESSION_ID was not available, so the client cannot verify a safe reattachment.");
    }
    let delayMs = Math.max(1, SUPERVISOR_RECONNECT_INITIAL_MS);
    let lastError: Error = initialError;
    try {
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(`Timed out waiting ${SUPERVISOR_RECONNECT_TIMEOUT_MS}ms for AgentSH session ${this.#expectedSessionId} at ${this.socketPath}: ${lastError.message}`);
        }
        try {
          const raw = await this.#requestOnce(
            "GET",
            this.#sessionPath(),
            undefined,
            { timeoutMs: Math.max(1, Math.min(CONNECT_TIMEOUT_MS, remaining)) },
          );
          const metadata = this.#validateExpectedSession(raw);
          this.connectionEvents.onReconnected?.(metadata);
          return metadata;
        } catch (error) {
          if (error instanceof RestHTTPError && error.statusCode === 404) {
            throw this.#sessionLost(`The supervisor returned HTTP 404 for ${this.#sessionPath()}.`);
          }
          if (!(error instanceof SafeSupervisorConnectError)) throw error;
          lastError = error;
          const waitMs = Math.min(delayMs, Math.max(1, deadline - Date.now()));
          await reconnectDelay(waitMs);
          delayMs = Math.min(Math.max(delayMs * 2, 1), Math.max(WATCH_RECONNECT_MS, 1));
        }
      }
    } catch (error) {
      if (!(error instanceof SupervisorSessionLostError)) this.connectionEvents.onReconnectFailed?.(asError(error));
      throw error;
    }
  }

  #ensureReconnect(deadline: number, error: SafeSupervisorConnectError) {
    this.connectionEvents.onReconnecting?.(error, deadline);
    if (!this.#reconnectInFlight) {
      const reconnect = this.#pollForExpectedSession(deadline, error);
      this.#reconnectInFlight = reconnect;
      reconnect.then(
        () => { if (this.#reconnectInFlight === reconnect) this.#reconnectInFlight = undefined; },
        () => { if (this.#reconnectInFlight === reconnect) this.#reconnectInFlight = undefined; },
      );
    }
    return this.#reconnectInFlight;
  }

  async #withReconnect<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const deadline = Date.now() + Math.max(0, SUPERVISOR_RECONNECT_TIMEOUT_MS);
    for (;;) {
      if (signal?.aborted) throw supervisorRequestAborted();
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof SafeSupervisorConnectError) || SUPERVISOR_RECONNECT_TIMEOUT_MS <= 0) throw error;
        if (Date.now() >= deadline) {
          const timeout = new Error(`Timed out waiting ${SUPERVISOR_RECONNECT_TIMEOUT_MS}ms for the AgentSH supervisor tunnel at ${this.socketPath}: ${error.message}`);
          this.connectionEvents.onReconnectFailed?.(timeout);
          throw timeout;
        }
        try {
          await awaitReconnectForCaller(this.#ensureReconnect(deadline, error), signal, deadline);
        } catch (reconnectError) {
          if (supervisorRequestWasAborted(reconnectError, signal)) throw supervisorRequestAborted();
          throw reconnectError;
        }
        // The failed connect never reached the server. Create a fresh HTTP
        // request only after the exact original session has been verified.
      }
    }
  }

  async #requestOnce<T = unknown>(method: string, path: string, body?: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const { signal, cleanup } = abortSignalFrom(options.signal, options.timeoutMs || CONNECT_TIMEOUT_MS);
    return await new Promise<T>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      let responseStarted = false;
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
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
        responseStarted = true;
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("aborted", () => finish(() => reject(new Error(`${method} ${path}: supervisor response was aborted after dispatch`))));
        res.on("error", (error) => finish(() => reject(error)));
        res.on("end", () => finish(() => {
          const text = Buffer.concat(chunks).toString("utf8");
          const statusCode = res.statusCode || 0;
          if (statusCode < 200 || statusCode >= 300) {
            reject(new RestHTTPError(method, path, statusCode, text));
            return;
          }
          if (!text.trim()) { resolve(undefined as T); return; }
          try { resolve(JSON.parse(text) as T); } catch (error) { reject(asError(error)); }
        }));
        res.on("close", () => {
          if (!settled && !res.complete) finish(() => reject(new Error(`${method} ${path}: supervisor response closed before completion after dispatch`)));
        });
      });
      req.on("error", (error) => finish(() => {
        if (!responseStarted && supervisorSocketUnavailable(error)) reject(new SafeSupervisorConnectError(error));
        else reject(error);
      }));
      req.setTimeout(options.timeoutMs || CONNECT_TIMEOUT_MS, () => req.destroy(new Error(`Timed out waiting for AgentSH REST supervisor socket ${this.socketPath}`)));
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    try {
      return await this.#withReconnect(
        () => this.#requestOnce<T>(method, path, body, options),
        options.signal,
      );
    } catch (error) {
      if (error instanceof RestHTTPError && error.statusCode === 404 && /session[_ -]?(?:not[_ -]?found|missing)|(?:not[_ -]?found|missing).*session/i.test(error.body)) {
        throw this.#sessionLost(`The supervisor reported that session ${this.#expectedSessionId} no longer exists.`);
      }
      throw error;
    }
  }

  async #requestNDJSONOnce(method: string, path: string, body: unknown, options: { signal?: AbortSignal; timeoutMs?: number; onEvent?: (message: SupervisorMessage) => void } = {}): Promise<unknown> {
    const timeoutMs = options.timeoutMs || CONNECT_TIMEOUT_MS;
    const { signal, cleanup, didTimeout } = abortSignalFrom(options.signal, timeoutMs);
    let socketTimedOut = false;
    const timeoutError = () => {
      socketTimedOut = true;
      return new SupervisorRequestTimeoutError(timeoutMs, `Streaming ${method} ${path}`);
    };
    const requestTimedOut = () => didTimeout() || socketTimedOut;
    const normalizeRequestError = (error: unknown) => requestTimedOut() ? timeoutError() : asError(error);
    return await new Promise<unknown>((resolve, reject) => {
      const payload = JSON.stringify(body);
      let settled = false;
      let responseStarted = false;
      const protocol = createSubagentProtocolState();
      let req: http.ClientRequest | undefined;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const emitEvent = (message: SupervisorMessage) => {
        if (!options.onEvent) return true;
        try {
          options.onEvent(message);
          return true;
        } catch (error) {
          const err = asError(error);
          settle(() => reject(err));
          req?.destroy(err);
          return false;
        }
      };
      req = http.request({
        socketPath: this.socketPath,
        host: "unix",
        method,
        path,
        signal,
        headers: {
          Accept: "application/x-ndjson",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      }, (res) => {
        responseStarted = true;
        const errorChunks: Buffer[] = [];
        res.on("data", (chunk) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
            errorChunks.push(bytes);
            return;
          }
          for (const message of appendSubagentProtocolChunk(protocol, bytes)) {
            if (!emitEvent(message as SupervisorMessage)) return;
          }
          if (protocol.finalResponse && !settled) {
            const finalResponse = protocol.finalResponse;
            settle(() => resolve(finalResponse));
            // `done` is the protocol terminal event. Do not let a peer that
            // keeps the HTTP response open turn a valid result into a later
            // transport timeout.
            res.destroy();
          }
        });
        res.on("aborted", () => {
          const error = requestTimedOut() ? timeoutError() : new Error(`${method} ${path}: supervisor response was aborted after dispatch`);
          abortSubagentProtocolStream(protocol, error.message);
          settle(() => reject(error));
        });
        res.on("error", (error) => {
          const normalized = normalizeRequestError(error);
          abortSubagentProtocolStream(protocol, normalized.message);
          settle(() => reject(normalized));
        });
        res.on("end", () => {
          const statusCode = res.statusCode || 0;
          if (statusCode < 200 || statusCode >= 300) {
            const text = Buffer.concat(errorChunks).toString("utf8");
            settle(() => reject(new RestHTTPError(method, path, statusCode, text)));
            return;
          }
          const finished = finishSubagentProtocolStream(protocol);
          for (const message of finished.events) emitEvent(message as SupervisorMessage);
          if (finished.error || !finished.finalResponse) {
            settle(() => reject(new Error(`${method} ${path}: ${finished.error || "stream ended without final done event"}`)));
            return;
          }
          settle(() => resolve(finished.finalResponse));
        });
        res.on("close", () => {
          if (!settled && !res.complete) {
            const error = requestTimedOut() ? timeoutError() : new Error(`${method} ${path}: supervisor response closed before completion after dispatch`);
            abortSubagentProtocolStream(protocol, error.message);
            settle(() => reject(error));
          }
        });
      });
      req.on("error", (error) => {
        const normalized = normalizeRequestError(error);
        abortSubagentProtocolStream(protocol, normalized.message);
        settle(() => {
          if (!responseStarted && supervisorSocketUnavailable(error)) reject(new SafeSupervisorConnectError(error));
          else reject(normalized);
        });
      });
      req.setTimeout(timeoutMs, () => req?.destroy(timeoutError()));
      req.write(payload);
      req.end();
    });
  }

  async requestNDJSON(method: string, path: string, body: unknown, options: { signal?: AbortSignal; timeoutMs?: number; onEvent?: (message: SupervisorMessage) => void } = {}): Promise<unknown> {
    try {
      return await this.#withReconnect(
        () => this.#requestNDJSONOnce(method, path, body, options),
        options.signal,
      );
    } catch (error) {
      if (error instanceof RestHTTPError && error.statusCode === 404 && /session[_ -]?(?:not[_ -]?found|missing)|(?:not[_ -]?found|missing).*session/i.test(error.body)) {
        throw this.#sessionLost(`The supervisor reported that session ${this.#expectedSessionId} no longer exists.`);
      }
      throw error;
    }
  }

  async hello() {
    let metadata: SupervisorMetadata;
    if (this.#expectedSessionId) {
      let raw: unknown;
      try {
        raw = await this.request("GET", this.#sessionPath());
      } catch (error) {
        if (error instanceof RestHTTPError && error.statusCode === 404) {
          throw this.#sessionLost(`The supervisor returned HTTP 404 for ${this.#sessionPath()}.`);
        }
        throw error;
      }
      metadata = this.#validateExpectedSession(raw);
    } else {
      const sessions = await this.request<unknown[]>("GET", "/api/v1/sessions");
      const first = sessions[0];
      if (!first) throw this.#sessionLost("The supervisor listed no sessions to attach to.");
      metadata = this.#validateExpectedSession(first);
    }
    if (this.#sessionId) {
      try {
        metadata.network_enforcement = await this.request<NetworkEnforcement>(
          "GET",
          `${this.#sessionPath(this.#sessionId)}/network-enforcement`,
        );
        metadata.network_enforcement_live = true;
        metadata.network_enforcement_error = undefined;
      } catch (error) {
        metadata.network_enforcement_live = false;
        metadata.network_enforcement_error = asError(error).message;
      }
    }
    assertNetworkEnforcementReady(metadata);
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
    const requestTimeoutMs = timeoutMs
      ? Math.max(TOOL_REQUEST_TIMEOUT_MS, timeoutMs + APPROVAL_REQUEST_TIMEOUT_SLACK_MS + CONNECT_TIMEOUT_MS)
      : TOOL_REQUEST_TIMEOUT_MS + APPROVAL_REQUEST_TIMEOUT_SLACK_MS;
    const raw = await this.request("POST", this.toolPath("exec_bash"), {
      command,
      cwd: options.cwd || effectiveSupervisorCwd(),
      timeout_ms: timeoutMs,
      persist_output_over_bytes: options.persist_output_over_bytes,
      persist_output_over_lines: options.persist_output_over_lines,
      actor: options.actor || parentActor(options.tool_call_id, "Pi bash tool"),
    }, { signal: options.signal, timeoutMs: requestTimeoutMs });
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

  async refreshDirenv(options: DirenvRefreshOptions) {
    const body = {
      cwd: env("PI_AGENTSH_REMOTE_CWD") || options.cwd || effectiveSupervisorCwd(),
      actor: options.actor || { kind: "extension", label: "Pi direnv refresh" },
    };
    try {
      const raw = await this.request("POST", this.toolPath("refresh_direnv"), body, {
        signal: options.signal,
        timeoutMs: TOOL_REQUEST_TIMEOUT_MS + APPROVAL_REQUEST_TIMEOUT_SLACK_MS,
      });
      return unwrapDirenvRefreshResponse(raw);
    } catch (error) {
      // AgentSH returns policy-disabled refreshes as a typed 403. Preserve that
      // value-free state while leaving all other HTTP/transport failures intact.
      if (error instanceof RestHTTPError && error.statusCode === 403) {
        try { return unwrapDirenvRefreshResponse(JSON.parse(error.body)); } catch { /* use original error */ }
      }
      throw error;
    }
  }

  async readFile(path: string, options: ReadFileOptions = {}) {
    const file = restFileRequest(this.#metadata, path, options.cwd);
    const raw = await this.request("POST", this.toolPath("read_file"), {
      ...file,
      offset: options.offset,
      limit: options.limit,
      max_bytes: DEFAULT_MAX_BYTES,
      actor: options.actor || parentActor(undefined, "Pi read tool"),
    }, { signal: options.signal, timeoutMs: TOOL_REQUEST_TIMEOUT_MS });
    return unwrapRestToolResponse<JsonObject>("read_file", raw);
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
      body.stream = true;
      const executionTimeoutMs = effectiveSubagentExecutionTimeoutMs(body.timeout_ms);
      const transportTimeoutMs = subagentTransportTimeoutMs(executionTimeoutMs);
      body.timeout_ms = executionTimeoutMs;
      try {
        const raw = await this.requestNDJSON("POST", this.toolPath("spawn_subagent"), body, { signal: options.signal, timeoutMs: transportTimeoutMs, onEvent: options.onUpdate });
        return unwrapRestSubagentResponse(raw);
      } catch (error) {
        if (error instanceof SupervisorRequestTimeoutError && !options.signal?.aborted) {
          throw new SubagentTransportTimeoutError(executionTimeoutMs, transportTimeoutMs);
        }
        throw error;
      }
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
  async refreshDirenv(_options: DirenvRefreshOptions) { return restUnsupported("refresh_direnv"); }
  async readFile(_path: string, _options: ReadFileOptions = {}) { return restUnsupported("read_file"); }
  async writeFile(_path: string, _content: string, _options: WriteFileOptions = {}) { return restUnsupported("write_file"); }
  async editFile(_path: string, _edits: Edit[], _options: EditFileOptions = {}) { return restUnsupported("edit_file"); }
  async spawnSubagent(_params: JsonObject, _options: SpawnSubagentOptions = {}) { return restUnsupported("spawn_subagent"); }
  async stop() { return undefined; }
}

class RestApprovalWatcher {
  #stopped = false;
  #timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly client: ApprovalClient,
    private readonly onApprovals: (approvals: ApprovalRequest[]) => void,
    private readonly onError: (error: Error) => void,
    private readonly onConnected: () => void,
  ) {}

  start() { this.#stopped = false; void this.#poll(); }
  stop() {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
  async #poll() {
    if (this.#stopped) return;
    try {
      this.onApprovals(await this.client.listApprovals());
      this.onConnected();
    } catch (error) { this.onError(asError(error)); }
    finally {
      const pollMs = Number(process.env.PI_AGENTSH_APPROVAL_POLL_MS || APPROVAL_POLL_MS);
      if (!this.#stopped) this.#timer = setTimeout(() => void this.#poll(), Number.isFinite(pollMs) ? Math.max(1, pollMs) : APPROVAL_POLL_MS);
    }
  }
}

function requireClient(state: SupervisorState) {
  if (!state.client || !state.active || !["connecting", "connected", "pending"].includes(state.status)) {
    throw new Error(`AgentSH supervisor is not ready${state.lastError ? `: ${state.lastError}` : ". Set PI_AGENTSH_MOCK_SUPERVISOR for mock NDJSON, or AGENTSH_SESSION_SUPERVISOR/PI_AGENTSH_ENABLE=1 for real Stage 1 REST before starting Pi."}`);
  }
  return state.client;
}

function requireApprovalClient(state: SupervisorState) {
  if (!state.approvalClient || !state.active || !["connecting", "connected", "pending"].includes(state.status)) throw new Error("AgentSH approval client is not attached.");
  return state.approvalClient;
}

function restoreConnectedState(state: SupervisorState) {
  if (state.terminalError) return;
  state.lastError = "";
  state.status = state.pendingCount > 0 ? "pending" : "connected";
  setStatus(state);
}

function watcherConnectionError(state: SupervisorState, error: Error) {
  if (state.terminalError) return;
  state.lastError = error.message;
  state.status = supervisorSocketUnavailable(error) || error instanceof SafeSupervisorConnectError ? "connecting" : "error";
  setStatus(state);
}

function updatePending(state: SupervisorState, delta: number) {
  state.pendingCount = Math.max(0, state.pendingCount + delta);
  if (state.status !== "error" && state.status !== "connecting" && state.status !== "starting") {
    state.status = state.pendingCount > 0 ? "pending" : "connected";
  }
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
    const choice = await showApprovalPrompt(ctx, approval, choices, controller.signal);
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
  state.terminalError = false;
}

async function attachToSocket(state: SupervisorState, mode: ProtocolMode, source: SupervisorSource, socketPath: string, ctx: ExtensionContext, seedMetadata?: SupervisorMetadata) {
  state.active = true;
  state.activeMode = mode;
  state.source = source;
  state.socketPath = socketPath;
  state.metadata = seedMetadata;
  state.sessionId = metadataSessionId(seedMetadata);
  state.status = "connecting";
  state.terminalError = false;
  setStatus(state, ctx);

  let client: SupervisorClient;
  const connectionEvents: RestConnectionEvents = {
    onReconnecting(error, deadline) {
      if (state.client !== client || state.terminalError) return;
      state.status = "connecting";
      state.lastError = `Supervisor tunnel unavailable (${supervisorErrorCode(error) || error.name}); retrying until ${new Date(deadline).toISOString()}`;
      setStatus(state);
    },
    onReconnected(metadata) {
      if (state.client !== client || state.terminalError) return;
      state.metadata = { ...state.metadata, ...metadata, supervisor_sock: socketPath };
      state.sessionId = metadataSessionId(state.metadata);
      restoreConnectedState(state);
    },
    onReconnectFailed(error) {
      if (state.client !== client || state.terminalError) return;
      state.status = "error";
      state.lastError = error.message;
      setStatus(state);
    },
    onSessionLost(error) {
      if (state.client !== client) return;
      state.terminalError = true;
      state.status = "error";
      state.lastError = error.message;
      state.watcher?.stop();
      setStatus(state);
    },
  };
  client = mode === "mock-ndjson"
    ? new MockSupervisorClient(socketPath)
    : mode === "legacy-approval-ui"
      ? new LegacyApprovalUIClient(socketPath)
      : new RestSupervisorClient(socketPath, seedMetadata, connectionEvents);
  state.client = client;
  state.approvalClient = client;
  const metadata = await client.hello();
  state.metadata = { ...seedMetadata, ...metadata, supervisor_sock: socketPath };
  assertNetworkEnforcementReady(state.metadata);
  state.sessionId = metadataSessionId(state.metadata);
  const expectedSessionId = env("AGENTSH_SESSION_ID");
  if (expectedSessionId && state.sessionId !== expectedSessionId) {
    throw new SupervisorSessionLostError(expectedSessionId, `The attached supervisor returned ${state.sessionId || "no session ID"}.`);
  }
  state.terminalError = false;
  restoreConnectedState(state);

  if (mode === "rest" && centralApprovalBridgeRequested() && centralApprovalBridgeEnabled() && state.sessionId) {
    state.approvalClient = new CentralApprovalClient(centralApprovalBridgeURL(), state.sessionId, centralApprovalBridgeToken());
  }

  state.watcher = mode === "mock-ndjson"
    ? new MockApprovalWatcher(
      client as MockSupervisorClient,
      (approval) => enqueueApproval(state, approval),
      (error) => watcherConnectionError(state, error),
      () => restoreConnectedState(state),
    )
    : new RestApprovalWatcher(
      client as RestSupervisorClient | LegacyApprovalUIClient,
      (approvals) => syncPendingApprovals(state, approvals),
      (error) => watcherConnectionError(state, error),
      () => restoreConnectedState(state),
    );
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
    state.watcher?.stop();
    state.watcher = undefined;
    state.client = undefined;
    state.approvalClient = undefined;
    state.active = true;
    state.status = "error";
    state.terminalError = error instanceof SupervisorSessionLostError;
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
    metadataNetworkEnforcement(state.metadata)?.requested ? `Network:  ${metadataNetworkEnforcement(state.metadata)?.requested} / ${metadataNetworkEnforcement(state.metadata)?.status || "unknown"} / ${metadataNetworkEnforcement(state.metadata)?.tier || "unknown"}${state.metadata?.network_enforcement_live ? " (live)" : " (not live)"}` : "",
    metadataNetworkEnforcement(state.metadata)?.detail ? `Net detail: ${metadataNetworkEnforcement(state.metadata)?.detail}` : "",
    state.metadata?.network_enforcement_error ? `Net error: ${state.metadata.network_enforcement_error}` : "",
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
      return await client.exec(commandOrParams.command, {
        ...options,
        cwd: commandOrParams.cwd ?? options.cwd,
        timeout_ms: commandOrParams.timeout_ms ?? options.timeout_ms,
        persist_output_over_bytes: commandOrParams.persist_output_over_bytes ?? options.persist_output_over_bytes,
        persist_output_over_lines: commandOrParams.persist_output_over_lines ?? options.persist_output_over_lines,
        actor: commandOrParams.actor ?? options.actor,
      });
    },
    async refreshDirenv(options) {
      return await requireClient(state).refreshDirenv({
        ...options,
        cwd: env("PI_AGENTSH_REMOTE_CWD") || options.cwd || effectiveSupervisorCwd(state.ctx),
      });
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
  const rawText = textFromResult(result, "");
  const localWindow = truncateHead(rawText, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  let text = localWindow.content;
  const remotelyTruncated = result?.truncated === true;
  if (remotelyTruncated || localWindow.truncated) {
    const startLine = numericField(result?.start_line) ?? 1;
    const endLine = numericField(result?.end_line) ?? (startLine + localWindow.outputLines - 1);
    const nextOffset = numericField(result?.next_offset) ?? (!localWindow.firstLineExceedsLimit && localWindow.outputLines > 0 ? endLine + 1 : undefined);
    if (nextOffset) {
      const range = endLine >= startLine ? `Showing lines ${startLine}-${endLine}. ` : "";
      text += `\n\n[${range}Use offset=${nextOffset} to continue.]`;
    } else if (result?.byte_truncated === true || localWindow.firstLineExceedsLimit) {
      text += `\n\n[Current line exceeds the ${formatSize(numericField(result?.max_bytes) ?? DEFAULT_MAX_BYTES)} read limit. Use supervised bash with a byte-range command to inspect the remainder.]`;
    }
  }
  return [{ type: "text", text }];
}

type SandboxEditRenderState = {
  callComponent?: Box;
  output?: string;
  isError?: boolean;
};

type SandboxEditRenderContext = {
  args?: any;
  state?: SandboxEditRenderState;
  lastComponent?: Component;
  isError?: boolean;
};

function sandboxEditPath(args: any) {
  return typeof args?.path === "string" && args.path ? args.path : "(unknown path)";
}

function getSandboxEditCallComponent(context: SandboxEditRenderContext | undefined) {
  const state = context?.state;
  if (context?.lastComponent instanceof Box) {
    if (state) state.callComponent = context.lastComponent;
    return context.lastComponent;
  }
  if (state?.callComponent) return state.callComponent;
  const component = new Box(1, 1, (text: string) => text);
  if (state) state.callComponent = component;
  return component;
}

function themeBg(theme: any, color: string, text: string) {
  return typeof theme?.bg === "function" ? theme.bg(color, text) : text;
}

function themeBold(theme: any, text: string) {
  return typeof theme?.bold === "function" ? theme.bold(text) : text;
}

function renderSandboxEditCallInto(component: Box, args: any, theme: any, state?: SandboxEditRenderState) {
  component.setBgFn(
    state?.isError
      ? (text: string) => themeBg(theme, "toolErrorBg", text)
      : state?.output
        ? (text: string) => themeBg(theme, "toolSuccessBg", text)
        : (text: string) => themeBg(theme, "toolPendingBg", text),
  );
  component.clear();
  component.addChild(new Text(`${theme.fg("toolTitle", themeBold(theme, "edit"))} ${theme.fg("accent", sandboxEditPath(args))}`, 0, 0));
  if (state?.output) {
    component.addChild(new Spacer(1));
    component.addChild(new Text(state.output, 0, 0));
  }
  return component;
}

function renderSandboxEditToolCall(args: any, theme: any, context?: SandboxEditRenderContext) {
  const component = getSandboxEditCallComponent(context);
  return renderSandboxEditCallInto(component, args, theme, context?.state);
}

function formatSandboxEditResult(result: any, args: any, theme: any, isError: boolean | undefined) {
  const details = result?.details && typeof result.details === "object" ? result.details : {};
  const diff = typeof details.diff === "string" && details.diff ? details.diff : typeof result?.details?.patch === "string" ? result.details.patch : typeof result?.diff === "string" ? result.diff : undefined;
  const text = textFromResult(result, "").trim();
  if (isError) return text ? theme.fg("error", text) : undefined;
  if (diff) return renderDiff(diff, { filePath: sandboxEditPath(args) });
  return text ? theme.fg("toolOutput", text) : undefined;
}

function renderSandboxEditToolResult(result: any, _options: any, theme: any, context?: SandboxEditRenderContext) {
  const state = context?.state;
  const output = formatSandboxEditResult(result, context?.args, theme, context?.isError);
  if (state) {
    state.output = output;
    state.isError = context?.isError;
    if (state.callComponent) renderSandboxEditCallInto(state.callComponent, context?.args, theme, state);
  }
  const component = new Container();
  if (!state && output) {
    const text = textFromResult(result, "").trim();
    component.addChild(new Text(text && !output.includes(text) ? `${theme.fg("toolOutput", text)}\n\n${output}` : output, 0, 0));
  }
  return component;
}

function modelMatches(candidate: any, requested: string) {
  const value = requested.trim();
  if (!value) return false;
  return candidate?.id === value || candidate?.name === value || `${candidate?.provider}/${candidate?.id}` === value || `${candidate?.provider}:${candidate?.id}` === value;
}

function contextWindowForModel(ctx: ExtensionContext | undefined, model?: string): number {
  const requested = typeof model === "string" ? model.trim() : "";
  if (requested) {
    const allModels = ctx?.modelRegistry?.getAll?.() ?? [];
    const match = allModels.find((candidate: any) => modelMatches(candidate, requested));
    if (typeof match?.contextWindow === "number" && Number.isFinite(match.contextWindow) && match.contextWindow > 0) return match.contextWindow;
  }
  const current = ctx?.model;
  if (!requested || modelMatches(current, requested)) {
    const contextWindow = current?.contextWindow;
    if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) return contextWindow;
  }
  return 0;
}

function latestSubagentAssistantMessage(state: SubagentStreamState) {
  return [...state.messages].reverse().find((message) => message.role === "assistant");
}

function latestSubagentAssistantText(state: SubagentStreamState): string {
  const latestAssistant = latestSubagentAssistantMessage(state);
  return latestAssistant?.content.filter((part) => part.type === "text").map((part) => String(part.text || "")).join("").trim() || "";
}

function piProtocolFailure(state: SubagentStreamState): { failureKind: "model" | "protocol"; message: string; retryable: boolean } | undefined {
  const hasProtocolEvidence = state.sawPiJsonStdout || state.protocolSettled || Boolean(state.modelStopReason);
  if (!hasProtocolEvidence) return undefined;
  const latestAssistant = latestSubagentAssistantMessage(state);
  const modelStopReason = String(state.modelStopReason || latestAssistant?.stopReason || "").trim();
  const normalizedStopReason = modelStopReason.toLowerCase().replace(/[_-]/g, "");
  if (["error", "aborted", "cancelled", "canceled"].includes(normalizedStopReason)) {
    return { failureKind: "model", message: latestAssistant?.errorMessage || `child model stopped: ${modelStopReason || "error"}`, retryable: false };
  }
  if (!state.protocolSettled) return { failureKind: "protocol", message: "child Pi stream ended before agent_settled", retryable: true };
  if (normalizedStopReason === "tooluse") {
    return { failureKind: "protocol", message: "child Pi settled after a tool-use turn without a final assistant response", retryable: true };
  }
  if (!state.final?.trim() && !latestSubagentAssistantText(state)) {
    return { failureKind: "protocol", message: "child Pi settled without visible final assistant text", retryable: true };
  }
  return undefined;
}

function subagentParentDetails(result: any, ctx?: ExtensionContext, streamedStates?: Map<string, SubagentStreamState>) {
  const detailResult = (item: any) => {
    const label = stringifyData(item?.label || "subagent") || "subagent";
    const streamed = streamedStates?.get(label);
    const parsed = typeof item?.stdout === "string" ? parseSubagentPiJsonStdout(item.stdout) : undefined;
    const model = item?.model || streamed?.model || parsed?.model;
    const usageCandidates = [streamed?.usage, parsed?.usage, item?.usage].filter((candidate): candidate is any => Boolean(candidate));
    const mostCompleteUsage = usageCandidates.sort((a, b) => usageNumber(b?.turns) - usageNumber(a?.turns))[0] ?? usageZero();
    const usage = { ...mostCompleteUsage };
    usage.contextWindow = usageNumber(item?.context_window ?? item?.contextWindow) || usageNumber(streamed?.usage.contextWindow) || contextWindowForModel(ctx, model);
    const serverDiagnostics = !streamed && Array.isArray(item?.protocol_diagnostics ?? item?.protocolDiagnostics)
      ? (item.protocol_diagnostics ?? item.protocolDiagnostics).map((diagnostic: any) => ({
          kind: stringifyData(diagnostic?.kind || "unknown_event") as any,
          detail: [diagnostic?.event, diagnostic?.bytes ? `${diagnostic.bytes} B` : ""].filter(Boolean).join(": ") || undefined,
        }))
      : [];
    const protocolDiagnostics = [
      ...(streamed?.protocolDiagnostics ?? parsed?.protocolDiagnostics ?? item?.protocolDiagnostics ?? []),
      ...serverDiagnostics,
    ];
    const itemTerminal = normalizeSubagentTerminal(item?.terminal, { exitCode: item?.exit_code ?? item?.exitCode, stopReason: item?.stop_reason ?? item?.stopReason, error: item?.error ?? item?.errorMessage });
    const terminalWasDowngraded = itemTerminal?.state === "completed" && streamed?.terminal?.state === "failed";
    const serverFinal = !terminalWasDowngraded && typeof item?.final === "string" && item.final.trim() ? item.final : undefined;
    return createSubagentProgressCapsule({
      label,
      task: item?.task ?? streamed?.task,
      exitCode: item?.exit_code ?? item?.exitCode ?? streamed?.exitCode,
      stopReason: item?.stop_reason ?? item?.stopReason ?? streamed?.stopReason,
      terminal: streamed?.terminal ?? itemTerminal,
      final: serverFinal ?? (terminalWasDowngraded ? undefined : streamed?.final),
      errorMessage: item?.error ?? item?.errorMessage ?? streamed?.errorMessage,
      stderr: item?.stderr ?? item?.stderrTail ?? streamed?.stderr,
      usage,
      messages: streamed?.messages?.length ? streamed.messages : parsed?.messages ?? item?.messages ?? [],
      model,
      modelStopReason: item?.model_stop_reason ?? item?.modelStopReason ?? streamed?.modelStopReason ?? parsed?.modelStopReason,
      tools: item?.tools ?? streamed?.tools,
      cwd: item?.cwd ?? streamed?.cwd,
      lastToolCall: streamed?.lastToolCall ?? parsed?.lastToolCall ?? item?.activeTool,
      completedTools: streamed?.completedTools?.length ? streamed.completedTools : parsed?.completedTools ?? item?.completedTools ?? [],
      readFiles: streamed?.readFiles?.length ? streamed.readFiles : parsed?.readFiles ?? item?.readFiles ?? [],
      modifiedFiles: streamed?.modifiedFiles?.length ? streamed.modifiedFiles : parsed?.modifiedFiles ?? item?.modifiedFiles ?? [],
      protocolDiagnostics,
      protocolSettled: item?.protocol_settled === true || item?.protocolSettled === true || streamed?.protocolSettled === true || parsed?.protocolSettled === true,
      stdoutTruncated: item?.stdout_truncated === true || item?.stdoutTruncated === true || streamed?.stdoutTruncated === true,
      stdoutTotalBytes: Math.max(usageNumber(item?.stdout_total_bytes ?? item?.stdoutTotalBytes), usageNumber(streamed?.stdoutTotalBytes)),
      compaction: streamed?.compaction ?? parsed?.compaction ?? item?.compaction,
      fullResultPath: item?.full_result_path ?? item?.fullResultPath,
      finalTruncated: item?.final_truncated === true || item?.finalTruncated === true,
      finalTotalBytes: item?.final_total_bytes ?? item?.finalTotalBytes,
      finalInlineBytes: item?.final_inline_bytes ?? item?.finalInlineBytes,
      artifactBytes: item?.artifact_bytes ?? item?.artifactBytes,
      artifactComplete: typeof item?.artifact_complete === "boolean" ? item.artifact_complete : item?.artifactComplete,
      artifactError: item?.artifact_error ?? item?.artifactError,
    });
  };
  const results = boundSubagentProgressCapsules(Array.isArray(result?.results) ? result.results.map(detailResult) : []);
  let terminal = normalizeSubagentTerminal(result?.terminal);
  if (terminal?.state === "completed") {
    const failedChild = results.find((child) => subagentTerminalFailed(child.terminal));
    if (failedChild?.terminal) terminal = { ...failedChild.terminal, message: failedChild.terminal.message || failedChild.errorMessage };
  }
  const serverParentFinal = terminal?.state === "completed" && typeof result?.final === "string" && result.final.trim() ? sanitizeSubagentParentText(result.final, 4 * 1024) : undefined;
  const singleArtifact = results.length === 1 ? results[0] : undefined;
  return {
    mode: result?.mode || (results.length > 1 ? "parallel" : "single"),
    results,
    terminal,
    final: serverParentFinal ?? (results.length === 1 && results[0].terminal?.state === "completed" ? results[0].final ?? results[0].lastAssistantText : undefined),
    summary: typeof result?.summary === "string" ? sanitizeSubagentParentText(result.summary, 4 * 1024) : undefined,
    error: terminal?.message || (typeof result?.error === "string" ? sanitizeSubagentParentText(result.error, 1024) : undefined),
    fullResultPath: singleArtifact?.fullResultPath,
    finalTruncated: singleArtifact?.finalTruncated,
    finalTotalBytes: singleArtifact?.finalTotalBytes,
    artifactBytes: singleArtifact?.artifactBytes,
    artifactComplete: singleArtifact?.artifactComplete,
    artifactError: singleArtifact?.artifactError,
  };
}

function resultLine(result: any) {
  const label = stringifyData(result?.label || "subagent");
  const failed = subagentTerminalFailed(result?.terminal);
  const text = stringifyData(failed
    ? result?.error || result?.errorMessage || result?.terminal?.message || result?.stop_reason || result?.stopReason || result?.final || result?.lastAssistantText || ""
    : result?.final || result?.lastAssistantText || result?.summary || result?.error || result?.errorMessage || result?.terminal?.message || result?.stop_reason || result?.stopReason || "").trim();
  return text ? `[${label}] ${truncateByBytes(text)}` : `[${label}] ${result?.exit_code ?? result?.exitCode ?? "completed"}`;
}

function subagentText(result: any) {
  const direct = textFromResult(result, "").trim();
  if (direct) return direct;
  if (typeof result?.final === "string" && result.final.trim()) return result.final;
  if (typeof result?.summary === "string" && result.summary.trim()) return result.summary;
  if (Array.isArray(result?.results) && result.results.length > 0) return result.results.map(resultLine).join("\n\n");
  return JSON.stringify(subagentParentDetails(result) ?? {}, null, 2);
}

function subagentArtifactHints(result: any): string {
  if (!Array.isArray(result?.results)) return "";
  const hints = result.results.flatMap((child: any) => {
    const label = stringifyData(child?.label || "subagent");
    const path = typeof child?.fullResultPath === "string" ? child.fullResultPath : "";
    if (path) {
      const bytes = usageNumber(child?.artifactBytes);
      const total = usageNumber(child?.finalTotalBytes);
      const completeness = child?.artifactComplete === false && total
        ? ` (${formatSize(bytes)} of ${formatSize(total)} retained)`
        : "";
      return [`Full subagent result [${label}]: ${path}${completeness}`];
    }
    if (typeof child?.artifactError === "string" && child.artifactError) {
      return [`Subagent result artifact unavailable [${label}]: ${child.artifactError}`];
    }
    return [];
  });
  return truncateByBytes(hints.join("\n"), 4 * 1024);
}

function boundedSubagentParentOutput(result: any): string {
  const inline = truncateByBytes(subagentText(result));
  const hints = subagentArtifactHints(result);
  return hints ? `${inline}\n\n${hints}` : inline;
}

function renderSubagentStream(state: SubagentStreamState) {
  let text = state.prefix;
  const appendBlock = (block: string) => {
    if (!block) return;
    if (text && !text.endsWith("\n")) text += "\n";
    text += block;
    if (!text.endsWith("\n")) text += "\n";
  };
  appendBlock(state.liveText);
  appendBlock(subagentLiveToolStatus(state) || "");
  appendBlock(state.rawText);
  const usage = formatSubagentUsage(state.usage, state.model);
  if (usage) appendBlock(`[${usage}]`);
  return text.trimEnd();
}

function formatTokenCount(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatSubagentUsage(usage: any, model?: string): string {
  const parts: string[] = [];
  const contextTokens = usageNumber(usage?.contextTokens);
  const contextWindow = usageNumber(usage?.contextWindow);
  if (usage?.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage?.input) parts.push(`↑${formatTokenCount(usage.input)}`);
  if (usage?.output) parts.push(`↓${formatTokenCount(usage.output)}`);
  if (usage?.cacheRead) parts.push(`R${formatTokenCount(usage.cacheRead)}`);
  if (usage?.cacheWrite) parts.push(`W${formatTokenCount(usage.cacheWrite)}`);
  if (usage?.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (contextTokens && contextWindow) {
    const pct = Math.min(999, Math.round((contextTokens / contextWindow) * 100));
    parts.push(`ctx:${formatTokenCount(contextTokens)}/${formatTokenCount(contextWindow)} (${pct}%)`);
  } else if (contextTokens) {
    parts.push(`ctx:${formatTokenCount(contextTokens)}`);
  }
  if (model) parts.push(model);
  return parts.join(" ");
}

function subagentFinalOutput(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) if (part?.type === "text") return String(part.text || "");
  }
  return "";
}

function subagentDisplayItems(messages: any[]): Array<{ type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> }> {
  const items: Array<{ type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> }> = [];
  for (const msg of messages) {
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part?.type === "text") items.push({ type: "text", text: String(part.text || "") });
      else if (part?.type === "toolCall") items.push({ type: "toolCall", name: String(part.name || "unknown"), args: part.arguments || {} });
    }
  }
  return items;
}

function formatSubagentToolCall(toolName: string, args: Record<string, unknown>, themeFg: (color: any, text: string) => string): string {
  const shortenPath = (p: string) => {
    const home = homedir();
    return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  };
  if (toolName === "bash") return themeFg("muted", "$ ") + themeFg("toolOutput", String(args.command || "...").slice(0, 80));
  if (toolName === "read") {
    const path = shortenPath(String(args.path || args.file_path || "..."));
    const lineInfo = args.offset ? `:${args.offset}${args.limit ? `-${Number(args.offset) + Number(args.limit) - 1}` : ""}` : "";
    return themeFg("muted", "read ") + themeFg("accent", path + lineInfo);
  }
  if (toolName === "write") return themeFg("muted", "write ") + themeFg("accent", shortenPath(String(args.path || args.file_path || "...")));
  if (toolName === "edit") return themeFg("muted", "edit ") + themeFg("accent", shortenPath(String(args.path || args.file_path || "...")));
  if (toolName === "ls") return themeFg("muted", "ls ") + themeFg("accent", shortenPath(String(args.path || ".")));
  if (toolName === "find") return themeFg("muted", "find ") + themeFg("accent", String(args.pattern || "*")) + themeFg("dim", ` in ${shortenPath(String(args.path || "."))}`);
  if (toolName === "grep") return themeFg("muted", "grep ") + themeFg("accent", `/${String(args.pattern || "")}/`) + themeFg("dim", ` in ${shortenPath(String(args.path || "."))}`);
  const argsStr = JSON.stringify(args || {});
  return themeFg("accent", toolName) + themeFg("dim", ` ${argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr}`);
}

function completedSubagentToolArgs(tool: any): Record<string, unknown> {
  if (tool?.args && typeof tool.args === "object" && !Array.isArray(tool.args)) return tool.args;
  return tool?.path ? { path: tool.path } : {};
}

function isSubagentFailure(result: any): boolean {
  const terminal = normalizeSubagentTerminal(result?.terminal, { exitCode: result?.exitCode, stopReason: result?.stopReason, error: result?.errorMessage });
  if (terminal) return subagentTerminalFailed(terminal);
  return result?.exitCode !== -1 && (result?.exitCode !== 0 || result?.stopReason === "error" || result?.stopReason === "aborted" || result?.stopReason === "timeout");
}

function aggregateSubagentUsage(results: any[]) {
  const total = usageZero();
  for (const r of results) {
    total.input += usageNumber(r?.usage?.input);
    total.output += usageNumber(r?.usage?.output);
    total.cacheRead += usageNumber(r?.usage?.cacheRead);
    total.cacheWrite += usageNumber(r?.usage?.cacheWrite);
    total.cost += usageNumber(r?.usage?.cost);
    total.turns += usageNumber(r?.usage?.turns);
  }
  return total;
}

function subagentResultStatus(result: any): string {
  if (result?.exitCode === -1) return "running";
  const terminal = normalizeSubagentTerminal(result?.terminal, { exitCode: result?.exitCode, stopReason: result?.stopReason, error: result?.errorMessage });
  if (terminal?.state === "timed_out") return "timed out";
  if (terminal?.state === "cancelled") return "cancelled";
  if (terminal?.state === "failed") return "failed";
  if (terminal?.state === "completed") return "completed";
  if (result?.stopReason === "aborted") return "aborted";
  if (result?.stopReason === "timeout") return "timed out";
  if (isSubagentFailure(result)) return "failed";
  return "completed";
}

function subagentLastAssistantText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;
    return msg.content.filter((part: any) => part?.type === "text").map((part: any) => String(part.text || "")).join("").trim();
  }
  return "";
}

function compactSubagentResultSummary(result: any): string {
  const lines: string[] = [];
  lines.push(`Subagent ${subagentResultStatus(result)}.`);
  if (result?.task) lines.push(`Task: ${result.task}`);
  if (result?.model) lines.push(`Model: ${result.model}`);
  if (result?.tools?.length) lines.push(`Tools: ${result.tools.join(", ")}`);
  const lastAssistant = String(result?.lastAssistantText || subagentLastAssistantText(result?.messages || [])).trim();
  if (lastAssistant) lines.push(`Last assistant text:\n${truncateByBytes(lastAssistant).split("\n").slice(-8).join("\n")}`);
  if (result?.activeTool) lines.push(`Active tool: ${result.activeTool.name} ${JSON.stringify(result.activeTool.args)}`);
  const lastTool = Array.isArray(result?.completedTools) ? result.completedTools.at(-1) : undefined;
  if (lastTool) {
    const summary = formatSubagentToolCall(lastTool.name, completedSubagentToolArgs(lastTool), (_color, text) => text);
    lines.push(`Last completed tool: ${summary}${lastTool.isError ? " (failed)" : ""}${lastTool.resultPreview ? `\n${lastTool.resultPreview}` : ""}`);
  }
  const stderr = String(result?.stderrTail || result?.stderr || "").trim().split("\n").filter(Boolean).slice(-8).join("\n");
  if (stderr) lines.push(`stderr:\n${stderr}`);
  if (result?.errorMessage) lines.push(`Error: ${result.errorMessage}`);
  if (result?.fullResultPath) lines.push(`Full result: ${result.fullResultPath}`);
  if (result?.artifactError) lines.push(`Result artifact unavailable: ${result.artifactError}`);
  lines.push(`Exit: ${result?.exitCode ?? 0}${result?.stopReason ? ` (${result.stopReason})` : ""}`);
  return truncateByBytes(lines.join("\n"));
}

function renderSubagentCall(args: any, theme: any) {
  if (args.chain?.length) return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `chain (${args.chain.length} steps)`)}`, 0, 0);
  if (args.tasks?.length) return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `parallel (${args.tasks.length} tasks)`)}`, 0, 0);
  const task = String(args.task ?? "...");
  return new Text(`${theme.fg("toolTitle", theme.bold("subagent single"))}\n  ${theme.fg("dim", task.length > 70 ? `${task.slice(0, 70)}...` : task)}`, 0, 0);
}

function renderSubagentResult(result: any, options: any, theme: any) {
  const details = result.details as any | undefined;
  if (!details?.results?.length) return new Text(result.content?.[0]?.type === "text" ? result.content[0].text : "(no output)", 0, 0);
  const expanded = Boolean(options?.expanded);
  const mdTheme = getMarkdownTheme();

  const renderDisplayItems = (items: ReturnType<typeof subagentDisplayItems>, limit?: number) => {
    const toShow = limit ? items.slice(-limit) : items;
    const skipped = limit && items.length > limit ? items.length - limit : 0;
    let text = "";
    if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
    for (const item of toShow) {
      if (item.type === "text") {
        const preview = expanded ? truncateByBytes(item.text) : truncateByBytes(item.text).split("\n").slice(0, 3).join("\n");
        text += `${theme.fg("toolOutput", preview)}\n`;
      } else {
        text += `${theme.fg("muted", "→ ") + formatSubagentToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
      }
    }
    return text.trimEnd();
  };

  const renderOneExpanded = (container: Container, r: any, title: string) => {
    const failed = isSubagentFailure(r);
    const icon = failed ? theme.fg("error", "✗") : r.exitCode === -1 ? theme.fg("warning", "⏳") : theme.fg("success", "✓");
    container.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold(title))}`, 0, 0));
    container.addChild(new Text(theme.fg("muted", "Status: ") + theme.fg(failed ? "error" : "dim", `${subagentResultStatus(r)} (exit ${r.exitCode ?? 0})`), 0, 0));
    if (r.task) container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
    if (r.model) container.addChild(new Text(theme.fg("muted", "Model: ") + theme.fg("dim", r.model), 0, 0));
    if (r.tools?.length) container.addChild(new Text(theme.fg("muted", "Tools: ") + theme.fg("dim", r.tools.join(", ")), 0, 0));
    if (r.cwd) container.addChild(new Text(theme.fg("muted", "Cwd: ") + theme.fg("dim", r.cwd), 0, 0));
    if (failed && r.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
    if (r.activeTool) container.addChild(new Text(theme.fg("muted", "Active tool: ") + formatSubagentToolCall(r.activeTool.name, r.activeTool.args, theme.fg.bind(theme)), 0, 0));
    const lastTool = Array.isArray(r.completedTools) ? r.completedTools.at(-1) : undefined;
    if (lastTool) {
      const summary = formatSubagentToolCall(lastTool.name, completedSubagentToolArgs(lastTool), theme.fg.bind(theme));
      container.addChild(new Text(theme.fg("muted", "Last completed tool: ") + summary + theme.fg("muted", `${lastTool.isError ? " (failed)" : ""}${lastTool.resultPreview ? `\n${lastTool.resultPreview}` : ""}`), 0, 0));
    }

    for (const item of subagentDisplayItems(r.messages || [])) {
      if (item.type === "toolCall") container.addChild(new Text(theme.fg("muted", "→ ") + formatSubagentToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0));
    }

    const finalOutput = r.final || subagentFinalOutput(r.messages || []);
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
    if (finalOutput) container.addChild(new Markdown(truncateByBytes(finalOutput.trim()), 0, 0, mdTheme));
    else container.addChild(new Text(theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)"), 0, 0));
    if (r.fullResultPath) container.addChild(new Text(theme.fg("dim", `Full result: ${r.fullResultPath}`), 0, 0));
    else if (r.artifactError) container.addChild(new Text(theme.fg("warning", `Result artifact unavailable: ${r.artifactError}`), 0, 0));

    const usage = formatSubagentUsage(r.usage, r.model);
    if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
    if ((r.stderrTail || r.stderr)?.trim()) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg(failed ? "error" : "dim", `stderr:\n${truncateByBytes((r.stderrTail || r.stderr).trim())}`), 0, 0));
    }
  };

  const mode = details.mode || (details.results.length > 1 ? "parallel" : "single");
  if (mode === "single" && details.results.length === 1) {
    const r = details.results[0];
    if (expanded) {
      const container = new Container();
      renderOneExpanded(container, r, r.label || "subagent");
      return container;
    }
    const failed = isSubagentFailure(r);
    const icon = r.exitCode === -1 ? theme.fg("warning", "⏳") : failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
    const displayItems = subagentDisplayItems(r.messages || []);
    let text = `${icon} ${theme.fg("toolTitle", theme.bold("subagent"))}`;
    if (failed) text += `\n${theme.fg("error", compactSubagentResultSummary(r).split("\n").slice(0, 14).join("\n"))}`;
    else if (displayItems.length === 0) {
      const lastTool = Array.isArray(r.completedTools) ? r.completedTools.at(-1) : undefined;
      const fallback = String(r.final || r.errorMessage || "").trim();
      if (lastTool) text += `\n${theme.fg("muted", "→ ")}${formatSubagentToolCall(lastTool.name, completedSubagentToolArgs(lastTool), theme.fg.bind(theme))}`;
      else text += fallback ? `\n${theme.fg("toolOutput", truncateByBytes(fallback).split("\n").slice(0, 8).join("\n"))}` : `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
    } else text += `\n${renderDisplayItems(displayItems, 10)}`;
    if (r.fullResultPath) text += `\n${theme.fg("dim", `Full result: ${r.fullResultPath}`)}`;
    else if (r.artifactError) text += `\n${theme.fg("warning", `Result artifact unavailable: ${r.artifactError}`)}`;
    const usage = formatSubagentUsage(r.usage, r.model);
    if (usage) text += `\n${theme.fg("dim", usage)}`;
    return new Text(text, 0, 0);
  }

  const running = details.results.filter((r: any) => r.exitCode === -1).length;
  const successCount = details.results.filter((r: any) => r.exitCode !== -1 && !isSubagentFailure(r)).length;
  const failCount = details.results.filter((r: any) => r.exitCode !== -1 && isSubagentFailure(r)).length;
  const icon = running > 0 ? theme.fg("warning", "⏳") : failCount > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✓");
  const noun = mode === "chain" ? "steps" : "tasks";
  const status = running > 0 ? `${successCount + failCount}/${details.results.length} done, ${running} running` : `${successCount}/${details.results.length} ${noun}`;

  if (expanded) {
    const container = new Container();
    container.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold(`${mode} `))}${theme.fg("accent", status)}`, 0, 0));
    for (const r of details.results) {
      container.addChild(new Spacer(1));
      renderOneExpanded(container, r, mode === "chain" ? `step ${r.step ?? "?"}` : r.label || "subagent");
    }
    const totalUsage = formatSubagentUsage(aggregateSubagentUsage(details.results));
    if (totalUsage) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("dim", `Total: ${totalUsage}`), 0, 0));
    }
    return container;
  }

  let text = `${icon} ${theme.fg("toolTitle", theme.bold(`${mode} `))}${theme.fg("accent", status)}`;
  for (const r of details.results) {
    const rIcon = r.exitCode === -1 ? theme.fg("warning", "⏳") : isSubagentFailure(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
    const displayItems = subagentDisplayItems(r.messages || []);
    text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", mode === "chain" ? `step ${r.step ?? "?"}` : r.label || "subagent")} ${rIcon}`;
    if (isSubagentFailure(r)) text += `\n${theme.fg("error", compactSubagentResultSummary(r).split("\n").slice(0, 10).join("\n"))}`;
    else if (displayItems.length === 0) {
      const lastTool = Array.isArray(r.completedTools) ? r.completedTools.at(-1) : undefined;
      const fallback = String(r.final || r.errorMessage || "").trim();
      if (lastTool) text += `\n${theme.fg("muted", "→ ")}${formatSubagentToolCall(lastTool.name, completedSubagentToolArgs(lastTool), theme.fg.bind(theme))}`;
      else text += fallback ? `\n${theme.fg("toolOutput", truncateByBytes(fallback).split("\n").slice(0, 5).join("\n"))}` : `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
    } else text += `\n${renderDisplayItems(displayItems, 5)}`;
    if (r.fullResultPath) text += `\n${theme.fg("dim", `Full result: ${r.fullResultPath}`)}`;
    else if (r.artifactError) text += `\n${theme.fg("warning", `Result artifact unavailable: ${r.artifactError}`)}`;
    const usage = formatSubagentUsage(r.usage, r.model);
    if (usage) text += `\n${theme.fg("dim", usage)}`;
  }
  if (running === 0) {
    const totalUsage = formatSubagentUsage(aggregateSubagentUsage(details.results));
    if (totalUsage) text += `\n\n${theme.fg("dim", `Total: ${totalUsage}`)}`;
  }
  if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
  return new Text(text, 0, 0);
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
    terminalError: false,
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
      const output = new StringOutputAccumulator();
      const emit = () => {
        const snapshot = output.snapshot({ persistIfTruncated: true });
        onUpdate?.({
          content: snapshot.content ? [{ type: "text", text: formatAccumulatedOutput(snapshot, output) }] : [],
          details: {
            truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
            fullOutputPath: snapshot.fullOutputPath,
          },
        });
      };
      onUpdate?.({ content: [], details: undefined });
      try {
        const result = await client.exec(params.command, {
          cwd: effectiveSupervisorCwd(ctx),
          timeout: params.timeout,
          tool_call_id: toolCallId,
          persist_output_over_bytes: DEFAULT_MAX_BYTES,
          persist_output_over_lines: DEFAULT_MAX_LINES,
          signal,
          onOutput: (chunk) => {
            output.append(chunk);
            emit();
          },
        });
        output.finish();
        const snapshot = output.snapshot({ persistIfTruncated: true });
        const exitCode = typeof result.exitCode === "number" ? result.exitCode : 0;
        const finalText = formatAccumulatedOutput(snapshot, output, result);
        const artifact = remoteOutputArtifact(result);
        const details = {
          exitCode,
          truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
          fullOutputPath: artifact?.path,
          outputArtifact: artifact,
        };
        if (exitCode !== 0) throw new Error(`${finalText}\n\nCommand exited with code ${exitCode}`);
        return { content: [{ type: "text", text: finalText }], details };
      } finally {
        output.finish();
        await output.closeTempFile();
      }
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
    renderShell: "self",
    renderCall(args, theme, context) {
      return renderSandboxEditToolCall(args, theme, context);
    },
    renderResult(result, options, theme, context) {
      return renderSandboxEditToolResult(result, options, theme, context);
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
    renderCall(args, theme) {
      return renderSubagentCall(args, theme);
    },
    renderResult(result, options, theme) {
      return renderSubagentResult(result, options, theme);
    },
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const effectiveParams = inheritSubagentModels(params, ctx.model);
      const hasSingle = typeof effectiveParams.task === "string" && effectiveParams.task.trim().length > 0;
      const hasTasks = Array.isArray(effectiveParams.tasks) && effectiveParams.tasks.length > 0;
      const hasChain = Array.isArray(effectiveParams.chain) && effectiveParams.chain.length > 0;
      if (Number(hasSingle) + Number(hasTasks) + Number(hasChain) !== 1) {
        throw new Error("Invalid parameters. Provide exactly one mode: task, non-empty tasks, or non-empty chain.");
      }
      const streamStates = new Map<string, SubagentStreamState>();
      const streamOrder: string[] = [];
      const streamKey = (message: SupervisorMessage) => stringifyData((message as any).label || (message as any).subagent_id || "subagent") || "subagent";
      const streamStateFor = (message: SupervisorMessage) => {
        const key = streamKey(message);
        let childState = streamStates.get(key);
        if (!childState) {
          const model = typeof (message as any).model === "string" ? (message as any).model : typeof effectiveParams.model === "string" ? effectiveParams.model : undefined;
          const usage = usageZero();
          usage.contextWindow = contextWindowForModel(ctx, model);
          childState = createSubagentStreamState({
            label: key,
            task: typeof (message as any).task === "string" ? (message as any).task : typeof effectiveParams.task === "string" ? effectiveParams.task : undefined,
            cwd: typeof (message as any).cwd === "string" ? (message as any).cwd : typeof effectiveParams.cwd === "string" ? effectiveParams.cwd : undefined,
            tools: Array.isArray((message as any).tools) ? (message as any).tools : Array.isArray(effectiveParams.tools) ? effectiveParams.tools : undefined,
            usage,
            model,
          });
          streamStates.set(key, childState);
          streamOrder.push(key);
        }
        return childState;
      };
      const renderSubagentStreams = () => streamOrder.map((key) => renderSubagentStream(streamStates.get(key)!)).filter(Boolean).join("\n\n");
      const streamDetails = () => ({
        mode: hasChain ? "chain" : hasTasks ? "parallel" : "single",
        results: boundSubagentProgressCapsules(streamOrder.map((key) => createSubagentProgressCapsule(streamStates.get(key)!))),
      });
      const emitSubagentUpdate = (message: SupervisorMessage) => {
        const latest = renderSubagentStreams();
        onUpdate?.({ content: latest ? [{ type: "text", text: latest }] : [], details: streamDetails() });
      };
      const resultArtifactThresholdBytes = hasSingle ? 4 * 1024 : 2 * 1024;
      let result: unknown;
      try {
        result = await requireClient(state).spawnSubagent({ ...effectiveParams, cwd: effectiveParams.cwd || effectiveSupervisorCwd(ctx), result_artifact_threshold_bytes: resultArtifactThresholdBytes, actor: parentActor(toolCallId, "Pi subagent tool") }, {
          signal,
          onUpdate: (message) => {
          if (message.event === "subagent_start") {
            emitSubagentUpdate(message);
            return;
          }
          if (message.event === "done") {
            for (const state of streamStates.values()) flushSubagentStdout(state);
            emitSubagentUpdate(message);
            return;
          }
          const childState = streamStateFor(message);
          if (message.event === "stdout") {
            appendSubagentStdoutChunk(childState, stringifyData(message.data || ""));
            emitSubagentUpdate(message);
          } else if (message.event === "stderr" || message.event === "message" || message.event === "subagent_update") {
            const text = stringifyData(message.data || message.result || "");
            if (message.event === "stderr") childState.stderr = tailByBytes((childState.stderr || "") + text);
            appendSubagentRawText(childState, text);
            emitSubagentUpdate(message);
          } else if (message.event === "subagent_child_start") {
            const label = stringifyData((message as any).label || "subagent");
            childState.label = label;
            if (typeof (message as any).task === "string") childState.task = (message as any).task;
            if (typeof (message as any).cwd === "string") childState.cwd = (message as any).cwd;
            if (Array.isArray((message as any).tools)) childState.tools = (message as any).tools;
            const model = typeof (message as any).model === "string" ? (message as any).model : undefined;
            if (model) childState.model = model;
            childState.usage.contextWindow = contextWindowForModel(ctx, childState.model || (typeof effectiveParams.model === "string" ? effectiveParams.model : undefined));
            appendSubagentPrefix(childState, `[${label} started]`);
            emitSubagentUpdate(message);
          } else if (message.event === "subagent_result") {
            flushSubagentStdout(childState);
            const result: any = (message as any).result;
            const rawExitCode = result?.exit_code ?? result?.exitCode;
            childState.exitCode = typeof rawExitCode === "number" && Number.isFinite(rawExitCode) ? rawExitCode : 1;
            childState.stopReason = stringifyData(result?.stop_reason || result?.stopReason || (childState.exitCode === 0 ? "completed" : "error"));
            childState.terminal = normalizeSubagentTerminal(result?.terminal, { exitCode: childState.exitCode, stopReason: childState.stopReason, error: result?.error });
            if (typeof result?.final === "string" && result.final.trim()) childState.final = truncateByBytes(result.final);
            const modelStopReason = stringifyData(result?.model_stop_reason ?? result?.modelStopReason ?? "").trim();
            if (modelStopReason) childState.modelStopReason = truncateByBytes(modelStopReason, 128);
            childState.protocolSettled ||= result?.protocol_settled === true || result?.protocolSettled === true;
            childState.stdoutTruncated ||= result?.stdout_truncated === true || result?.stdoutTruncated === true;
            childState.stdoutTotalBytes = Math.max(childState.stdoutTotalBytes, usageNumber(result?.stdout_total_bytes ?? result?.stdoutTotalBytes));
            const protocolFailure = childState.terminal?.state === "completed" ? piProtocolFailure(childState) : undefined;
            if (protocolFailure) {
              childState.final = undefined;
              childState.exitCode = 1;
              childState.stopReason = "error";
              childState.terminal = {
                state: "failed",
                failureKind: protocolFailure.failureKind,
                exitCode: 1,
                termination: "natural",
                retryable: protocolFailure.retryable,
                message: protocolFailure.message,
              };
            }
            if (Array.isArray(result?.protocol_diagnostics ?? result?.protocolDiagnostics)) {
              for (const diagnostic of result.protocol_diagnostics ?? result.protocolDiagnostics) {
                childState.protocolDiagnostics.push({
                  kind: stringifyData(diagnostic?.kind || "unknown_event") as any,
                  detail: [diagnostic?.event, diagnostic?.bytes ? `${diagnostic.bytes} B` : ""].filter(Boolean).join(": ") || undefined,
                });
              }
            }
            childState.errorMessage = childState.terminal?.message || (typeof result?.error === "string" ? truncateByBytes(result.error, 2 * 1024) : childState.errorMessage);
            childState.stderr = typeof result?.stderr === "string" ? tailByBytes(result.stderr) : childState.stderr;
            const final = stringifyData(result?.final || result?.error || "");
            if (final) {
              if (childState.liveText.trim() === final.trim()) childState.liveText = "";
              appendSubagentPrefix(childState, `[${stringifyData((message as any).label || result?.label || "subagent")}] ${truncateByBytes(final)}`);
            }
            emitSubagentUpdate(message);
          } else if (message.event === "tool_update") {
            emitSubagentUpdate(message);
          }
          },
        });
      } catch (error) {
        const rawMessage = asError(error).message || "spawn_subagent failed";
        const terminal = normalizeSubagentTerminal(error instanceof SubagentTransportTimeoutError
          ? { state: "timed_out", failure_kind: "transport", cancellation_cause: "request_timeout", exit_code: 124, termination: "natural", retryable: true, message: rawMessage }
          : signal?.aborted
            ? { state: "cancelled", cancellation_cause: "user_cancelled", exit_code: 130, termination: "graceful", retryable: true, message: rawMessage }
            : { state: "failed", failure_kind: "transport", exit_code: 1, termination: "natural", retryable: true, message: rawMessage });
        const message = terminal?.message || "spawn_subagent failed";
        for (const childState of streamStates.values()) {
          flushSubagentStdout(childState);
          if (childState.exitCode === -1) {
            const inferredProtocolFailure = piProtocolFailure(childState);
            const interrupted = terminal?.state === "cancelled" || terminal?.state === "timed_out";
            const protocolFailure = interrupted && inferredProtocolFailure?.failureKind === "protocol" && !childState.protocolSettled
              ? undefined
              : inferredProtocolFailure;
            const retainedFinal = latestSubagentAssistantText(childState);
            if (childState.protocolSettled && !protocolFailure && retainedFinal) {
              childState.exitCode = 0;
              childState.stopReason = "completed";
              childState.final ||= retainedFinal;
              childState.terminal = { state: "completed", exitCode: 0, termination: "natural", retryable: false };
            } else if (protocolFailure) {
              childState.final = undefined;
              childState.exitCode = 1;
              childState.stopReason = "error";
              childState.terminal = { state: "failed", failureKind: protocolFailure.failureKind, exitCode: 1, termination: "natural", retryable: protocolFailure.retryable, message: protocolFailure.message };
              childState.errorMessage ||= protocolFailure.message;
            } else if (interrupted) {
              childState.exitCode = terminal?.exitCode ?? 1;
              childState.stopReason = terminal?.state === "cancelled" ? "cancelled" : "timeout";
              childState.terminal = terminal;
              childState.errorMessage ||= message;
            } else {
              childState.exitCode = terminal?.exitCode ?? 1;
              childState.stopReason ||= terminal?.state === "cancelled" ? "cancelled" : terminal?.state === "timed_out" ? "timeout" : "error";
              childState.terminal ||= terminal;
              childState.errorMessage ||= message;
            }
          }
        }
        const mode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
        const results = streamOrder.length
          ? streamOrder.map((key) => createSubagentProgressCapsule(streamStates.get(key)!))
          : [createSubagentProgressCapsule({ label: "subagent", exitCode: terminal?.exitCode ?? 1, stopReason: terminal?.state === "cancelled" ? "cancelled" : terminal?.state === "timed_out" ? "timeout" : "error", terminal, final: message, errorMessage: message })];
        const outcomeLabel = terminal?.state === "cancelled" ? "subagent cancelled" : terminal?.state === "timed_out" ? "subagent timed out" : "subagent failed";
        result = {
          mode,
          terminal,
          final: `${outcomeLabel}: ${message}`,
          summary: `${outcomeLabel}: ${message}`,
          error: message,
          results,
        };
        const details = subagentParentDetails(result, ctx, streamStates) as any;
        const text = boundedSubagentParentOutput(details);
        return { content: [{ type: "text", text }], details, isError: true };
      }
      const details = subagentParentDetails(result, ctx, streamStates) as any;
      const text = boundedSubagentParentOutput(details);
      const isError = subagentTerminalFailed(details?.terminal) || details?.results?.some((child: any) => subagentTerminalFailed(child?.terminal)) || Boolean((result as any)?.error);
      return { content: [{ type: "text", text }], details, isError };
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
