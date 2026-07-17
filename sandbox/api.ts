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

declare global {
  // Shared, discipline-based API installed by the trusted sandbox extension.
  // eslint-disable-next-line no-var
  var __AGENTSH_PI__: AgentSHDirenvAPI | undefined;
}
