/**
 * Sandbox Extension v2 — trusted Pi-side AgentSH supervisor client.
 *
 * In the detached-supervisor architecture the top-level Pi process is trusted
 * UI/control-plane code. This extension attaches to or starts an AgentSH
 * per-session supervisor, routes side-effecting tools through it, and renders
 * approval events in Pi.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import * as http from "node:http";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { posix as posixPath } from "node:path";
import { Type } from "@sinclair/typebox";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@mariozechner/pi-tui";
import {
  approvalChoices,
  approvalPresentation,
  approvalResolutionBody,
  approvalTitle,
  resolveChoice,
  type ApprovalChoice,
  type ApprovalRequest,
  type ApprovalResolution,
} from "./approval-model.js";
import { formatAccumulatedOutput, remoteOutputArtifact, StringOutputAccumulator } from "./command-output.js";
import { execFailureText, normalizeExecResult, recognizedSemanticExecFailure, type ExecResult } from "./exec-result.js";
import { contentFromReadResult, renderSandboxEditToolCall, renderSandboxEditToolResult, textFromResult } from "./tool-result-presentation.js";
import { detachedOperatorHeaders } from "./operator-auth.js";
import { selectSupervisorCwd } from "./execution-cwd.js";
import {
  absoluteToVirtual,
  normalizeWorkspaceRoots,
  restFileRequest as buildRestFileRequest,
  supervisorAbsolutePath as resolveSupervisorAbsolutePath,
  toSlashPath,
  type WorkspaceRoot,
} from "./workspace-paths.js";
import { normalizeSupervisorSubagentCwds } from "./subagent-cwd.js";
import { inheritSubagentModels } from "./subagent-model.js";
import { abortSubagentProtocolStream, appendSubagentProtocolChunk, createSubagentProtocolState, finishSubagentProtocolStream } from "./subagent-protocol.js";
import { attachRetainedReports } from "../subagent/result-artifact.js";
import { boundedSubagentParentOutput, contextWindowForModel, latestSubagentAssistantText, piProtocolFailure, subagentParentDetails, trustedRetainedSubagentReports } from "./subagent-parent-result.js";
import { renderSubagentCall, renderSubagentResult, renderSubagentStream, subagentDetailsFailed } from "./subagent-render.js";
import { boundSubagentProgressCapsules, createSubagentProgressCapsule } from "./subagent-result.js";
import { appendSubagentPrefix, appendSubagentRawText, appendSubagentStdoutChunk, createSubagentStreamState, flushSubagentStdout, tailByBytes, truncateByBytes, usageNumber, usageZero, type SubagentStreamState } from "./subagent-stream.js";
import { normalizeSubagentTerminal } from "./subagent-terminal.js";
import type { AgentSHExecutionTarget, AgentSHPiAPI, DirenvRefreshOptions, DirenvRefreshResult, DirenvRefreshState } from "./api.js";
import {
  agentSHSupervisorProtocol,
  classifyAgentSHStartup,
  type AgentSHStartupClassification,
  type AgentSHSupervisorProtocol,
} from "../shared/agentsh-mode.js";
import { bufferedHttpRequest, HttpTransportError } from "../shared/http-transport.js";
import {
  CommandExecutionTimeoutError,
  CommandTransportTimeoutError,
  commandExecutionTimeoutDetails,
  configuredCommandExecutionTimeout,
  configuredCommandTransportSlack,
  deriveCommandTimeoutBudget,
  parseCommandTimeoutMetadata,
  type CommandTimeoutBudget,
} from "./command-timeout.js";

type JsonObject = Record<string, unknown>;
type ProtocolMode = AgentSHSupervisorProtocol;
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

type NethelperLifecycle = {
  schema_version?: number;
  helper_kind?: string;
  lease_id?: string;
  unit_name?: string;
  soft_expires_at?: string;
  hard_expires_at?: string;
  soft_remaining_seconds?: number;
  hard_remaining_seconds?: number;
  binding_generation?: number;
  renewal_generation?: number;
  socket_live?: boolean;
  credential_source_live?: boolean;
  status?: string;
  terminal_reason?: string;
  last_checked_at?: string;
  [key: string]: unknown;
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
  helper_lifecycle?: NethelperLifecycle;
  [key: string]: unknown;
};

type DetachedRuntimeStatus = {
  protocol_version?: number;
  session_id?: string;
  lifecycle_state?: string;
  generation?: number;
  incarnation_id?: string;
  owner_pid?: number;
  owner_start_identity?: string;
  boot_id?: string;
  heartbeat_at?: string;
  recoverable?: boolean;
  last_error?: string;
  required_environment?: string[];
  direnv_refresh_required?: boolean;
  network_enforcement?: NetworkEnforcement;
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
  command_timeout?: unknown;
  supervisor_generation?: number;
  supervisor_incarnation_id?: string;
  detached_runtime?: DetachedRuntimeStatus;
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

type PaseoRemoteUi = {
  isConnected(): boolean;
  select(title: string, options: string[], settings?: { signal?: AbortSignal }): Promise<string | undefined>;
  selectMirrored?(
    title: string,
    options: string[],
    localSelect: (signal: AbortSignal) => Promise<string | undefined>,
    settings?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
};

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

type ReadFileOptions = { offset?: number; limit?: number; maxBytes?: number; cwd?: string; actor?: Actor; signal?: AbortSignal };
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

type SupervisorState = {
  active: boolean;
  startup: AgentSHStartupClassification;
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
  connectingClient?: SupervisorClient;
  approvalClient?: ApprovalClient;
  watcher?: ApprovalWatcher;
  ctx?: ExtensionContext;
  lifecycleTail: Promise<void>;
  lifecycleBusy: boolean;
  shuttingDown: boolean;
  terminalError: boolean;
  executionTarget?: AgentSHExecutionTarget;
};

const PROTOCOL_VERSION = 1;
const CONNECT_TIMEOUT_MS = Number(process.env.PI_AGENTSH_CONNECT_TIMEOUT_MS || "10000");
const START_TIMEOUT_MS = Number(process.env.PI_AGENTSH_START_TIMEOUT_MS || "30000");
const WATCH_RECONNECT_MS = Number(process.env.PI_AGENTSH_WATCH_RECONNECT_MS || "1500");
const SUPERVISOR_RECONNECT_TIMEOUT_MS = Number(process.env.PI_AGENTSH_RECONNECT_TIMEOUT_MS || "30000");
const SUPERVISOR_RECONNECT_INITIAL_MS = Number(process.env.PI_AGENTSH_RECONNECT_INITIAL_MS || "100");
const SUPERVISOR_RECOVERY_TRIGGER_MS = Number(process.env.PI_AGENTSH_RECOVERY_TRIGGER_MS || String(Math.min(2000, Math.max(0, Math.floor(SUPERVISOR_RECONNECT_TIMEOUT_MS / 3)))));
const APPROVAL_POLL_MS = Number(process.env.PI_AGENTSH_APPROVAL_POLL_MS || "1500");
const TOOL_REQUEST_TIMEOUT_MS = Number(process.env.PI_AGENTSH_TOOL_REQUEST_TIMEOUT_MS || "600000");
const APPROVAL_REQUEST_TIMEOUT_SLACK_MS = Number(process.env.PI_AGENTSH_APPROVAL_TIMEOUT_SLACK_MS || "300000");
const COMMAND_EXECUTION_TIMEOUT_FALLBACK = configuredCommandExecutionTimeout(process.env.PI_AGENTSH_COMMAND_EXECUTION_TIMEOUT_MS);
const CONFIGURED_COMMAND_TRANSPORT_SLACK_MS = configuredCommandTransportSlack(
  process.env.PI_AGENTSH_COMMAND_TRANSPORT_SLACK_MS,
  APPROVAL_REQUEST_TIMEOUT_SLACK_MS,
  CONNECT_TIMEOUT_MS,
);
const CONFIGURED_SUBAGENT_EXECUTION_TIMEOUT_MS = optionalPositiveTimeoutEnv("PI_AGENTSH_SUBAGENT_EXECUTION_TIMEOUT_MS");
const LEGACY_SUBAGENT_EXECUTION_TIMEOUT_MS = CONFIGURED_SUBAGENT_EXECUTION_TIMEOUT_MS === undefined
  ? optionalPositiveTimeoutEnv("PI_AGENTSH_SUBAGENT_REQUEST_TIMEOUT_MS")
  : undefined;
const SUBAGENT_EXECUTION_TIMEOUT_MS = CONFIGURED_SUBAGENT_EXECUTION_TIMEOUT_MS ?? LEGACY_SUBAGENT_EXECUTION_TIMEOUT_MS;
const SUBAGENT_TRANSPORT_SLACK_MS = optionalPositiveTimeoutEnv("PI_AGENTSH_SUBAGENT_TRANSPORT_SLACK_MS") ?? 300_000;
const SUBAGENT_TRANSPORT_TIMEOUT_FLOOR_MS = optionalPositiveTimeoutEnv("PI_AGENTSH_SUBAGENT_TRANSPORT_TIMEOUT_MS");
const MAX_NODE_TIMEOUT_MS = 2_147_483_647;
const VALID_POLICIES = new Set(["pi-autonomous", "pi-supervised"]);
const VALID_STAGE1_WORKSPACE_MODES = new Set(["shadow", "direct"]);
const RECOVERY_STATE_VERSION = 1;
const MAX_RECOVERY_STATE_BYTES = 16 * 1024;
const MAX_RECOVERY_OUTPUT_BYTES = 64 * 1024;
const AGENTSH_CHILD_CAPABILITY_ENV = "AGENTSH_CHILD_CAPABILITY";
const AGENTSH_CHILD_CAPABILITY_HEADER = "X-AgentSH-Child-Capability";
const PASEO_REMOTE_UI_KEY = "__piPaseoRemoteUiV1";

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
  readonly diagnostic: string;

  constructor(error: unknown) {
    const cause = asError(error);
    super("AgentSH supervisor is unavailable");
    this.name = "SafeSupervisorConnectError";
    this.code = supervisorErrorCode(error) as "ECONNREFUSED" | "ENOENT";
    this.diagnostic = cause.message;
  }
}

type RestErrorPayload = {
  code?: string;
  error?: string;
  path?: string;
  error_id?: string;
};

const REST_DOMAIN_CODES = new Set([
  "file_not_found", "file_permission_denied", "session_not_found", "policy_denied", "approval_denied",
  "edit_conflict", "invalid_request", "unsupported_endpoint", "conflict",
  "supervisor_not_ready", "internal_error",
]);

function parseRestErrorPayload(body: string): RestErrorPayload | undefined {
  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const source = value as JsonObject;
    const code = typeof source.code === "string" && REST_DOMAIN_CODES.has(source.code) ? source.code : undefined;
    if (!code) return undefined;
    return {
      code,
      error: safeExecText(source.error, 1000),
      path: safeExecText(source.path, 4096),
      error_id: safeExecText(source.error_id, 160),
    };
  } catch {
    return undefined;
  }
}

function restDomainErrorMessage(_statusCode: number, payload?: RestErrorPayload) {
  if (!payload?.code) return "AgentSH request failed";
  const path = payload.path ? `: ${payload.path}` : "";
  const detail = payload.error ? `: ${payload.error}` : "";
  switch (payload.code) {
    case "file_not_found": return `File not found${path}`;
    case "file_permission_denied": return `File access denied${path}`;
    case "session_not_found": return "AgentSH session not found";
    case "policy_denied": return `AgentSH policy denied the operation${path}${detail}`;
    case "approval_denied": return `AgentSH approval denied the operation${path}${detail}`;
    case "edit_conflict": return `Edit conflict${path}${detail}`;
    case "invalid_request": return `Invalid AgentSH request${detail}`;
    case "unsupported_endpoint": return "This AgentSH supervisor does not support the requested endpoint";
    case "conflict": return `AgentSH request conflicted with current state${detail}`;
    case "supervisor_not_ready": return `AgentSH supervisor is not ready${detail}`;
    case "internal_error": return `AgentSH internal error${payload.error_id ? ` (reference ${payload.error_id})` : ""}`;
    default: return "AgentSH request failed";
  }
}

class RestHTTPError extends Error {
  readonly domainCode?: string;
  readonly resourcePath?: string;
  readonly errorId?: string;
  readonly diagnostic: string;

  constructor(
    readonly method: string,
    readonly path: string,
    readonly statusCode: number,
    readonly body: string,
  ) {
    const payload = parseRestErrorPayload(body);
    super(restDomainErrorMessage(statusCode, payload));
    this.name = "RestHTTPError";
    this.domainCode = payload?.code;
    this.resourcePath = payload?.path;
    this.errorId = payload?.error_id;
    this.diagnostic = `${method} ${path}: HTTP ${statusCode}${body.trim() ? `: ${truncate(body.trim(), 1000)}` : ""}`;
    if (process.env.PI_AGENTSH_DEBUG_REST_ERRORS === "1") console.error(this.diagnostic);
  }
}

function restHTTPErrorIsSessionNotFound(error: RestHTTPError) {
  if (error.domainCode !== undefined) return error.domainCode === "session_not_found";
  return error.statusCode === 404
    && /session[_ -]?(?:not[_ -]?found|missing)|(?:not[_ -]?found|missing).*session/i.test(error.body);
}

class SupervisorUnavailableError extends Error {
  readonly diagnostic: string;

  constructor(detail: unknown) {
    const cause = asError(detail);
    super(`AgentSH supervisor is unavailable. Timed out waiting ${SUPERVISOR_RECONNECT_TIMEOUT_MS}ms for safe reconnection; the request was not completed`);
    this.name = "SupervisorUnavailableError";
    this.diagnostic = cause.message;
  }
}

class SupervisorRequestTimeoutError extends Error {
  constructor(readonly timeoutMs: number, operation: string) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = "SupervisorRequestTimeoutError";
  }
}

class SubagentTransportTimeoutError extends Error {
  constructor(readonly executionTimeoutMs: number | undefined, readonly transportTimeoutMs: number) {
    const executionDescription = executionTimeoutMs === undefined ? "policy-controlled execution deadline" : `execution deadline ${executionTimeoutMs}ms`;
    super(`AgentSH subagent transport timed out after ${transportTimeoutMs}ms while waiting for the server terminal event (${executionDescription})`);
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
  timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "Positive timeout in seconds. Omit it to use the AgentSH operator default/maximum." })),
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

function modelMayOverrideSubagentTimeout(processEnv: NodeJS.ProcessEnv = process.env): boolean {
  return processEnv.PI_AGENTSH_EXPOSE_SUBAGENT_TIMEOUT === "1";
}

function optionalPositiveTimeoutEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer number of milliseconds`);
  }
  return value;
}

function effectiveSubagentExecutionTimeoutMs(value: unknown): number | undefined {
  const maxExecutionTimeout = MAX_NODE_TIMEOUT_MS - SUBAGENT_TRANSPORT_SLACK_MS;
  if (SUBAGENT_EXECUTION_TIMEOUT_MS !== undefined && (!Number.isSafeInteger(SUBAGENT_EXECUTION_TIMEOUT_MS) || SUBAGENT_EXECUTION_TIMEOUT_MS < 1 || SUBAGENT_EXECUTION_TIMEOUT_MS > maxExecutionTimeout)) {
    throw new Error(`configured subagent execution timeout must be between 1 and ${maxExecutionTimeout}ms`);
  }
  if (value === undefined || value === null || value === 0) return SUBAGENT_EXECUTION_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("spawn_subagent timeout_ms must be a positive integer");
  }
  if (value > maxExecutionTimeout) {
    throw new Error(`spawn_subagent timeout_ms must not exceed ${maxExecutionTimeout}`);
  }
  return SUBAGENT_EXECUTION_TIMEOUT_MS === undefined ? value : Math.min(value, SUBAGENT_EXECUTION_TIMEOUT_MS);
}

function subagentTransportTimeoutMs(executionTimeoutMs: number | undefined): number {
  if (executionTimeoutMs === undefined) {
    return SUBAGENT_TRANSPORT_TIMEOUT_FLOOR_MS ?? MAX_NODE_TIMEOUT_MS;
  }
  const derived = executionTimeoutMs + SUBAGENT_TRANSPORT_SLACK_MS;
  const timeout = Math.max(derived, SUBAGENT_TRANSPORT_TIMEOUT_FLOOR_MS ?? 0);
  if (!Number.isSafeInteger(timeout) || timeout > MAX_NODE_TIMEOUT_MS) {
    throw new Error(`spawn_subagent transport timeout must not exceed ${MAX_NODE_TIMEOUT_MS}`);
  }
  return timeout;
}

export function childExecutionCapabilityHeaders(path: string, processEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (!/\/tools\/exec_bash$/.test(path)) return {};
  const token = processEnv[AGENTSH_CHILD_CAPABILITY_ENV]?.trim();
  if (!token) return {};
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error(`${AGENTSH_CHILD_CAPABILITY_ENV} is malformed`);
  }
  return { [AGENTSH_CHILD_CAPABILITY_HEADER]: token };
}

function env(name: string) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : "";
}

function effectiveSupervisorCwd(ctx?: ExtensionContext, target?: AgentSHExecutionTarget) {
  // A fixed remote cwd is operator-owned routing configuration. Pi's context
  // and a retained execution target may still name the host checkout when a
  // MicroVM Draft is resumed; never forward that host path into the guest.
  return selectSupervisorCwd(env("PI_AGENTSH_REMOTE_CWD"), target?.cwd, ctx?.cwd, process.cwd());
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

function detachedControlToken() {
  return env("AGENTSH_DETACHED_CONTROL_TOKEN");
}

function centralApprovalBridgeEnabled() {
  return Boolean(centralApprovalBridgeURL() && centralApprovalBridgeToken());
}

function centralApprovalBridgeRequested() {
  return env("PI_AGENTSH_APPROVAL_CLIENT").toLowerCase() === "central";
}

function agentshBinEnv() {
  return env("PI_AGENTSH_BIN") || "agentsh";
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
  const generation = Number(obj.generation || metadata.generation || 0);
  const incarnation = String(obj.incarnation_id || metadata.incarnation_id || "");
  if (Number.isSafeInteger(generation) && generation > 0) metadata.supervisor_generation = generation;
  if (incarnation) metadata.supervisor_incarnation_id = incarnation;
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

function ringApprovalBell() {
  if (!/^(1|true|yes|on)$/i.test(env("PI_AGENTSH_APPROVAL_BELL"))) return;
  try {
    process.stdout.write("\x07");
  } catch {
    // A notification must never prevent the approval prompt from opening.
  }
}

function paseoRemoteSelect(
  title: string,
  options: string[],
  localSelect: (signal: AbortSignal) => Promise<string | undefined>,
  signal: AbortSignal,
): Promise<string | undefined> | null {
  const bridge = (globalThis as Record<string, unknown>)[PASEO_REMOTE_UI_KEY] as PaseoRemoteUi | undefined;
  if (!bridge || typeof bridge.isConnected !== "function" || typeof bridge.select !== "function") return null;
  try {
    if (!bridge.isConnected()) return null;
    if (typeof bridge.selectMirrored === "function") {
      return Promise.resolve(bridge.selectMirrored(title, options, localSelect, { signal })).catch(() => undefined);
    }
    return Promise.resolve(bridge.select(title, options, { signal })).catch(() => undefined);
  } catch {
    return Promise.resolve(undefined);
  }
}

function showApprovalPrompt(ctx: ExtensionContext, approval: ApprovalRequest, choices: ApprovalChoice[], signal: AbortSignal): Promise<string | undefined> {
  const presentation = approvalPresentation(approval);
  const title = [presentation.title, ...presentation.details].join("\n");
  const options = choices.map((candidate) => candidate.label);
  const localSelect = (localSignal: AbortSignal) => showTerminalApprovalPrompt(ctx, presentation, choices, localSignal);
  const remoteChoice = paseoRemoteSelect(title, options, localSelect, signal);
  return remoteChoice ?? localSelect(signal);
}

function showTerminalApprovalPrompt(
  ctx: ExtensionContext,
  presentation: ReturnType<typeof approvalPresentation>,
  choices: ApprovalChoice[],
  signal: AbortSignal,
): Promise<string | undefined> {
  const title = [presentation.title, ...presentation.details].join("\n");
  const options = choices.map((candidate) => candidate.label);
  if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
    return ctx.ui.select(title, options, { signal });
  }
  return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
    const denyIndex = choices.findIndex((candidate) => candidate.decision === "deny" && candidate.scope === "once");
    let selectedIndex = denyIndex >= 0 ? denyIndex : 0;
    let cachedLines: string[] | undefined;
    let cachedWidth = 0;
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
        }
      },
      render(width: number) {
        if (cachedLines && cachedWidth === width) return cachedLines;
        const renderWidth = Math.max(1, width);
        const lines: string[] = [];
        const addWrapped = (prefix: string, text: string) => {
          const prefixWidth = visibleWidth(prefix);
          if (prefixWidth >= renderWidth) {
            lines.push(...wrapTextWithAnsi(prefix + text, renderWidth));
            return;
          }
          const wrapped = wrapTextWithAnsi(text, Math.max(1, renderWidth - prefixWidth));
          const continuation = " ".repeat(prefixWidth);
          for (let i = 0; i < wrapped.length; i++) lines.push(`${i === 0 ? prefix : continuation}${wrapped[i]}`);
        };

        lines.push(theme.fg("accent", "─".repeat(renderWidth)));
        addWrapped(" ", theme.fg("accent", theme.bold(presentation.title)));
        for (let i = 0; i < presentation.details.length; i++) {
          const color = i === 0 ? "text" : "muted";
          addWrapped(" ", theme.fg(color, presentation.details[i] || ""));
        }
        lines.push("");
        for (let i = 0; i < choices.length; i++) {
          const selected = i === selectedIndex;
          const prefix = selected ? theme.fg("accent", "→ ") : "  ";
          const color = choices[i]?.decision === "deny" ? "warning" : "success";
          addWrapped(prefix, theme.fg(color, choices[i]?.label || ""));
        }
        lines.push("");
        addWrapped(" ", theme.fg("dim", "↑↓/j/k select • Enter choose • Esc deny"));
        lines.push(theme.fg("accent", "─".repeat(renderWidth)));
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
    return await this.request("read_file", { path, cwd: options.cwd, offset: options.offset, limit: options.limit, max_bytes: options.maxBytes, actor: options.actor || parentActor(undefined, "Pi read tool") }, { signal: options.signal });
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
    const body: JsonObject = { ...params, actor: options.actor || params.actor || parentActor(undefined, "Pi subagent tool") };
    if (executionTimeoutMs === undefined) delete body.timeout_ms;
    else body.timeout_ms = executionTimeoutMs;
    return await this.request("spawn_subagent", body, {
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

function bufferedExecResult(raw: unknown): JsonObject {
  const envelope = (raw && typeof raw === "object" ? raw : undefined) as RestToolResponse<unknown> | undefined;
  const candidate = envelope && typeof envelope.ok === "boolean" ? envelope.result : raw;
  return candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate as JsonObject : {};
}

function parseRestHTTPErrorBody(error: RestHTTPError): unknown {
  if (!error.body.trim()) return undefined;
  try { return JSON.parse(error.body); } catch { return undefined; }
}

function commandExecutionTimeoutError(raw: unknown, budget: CommandTimeoutBudget): CommandExecutionTimeoutError | undefined {
  const timeout = commandExecutionTimeoutDetails(raw, budget);
  if (!timeout) return undefined;
  return new CommandExecutionTimeoutError({
    effectiveTimeoutMs: timeout.effectiveTimeoutMs,
    timeoutSource: timeout.source,
    clientExecutionTimeoutMs: budget.executionTimeoutMs,
    clientExecutionTimeoutSource: budget.executionTimeoutSource,
    result: bufferedExecResult(raw),
    serverMessage: timeout.serverMessage,
  });
}

function emitBufferedExecOutput(result: JsonObject, options: ExecOptions) {
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
  return { stdout, stderr };
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

function objectField(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function redactSensitiveText(value: string) {
  return value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, "$1 [REDACTED]")
    .replace(/([?&](?:access_token|api[_-]?key|key|token|secret|signature|sig|password)=)[^&#\s]*/gi, "$1[REDACTED]")
    .replace(/(["']?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|credential|password)["']?\s*[:=]\s*)(["'])[^"'\r\n]*\2/gi, "$1$2[REDACTED]$2")
    .replace(/\b(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|credential|password)\s*[:=]\s*[^\s,;}&]+/gi, "$1=[REDACTED]")
    .replace(/\b(sk-(?:live|test|proj)-[A-Za-z0-9_-]+|sk-ant-[A-Za-z0-9_-]+|gh[opusr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16})\b/g, "[REDACTED]");
}

function safeExecText(value: unknown, max = 1000) {
  if (typeof value !== "string") return undefined;
  const text = redactSensitiveText(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim());
  return text ? truncate(text, max) : undefined;
}

// Bind the pure path helpers to Pi's dynamic execution default here so a fixed
// remote cwd keeps precedence when callers omit cwd.
function restFileRequest(metadata: SupervisorMetadata | undefined, path: string, cwd = effectiveSupervisorCwd()) {
  return buildRestFileRequest(metadata, path, cwd);
}

function supervisorAbsolutePath(metadata: SupervisorMetadata | undefined, path: string, cwd = effectiveSupervisorCwd()) {
  return resolveSupervisorAbsolutePath(metadata, path, cwd);
}

function commandTimeoutFieldFromRest(...objects: JsonObject[]) {
  for (const object of objects) {
    if (Object.prototype.hasOwnProperty.call(object, "command_timeout")) {
      return { present: true as const, value: object.command_timeout };
    }
  }
  return { present: false as const };
}

function sessionMetadataFromRest(raw: unknown, socketPath: string, seed?: SupervisorMetadata): SupervisorMetadata {
  const obj = (raw && typeof raw === "object" ? raw : {}) as JsonObject;
  const session = (obj.session && typeof obj.session === "object" ? obj.session : obj) as JsonObject;
  const shadow = (session.shadow && typeof session.shadow === "object" ? session.shadow : {}) as JsonObject;
  const sessionId = String(obj.session_id || obj.id || session.id || seed?.session_id || seed?.sessionId || env("AGENTSH_SESSION_ID") || "");
  const roots = normalizeWorkspaceRoots(obj.workspace_roots || session.workspace_roots || shadow.roots || seed?.workspace_roots);
  const networkEnforcement = (obj.network_enforcement || session.network_enforcement || seed?.network_enforcement || seed?.networkEnforcement) as NetworkEnforcement | undefined;
  // This field must come from the live hello/reconnect response. Preserve a
  // present malformed value for fail-closed validation, and do not retain a
  // stale start/attachment seed when an older supervisor omits the field.
  const responseMetadata = (obj.metadata && typeof obj.metadata === "object" ? obj.metadata : {}) as JsonObject;
  const sessionMetadata = (session.metadata && typeof session.metadata === "object" ? session.metadata : {}) as JsonObject;
  const commandTimeout = commandTimeoutFieldFromRest(obj, session, responseMetadata, sessionMetadata);
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
  if (commandTimeout.present) metadata.command_timeout = commandTimeout.value;
  else delete metadata.command_timeout;
  return metadata;
}

class RestSupervisorClient {
  readonly mode = "rest" as const;
  #sessionId: string;
  #expectedSessionId: string;
  #metadata?: SupervisorMetadata;
  #detachedRuntime?: DetachedRuntimeStatus;
  #reconnectInFlight?: Promise<SupervisorMetadata>;
  #lifecycleController = new AbortController();

  constructor(readonly socketPath: string, seedMetadata?: SupervisorMetadata, private readonly connectionEvents: RestConnectionEvents = {}) {
    this.#metadata = seedMetadata;
    this.#sessionId = metadataSessionId(seedMetadata);
    this.#expectedSessionId = this.#sessionId;
  }

  get sessionId() { return this.#sessionId; }

  async dispose() {
    this.#lifecycleController.abort();
    try { await this.#reconnectInFlight; } catch { /* shutdown owns the terminal state */ }
  }

  #sessionPath(sessionId = this.#expectedSessionId) {
    return `/api/v1/sessions/${encodeURIComponent(sessionId)}`;
  }

  async #observeDetachedRuntime(timeoutMs: number, signal?: AbortSignal) {
    let raw: unknown;
    try {
      raw = await this.#requestOnce("GET", "/api/v1/detached/status", undefined, { signal, timeoutMs });
    } catch (error) {
      if (error instanceof RestHTTPError && error.statusCode === 404) return undefined;
      throw error;
    }
    if (!raw || typeof raw !== "object") throw this.#sessionLost("The detached status response was not an object.");
    const status = raw as DetachedRuntimeStatus;
    // Compatibility fixtures and pre-v2 supervisors may route unknown paths to
    // an empty/default JSON object instead of a literal 404.
    if (Number(status.protocol_version || 0) < 2 && !status.lifecycle_state && !status.incarnation_id) return undefined;
    const actual = String(status.session_id || "");
    const generation = Number(status.generation || 0);
    const incarnation = String(status.incarnation_id || "");
    if (!this.#expectedSessionId || actual !== this.#expectedSessionId) {
      throw this.#sessionLost(`Detached status returned ${actual || "no session ID"}, expected ${this.#expectedSessionId || "an exact captured identity"}.`);
    }
    if (!Number.isSafeInteger(generation) || generation <= 0 || !incarnation || Number(status.protocol_version || 0) < 2) {
      throw this.#sessionLost("The detached status response omitted its durable incarnation identity.");
    }
    const previous = this.#detachedRuntime;
    const seededGeneration = Number(this.#metadata?.supervisor_generation || 0);
    const seededIncarnation = String(this.#metadata?.supervisor_incarnation_id || "");
    if (seededGeneration > 0 && generation < seededGeneration) {
      throw this.#sessionLost(`Detached generation regressed from captured ${seededGeneration} to ${generation}.`);
    }
    if (seededGeneration > 0 && generation === seededGeneration && seededIncarnation && incarnation !== seededIncarnation) {
      throw this.#sessionLost("Detached incarnation disagrees with the wrapper-captured identity.");
    }
    if (previous) {
      const previousGeneration = Number(previous.generation || 0);
      const previousIncarnation = String(previous.incarnation_id || "");
      if (generation < previousGeneration || (generation === previousGeneration && incarnation !== previousIncarnation)) {
        throw this.#sessionLost("Detached supervisor incarnation changed without a monotonic recovery generation.");
      }
    }
    const lifecycle = String(status.lifecycle_state || "");
    if (["finalizing", "stopping", "stopped", "finalized"].includes(lifecycle) || status.recoverable === false) {
      throw this.#sessionLost(`The exact detached session is ${lifecycle || "terminal"} and is not recoverable.`);
    }
    if (!["ready", "degraded", "recovering", "failed"].includes(lifecycle)) {
      throw this.#sessionLost(`The detached supervisor returned unsupported lifecycle state ${lifecycle || "empty"}.`);
    }
    this.#detachedRuntime = status;
    if (this.#metadata) {
      this.#metadata.detached_runtime = status;
      this.#metadata.supervisor_generation = generation;
      this.#metadata.supervisor_incarnation_id = incarnation;
    }
    return status;
  }

  async #reprovisionDetachedRuntime(status: DetachedRuntimeStatus, timeoutMs: number, signal?: AbortSignal) {
    const required = status.required_environment;
    if (required !== undefined && !Array.isArray(required)) {
      throw this.#sessionLost("The detached status returned malformed required_environment metadata.");
    }
    const names = Array.from(new Set((required || []).map((name) => String(name))));
    if (names.length > 256 || names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
      throw this.#sessionLost("The detached status returned unsafe required_environment names.");
    }
    if (names.length > 0) {
      const values: Record<string, string> = {};
      const unset: string[] = [];
      for (const name of names) {
        const value = process.env[name];
        if (value === undefined) unset.push(name);
        else values[name] = value;
      }
      // Send only names explicitly requested by the authenticated, exact local
      // supervisor. AgentSH records names in audit/recovery state, never these
      // values, and an absent parent value is acknowledged as an explicit unset.
      await this.#requestOnce("PATCH", this.#sessionPath(), { env: values, unset }, { signal, timeoutMs });
    }
    if (status.direnv_refresh_required) {
      const raw = await this.#requestOnce(
        "POST",
        `${this.#sessionPath()}/tools/refresh_direnv`,
        { cwd: effectiveSupervisorCwd(), actor: { kind: "extension", label: "Pi detached recovery direnv refresh" } },
        // Recovery is bounded by the caller's reconnect/recovery lifetime. Do
        // not let the ordinary interactive direnv allowance outlive it.
        { signal, timeoutMs: Math.max(1, timeoutMs) },
      );
      const envelope = objectField(raw);
      if (envelope?.ok !== true) {
        throw new Error("AgentSH could not restore the required direnv snapshot after supervisor recovery");
      }
    }
    if (names.length === 0 && !status.direnv_refresh_required) return status;
    const refreshed = await this.#observeDetachedRuntime(timeoutMs, signal);
    if (!refreshed) throw this.#sessionLost("The protocol-v2 detached status disappeared during environment recovery.");
    return refreshed;
  }

  #runtimeNeedsSupervisorRecovery(status: DetachedRuntimeStatus) {
    return status.lifecycle_state !== "ready";
  }

  async #recoverLiveDetachedRuntime(status: DetachedRuntimeStatus, timeoutMs: number, signal?: AbortSignal) {
    let current = await this.#reprovisionDetachedRuntime(status, timeoutMs, signal);
    if (!this.#runtimeNeedsSupervisorRecovery(current)) return current;
    const config = recoveryConfiguration(this.#expectedSessionId);
    if (!config) return current;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    const lifecycleSignal = this.#lifecycleController.signal;
    for (const source of [signal, lifecycleSignal]) {
      if (source?.aborted) controller.abort();
      else source?.addEventListener("abort", onAbort, { once: true });
    }
    try {
      await spawnRecovery(config, controller, timeoutMs);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      lifecycleSignal.removeEventListener("abort", onAbort);
    }
    const recovered = await this.#observeDetachedRuntime(timeoutMs, signal);
    if (!recovered) throw this.#sessionLost("The recovery command returned without a protocol-v2 detached status.");
    return await this.#reprovisionDetachedRuntime(recovered, timeoutMs, signal);
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
    // Older supervisors may omit this field. Once present, malformed policy
    // metadata is a protocol/config failure rather than a silent fallback.
    parseCommandTimeoutMetadata(metadata);
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
    let recoveryAttempted = false;
    const reconnectStartedAt = Date.now();
    try {
      for (;;) {
        if (this.#lifecycleController.signal.aborted) throw supervisorRequestAborted();
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new SupervisorUnavailableError(`Timed out waiting ${SUPERVISOR_RECONNECT_TIMEOUT_MS}ms for AgentSH session ${this.#expectedSessionId} at ${this.socketPath}: ${lastError instanceof SafeSupervisorConnectError ? lastError.diagnostic : lastError.message}`);
        }
        try {
          const probeTimeout = Math.max(1, Math.min(CONNECT_TIMEOUT_MS, remaining));
          let runtime = await this.#observeDetachedRuntime(probeTimeout, this.#lifecycleController.signal);
          if (runtime) runtime = await this.#reprovisionDetachedRuntime(runtime, probeTimeout, this.#lifecycleController.signal);
          if (runtime && this.#runtimeNeedsSupervisorRecovery(runtime)) {
            throw new SafeSupervisorConnectError(new Error(`exact detached supervisor is ${runtime.lifecycle_state}: ${runtime.last_error || "recovery required"}`));
          }
          const raw = await this.#requestOnce(
            "GET",
            this.#sessionPath(),
            undefined,
            { signal: this.#lifecycleController.signal, timeoutMs: probeTimeout },
          );
          const metadata = this.#validateExpectedSession(raw);
          try {
            metadata.network_enforcement = await this.#requestOnce(
              "GET",
              `${this.#sessionPath(this.#sessionId)}/network-enforcement`,
              undefined,
              { signal: this.#lifecycleController.signal, timeoutMs: probeTimeout },
            ) as NetworkEnforcement;
            metadata.network_enforcement_live = true;
            metadata.network_enforcement_error = undefined;
          } catch (networkError) {
            metadata.network_enforcement_live = false;
            metadata.network_enforcement_error = asError(networkError).message;
          }
          assertNetworkEnforcementReady(metadata);
          this.connectionEvents.onReconnected?.(metadata);
          return metadata;
        } catch (error) {
          if (error instanceof RestHTTPError && error.statusCode === 404) {
            throw this.#sessionLost(`The supervisor returned HTTP 404 for ${this.#sessionPath()}.`);
          }
          if (!(error instanceof SafeSupervisorConnectError)) throw error;
          lastError = error;
          if (!recoveryAttempted && Date.now() - reconnectStartedAt >= SUPERVISOR_RECOVERY_TRIGGER_MS) {
            const config = recoveryConfiguration(this.#expectedSessionId);
            if (config) {
              recoveryAttempted = true;
              const controller = new AbortController();
              const onLifecycleAbort = () => controller.abort();
              const lifecycleSignal = this.#lifecycleController.signal;
              if (lifecycleSignal.aborted) controller.abort();
              else lifecycleSignal.addEventListener("abort", onLifecycleAbort, { once: true });
              try {
                await spawnRecovery(config, controller, Math.max(1, Math.min(recoveryTimeoutMs(), deadline - Date.now())));
                lastError = new Error("wrapper recovery completed; waiting for the exact supervisor incarnation");
                continue;
              } catch (recoveryError) {
                if (lifecycleSignal.aborted) throw supervisorRequestAborted();
                lastError = asError(recoveryError);
              } finally {
                lifecycleSignal.removeEventListener("abort", onLifecycleAbort);
              }
            }
          }
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
      if (signal?.aborted || this.#lifecycleController.signal.aborted) throw supervisorRequestAborted();
      if (this.#reconnectInFlight) {
        await awaitReconnectForCaller(this.#reconnectInFlight, signal, deadline);
      }
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof SafeSupervisorConnectError) || SUPERVISOR_RECONNECT_TIMEOUT_MS <= 0) throw error;
        if (Date.now() >= deadline) {
          const timeout = new SupervisorUnavailableError(`Timed out waiting ${SUPERVISOR_RECONNECT_TIMEOUT_MS}ms for the AgentSH supervisor tunnel at ${this.socketPath}: ${error.diagnostic}`);
          this.connectionEvents.onReconnectFailed?.(timeout);
          throw timeout;
        }
        try {
          await awaitReconnectForCaller(this.#ensureReconnect(deadline, error), signal, deadline);
        } catch (reconnectError) {
          if (supervisorRequestWasAborted(reconnectError, signal)) throw supervisorRequestAborted();
          if (reconnectError instanceof SupervisorSessionLostError || reconnectError instanceof SupervisorUnavailableError) throw reconnectError;
          throw new SupervisorUnavailableError(reconnectError);
        }
        // The failed connect never reached the server. Create a fresh HTTP
        // request only after the exact original session has been verified.
      }
    }
  }

  async #requestOnce<T = unknown>(method: string, path: string, body?: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const timeoutMs = options.timeoutMs || CONNECT_TIMEOUT_MS;
    const { signal, cleanup, didTimeout } = abortSignalFrom(options.signal, timeoutMs);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const capabilityHeaders = childExecutionCapabilityHeaders(path);
    const operatorHeaders = detachedOperatorHeaders(path, detachedControlToken());
    try {
      const response = await bufferedHttpRequest({
        request: { socketPath: this.socketPath, host: "unix", path },
        method,
        headers: payload === undefined ? { Accept: "application/json", ...capabilityHeaders, ...operatorHeaders } : {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(payload)),
          ...capabilityHeaders,
          ...operatorHeaders,
        },
        body: payload,
        signal,
        timeoutMs,
      });
      const text = response.body.toString("utf8");
      if (response.statusCode < 200 || response.statusCode >= 300) throw new RestHTTPError(method, path, response.statusCode, text);
      if (!text.trim()) return undefined as T;
      try { return JSON.parse(text) as T; } catch (error) { throw asError(error); }
    } catch (error) {
      if (error instanceof RestHTTPError) throw error;
      if (options.signal?.aborted) throw supervisorRequestAborted();
      if (didTimeout() || (error instanceof HttpTransportError && error.kind === "timeout")) {
        throw new SupervisorRequestTimeoutError(timeoutMs, `${method} ${path}`);
      }
      const cause = error instanceof HttpTransportError ? error.cause : error;
      if (error instanceof HttpTransportError && !error.responseStarted && supervisorSocketUnavailable(cause)) {
        throw new SafeSupervisorConnectError(cause);
      }
      throw asError(error);
    } finally {
      cleanup();
    }
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    try {
      return await this.#withReconnect(
        () => this.#requestOnce<T>(method, path, body, options),
        options.signal,
      );
    } catch (error) {
      if (error instanceof RestHTTPError && restHTTPErrorIsSessionNotFound(error)) {
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
        signal.removeEventListener("abort", onAbort);
        cleanup();
        fn();
      };
      const onAbort = () => {
        const error = normalizeRequestError(new Error(`${method} ${path}: supervisor stream was aborted`));
        abortSubagentProtocolStream(protocol, error.message);
        settle(() => reject(error));
        req?.destroy(error);
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
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      if (!settled) {
        req.write(payload);
        req.end();
      }
    });
  }

  async requestNDJSON(method: string, path: string, body: unknown, options: { signal?: AbortSignal; timeoutMs?: number; onEvent?: (message: SupervisorMessage) => void } = {}): Promise<unknown> {
    try {
      return await this.#withReconnect(
        () => this.#requestNDJSONOnce(method, path, body, options),
        options.signal,
      );
    } catch (error) {
      if (error instanceof RestHTTPError && restHTTPErrorIsSessionNotFound(error)) {
        throw this.#sessionLost(`The supervisor reported that session ${this.#expectedSessionId} no longer exists.`);
      }
      throw error;
    }
  }

  async hello() {
    const lifecycleSignal = this.#lifecycleController.signal;
    let runtime = await this.#observeDetachedRuntime(CONNECT_TIMEOUT_MS, lifecycleSignal);
    if (runtime) runtime = await this.#recoverLiveDetachedRuntime(runtime, recoveryTimeoutMs(), lifecycleSignal);
    if (runtime && runtime.lifecycle_state !== "ready") {
      throw new Error(`Exact detached supervisor recovery is incomplete (${runtime.lifecycle_state}): ${runtime.last_error || "runtime prerequisites are not ready"}`);
    }
    let metadata: SupervisorMetadata;
    if (this.#expectedSessionId) {
      let raw: unknown;
      try {
        raw = await this.request("GET", this.#sessionPath(), undefined, { signal: lifecycleSignal });
      } catch (error) {
        if (error instanceof RestHTTPError && error.statusCode === 404) {
          throw this.#sessionLost(`The supervisor returned HTTP 404 for ${this.#sessionPath()}.`);
        }
        throw error;
      }
      metadata = this.#validateExpectedSession(raw);
    } else {
      const sessions = await this.request<unknown[]>("GET", "/api/v1/sessions", undefined, { signal: lifecycleSignal });
      const first = sessions[0];
      if (!first) throw this.#sessionLost("The supervisor listed no sessions to attach to.");
      metadata = this.#validateExpectedSession(first);
    }
    if (this.#sessionId) {
      try {
        metadata.network_enforcement = await this.request<NetworkEnforcement>(
          "GET",
          `${this.#sessionPath(this.#sessionId)}/network-enforcement`,
          undefined,
          { signal: lifecycleSignal },
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
    const requestId = randomUUID();
    let explicitCancellation: Promise<void> | undefined;
    const cancelExplicitly = () => {
      if (!explicitCancellation) {
        explicitCancellation = this.#requestOnce(
          "POST",
          `${this.toolPath("exec_bash")}/${encodeURIComponent(requestId)}/cancel`,
          { cause: "client_cancelled" },
          { timeoutMs: 2_000 },
        ).then(() => undefined, () => undefined);
      }
      return explicitCancellation;
    };
    const onAbort = () => { void cancelExplicitly(); };
    const removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    let budget: CommandTimeoutBudget | undefined;
    let raw: unknown;
    try {
      raw = await this.#withReconnect(async () => {
        // A safe connect failure has not dispatched the command. After the
        // existing reconnect lifetime verifies the exact session, this closure
        // runs again against refreshed metadata and starts a fresh, full
        // command-response transport lifetime.
        const attemptBudget = deriveCommandTimeoutBudget({
          metadata: this.#metadata,
          fallback: COMMAND_EXECUTION_TIMEOUT_FALLBACK,
          transportSlackMs: CONFIGURED_COMMAND_TRANSPORT_SLACK_MS,
          terminalResponseMarginMs: CONNECT_TIMEOUT_MS,
          timeoutSeconds: options.timeout,
          timeoutMs: options.timeout_ms,
        });
        budget = attemptBudget;
        const body: JsonObject = {
          request_id: requestId,
          command,
          cwd: options.cwd || effectiveSupervisorCwd(),
          persist_output_over_bytes: options.persist_output_over_bytes,
          persist_output_over_lines: options.persist_output_over_lines,
          actor: options.actor || parentActor(options.tool_call_id, "Pi bash tool"),
        };
        // Omission is semantically meaningful: AgentSH must select and report
        // its operator policy default/fallback. Explicit values are sent
        // uncapped so AgentSH can report policy_cap when appropriate.
        if (attemptBudget.requestedTimeoutMs !== undefined) body.timeout_ms = attemptBudget.requestedTimeoutMs;

        try {
          return await this.#requestOnce("POST", this.toolPath("exec_bash"), body, {
            signal: options.signal,
            timeoutMs: attemptBudget.transportTimeoutMs,
          });
        } catch (error) {
          if (options.signal?.aborted) {
            await cancelExplicitly();
            throw supervisorRequestAborted();
          }
          // Classify only this dispatched/socket-response lifetime. Errors from
          // the separate safe reconnect poll retain reconnect diagnostics.
          if (error instanceof SupervisorRequestTimeoutError) {
            await cancelExplicitly();
            throw new CommandTransportTimeoutError(
              attemptBudget.executionTimeoutMs,
              attemptBudget.transportTimeoutMs,
              attemptBudget.transportSlackMs,
            );
          }
          throw error;
        }
      }, options.signal);
    } catch (error) {
      if (options.signal?.aborted) {
        await cancelExplicitly();
        removeAbortListener();
        throw supervisorRequestAborted();
      }
      if (error instanceof RestHTTPError && restHTTPErrorIsSessionNotFound(error)) {
        removeAbortListener();
        throw this.#sessionLost(`The supervisor reported that session ${this.#expectedSessionId} no longer exists.`);
      }
      if (error instanceof RestHTTPError && budget) {
        const parsed = parseRestHTTPErrorBody(error);
        const executionTimeout = commandExecutionTimeoutError(parsed, budget);
        if (executionTimeout) {
          emitBufferedExecOutput(bufferedExecResult(parsed), options);
          removeAbortListener();
          throw executionTimeout;
        }
        const envelope = objectField(parsed);
        const semanticResult = envelope?.ok === false ? objectField(envelope.result) : undefined;
        if (semanticResult && recognizedSemanticExecFailure(semanticResult)) {
          raw = parsed;
        } else {
          removeAbortListener();
          throw error;
        }
      } else {
        removeAbortListener();
        throw error;
      }
    }
    removeAbortListener();

    if (!budget) throw new Error("AgentSH exec_bash completed without a command timeout budget");
    const executionTimeout = commandExecutionTimeoutError(raw, budget);
    if (executionTimeout) {
      emitBufferedExecOutput(bufferedExecResult(raw), options);
      throw executionTimeout;
    }

    const envelope = objectField(raw);
    const resultObject = envelope && typeof envelope.ok === "boolean"
      ? objectField(envelope.result)
      : objectField(raw);
    if (!resultObject) throw new Error("exec_bash returned no structured result");
    const result = normalizeExecResult(resultObject);
    const { stdout, stderr } = emitBufferedExecOutput(result, options);
    return { ...result, stdout, stderr } as ExecResult;

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
      max_bytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
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
      const requestId = `subagent-request-${randomUUID()}`;
      if (executionTimeoutMs === undefined) delete body.timeout_ms;
      else body.timeout_ms = executionTimeoutMs;
      body.request_id = requestId;
      if (options.signal?.aborted) throw supervisorRequestAborted();

      // A caller abort is first propagated over an independent control request.
      // Only if that request cannot be delivered do we close the result stream.
      // This lets AgentSH durably distinguish user/parent cancellation from a
      // genuine transport disconnect before it terminates the child process.
      const streamController = new AbortController();
      const actor = objectField(body.actor);
      const cancellationCause = Number(actor?.subagent_depth || 0) > 0 ? "parent_cancelled" : "user_cancelled";
      let cancellationStarted = false;
      const propagateCancellation = async () => {
        if (cancellationStarted) return;
        cancellationStarted = true;
        const path = `${this.toolPath("spawn_subagent")}/${encodeURIComponent(requestId)}/cancel`;
        let lastError: unknown;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          try {
            await this.#requestOnce("POST", path, { cause: cancellationCause }, { timeoutMs: 2_000 });
            return;
          } catch (error) {
            lastError = error;
            if (!(error instanceof RestHTTPError && error.statusCode === 409) || attempt === 3) break;
            await reconnectDelay(25);
          }
        }
        streamController.abort(lastError);
      };
      const onCallerAbort = () => { void propagateCancellation(); };
      options.signal?.addEventListener("abort", onCallerAbort, { once: true });
      try {
        const raw = await this.requestNDJSON("POST", this.toolPath("spawn_subagent"), body, { signal: streamController.signal, timeoutMs: transportTimeoutMs, onEvent: options.onUpdate });
        return unwrapRestSubagentResponse(raw);
      } catch (error) {
        if (error instanceof SupervisorRequestTimeoutError && !options.signal?.aborted) {
          throw new SubagentTransportTimeoutError(executionTimeoutMs, transportTimeoutMs);
        }
        throw error;
      } finally {
        options.signal?.removeEventListener("abort", onCallerAbort);
      }
    } catch (error) {
      if (error instanceof RestHTTPError && error.domainCode === "unsupported_endpoint") {
        throw new Error("AgentSH supervisor does not support spawn_subagent; rebuild/deploy a newer AgentSH or disable sandbox subagent registration.");
      }
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

class CentralApprovalClient implements ApprovalClient {
  constructor(readonly baseURL: string, readonly sessionId: string, readonly token: string) {}

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const url = new URL(path, `${this.baseURL}/`);
    const response = await bufferedHttpRequest({
      request: url,
      method,
      headers: payload === undefined ? {
        Accept: "application/json",
        "X-AgentSH-Session-Event-Token": this.token,
      } : {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(payload)),
        "X-AgentSH-Session-Event-Token": this.token,
      },
      body: payload,
      timeoutMs: CONNECT_TIMEOUT_MS,
    });
    const text = response.body.toString("utf8");
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`${method} ${url.pathname}: HTTP ${response.statusCode}${text.trim() ? `: ${truncate(text.trim(), 1000)}` : ""}`);
    }
    if (!text.trim()) return undefined as T;
    try { return JSON.parse(text) as T; } catch (error) { throw asError(error); }
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
  if (!ctx?.hasUI || state.resolving.has(approval.id) || !state.pendingIds.has(approval.id)) return;
  state.resolving.add(approval.id);
  const controller = new AbortController();
  state.promptAbortControllers.set(approval.id, controller);
  try {
    const choices = approvalChoices(approval);
    ringApprovalBell();
    const choice = await showApprovalPrompt(ctx, approval, choices, controller.signal);
    if (controller.signal.aborted) return;
    const resolution = resolveChoice(choices, choice);
    const approvalClient = requireApprovalClient(state);
    await approvalClient.resolveApproval(approval.id, resolution);
    if (resolution.scope === "session") {
      removePending(state, approval.id);
      try {
        syncPendingApprovals(state, await approvalClient.listApprovals());
      } catch {
        // The background watcher will retry polling.
      }
    }
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


function mergeLiveSupervisorMetadata(previous: SupervisorMetadata | undefined, live: SupervisorMetadata, socketPath: string) {
  const metadata: SupervisorMetadata = { ...previous, ...live, supervisor_sock: socketPath };
  if (!Object.prototype.hasOwnProperty.call(live, "command_timeout")) delete metadata.command_timeout;
  return metadata;
}

async function attachToSocket(state: SupervisorState, mode: ProtocolMode, source: SupervisorSource, socketPath: string, ctx: ExtensionContext, seedMetadata?: SupervisorMetadata, expectedSessionId = "") {

  state.active = true;
  state.activeMode = mode;
  state.source = source;
  state.socketPath = socketPath;
  state.metadata = undefined;
  state.sessionId = "";
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
      state.metadata = mergeLiveSupervisorMetadata(state.metadata, metadata, socketPath);
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
  if (state.shuttingDown) throw supervisorRequestAborted();
  client = mode === "mock-ndjson"
    ? new MockSupervisorClient(socketPath)
    : mode === "legacy-approval-ui"
      ? new LegacyApprovalUIClient(socketPath)
      : new RestSupervisorClient(socketPath, expectedSessionId ? { ...seedMetadata, session_id: expectedSessionId } : seedMetadata, connectionEvents);
  state.connectingClient = client;
  let metadata: SupervisorMetadata;
  try {
    metadata = await client.hello();
  } finally {
    if (state.connectingClient === client) state.connectingClient = undefined;
  }
  const validatedMetadata = mergeLiveSupervisorMetadata(seedMetadata, metadata, socketPath);
  assertNetworkEnforcementReady(validatedMetadata);
  const actualSessionId = metadataSessionId(validatedMetadata);
  const requiredSessionId = expectedSessionId || env("AGENTSH_SESSION_ID");
  if (requiredSessionId && actualSessionId !== requiredSessionId) {
    throw new SupervisorSessionLostError(requiredSessionId, `The attached supervisor returned ${actualSessionId || "no session ID"}.`);
  }
  // Publish capability-bearing state only after exact identity and fresh strict
  // evidence have both passed. Before this point callbacks are inert because
  // state.client is not this candidate.
  state.client = client;
  state.approvalClient = client;
  state.metadata = validatedMetadata;
  state.sessionId = actualSessionId;

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

function detachedIdentitySeed(expectedSessionId: string): SupervisorMetadata | undefined {
  if (!expectedSessionId) return undefined;
  const generation = Number(env("AGENTSH_SESSION_SUPERVISOR_GENERATION") || 0);
  const incarnation = env("AGENTSH_SESSION_SUPERVISOR_INCARNATION");
  const seed: SupervisorMetadata = { session_id: expectedSessionId };
  if (Number.isSafeInteger(generation) && generation > 0) seed.supervisor_generation = generation;
  if (incarnation) seed.supervisor_incarnation_id = incarnation;
  return seed;
}

async function attachOrStartUnserialized(state: SupervisorState, ctx: ExtensionContext, options: { notifyOnSuccess?: boolean; expectedSessionId?: string } = {}) {
    if (state.shuttingDown) throw supervisorRequestAborted();
    state.ctx = ctx;
    state.mode = agentSHSupervisorProtocol(state.startup);
    resetConnection(state);
    state.ctx = ctx;
    state.lastError = "";
    const expectedSessionId = options.expectedSessionId ?? env("AGENTSH_SESSION_ID");

    if (state.mode === "mock-ndjson") {
      const mockSock = normalizeSocketPath(env("PI_AGENTSH_MOCK_SUPERVISOR"));
      if (!mockSock) throw new Error("Full AgentSH mock mode was selected without a supervisor socket");
      await attachToSocket(state, "mock-ndjson", "mock", mockSock, ctx, undefined, expectedSessionId);
      if (options.notifyOnSuccess) notify(ctx, `AgentSH mock supervisor attached: ${state.sessionId || mockSock}`, "info");
      return;
    }

    if (state.mode === "rest") {
      const envSock = normalizeSocketPath(env("AGENTSH_SESSION_SUPERVISOR"));
      if (envSock) {
        await attachToSocket(state, "rest", "agentsh-env", envSock, ctx, detachedIdentitySeed(expectedSessionId), expectedSessionId);
        if (options.notifyOnSuccess) notify(ctx, `AgentSH REST supervisor attached: ${state.sessionId || envSock}`, "info");
        return;
      }
      if (state.startup.startSupervisor) {
        state.active = true;
        state.source = "agentsh-started";
        state.status = "starting";
        setStatus(state, ctx);
        const started = await runAgentSHSessionStart(ctx);
        const sock = metadataSocket(started);
        if (!sock) throw new Error("Started AgentSH session did not report supervisor_sock");
        await attachToSocket(state, "rest", "agentsh-started", sock, ctx, started, expectedSessionId || metadataSessionId(started));
        if (options.notifyOnSuccess) notify(ctx, `AgentSH REST supervisor started: ${state.sessionId || sock}`, "info");
        return;
      }
      throw new Error("Full AgentSH REST mode was selected without a supervisor socket or local-start request");
    }

    if (state.startup.kind === "full" || state.startup.kind === "conflict") {
      throw new Error("Full AgentSH mode was selected, but no full supervisor transport is configured");
    }

    if (state.mode === "legacy-approval-ui") {
      const approvalUISock = normalizeSocketPath(env("AGENTSH_APPROVAL_UI_SOCKET"));
      if (!approvalUISock) throw new Error("AgentSH approval-only mode was selected without its socket");
      await attachToSocket(state, "legacy-approval-ui", "agentsh-approval-ui", approvalUISock, ctx, undefined, expectedSessionId);
      if (options.notifyOnSuccess) notify(ctx, `AgentSH approval UI socket attached: ${state.sessionId || approvalUISock}`, "info");
      return;
    }

    state.status = "inactive";
    state.active = false;
    setStatus(state, ctx);
}

function queueLifecycle<T>(state: SupervisorState, operation: () => Promise<T>): Promise<T> {
  const run = state.lifecycleTail.catch(() => undefined).then(async () => {
    state.lifecycleBusy = true;
    try { return await operation(); } finally { state.lifecycleBusy = false; }
  });
  state.lifecycleTail = run.then(() => undefined, () => undefined);
  return run;
}

function attachFailure(state: SupervisorState, ctx: ExtensionContext, error: unknown) {
  resetConnection(state);
  state.active = true;
  state.status = "error";
  state.terminalError = error instanceof SupervisorSessionLostError;
  state.lastError = safeExecText(asError(error).message) || "AgentSH attachment failed";
  setStatus(state, ctx);
}

async function attachOrStart(state: SupervisorState, ctx: ExtensionContext, options: { notifyOnSuccess?: boolean; expectedSessionId?: string } = {}) {
  return await queueLifecycle(state, async () => {
    try {
      await attachOrStartUnserialized(state, ctx, options);
    } catch (error) {
      attachFailure(state, ctx, error);
      throw error;
    }
  });
}

type RecoveryConfiguration = { command: string; statePath: string; expectedSession: string; cwd: string };

function protectedLifecycleParent(statePath: string) {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  let directory = posixPath.dirname(statePath);
  let immediate = true;
  for (;;) {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    const publiclyWritable = (info.mode & 0o022) !== 0;
    const stickyProtectedDirectory = (info.mode & 0o1000) !== 0 && (info.uid === 0 || info.uid === uid);
    if (publiclyWritable && !stickyProtectedDirectory) return false;
    if (immediate && ((info.mode & 0o077) !== 0 || (uid !== undefined && info.uid !== uid))) return false;
    const parent = posixPath.dirname(directory);
    if (parent === directory) return true;
    directory = parent;
    immediate = false;
  }
}

function readLifecycleState(statePath: string, expectedSession: string) {
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const fd = openSync(statePath, fsConstants.O_RDONLY | noFollow);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_RECOVERY_STATE_BYTES || (info.mode & 0o077) !== 0) throw new Error("invalid lifecycle state permissions or size");
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("invalid lifecycle state owner");
    const bytes = Buffer.alloc(Number(info.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== bytes.length) throw new Error("short lifecycle state read");
    const value = JSON.parse(bytes.toString("utf8")) as JsonObject;
    const keys = Object.keys(value);
    if (!keys.every((key) => ["schema_version", "session_id", "status"].includes(key))) throw new Error("unsupported lifecycle state fields");
    if (value.schema_version !== RECOVERY_STATE_VERSION || value.session_id !== expectedSession) throw new Error("lifecycle state identity mismatch");
    if (value.status !== undefined && (typeof value.status !== "string" || !["active", "degraded", "recovering", "failed", "stopped"].includes(value.status))) throw new Error("invalid lifecycle state status");
  } finally {
    closeSync(fd);
  }
}

function safeRecoveryCwd() {
  for (const candidate of [homedir(), "/"]) {
    try {
      const info = statSync(candidate);
      if (info.isDirectory() && realpathSync(candidate) === candidate) return candidate;
    } catch { /* try the platform root */ }
  }
  throw new Error("No safe local recovery working directory is available");
}

function recoveryConfiguration(expectedSession = env("AGENTSH_SESSION_ID")): RecoveryConfiguration | undefined {
  const command = env("PI_AGENTSH_RECOVERY_COMMAND");
  const statePath = env("PI_AGENTSH_LIFECYCLE_STATE");
  if (!command || !statePath || !expectedSession || expectedSession.length > 256) return undefined;
  if (!posixPath.isAbsolute(command) || posixPath.normalize(command) !== command || !/^\/nix\/store\/[a-z0-9]{32}-[^/]+(?:\/.+)?$/.test(command)) return undefined;
  if (!posixPath.isAbsolute(statePath) || posixPath.normalize(statePath) !== statePath || statePath.length > 4096) return undefined;
  try {
    const commandInfo = lstatSync(command);
    if (!commandInfo.isFile() || commandInfo.isSymbolicLink() || realpathSync(command) !== command) return undefined;
    accessSync(command, fsConstants.X_OK);
    const stateInfo = lstatSync(statePath);
    if (!stateInfo.isFile() || stateInfo.isSymbolicLink() || realpathSync(statePath) !== statePath || !protectedLifecycleParent(statePath)) return undefined;
    readLifecycleState(statePath, expectedSession);
    return { command, statePath, expectedSession, cwd: safeRecoveryCwd() };
  } catch {
    return undefined;
  }
}

function recoveryTimeoutMs() {
  const raw = env("PI_AGENTSH_RECOVERY_TIMEOUT_MS") || "300000";
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_NODE_TIMEOUT_MS ? value : 300000;
}

function recoveryEnvironment(config: RecoveryConfiguration) {
  const result: Record<string, string> = {
    PI_AGENTSH_LIFECYCLE_STATE: config.statePath,
    PI_AGENTSH_RECOVERY_EXPECTED_SESSION: config.expectedSession,
    PI_AGENTSH_RECOVERY_CONTRACT_VERSION: String(RECOVERY_STATE_VERSION),
  };
  for (const key of ["HOME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ"]) {
    const value = process.env[key];
    if (value && value.length <= 4096) result[key] = value;
  }
  return result;
}

function appendBoundedOutput(current: string, chunk: unknown) {
  const combined = current + String(chunk);
  return Buffer.byteLength(combined) <= MAX_RECOVERY_OUTPUT_BYTES
    ? combined
    : Buffer.from(combined).subarray(0, MAX_RECOVERY_OUTPUT_BYTES).toString("utf8");
}

async function spawnRecovery(config: RecoveryConfiguration, controller: AbortController, timeoutMs: number) {
  await new Promise<void>((resolve, reject) => {
    const usePosixGroup = process.platform !== "win32";
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(config.command, [], {
        cwd: config.cwd,
        env: recoveryEnvironment(config),
        detached: usePosixGroup,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      throw new Error(`Wrapper recovery spawn failed (${supervisorErrorCode(error) || "unknown"}; executable validated; cwd validated)`);
    }
    // Capture the group identity once. Never re-read child.pid after close: on
    // POSIX that numeric PID can already have been recycled for another child.
    const processGroupId = usePosixGroup && Number.isSafeInteger(child.pid) && Number(child.pid) > 0
      ? Number(child.pid)
      : undefined;
    child.stdout?.on("data", (chunk) => { stdout = appendBoundedOutput(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = appendBoundedOutput(stderr, chunk); });
    let settled = false;
    let leaderClosed = false;
    let groupCleanupComplete = false;
    let terminationError: Error | undefined;
    let cleanupError: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const signalTree = (signal: NodeJS.Signals): "sent" | "missing" | "failed" => {
      try {
        if (processGroupId !== undefined) process.kill(-processGroupId, signal);
        else child.kill(signal);
        return "sent";
      } catch (error) {
        if (supervisorErrorCode(error) === "ESRCH") return "missing";
        cleanupError = new Error(`Wrapper recovery cleanup failed while sending ${signal} (${supervisorErrorCode(error) || "unknown"})`);
        return "failed";
      }
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      controller.signal.removeEventListener("abort", onAbort);
      callback();
    };
    const finishTerminationIfReady = () => {
      if (!terminationError || !leaderClosed || (processGroupId !== undefined && !groupCleanupComplete)) return;
      finish(() => reject(cleanupError || terminationError!));
    };
    const escalate = () => {
      if (!terminationError || groupCleanupComplete) return;
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
      // A successful negative-PGID kill signals every remaining member. ESRCH
      // proves that the group no longer exists. In either case cleanup is done;
      // importantly, no stale delayed signal remains that could hit a reused ID.
      signalTree("SIGKILL");
      groupCleanupComplete = true;
      finishTerminationIfReady();
    };
    const terminate = (error: Error) => {
      if (terminationError) return;
      terminationError = error;
      const termResult = signalTree("SIGTERM");
      if (processGroupId === undefined) {
        // Non-POSIX fallback can only control the direct child. Keep the KILL
        // escalation until that child closes.
        killTimer = setTimeout(() => signalTree("SIGKILL"), 2000);
      } else if (termResult === "missing") {
        groupCleanupComplete = true;
      } else {
        killTimer = setTimeout(escalate, 2000);
      }
      finishTerminationIfReady();
    };
    const onAbort = () => terminate(supervisorRequestAborted());
    const timer = setTimeout(() => terminate(new Error(`Wrapper recovery timed out after ${timeoutMs}ms`)), timeoutMs);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
    child.on("error", (error) => finish(() => reject(terminationError || new Error(`Wrapper recovery spawn failed (${supervisorErrorCode(error) || "unknown"}; executable validated; cwd validated)`))));
    child.on("close", (code, signal) => {
      leaderClosed = true;
      if (terminationError) {
        if (processGroupId !== undefined && !groupCleanupComplete) {
          // close only reaps the leader. Escalate now rather than cancelling the
          // group cleanup or retaining a stale PGID until the grace timer.
          escalate();
        } else {
          finishTerminationIfReady();
        }
        if (processGroupId === undefined) finish(() => reject(cleanupError || terminationError!));
        return;
      }
      finish(() => {
        if (code === 0) return resolve();
        const diagnostic = safeExecText(stderr || stdout, 500);
        reject(new Error(`Wrapper recovery failed${code === null ? ` from signal ${signal || "unknown"}` : ` with code ${code}`}${diagnostic ? `: ${diagnostic}` : ""}`));
      });
    });
  });
}

function lifecycleIdentity(value: unknown) {
  return safeExecText(value, 180) || "-";
}

function formatRemaining(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unknown";
  const seconds = Math.max(0, Math.floor(value));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

function validatedHelperLifecycle(value: unknown): NethelperLifecycle | undefined {
  const helper = objectField(value);
  if (!helper || helper.schema_version !== 1) return undefined;
  const boundedString = (field: string, max = 256) => helper[field] === undefined || (typeof helper[field] === "string" && (helper[field] as string).length <= max);
  if (!["helper_kind", "lease_id", "unit_name", "soft_expires_at", "hard_expires_at", "terminal_reason", "last_checked_at"].every((field) => boundedString(field))) return undefined;
  if (typeof helper.status !== "string" || !["active", "renewing", "degraded", "expired", "failed", "stopped", "unknown"].includes(helper.status)) return undefined;
  for (const field of ["soft_remaining_seconds", "hard_remaining_seconds", "binding_generation", "renewal_generation"]) {
    const value = helper[field];
    if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_NODE_TIMEOUT_MS)) return undefined;
  }
  for (const field of ["socket_live", "credential_source_live"]) if (helper[field] !== undefined && typeof helper[field] !== "boolean") return undefined;
  return helper as NethelperLifecycle;
}

function helperLifecycleLines(report?: NetworkEnforcement) {
  const raw = report?.helper_lifecycle;
  if (!raw) return [];
  const helper = validatedHelperLifecycle(raw);
  if (!helper) return ["Helper:   invalid/unsupported lifecycle evidence"];
  const generations = [
    typeof helper.binding_generation === "number" ? `binding ${helper.binding_generation}` : "",
    typeof helper.renewal_generation === "number" ? `renewal ${helper.renewal_generation}` : "",
  ].filter(Boolean).join(", ");
  const liveText = (value: unknown) => value === true ? "live" : value === false ? "not live" : "unknown";
  const liveness = `socket ${liveText(helper.socket_live)}, credential source ${liveText(helper.credential_source_live)}`;
  const terminal = ["expired", "failed", "stopped"].includes(String(helper.status));
  const remaining = (value: unknown) => value === undefined && terminal ? "0s" : formatRemaining(value);
  return [
    `Helper:   ${lifecycleIdentity(helper.status)} / ${lifecycleIdentity(helper.helper_kind || "unknown")} (${liveness})`,
    `Lease:    ${lifecycleIdentity(helper.lease_id)}${helper.unit_name ? ` / unit ${lifecycleIdentity(helper.unit_name)}` : ""}${generations ? ` / ${generations}` : ""}`,
    `Expiry:   soft ${lifecycleIdentity(helper.soft_expires_at)} (${remaining(helper.soft_remaining_seconds)} remaining); hard ${lifecycleIdentity(helper.hard_expires_at)} (${remaining(helper.hard_remaining_seconds)} remaining)`,
    helper.terminal_reason ? `Helper reason: ${lifecycleIdentity(helper.terminal_reason)}` : "",
  ].filter(Boolean);
}

function helpText(state: SupervisorState) {
  const commandTimeout = parseCommandTimeoutMetadata(state.metadata);
  if (!state.active) {
    return [
      "AgentSH supervisor client is inactive.",
      "",
      "Attach with AGENTSH_SESSION_SUPERVISOR=<supervisor.sock>, use legacy AGENTSH_APPROVAL_UI_SOCKET=<ui.sock>,",
      "test with PI_AGENTSH_MOCK_SUPERVISOR=<mock.sock>, or start a detached supervisor with PI_AGENTSH_ENABLE=1.",
      "",
      "Optional env: PI_AGENTSH_POLICY=pi-autonomous|pi-supervised, PI_AGENTSH_WORKSPACE_MODE=shadow|direct, PI_AGENTSH_BIN=agentsh.",
      recoveryConfiguration() ? "Wrapper recovery is managed automatically by the trusted launcher." : "",
    ].join("\n");
  }
  return [
    "AgentSH supervisor client status",
    "",
    `Source:   ${state.source}`,
    `Mode:     ${state.activeMode || state.mode || "-"}`,
    `Socket:   ${state.socketPath}`,
    `Session:  ${state.sessionId || "-"}`,
    `Supervisor: ${state.status}`,
    `Pending:  ${state.pendingCount}`,
    state.metadata?.policy ? `Policy:   ${state.metadata.policy}` : "",
    state.metadata?.workspace_mode ? `Workspace: ${state.metadata.workspace_mode}` : "",
    state.metadata?.worktree ? `Worktree: ${state.metadata.worktree}` : "",
    state.metadata?.real_workspace ? `Real:     ${state.metadata.real_workspace}` : "",
    state.metadata?.protocol_version ? `Protocol: ${state.metadata.protocol_version}` : `Protocol: ${PROTOCOL_VERSION}`,
    commandTimeout ? `Command timeout: default ${commandTimeout.defaultMs}ms${commandTimeout.maximumMs !== undefined ? `, maximum ${commandTimeout.maximumMs}ms` : ""}${commandTimeout.approvalExtensionMs !== undefined ? `, approval extension ${commandTimeout.approvalExtensionMs}ms` : ""} (${commandTimeout.source})` : `Command timeout: compatibility default/ceiling ${COMMAND_EXECUTION_TIMEOUT_FALLBACK.defaultMs}ms (${COMMAND_EXECUTION_TIMEOUT_FALLBACK.source})`,
    metadataNetworkEnforcement(state.metadata)?.requested ? `Network:  ${metadataNetworkEnforcement(state.metadata)?.requested} / ${metadataNetworkEnforcement(state.metadata)?.status || "unknown"} / ${metadataNetworkEnforcement(state.metadata)?.tier || "unknown"}${state.metadata?.network_enforcement_live ? " (live)" : " (not live)"}` : "",
    metadataNetworkEnforcement(state.metadata)?.detail ? `Net detail: ${metadataNetworkEnforcement(state.metadata)?.detail}` : "",
    ...helperLifecycleLines(metadataNetworkEnforcement(state.metadata)),
    state.metadata?.network_enforcement_error ? `Net error: ${state.metadata.network_enforcement_error}` : "",
    Array.isArray(state.metadata?.supported_ops) ? `Ops:      ${state.metadata.supported_ops.join(", ")}` : "",
    recoveryConfiguration() ? "Recovery: automatic through the trusted launcher" : "Recovery: unavailable (wrapper did not provide validated recovery state)",
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
    setExecutionTarget(target) {
      state.executionTarget = { ...target };
    },
    getExecutionTarget() {
      return state.executionTarget ? { ...state.executionTarget } : undefined;
    },
    async exec(commandOrParams, options = {}) {
      const client = requireClient(state);
      if (typeof commandOrParams === "string") return await client.exec(commandOrParams, options);
      return await client.exec(commandOrParams.command, {
        ...options,
        cwd: commandOrParams.cwd ?? options.cwd ?? effectiveSupervisorCwd(state.ctx, state.executionTarget),
        timeout_ms: commandOrParams.timeout_ms !== undefined ? commandOrParams.timeout_ms : options.timeout_ms,
        persist_output_over_bytes: commandOrParams.persist_output_over_bytes ?? options.persist_output_over_bytes,
        persist_output_over_lines: commandOrParams.persist_output_over_lines ?? options.persist_output_over_lines,
        actor: commandOrParams.actor ?? options.actor,
      });
    },
    async refreshDirenv(options) {
      return await requireClient(state).refreshDirenv({
        ...options,
        cwd: options.cwd || effectiveSupervisorCwd(state.ctx, state.executionTarget),
      });
    },
    async readFile(path, options = {}) { return await requireClient(state).readFile(path, options); },
    async writeFile(path, content, options = {}) { return await requireClient(state).writeFile(path, content, options); },
    async editFile(path, edits, options = {}) { return await requireClient(state).editFile(path, edits, options); },
    async spawnSubagent(params, options = {}) { return await requireClient(state).spawnSubagent(params, options); },
    async resolveApproval(approvalId, resolution) { return await requireApprovalClient(state).resolveApproval(approvalId, resolution); },
    toSupervisorPath(path, cwd = effectiveSupervisorCwd(state.ctx, state.executionTarget)) {
      return supervisorAbsolutePath(state.metadata, path, cwd);
    },
    getSupervisorMetadata() { return state.metadata; },
    getSupervisorState() {
      const protocol = state.activeMode || state.mode;
      const active = state.active
        && Boolean(state.client)
        && (state.status === "connecting" || state.status === "connected" || state.status === "pending");
      return {
        configured: state.startup.kind === "full" || state.startup.kind === "conflict" || state.mode !== "",
        active,
        protocol,
        status: state.status,
        source: state.source,
        socketPath: state.socketPath,
        sessionId: state.sessionId,
        metadata: state.metadata,
        lastError: state.lastError || undefined,
      };
    },
  };
}

export default function sandbox(pi: ExtensionAPI) {
  const exposeSubagentTimeout = modelMayOverrideSubagentTimeout();
  const startup = classifyAgentSHStartup(process.env);
  const state: SupervisorState = {
    active: false,
    startup,
    mode: agentSHSupervisorProtocol(startup),
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
    lifecycleTail: Promise.resolve(),
    lifecycleBusy: false,
    shuttingDown: false,
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
    state.shuttingDown = true;
    const clients = new Set([state.client, state.connectingClient]);
    await Promise.all(Array.from(clients, async (client) => {
      if (client instanceof RestSupervisorClient) await client.dispose();
    }));
    await queueLifecycle(state, async () => {
      resetConnection(state);
      if (state.ctx?.hasUI) state.ctx.ui.setStatus("sandbox", undefined);
      state.ctx = undefined;
    });
  });

  pi.registerCommand("sandbox", {
    description: "Show AgentSH supervisor-client status",
    handler: async (_args, ctx) => notify(ctx, helpText(state), state.status === "error" ? "error" : "info"),
  });

  pi.registerCommand("sandbox-allow", {
    description: "Explain AgentSH approval flow for a target path/domain",
    handler: async (args, ctx) => notify(ctx, grantGuidance("access", args?.trim?.() || "", "manual request", state), "info"),
  });

  if (startup.kind === "full" || startup.kind === "conflict") {
    pi.registerTool({
      name: "bash",
    label: "bash",
    description: "Execute a bash command through the AgentSH session supervisor. A positive timeout is in seconds; omission uses the AgentSH operator default/maximum. Real REST exec_bash is buffered, not live-streamed.",
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
          cwd: effectiveSupervisorCwd(ctx, state.executionTarget),
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
        const failure = result.normalizedFailure;
        const details = {
          backend: "agentsh" as const,
          failed: Boolean(failure || exitCode !== 0),
          exitCode,
          commandStarted: failure?.commandStarted,
          dispatchState: failure?.dispatchState,
          failureKind: failure?.failureKind,
          retryable: failure?.retryable,
          code: failure?.code,
          message: failure?.message,
          policyRule: failure?.policyRule,
          queueDurationMs: failure?.queueDurationMs,
          executionDurationMs: failure?.executionDurationMs,
          normalizationSource: failure?.source,
          truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
          fullOutputPath: artifact?.path,
          outputArtifact: artifact,
        };

        if (failure || exitCode !== 0) {
          const semantic = failure ? execFailureText(failure, exitCode) : `Command exited with code ${exitCode}`;
          return { content: [{ type: "text", text: `${finalText}\n\n${semantic}` }], details, isError: true };
        }
        return { content: [{ type: "text", text: finalText }], details, isError: false };
      } catch (error) {
        if (error instanceof CommandExecutionTimeoutError) {
          output.finish();
          const result = error.result && typeof error.result === "object" && !Array.isArray(error.result) ? error.result as ExecResult : undefined;
          const snapshot = output.snapshot({ persistIfTruncated: true });
          let finalText = formatAccumulatedOutput(snapshot, output, result);
          const artifact = remoteOutputArtifact(result);
          if (artifact?.path && !finalText.includes(artifact.path)) finalText += `\n\n[Remote output artifact: ${artifact.path}]`;
          error.withToolOutput(finalText, { exitCode: error.exitCode, truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined, fullOutputPath: artifact?.path, outputArtifact: artifact });
          throw error;
        }
        if (error instanceof SupervisorSessionLostError || (error instanceof Error && error.name === "AbortError")) throw error;
        output.finish();
        const snapshot = output.snapshot({ persistIfTruncated: true });
        const message = safeExecText(asError(error).message) || "supervisor transport failed";
        const safeBeforeDispatch = error instanceof SafeSupervisorConnectError;
        const text = safeBeforeDispatch
          ? `Command was not executed because the AgentSH supervisor transport was unavailable. ${message}`
          : `Command outcome is ambiguous because the AgentSH supervisor transport failed after dispatch could not be excluded. The command was not replayed. ${message}`;
        return { content: [{ type: "text", text: `${formatAccumulatedOutput(snapshot, output)}\n\n${text}` }], details: { backend: "agentsh", failed: true, commandStarted: undefined, failureKind: "transport_ambiguity", retryable: false, message, normalizationSource: "transport" }, isError: true };

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
        const result = await requireClient(state).readFile(params.path, { cwd: effectiveSupervisorCwd(ctx, state.executionTarget), offset: params.offset, limit: params.limit, actor: parentActor(toolCallId, "Pi read tool"), signal });
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
      const result = await requireClient(state).writeFile(params.path, params.content, { cwd: effectiveSupervisorCwd(ctx, state.executionTarget), actor: parentActor(toolCallId, "Pi write tool"), signal });
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
      const result = await requireClient(state).editFile(params.path, params.edits, { cwd: effectiveSupervisorCwd(ctx, state.executionTarget), actor: parentActor(toolCallId, "Pi edit tool"), signal });
      return { content: [{ type: "text", text: textFromResult(result, `Edited ${params.path}`) }], details: (result as any)?.details || { diff: (result as any)?.diff } };
    },
  });

  }

  const agentSHSubagentAdapter = {
    detailsFailed(details: unknown) {
      return subagentDetailsFailed(details);
    },
    renderCall(args, theme) {
      return renderSubagentCall(args, theme);
    },
    renderResult(result, options, theme) {
      return renderSubagentResult(result, options, theme);
    },
    async execute(toolCallId, params: any, signal, onUpdate, ctx) {
      const inheritedParams = inheritSubagentModels(params, ctx.model);
      const normalizedCwds = normalizeSupervisorSubagentCwds(
        inheritedParams,
        effectiveSupervisorCwd(ctx, state.executionTarget),
        (absolute) => absoluteToVirtual(state.metadata, toSlashPath(absolute)),
      );
      const parentCwd = normalizedCwds.parentCwd;
      const effectiveParams = normalizedCwds.params;
      if (!exposeSubagentTimeout) delete effectiveParams.timeout_ms;
      const hasSingle = typeof effectiveParams.task === "string" && effectiveParams.task.trim().length > 0;
      const hasTasks = Array.isArray(effectiveParams.tasks) && effectiveParams.tasks.length > 0;
      const hasChain = Array.isArray(effectiveParams.chain) && effectiveParams.chain.length > 0;
      const hasDisposition = typeof effectiveParams.action === "string" || typeof effectiveParams.draft_id === "string";
      if (Number(hasSingle) + Number(hasTasks) + Number(hasChain) + Number(hasDisposition) !== 1) {
        throw new Error("Invalid parameters. Provide exactly one mode: task, non-empty tasks, non-empty chain, or Draft disposition.");
      }
      if (hasDisposition && effectiveParams.mode !== "draft") {
        throw new Error("Draft disposition requires mode=draft.");
      }
      const streamStates = new Map<string, SubagentStreamState>();
      const rawStreamResults = new Map<string, any>();
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
        result = await requireClient(state).spawnSubagent({ ...effectiveParams, cwd: effectiveParams.cwd || parentCwd, result_artifact_threshold_bytes: resultArtifactThresholdBytes, actor: parentActor(toolCallId, "Pi subagent tool") }, {
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
            rawStreamResults.set(childState.label, result);
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
          ? { state: "timed_out", failure_kind: "transport", cancellation_cause: "request_timeout", exit_code: 124, termination: "natural", retryable: false, side_effects_may_have_occurred: true, message: rawMessage }
          : signal?.aborted
            ? { state: "cancelled", cancellation_cause: "user_cancelled", exit_code: 130, termination: "graceful", retryable: false, side_effects_may_have_occurred: true, message: rawMessage }
            : { state: "failed", failure_kind: "transport", exit_code: 1, termination: "natural", retryable: false, side_effects_may_have_occurred: true, message: rawMessage });
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
        const rawRetained = {
          results: streamOrder.map((key) => {
            const label = streamStates.get(key)?.label ?? key;
            return rawStreamResults.get(label) ?? { label };
          }),
        };
        return attachRetainedReports(
          { content: [{ type: "text", text }], details },
          trustedRetainedSubagentReports(rawRetained, details, streamStates),
        );
      }
      const details = subagentParentDetails(result, ctx, streamStates) as any;
      const text = boundedSubagentParentOutput(details);
      return attachRetainedReports(
        { content: [{ type: "text", text }], details },
        trustedRetainedSubagentReports(result, details, streamStates),
      );
    },
  };
  if (globalThis.__AGENTSH_PI__) globalThis.__AGENTSH_PI__.subagentAdapter = agentSHSubagentAdapter;

  pi.on("tool_result", (event) => {
    if (event.toolName !== "bash" || event.isError) return;
    const details = event.details as { backend?: string; failed?: boolean } | undefined;
    if (details?.backend === "agentsh" && details.failed === true) {
      return { isError: true };
    }
  });

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
