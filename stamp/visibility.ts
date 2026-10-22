import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mergeExtensionSettings, readExtensionDefaults, readPreferenceDocument } from "../shared/extension-defaults.js";

/** Display default only; /stamp session visibility never changes collection. */
export function visibleByDefault(): boolean {
  const settings = mergeExtensionSettings(readExtensionDefaults("stamp"),
    readPreferenceDocument(join(getAgentDir(), "stamp-display.json")));
  if (settings.visibleByDefault !== undefined && typeof settings.visibleByDefault !== "boolean") {
    throw new Error("Invalid stamp visibleByDefault preference");
  }
  return settings.visibleByDefault === true;
}
