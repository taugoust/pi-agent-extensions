import { createHash } from "node:crypto";
import { constants, openSync, closeSync, unlinkSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { TuiWorkerManifest } from "../shared/tui-worker-protocol.ts";
import { atomicPrivateJson, privateDirectory, readPrivateJson } from "./tui-worker-store.ts";
import { validateSubagentDisplayName, subagentTmuxAlias } from "./tui-names.ts";

type Identity = Pick<TuiWorkerManifest, "ownerSessionId" | "taskId" | "groupId" | "childId" | "attempt" | "runtimeId" | "workerEpoch">;
export type TaskNameRecord = Identity & { version: 1; revision: number; displayName: string; alias: string; source: "parent" | "pi" | "paseo"; previousName?: string };
const keys = ["ownerSessionId", "taskId", "groupId", "childId", "attempt", "runtimeId", "workerEpoch"] as const;
const identityOnly = (identity: Identity): Identity => Object.fromEntries(keys.map(key => [key, identity[key]])) as Identity;
const same = (a: Identity, b: Identity) => keys.every(key => a[key] === b[key]);

/** Stable task metadata. Only the currently claimed attempt/epoch may rename.
 * The private root lock serializes claims, revisions and alias collision allocation.
 * A crash-held lock fails closed rather than guessing that another writer died. */
export class TaskNameStore {
  readonly root: string;
  readonly path: string;
  readonly identity: Identity;
  constructor(workerDirectory: string, identity: Identity) {
    this.identity = identityOnly(identity);
    if (basename(dirname(workerDirectory)) !== "workers") throw new Error("Canonical name requires owned worker directory layout");
    this.root = join(dirname(dirname(workerDirectory)), "task-names");
    this.path = join(this.root, createHash("sha256").update(JSON.stringify([identity.ownerSessionId, identity.taskId])).digest("hex") + ".json");
  }
  private locked<T>(fn: () => T): T {
    privateDirectory(this.root, true);
    const lock = join(this.root, ".write-lock");
    const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { return fn(); } finally { closeSync(fd); unlinkSync(lock); }
  }
  read(currentAttempt = true): TaskNameRecord | undefined {
    let record: TaskNameRecord;
    try { record = readPrivateJson(this.path) as TaskNameRecord; } catch (error: any) { if (error.code === "ENOENT") return; throw error; }
    if (record.version !== 1 || record.ownerSessionId !== this.identity.ownerSessionId || record.taskId !== this.identity.taskId
      || !Number.isSafeInteger(record.revision) || record.revision < 1 || !Number.isSafeInteger(record.attempt) || record.attempt < 1
      || keys.some(key => key !== "attempt" && (typeof record[key] !== "string" || !record[key] || record[key].length > 512))
      || !["parent", "pi", "paseo"].includes(record.source) || validateSubagentDisplayName(record.displayName) !== record.displayName
      || record.previousName !== undefined && validateSubagentDisplayName(record.previousName) !== record.previousName
      || typeof record.alias !== "string" || record.alias.length > 40 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.alias)) throw new Error("Invalid canonical task name metadata");
    if (currentAttempt && !same(record, this.identity)) throw new Error("Stale canonical task name authority");
    return { ...identityOnly(record), version: 1, revision: record.revision, displayName: record.displayName,
      alias: record.alias, source: record.source, ...(record.previousName ? { previousName: record.previousName } : {}) };
  }
  private alias(name: string): string {
    const occupied: string[] = [];
    for (const file of readdirSync(this.root)) {
      if (!/^[a-f0-9]{64}\.json$/.test(file) || join(this.root, file) === this.path) continue;
      const record = readPrivateJson(join(this.root, file)) as TaskNameRecord;
      if (typeof record.alias === "string") occupied.push(record.alias);
    }
    return subagentTmuxAlias(name, occupied);
  }
  claim(name: string): TaskNameRecord {
    const displayName = validateSubagentDisplayName(name);
    if (!displayName) throw new Error("Canonical task name is required");
    return this.locked(() => {
      const prior = this.read(false);
      if (prior && !same(prior, this.identity) && this.identity.attempt <= prior.attempt) throw new Error("Cannot reclaim canonical name from newer or competing attempt");
      if (prior && same(prior, this.identity)) return prior;
      const record: TaskNameRecord = { ...this.identity, version: 1, revision: (prior?.revision ?? 0) + 1,
        displayName: prior?.displayName ?? displayName, alias: prior?.alias ?? this.alias(displayName), source: prior?.source ?? "parent" };
      atomicPrivateJson(this.path, record);
      return record;
    });
  }
  rename(name: string, expectedRevision: number, source: "pi" | "paseo"): TaskNameRecord {
    const displayName = validateSubagentDisplayName(name);
    if (!displayName) throw new Error("Canonical task name is required");
    return this.locked(() => {
      const prior = this.read();
      if (!prior || prior.revision !== expectedRevision) throw new Error("Canonical name revision conflict");
      if (prior.displayName === displayName) return prior;
      const record: TaskNameRecord = { ...prior, displayName, alias: this.alias(displayName), previousName: prior.displayName, source, revision: prior.revision + 1 };
      atomicPrivateJson(this.path, record);
      return record;
    });
  }
}
