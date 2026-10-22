import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mergeExtensionSettings, readExtensionDefaults, readPreferenceDocument } from "../shared/extension-defaults.js";

/** Approval wait budget only; socket ownership and authorization are never settings. */
export function permissionGateTimeoutPreference(): string | undefined {
  const settings = mergeExtensionSettings(readExtensionDefaults("permission-gate"),
    readPreferenceDocument(join(getAgentDir(), "permission-gate.json")));
  const value = settings.timeoutMs;
  if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error("Invalid permission-gate timeoutMs preference");
  }
  return process.env.PI_AGENTSH_PERMISSION_GATE_TIMEOUT_MS ?? (value === undefined ? undefined : String(value));
}
