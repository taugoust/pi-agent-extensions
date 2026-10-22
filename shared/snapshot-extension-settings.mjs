#!/usr/bin/env node
/**
 * Snapshot public extension settings for an isolated agent directory.
 * Usage: node .../shared/snapshot-extension-settings.mjs SOURCE DEST
 *
 * The adjacent manifest is the only path authority. No directory enumeration,
 * credentials, accounts, global settings, sessions, control files or identity
 * propagation. Runtime extensions retain responsibility for schema validation.
 * Source symlinks may point into the Nix store; only regular JSON objects up to
 * 64 KiB are accepted. The resolved destination root and directories beneath it must be owned,
 * non-writable by other users, nonsymlink directories. Files publish atomically with mode 0600.
 * Missing source removes only the corresponding approved destination file.
 * Existing empty objects are preserved; SOURCE == DEST is a safe no-op.
 * An empty SOURCE means no configured root, never the current directory.
 */
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const manifest = JSON.parse(readFileSync(new URL("./extension-config-manifest.json", import.meta.url), "utf8"));
const paths = [
  ...manifest.defaults.map((name) => {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("Invalid defaults manifest name");
    return `defaults/${name}.json`;
  }),
  ...manifest.preferences,
];
for (const path of paths) {
  if (typeof path !== "string" || !/^(?:[a-z0-9-]+\/)*[a-z0-9-]+\.json$/.test(path)) {
    throw new Error("Invalid public extension settings manifest path");
  }
}

function canonicalPath(path) {
  try { return realpathSync(path); }
  catch (error) { if (error.code === "ENOENT") return resolve(path); throw error; }
}

function readObject(path) {
  let descriptor;
  try { descriptor = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  try {
    const limit = 64 * 1024;
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size > limit) throw new Error("expected regular JSON file, at most 64 KiB");
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (!count) break;
      offset += count;
    }
    if (offset > limit) throw new Error("JSON file exceeds 64 KiB");
    const object = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset)));
    if (object === null || typeof object !== "object" || Array.isArray(object)) throw new Error("expected JSON object");
    const contents = `${JSON.stringify(object)}\n`;
    if (Buffer.byteLength(contents) > limit) throw new Error("serialized JSON exceeds 64 KiB");
    return contents;
  } catch (error) { throw new Error(`${path}: ${error.message}`); }
  finally { closeSync(descriptor); }
}

async function assertDirectory(path) {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o022)
    || (typeof process.getuid === "function" && stats.uid !== process.getuid())) {
    throw new Error(`${path}: destination must be an owned nonsymlink directory without group/other write access`);
  }
}

async function destinationParent(root, relative, create) {
  let directory = root;
  for (const component of dirname(relative).split("/")) {
    if (component === ".") continue;
    directory = join(directory, component);
    try { await assertDirectory(directory); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!create) return undefined;
      try { await mkdir(directory, { mode: 0o700 }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      await assertDirectory(directory);
    }
  }
  return directory;
}

export async function snapshotExtensionSettings(source, destination) {
  if (!destination) throw new Error("destination agent directory must not be empty");
  const sourceRoot = source === "" ? undefined : canonicalPath(source);
  if (sourceRoot !== undefined && sourceRoot === canonicalPath(destination)) return;
  // Validate all source documents before changing any destination settings.
  const snapshot = paths.map((path) => [path, sourceRoot === undefined ? undefined : readObject(join(sourceRoot, path))]);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const destinationRoot = realpathSync(destination);
  if (sourceRoot === destinationRoot) return;
  await assertDirectory(destinationRoot);
  for (const [relative, contents] of snapshot) {
    const parent = await destinationParent(destinationRoot, relative, contents !== undefined);
    if (!parent) continue;
    const target = join(destinationRoot, relative);
    if (contents === undefined) {
      await rm(target, { force: true }); // Never recursive; cannot remove an unrelated directory.
      continue;
    }
    const temporary = join(parent, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
      await rename(temporary, target); // Replaces a destination symlink, never follows it.
    } finally { await rm(temporary, { force: true }); }
  }
}

if (process.argv[1] && canonicalPath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) {
    console.error("Usage: node .../shared/snapshot-extension-settings.mjs SOURCE DEST");
    process.exitCode = 1;
  } else {
    snapshotExtensionSettings(process.argv[2], process.argv[3]).catch((error) => {
      console.error(`Extension settings snapshot failed: ${error.message}`);
      process.exitCode = 1;
    });
  }
}
