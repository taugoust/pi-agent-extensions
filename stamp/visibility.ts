import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Deployment default only; runtime visibility never changes collection settings. */
export function visibleByDefault(): boolean {
  try {
    return JSON.parse(readFileSync(join(getAgentDir(), "stamp-display.json"), "utf8")).visibleByDefault === true;
  } catch {
    return false;
  }
}
