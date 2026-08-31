export type AdaptiveSupervisorState = {
  configured: boolean;
  active: boolean;
  status?: string;
  lastError?: string;
};

export type AdaptiveSubagentBridge = {
  getSupervisorState(): AdaptiveSupervisorState;
  subagentAdapter?: unknown;
};

export function agentSHExpected(processEnv: Record<string, string | undefined>): boolean {
  return Boolean(
    processEnv.PI_SUPERVISED === "1" ||
    processEnv.PI_AUTO === "1" ||
    processEnv.PI_AGENTSH_REMOTE === "ssh" ||
    processEnv.AGENTSH_SESSION_SUPERVISOR ||
    processEnv.PI_AGENTSH_MOCK_SUPERVISOR ||
    processEnv.PI_AGENTSH_ENABLE === "1"
  );
}

export type AdaptiveSubagentBackend =
  | { kind: "native" }
  | { kind: "agentsh" }
  | { kind: "unavailable"; message: string };

/** Select once at tool execution time. Never bypass an expected AgentSH boundary. */
export function selectSubagentBackend(bridge: AdaptiveSubagentBridge | undefined, agentSHExpected = false): AdaptiveSubagentBackend {
  const state = bridge?.getSupervisorState?.();
  const adapter = bridge?.subagentAdapter as { execute?: unknown; detailsFailed?: unknown; renderCall?: unknown; renderResult?: unknown } | undefined;
  const adapterValid = typeof adapter?.execute === "function" && typeof adapter.detailsFailed === "function" && typeof adapter.renderCall === "function" && typeof adapter.renderResult === "function";
  if (state?.active && adapterValid) return { kind: "agentsh" };
  if (agentSHExpected || state?.configured || state?.active) {
    const detail = state?.lastError ? `: ${state.lastError}` : state?.status ? ` (${state.status})` : "";
    return { kind: "unavailable", message: `AgentSH is configured but its subagent supervisor is unavailable${detail}; native fallback is disabled` };
  }
  return { kind: "native" };
}

export function adaptiveDispositionError(params: Record<string, unknown>): string | undefined {
  const hasAction = typeof params.action === "string" && params.action.trim() !== "";
  const hasDraftID = typeof params.draft_id === "string" && params.draft_id.trim() !== "";
  if (hasAction !== hasDraftID) return "Draft disposition requires both action and draft_id";
  if ((hasAction || hasDraftID) && params.mode !== "draft") return "Draft disposition requires mode=draft";
  return undefined;
}

export function nativeSubagentRequestSupported(params: Record<string, unknown>): boolean {
  return (!params.mode || params.mode === "shared") && !params.action && !params.draft_id;
}
