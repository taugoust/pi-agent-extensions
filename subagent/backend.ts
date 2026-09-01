import {
  agentSHRuntimeDisposition,
  classifyAgentSHStartup,
  type AgentSHRuntimeState,
  type AgentSHStartupClassification,
} from "../shared/agentsh-mode.js";

export type AdaptiveSupervisorState = AgentSHRuntimeState & {
  configured: boolean;
  active: boolean;
  status?: string;
  lastError?: string;
};

export type AdaptiveSubagentBridge = {
  getSupervisorState(): AdaptiveSupervisorState;
  subagentAdapter?: unknown;
};

export type AdaptiveSubagentBackend =
  | { kind: "native" }
  | { kind: "agentsh" }
  | { kind: "unavailable"; message: string };

/** Select once at tool execution time. Never bypass a selected full AgentSH boundary. */
export function selectSubagentBackend(
  bridge: AdaptiveSubagentBridge | undefined,
  startup: AgentSHStartupClassification = classifyAgentSHStartup(process.env),
): AdaptiveSubagentBackend {
  let state: AdaptiveSupervisorState | undefined;
  try {
    state = bridge && typeof bridge.getSupervisorState !== "function"
      ? { configured: true, active: false }
      : bridge?.getSupervisorState?.();
  } catch {
    state = { configured: true, active: false };
  }
  const disposition = agentSHRuntimeDisposition(startup, state);
  const adapter = bridge?.subagentAdapter as { execute?: unknown; detailsFailed?: unknown; renderCall?: unknown; renderResult?: unknown } | undefined;
  const adapterValid = typeof adapter?.execute === "function" && typeof adapter.detailsFailed === "function" && typeof adapter.renderCall === "function" && typeof adapter.renderResult === "function";
  if (disposition.kind === "full" && adapterValid) return { kind: "agentsh" };
  if (disposition.kind === "native" || disposition.kind === "guard-only") return { kind: "native" };

  const detail = state?.lastError ? `: ${state.lastError}` : state?.status ? ` (${state.status})` : "";
  return { kind: "unavailable", message: `AgentSH is configured but its subagent supervisor is unavailable${detail}; native fallback is disabled` };
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
