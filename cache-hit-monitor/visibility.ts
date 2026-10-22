import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mergeExtensionSettings, readExtensionDefaults, readPreferenceDocument } from "../shared/extension-defaults.js";

/** Display default only; runtime toggles never disable cache collection. */
export function visibleByDefault(): boolean {
  const settings = mergeExtensionSettings(readExtensionDefaults("cache-hit-monitor"),
    readPreferenceDocument(join(getAgentDir(), "cache-hit-monitor-display.json")));
  if (settings.visibleByDefault !== undefined && typeof settings.visibleByDefault !== "boolean") {
    throw new Error("Invalid cache-hit-monitor visibleByDefault preference");
  }
  return settings.visibleByDefault === true;
}
