import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

/** Directories under the agent directory that hold Pi's installed resources. */
const RESOURCE_DIRS = new Set(["extensions", "skills", "prompts", "themes", "defaults"]);

/**
 * A fingerprint of the Nix-managed files in Pi's agent directory.
 *
 * Home Manager installs Pi's config and extensions as symlinks. Each link is
 * resolved to the store path it finally points at, so a deploy that changes
 * Pi's files changes the fingerprint, while a deploy that only changes other
 * parts of the Home Manager generation doesn't. Files Pi writes itself, such
 * as sessions, are plain files and don't count. Only the top level of the
 * agent directory and its resource directories are read.
 */
export function readConfigFingerprint(agentDir: string, store = "/nix/store/"): string {
  const links: string[] = [];
  const addLink = (path: string, name: string) => {
    try {
      const target = realpathSync(path);
      if (target.startsWith(store)) links.push(`${name} -> ${target}`);
    } catch {
      // A link removed or dangling while a deploy relinks files is part of a
      // change that the next poll will see in full.
    }
  };
  const visit = (dir: string, relative: string, recurse: (name: string) => boolean) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) addLink(path, name);
      else if (entry.isDirectory() && recurse(entry.name)) visit(path, name, () => true);
    }
  };
  visit(agentDir, "", (name) => RESOURCE_DIRS.has(name));
  return links.sort().join("\n");
}

/**
 * Tracks the fingerprint between polls. A change is only reported once the
 * same new fingerprint is seen twice in a row, so a deploy that is still
 * relinking files doesn't trigger a reload halfway through.
 */
export class ConfigChangeDetector {
  private candidate: string | null = null;

  constructor(private current: string) {}

  /** Returns true when the config has changed and settled. */
  observe(fingerprint: string): boolean {
    if (fingerprint === this.current) {
      this.candidate = null;
      return false;
    }
    if (fingerprint !== this.candidate) {
      this.candidate = fingerprint;
      return false;
    }
    return true;
  }

  /** The config that is now loaded. */
  accept(fingerprint: string): void {
    this.current = fingerprint;
    this.candidate = null;
  }
}
