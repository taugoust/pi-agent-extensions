import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function validateRuntimePath(path: string, label: string, mode = constants.R_OK): void {
  try {
    accessSync(path, mode);
    if (!statSync(path).isFile()) throw new Error("not a regular file");
  } catch (error) {
    throw new Error(`${label} is unavailable at ${path}; reload Pi after updating its extensions/runtime. ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Resolve while the extension is loaded, not when its first job is requested.
// Home Manager can remove/retarget the discovery symlink during this session.
// Retain a load-time failure for the tool to report, rather than crashing module
// loading or silently switching an old extension to a new runner implementation.
export function pinRuntimePath(url: URL, label: string): () => string {
  const original = fileURLToPath(url);
  let pinned: string | undefined;
  let failure: unknown;
  try { pinned = realpathSync(original); } catch (error) { failure = error; }
  return () => {
    if (!pinned) throw new Error(`${label} could not be resolved at extension load from ${original}; reload Pi after updating its extensions/runtime. ${failure instanceof Error ? failure.message : String(failure)}`);
    validateRuntimePath(pinned, label);
    return pinned;
  };
}
