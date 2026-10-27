import { constants, readdirSync, openSync, closeSync, fstatSync, readSync, lstatSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseTuiWorkerRequest } from "./tui-worker-protocol.ts";
export function ancestryStateRoot(env: NodeJS.ProcessEnv, home: string): string {
  return env.PI_TUI_WORKER_STATE_ROOT ?? join(env.XDG_STATE_HOME || join(home, ".local", "state"), "pi-tui");
}
export function privateEvidenceDirectory(path: string): string {
  const absolute = resolve(path);
  for (let cursor = absolute; ; cursor = dirname(cursor)) {
    const stat = lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Job evidence directory must not contain symlinks");
    if (cursor === absolute && ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid()))) throw new Error("Job evidence directory must be private");
    if (dirname(cursor) === cursor) break;
  }
  return absolute;
}
function validateWorkerManifest(m: any): any {
  parseTuiWorkerRequest({ protocol: m.protocol, requestId: "validate", token: m.controlToken, ownerSessionId: m.ownerSessionId,
    taskId: m.taskId, runtimeId: m.runtimeId, groupId: m.groupId, childId: m.childId, attempt: m.attempt, workerEpoch: m.workerEpoch, operation: "status" });
  if (typeof m.sessionFile !== "string" || typeof m.controlSocket !== "string") throw new Error("Invalid ancestry manifest paths");
  return m;
}

export type JobOwner = { sessionId: string; childId?: string };
export type JobAncestry = { owners: JobOwner[]; fingerprint: string; unavailable?: boolean };
const MAX_GROUPS = 10000, MAX_WORKERS = 20000;
export const MAX_READONLY_SNAPSHOT_BYTES = 64 * 1024 * 1024;
class AncestryCapacityError extends Error {}
type ByteBudget = { remaining: number };
function consume(budget: ByteBudget, bytes: number): void {
  if (bytes > budget.remaining) throw new AncestryCapacityError("Read-only job ancestry byte capacity exceeded");
  budget.remaining -= bytes;
}
function readEvidence(path: string, budget: ByteBudget): any {
  privateEvidenceDirectory(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd), maximum = 256 * 1024;
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe job ancestry evidence");
    if (stat.size > budget.remaining) throw new AncestryCapacityError("Read-only job ancestry byte capacity exceeded");
    const bytes = Buffer.alloc(Math.min(maximum + 1, budget.remaining + 1)), count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count > maximum) throw new Error("Job ancestry evidence capacity exceeded");
    consume(budget, count);
    return JSON.parse(bytes.subarray(0, count).toString("utf8"));
  } finally { closeSync(fd); }
}
/** Observation only. No scheduler, socket calls, reconciliation or ownership adoption. */
export function readJobAncestry(root: string, owner: string, maxBytes = MAX_READONLY_SNAPSHOT_BYTES): JobAncestry {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_READONLY_SNAPSHOT_BYTES) throw new Error("Invalid read-only ancestry byte bound");
  const budget = { remaining: maxBytes };
  const hash = createHash("sha256").update(owner);
  const owners: JobOwner[] = [{ sessionId: owner }];
  try { lstatSync(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { owners, fingerprint: hash.digest("hex") };
    throw error;
  }
  root = privateEvidenceDirectory(root);
  const byOwner = new Map<string, any[]>();
  let groupCount = 0, unavailable = false;
  for (const directory of ["groups", "headless-groups"]) {
    let groupsDir: string;
    try { groupsDir = privateEvidenceDirectory(join(root, directory)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const files = readdirSync(groupsDir).filter(name => /^subagent-job-[a-f0-9]{24}\.json$/.test(name)).sort();
    groupCount += files.length;
    if (groupCount > MAX_GROUPS) throw new Error("Read-only job ancestry group capacity exceeded");
    for (const file of files) {
      try {
        const group = readEvidence(join(groupsDir, file), budget);
        // Attribute readable records before validating their schema: legacy or
        // malformed records from unrelated sessions must not taint this scope.
        // The owner field alone never grants authority; validation still happens
        // before any children can be traversed.
        if (!group || typeof group.owner !== "string") throw new Error("Unattributable retained job ancestry group");
        const valid = group.version === 1 && `${group.id}.json` === file && Array.isArray(group.children) && group.children.length <= 8;
        const groups = byOwner.get(group.owner) ?? []; groups.push({ group, valid, directory, file }); byOwner.set(group.owner, groups);
      } catch (error) {
        if (error instanceof AncestryCapacityError) throw error;
        unavailable = true; hash.update(JSON.stringify(["unavailable-group", directory, file]));
      }
    }
  }
  const queue = [owner], seen = new Set(queue), identities = new Set<string>();
  let workers = 0;
  for (let i = 0; i < queue.length; i++) {
    const session = queue[i]!;
    for (const record of byOwner.get(session) ?? []) {
      if (!record.valid) {
        unavailable = true; hash.update(JSON.stringify(["unavailable-group", record.directory, record.file]));
        continue;
      }
      const group = record.group;
      // Hash only identity evidence, not unrelated task status or notification writes.
      for (const child of group.children) {
        if (++workers > MAX_WORKERS) throw new Error("Read-only job ancestry worker capacity exceeded");
        try {
        if (!/^subagent-child-[a-f0-9]{24}$/.test(child.childId) || !/^subagent-task-[a-f0-9]{24}$/.test(child.taskId)
          || !/^[a-f0-9]{64}$/.test(child.operatorCapability) || !Number.isSafeInteger(child.attempt) || child.attempt < 1
          || typeof child.directory !== "string" || !/^[a-f0-9]{24}$/.test(child.directory.split("/").pop() ?? "")
          || child.directory !== join(root, "workers", child.directory.split("/").pop())) throw new Error("Invalid retained job ancestry child");
        let manifest;
        try { manifest = validateWorkerManifest(readEvidence(join(child.directory, "manifest.json"), budget)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && !child.started) continue; throw error; }
        if (manifest.sessionFile !== join(child.directory, "session.jsonl") || manifest.controlSocket !== join(child.directory, "control.sock")
          || manifest.ownerSessionId !== session || manifest.groupId !== group.id || manifest.childId !== child.childId
          || manifest.taskId !== child.taskId || manifest.attempt !== child.attempt
          ) throw new Error("Read-only job ancestry identity mismatch");
        const nonceBound = manifest.operatorCapabilityHash === createHash("sha256").update(child.operatorCapability).digest("hex");
        const retainedHeadlessBound = manifest.execution === "rpc-headless" && manifest.operatorCapabilityHash === undefined
          && typeof child.launcherToken === "string" && child.launcherToken === manifest.processToken && child.launcherPid === manifest.processPid
          && typeof group.ownerToken === "string" && group.ownerToken === manifest.foregroundOwner?.token;
        if (!nonceBound && !retainedHeadlessBound) throw new Error("Read-only job ancestry nonce mismatch");
        const identity = JSON.stringify([session, group.id, child.taskId, child.childId, child.attempt, manifest.runtimeId, manifest.workerEpoch, createHash("sha256").update(manifest.controlToken).digest("hex"), manifest.operatorCapabilityHash, manifest.execution === "rpc-headless" ? [child.launcherToken, child.launcherPid, group.ownerToken] : null]);
        if (identities.has(identity)) throw new Error("Duplicate read-only job ancestry identity");
        identities.add(identity); hash.update(identity);
        owners.push({ sessionId: session, childId: child.childId });
        let fd: number;
        try { fd = openSync(manifest.sessionFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && !child.started) continue; throw error; }
        let descendant: string;
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe descendant session header");
          const bytes = Buffer.alloc(Math.min(8192, budget.remaining + 1)), n = readSync(fd, bytes, 0, bytes.length, 0), newline = bytes.indexOf(10, 0);
          consume(budget, n);
          if (newline < 0 || newline >= n) throw new Error("Missing bounded descendant session header");
          const header = JSON.parse(bytes.subarray(0, newline).toString("utf8"));
          if (header.type !== "session" || typeof header.id !== "string" || !header.id || Buffer.byteLength(header.id) > 512) throw new Error("Invalid descendant session header");
          descendant = header.id;
        } finally { closeSync(fd); }
        hash.update(descendant);
        // Resumed attempts legitimately retain a session ID. Already-authorized
        // sessions (including cycles) add no authority and must not be traversed twice.
        if (seen.has(descendant)) continue;
        seen.add(descendant); queue.push(descendant); owners.push({ sessionId: descendant });
        } catch (error) {
          if (error instanceof AncestryCapacityError) throw error;
          // A stale/unverifiable worker never authorizes its branch. Keep other
          // proven branches and direct jobs available, with an explicit notice.
          unavailable = true;
          hash.update(JSON.stringify(["unavailable", group.id, child?.taskId, child?.attempt]));
        }
      }
    }
  }
  return { owners, fingerprint: hash.digest("hex"), ...(unavailable ? { unavailable: true } : {}) };
}
export function ownsJob(owners: JobOwner[], metadata: { sessionId?: string; childId?: string; infrastructure?: boolean }): boolean {
  return !metadata.infrastructure && owners.some(owner => owner.sessionId === metadata.sessionId && owner.childId === metadata.childId);
}
