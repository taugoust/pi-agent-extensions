import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

type Document = Record<string, unknown>;
const isDocument = (value: unknown): value is Document =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Operator defaults are read-only inputs, never preference/credential stores.
 * Precedence: built-ins < defaults/<canonical-name>.json < existing mutable
 * preferences < in-memory/session overrides (including display commands).
 * Objects merge recursively; arrays, null and scalars replace, never concatenate.
 * Consumers validate their existing public fields; this does not grant authority.
 */
export function mergeExtensionSettings(base: Document, override: Document): Document {
  const merged: Document = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    merged[key] = isDocument(value) && isDocument(base[key])
      ? mergeExtensionSettings(base[key], value) : value;
  }
  return merged;
}

/** Follows Nix-managed symlinks, but bounds reads and rejects nonregular files. */
export function readExtensionDefaults(name: string, agentDir = getAgentDir()): Document {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("Invalid canonical extension name");
  return readPreferenceDocument(join(agentDir, "defaults", `${name}.json`));
}

/** Only explicitly named public preference paths may be passed here. */
export function readPreferenceDocument(path: string): Document {
  let descriptor: number;
  try { descriptor = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    const limit = 64 * 1024;
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size > limit) throw new Error(`${path}: invalid preferences file`);
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (!count) break;
      offset += count;
    }
    if (offset > limit) throw new Error(`${path}: preferences file exceeds size limit`);
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset)));
    if (!isDocument(value)) throw new Error(`${path}: preferences must be an object`);
    return value;
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  } finally { closeSync(descriptor); }
}

export function withExtensionDefaults(name: string, value: unknown, section?: string): unknown {
  if (!isDocument(value)) return value; // Let the existing validator reject it.
  const defaults = readExtensionDefaults(name);
  const base = section === undefined ? defaults : defaults[section];
  if (base !== undefined && !isDocument(base)) {
    throw new Error(`defaults/${name}.json: ${section} must be an object`);
  }
  return mergeExtensionSettings(isDocument(base) ? base : {}, value);
}
