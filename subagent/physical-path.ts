import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Resolve existing symlinks physically; preserve missing suffixes after the nearest real ancestor. */
export function physicalPath(path: string): { path: string; exists: boolean } {
  let candidate = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      const canonical = realpathSync(candidate);
      return { path: join(canonical, ...missing), exists: missing.length === 0 };
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      let missingEntry = false;
      try { lstatSync(candidate); }
      catch (statError: any) { if (statError?.code === "ENOENT") missingEntry = true; else throw statError; }
      if (!missingEntry) throw error; // An existing but unresolved entry (for example a broken symlink) is unknown.
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      missing.unshift(basename(candidate));
      candidate = parent;
    }
  }
}
