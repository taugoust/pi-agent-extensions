import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mergeExtensionSettings, readExtensionDefaults, readPreferenceDocument } from "../shared/extension-defaults.js";

// Existing operator tunables only. Identity, capabilities, policy, enforcement,
// trusted recovery executables and model-visible authority stay environment-owned.
const fields = {
  PI_AGENTSH_CONNECT_TIMEOUT_MS: "connectTimeoutMs",
  PI_AGENTSH_START_TIMEOUT_MS: "startTimeoutMs",
  PI_AGENTSH_WATCH_RECONNECT_MS: "watchReconnectMs",
  PI_AGENTSH_RECONNECT_TIMEOUT_MS: "reconnectTimeoutMs",
  PI_AGENTSH_RECONNECT_INITIAL_MS: "reconnectInitialMs",
  PI_AGENTSH_RECOVERY_TRIGGER_MS: "recoveryTriggerMs",
  PI_AGENTSH_APPROVAL_POLL_MS: "approvalPollMs",
  PI_AGENTSH_TOOL_REQUEST_TIMEOUT_MS: "toolRequestTimeoutMs",
  PI_AGENTSH_APPROVAL_TIMEOUT_SLACK_MS: "approvalTimeoutSlackMs",
  PI_AGENTSH_COMMAND_EXECUTION_TIMEOUT_MS: "commandExecutionTimeoutMs",
  PI_AGENTSH_COMMAND_TRANSPORT_SLACK_MS: "commandTransportSlackMs",
  PI_AGENTSH_SUBAGENT_EXECUTION_TIMEOUT_MS: "subagentExecutionTimeoutMs",
  PI_AGENTSH_SUBAGENT_REQUEST_TIMEOUT_MS: "subagentRequestTimeoutMs",
  PI_AGENTSH_SUBAGENT_TRANSPORT_SLACK_MS: "subagentTransportSlackMs",
  PI_AGENTSH_SUBAGENT_TRANSPORT_TIMEOUT_MS: "subagentTransportTimeoutMs",
  PI_AGENTSH_SUBAGENT_RESULT_MAX_BYTES: "subagentResultMaxBytes",
  PI_AGENTSH_RECOVERY_TIMEOUT_MS: "recoveryTimeoutMs",
  PI_AGENTSH_APPROVAL_BELL: "approvalBell",
  PI_AGENTSH_DEBUG_REST_ERRORS: "debugRestErrors",
} as const;

let settings: Record<string, unknown> | undefined;
function preferences(): Record<string, unknown> {
  if (settings) return settings;
  const document = mergeExtensionSettings(readExtensionDefaults("sandbox"),
    readPreferenceDocument(join(getAgentDir(), "sandbox.json")));
  for (const field of Object.values(fields)) {
    const value = document[field];
    if (value === undefined) continue;
    const valid = field === "approvalBell" || field === "debugRestErrors"
      ? typeof value === "boolean"
      : typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    if (!valid) throw new Error(`Invalid sandbox ${field} preference`);
  }
  return settings = document;
}

/** Existing environment overrides remain highest priority; no process.env mutation. */
export function sandboxSetting(name: string): string | undefined {
  const field = fields[name as keyof typeof fields];
  if (!field) return process.env[name];
  const value = preferences()[field];
  if (process.env[name] !== undefined) return process.env[name];
  return value === undefined ? undefined : typeof value === "boolean" ? (value ? "1" : "0") : String(value);
}
