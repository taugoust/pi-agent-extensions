export type AgentSHSupervisorProtocol = "mock-ndjson" | "rest" | "legacy-approval-ui" | "";
export type AgentSHStartupProtocol = AgentSHSupervisorProtocol | "permission-gate";
export type AgentSHStartupKind = "native" | "guard-only" | "full" | "conflict";

export type AgentSHStartupClassification = Readonly<{
  /** Authority selected before extension startup. Full mode must never fall back to native side effects. */
  kind: AgentSHStartupKind;
  /** Concrete transport selected by the startup environment, if one was supplied. */
  protocol: AgentSHStartupProtocol;
  /** True only when Pi is expected to start a local REST supervisor. */
  startSupervisor: boolean;
}>;

export type AgentSHRuntimeState = {
  configured?: unknown;
  active?: unknown;
  protocol?: unknown;
  source?: unknown;
  status?: unknown;
  lastError?: unknown;
};

export type AgentSHRuntimeDisposition = Readonly<{
  kind: "native" | "guard-only" | "full" | "unavailable";
  protocol: AgentSHStartupProtocol;
}>;

const FULL_STATUSES = new Set(["connecting", "connected", "pending"]);

function own(env: Record<string, string | undefined>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(env, name);
}

function value(env: Record<string, string | undefined>, name: string): string {
  return typeof env[name] === "string" ? env[name]!.trim() : "";
}

/**
 * Classify AgentSH once, before asynchronous extension startup.
 *
 * Permission Gate and the retired approval-only relay are deliberately limited
 * authority channels. Neither selects the full supervisor backend by itself.
 */
export function classifyAgentSHStartup(
  env: Record<string, string | undefined> = process.env,
): AgentSHStartupClassification {
  const startSupervisor = value(env, "PI_AGENTSH_ENABLE") === "1";
  const mockSupervisor = value(env, "PI_AGENTSH_MOCK_SUPERVISOR") !== "";
  const restSupervisor = value(env, "AGENTSH_SESSION_SUPERVISOR") !== "";
  const legacyApproval = value(env, "AGENTSH_APPROVAL_UI_SOCKET") !== "";
  // An empty Permission Gate marker is still a selected, malformed guard. Its
  // owner must claim it and fail closed rather than silently enabling legacy mode.
  const permissionGate = own(env, "AGENTSH_PERMISSION_GATE_SOCKET");

  const fullSelected = mockSupervisor
    || restSupervisor
    || startSupervisor
    || value(env, "PI_SUPERVISED") === "1"
    || value(env, "PI_AUTO") === "1"
    || value(env, "PI_AGENTSH_REMOTE") === "ssh"
    || value(env, "PI_AGENTSH_READ_MODE") === "supervised"
    || value(env, "AGENTSH_CHILD_CAPABILITY") !== "";

  const protocol: AgentSHStartupProtocol = mockSupervisor
    ? "mock-ndjson"
    : restSupervisor || startSupervisor
      ? "rest"
      : legacyApproval
        ? "legacy-approval-ui"
        : permissionGate
          ? "permission-gate"
          : "";

  return {
    kind: fullSelected && permissionGate
      ? "conflict"
      : fullSelected
        ? "full"
        : protocol
          ? "guard-only"
          : "native",
    protocol,
    startSupervisor,
  };
}

/** Return the protocol implemented by the sandbox supervisor client. */
export function agentSHSupervisorProtocol(
  startup: AgentSHStartupClassification,
): AgentSHSupervisorProtocol {
  return startup.protocol === "permission-gate" ? "" : startup.protocol;
}

function publishedProtocol(state: AgentSHRuntimeState | null | undefined): AgentSHStartupProtocol | "invalid" {
  if (!state) return "";
  if (state.protocol !== undefined) {
    if (
      state.protocol === ""
      || state.protocol === "rest"
      || state.protocol === "mock-ndjson"
      || state.protocol === "legacy-approval-ui"
      || state.protocol === "permission-gate"
    ) return state.protocol;
    return "invalid";
  }

  // Compatibility with sandbox versions that predate the protocol field.
  if (state.source === "mock") return "mock-ndjson";
  if (state.source === "agentsh-env" || state.source === "agentsh-started") return "rest";
  if (state.source === "agentsh-approval-ui") return "legacy-approval-ui";
  return "";
}

function runtimeReady(state: AgentSHRuntimeState | null | undefined): boolean {
  if (state?.active !== true) return false;
  return typeof state.status !== "string" || FULL_STATUSES.has(state.status);
}

/**
 * Combine immutable startup intent with the sandbox's live state.
 *
 * `unavailable` is sticky for every selected full mode: callers must fail
 * closed instead of using a native backend. Limited guard-only protocols never
 * imply that commands, files, HTTP, direnv, SSH, PDF, or subagents are supervised.
 */
export function agentSHRuntimeDisposition(
  startup: AgentSHStartupClassification,
  state?: AgentSHRuntimeState | null,
): AgentSHRuntimeDisposition {
  if (state !== undefined && state !== null) {
    if (typeof state !== "object" || Array.isArray(state)) return { kind: "unavailable", protocol: startup.protocol };
    if (state.configured !== undefined && typeof state.configured !== "boolean") return { kind: "unavailable", protocol: startup.protocol };
    if (state.active !== undefined && typeof state.active !== "boolean") return { kind: "unavailable", protocol: startup.protocol };
    if (state.status !== undefined && typeof state.status !== "string") return { kind: "unavailable", protocol: startup.protocol };
  }
  const published = publishedProtocol(state);
  if (published === "invalid") return { kind: "unavailable", protocol: "" };
  const protocolPublished = Boolean(state && Object.prototype.hasOwnProperty.call(state, "protocol"));
  const protocol = published || (!protocolPublished ? startup.protocol : "");

  const fullProtocol = protocol === "rest" || protocol === "mock-ndjson";
  const limitedProtocol = protocol === "permission-gate" || protocol === "legacy-approval-ui";
  // configured/active without a protocol is an older full sandbox publication.
  const untypedFullState = published === "" && (state?.configured === true || state?.active === true);
  const legacyFullState = !protocolPublished && startup.protocol === "" && untypedFullState;
  const fullSelected = startup.kind === "full" || startup.kind === "conflict" || fullProtocol || untypedFullState;

  if (fullSelected) {
    if (limitedProtocol || (!fullProtocol && !legacyFullState) || !runtimeReady(state)) {
      return { kind: "unavailable", protocol };
    }
    return { kind: "full", protocol };
  }

  if (limitedProtocol || startup.kind === "guard-only") {
    return { kind: "guard-only", protocol: protocol || startup.protocol };
  }
  return { kind: "native", protocol: "" };
}
