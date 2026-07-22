export type JsonObject = Record<string, unknown>;

export type AgentSHActor = {
  kind: "parent" | "subagent" | "tool" | "extension";
  label?: string;
  subagent_id?: string;
  subagent_depth?: number;
  tool_call_id?: string;
  task?: string;
};

export type AgentSHWorkspaceRoot = {
  name?: string;
  real?: string;
  work?: string;
};

export type AgentSHNethelperLifecycle = {
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

export type AgentSHNetworkEnforcement = {
  requested?: "none" | "best-effort" | "strict" | string;
  readiness?: "none" | "degraded" | "ready" | "active" | "failed" | string;
  status?: "none" | "degraded" | "ready" | "active" | "failed" | string;
  tier?: string;
  network_policy_enforced?: boolean;
  checked_at?: string;
  detail?: string;
  warning?: string;
  helper_lifecycle?: AgentSHNethelperLifecycle;
  [key: string]: unknown;
};

export type AgentSHSupervisorMetadata = {
  session_id?: string;
  sessionId?: string;
  protocol_version?: number;
  supervisor_sock?: string;
  supervisorSock?: string;
  worktree?: string;
  real_workspace?: string;
  workspace_mode?: string;
  virtual_root?: string;
  workspace_roots?: AgentSHWorkspaceRoot[];
  runtime_home?: string;
  runtime_tmp?: string;
  policy?: string;
  supported_ops?: string[];
  network_enforcement?: AgentSHNetworkEnforcement;
  networkEnforcement?: AgentSHNetworkEnforcement;
  network_enforcement_live?: boolean;
  network_enforcement_error?: string;
  command_timeout?: unknown;
  [key: string]: unknown;
};

export type AgentSHSupervisorStatus =
  | "inactive"
  | "starting"
  | "connecting"
  | "connected"
  | "pending"
  | "error";

export type AgentSHSupervisorSource =
  | "agentsh-env"
  | "agentsh-started"
  | "agentsh-approval-ui"
  | "mock"
  | "";

export type AgentSHSupervisorMessage = {
  id?: string;
  ok?: boolean;
  error?: string;
  event?: string;
  data?: unknown;
  result?: unknown;
  [key: string]: unknown;
};

export type AgentSHNormalizedExecFailure = {
  commandStarted?: boolean;
  dispatchState?: string;
  failureKind?: string;
  retryable?: boolean;
  code?: string;
  message?: string;
  policyRule?: string;
  queueDurationMs?: number;
  executionDurationMs?: number;
  source: "top-level" | "nested" | "legacy" | "transport";
};

export type AgentSHExecResult = {
  exitCode?: number | null;
  exit_code?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  stdout_truncated?: boolean;
  stdoutTruncated?: boolean;
  stdout_total_bytes?: number;
  stdoutTotalBytes?: number;
  normalizedFailure?: AgentSHNormalizedExecFailure;
  [key: string]: unknown;
};

export type AgentSHExecOptions = {
  cwd?: string;
  timeout?: number;
  timeout_ms?: number;
  persist_output_over_bytes?: number;
  persist_output_over_lines?: number;
  actor?: AgentSHActor;
  tool_call_id?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  signal?: AbortSignal;
};

export type AgentSHReadFileOptions = {
  offset?: number;
  limit?: number;
  maxBytes?: number;
  cwd?: string;
  actor?: AgentSHActor;
  signal?: AbortSignal;
};

export type AgentSHReadFileResult = {
  path?: string;
  real_path?: string;
  size?: number;
  truncated?: boolean;
  byte_truncated?: boolean;
  start_line?: number;
  end_line?: number;
  next_offset?: number;
  max_bytes?: number;
  encoding?: "utf-8" | "base64" | string;
  content?: string;
  base64?: string;
  text?: string;
  details?: unknown;
  [key: string]: unknown;
};

export type AgentSHWriteFileOptions = {
  cwd?: string;
  actor?: AgentSHActor;
  signal?: AbortSignal;
};

export type AgentSHEdit = {
  oldText: string;
  newText: string;
};

export type AgentSHEditFileOptions = {
  cwd?: string;
  actor?: AgentSHActor;
  signal?: AbortSignal;
};

export type AgentSHSpawnSubagentOptions = {
  actor?: AgentSHActor;
  signal?: AbortSignal;
  onUpdate?: (message: AgentSHSupervisorMessage) => void;
};

export type AgentSHApprovalResolution = {
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

export type DirenvRefreshState =
  | "no_envrc"
  | "not_allowed"
  | "loaded"
  | "unchanged"
  | "policy_denied"
  | "timed_out"
  | "invalid_output"
  | "unavailable";

export type DirenvRefreshResult = {
  state: DirenvRefreshState;
  set_count: number;
  unset_count: number;
  rejected_count: number;
  generation: number;
  duration_ms: number;
};

export type DirenvRefreshOptions = {
  cwd: string;
  actor?: { kind: "extension"; label?: string };
  signal?: AbortSignal;
};

export type AgentSHDirenvAPI = {
  refreshDirenv(options: DirenvRefreshOptions): Promise<DirenvRefreshResult>;
};

export type AgentSHPiAPI = AgentSHDirenvAPI & {
  exec(
    command:
      | string
      | {
          command: string;
          cwd?: string;
          timeout_ms?: number;
          persist_output_over_bytes?: number;
          persist_output_over_lines?: number;
          actor?: AgentSHActor;
        },
    options?: AgentSHExecOptions,
  ): Promise<AgentSHExecResult>;
  readFile(path: string, options?: AgentSHReadFileOptions): Promise<AgentSHReadFileResult>;
  writeFile(path: string, content: string, options?: AgentSHWriteFileOptions): Promise<unknown>;
  editFile(path: string, edits: AgentSHEdit[], options?: AgentSHEditFileOptions): Promise<unknown>;
  spawnSubagent(params: JsonObject, options?: AgentSHSpawnSubagentOptions): Promise<unknown>;
  resolveApproval(approvalId: string, resolution: AgentSHApprovalResolution): Promise<unknown>;
  /** Resolve a control-plane, real-workspace, shadow-worktree, or relative path to the supervisor-visible path. */
  toSupervisorPath(path: string, cwd?: string): string;
  getSupervisorMetadata(): AgentSHSupervisorMetadata | undefined;
  getSupervisorState(): {
    active: boolean;
    status: AgentSHSupervisorStatus;
    source: AgentSHSupervisorSource;
    socketPath: string;
    sessionId: string;
    metadata?: AgentSHSupervisorMetadata;
    lastError?: string;
  };
};

declare global {
  // Shared, discipline-based API installed by the trusted sandbox extension.
  // eslint-disable-next-line no-var
  var __AGENTSH_PI__: AgentSHPiAPI | undefined;
}
