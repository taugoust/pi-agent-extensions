import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
export function getAgentDir() {
  if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
  if (!process.env.PI_SUBAGENT_TEST_AGENT_DIR)
    throw new Error("Tests must pass an isolated agent directory");
  return process.env.PI_SUBAGENT_TEST_AGENT_DIR;
}
export class ProjectTrustStore {
  constructor(agentDir) {
    this.path = join(agentDir, "trust.json");
  }
  get(cwd) {
    let current = resolve(cwd);
    let entries = {};
    try {
      entries = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    while (true) {
      if (Object.hasOwn(entries, current)) return entries[current];
      const parent = dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
  set(cwd, decision) {
    let entries = {};
    try {
      entries = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    entries[resolve(cwd)] = decision;
    writeFileSync(this.path, JSON.stringify(entries, null, 2), { mode: 0o600 });
  }
}
export class SettingsManager {
  static create(_cwd, agentDir) {
    let settings = {};
    try {
      settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const configured = settings.defaultProjectTrust;
    const policy = configured === "always" || configured === "never" ? configured : "ask";
    return { getDefaultProjectTrust: () => policy };
  }
}
