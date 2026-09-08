import { constants, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, resolve, join, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import { parseTuiWorkerPlacement, parseTuiWorkerRequest } from "../shared/tui-worker-protocol.ts";
import type { TuiWorkerManifest, TuiWorkerEvent, TuiWorkerResponse } from "../shared/tui-worker-protocol.ts";

export type WorkerReceipt = { digest: string; response?: TuiWorkerResponse };
export type WorkerState = {
  version: 1; sequence: number; active: boolean; sealed: boolean;
  phase: "ready" | "running" | "settled" | "closing";
  receipts: Record<string, WorkerReceipt>; events: TuiWorkerEvent[];
  lastReport?: string; lastOutcome?: string; reapReservation?: string;
};
export const MAX_WORKER_STATE_BYTES = 16 * 1024 * 1024;

/** Reconnect discovery never infers child death from the parent PID. */
export function discoverTuiWorkers(root: string, ownerSessionId: string): TuiWorkerManifest[] {
  if (!ownerSessionId || Buffer.byteLength(ownerSessionId) > 512) throw new Error("Invalid owner session");
  const directory = privateDirectory(root);
  const workers: TuiWorkerManifest[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    try {
      const manifest = new TuiWorkerStore(join(directory, entry.name)).readManifest();
      if (manifest.ownerSessionId === ownerSessionId) workers.push(manifest);
    } catch { /* Untrusted or incomplete launch directories are not executable discoveries. */ }
  }
  return workers;
}

export function privateDirectory(path: string, create = false): string {
  const absolute = resolve(path);
  if (create) mkdirSync(absolute, { recursive: true, mode: 0o700 });
  // Do not traverse symlinked ancestors, including an attacker-controlled root.
  let cursor = absolute;
  for (;;) {
    const info = lstatSync(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Worker directory must not contain symlinks");
    if (cursor === absolute && ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))) {
      throw new Error("Worker directory must be private and owned by this user");
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return absolute;
}

export function readPrivateJson(path: string, maximum = MAX_WORKER_STATE_BYTES): unknown {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum || (stat.mode & 0o077) !== 0
    || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe worker state file");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return JSON.parse(readFileSync(fd, "utf8")); }
  finally { closeSync(fd); }
}

export function atomicPrivateJson(path: string, value: unknown): void {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > MAX_WORKER_STATE_BYTES) throw new Error("Worker state capacity exhausted");
  const temporary = `${path}.tmp-${randomBytes(8).toString("hex")}`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); }
  finally { closeSync(fd); }
  try {
    renameSync(temporary, path);
    const directory = openSync(dirname(path), constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { try { unlinkSync(temporary); } catch {} }
}

export function validateWorkerManifest(value: unknown): TuiWorkerManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid worker manifest");
  const m = value as TuiWorkerManifest;
  parseTuiWorkerRequest({ protocol: m.protocol, requestId: "validate", token: m.controlToken,
    ownerSessionId: m.ownerSessionId, taskId: m.taskId, runtimeId: m.runtimeId,
    groupId: m.groupId, childId: m.childId, attempt: m.attempt, workerEpoch: m.workerEpoch, operation: "status" });
  parseTuiWorkerPlacement(m.placement);
  for (const path of [m.controlSocket, m.sessionFile]) {
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) throw new Error("Invalid worker path");
  }
  if (Buffer.byteLength(m.controlSocket) > 100) throw new Error("Worker socket path is too long");
  if (m.presentation !== "foreground-staged" && m.presentation !== "background") throw new Error("Invalid presentation");
  if (m.launchMode !== undefined && m.launchMode !== "guard-only" && m.launchMode !== "none") throw new Error("Invalid launch mode");
  if (m.operatorCapabilityHash !== undefined && !/^[a-f0-9]{64}$/.test(m.operatorCapabilityHash)) throw new Error("Invalid operator capability hash");
  if ((m.panePid === undefined) !== (m.paneProcessToken === undefined)
    || (m.panePid !== undefined && (!Number.isSafeInteger(m.panePid) || m.panePid < 1))
    || (m.paneProcessToken !== undefined && (typeof m.paneProcessToken !== "string" || !/^[a-zA-Z0-9:._-]{1,256}$/.test(m.paneProcessToken)))) throw new Error("Invalid pane process identity");
  return structuredClone(m);
}

/** Single writer: the child owns state; launcher owns placement manifest only. */
export class TuiWorkerStore {
  readonly directory: string;
  constructor(directory: string, create = false) { this.directory = privateDirectory(directory, create); }
  path(name: string): string {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) throw new Error("Invalid worker filename");
    return join(this.directory, name);
  }
  private manifestPaths(m: TuiWorkerManifest): TuiWorkerManifest {
    if (m.controlSocket !== this.path("control.sock") || m.sessionFile !== this.path("session.jsonl")) throw new Error("Manifest paths must belong to the private worker directory");
    return m;
  }
  readManifest(): TuiWorkerManifest { return this.manifestPaths(validateWorkerManifest(readPrivateJson(this.path("manifest.json")))); }
  writeManifest(m: TuiWorkerManifest): void { atomicPrivateJson(this.path("manifest.json"), this.manifestPaths(validateWorkerManifest(m))); }
  readState(): WorkerState {
    let s: WorkerState;
    try { s = readPrivateJson(this.path("state.json")) as WorkerState; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { version: 1, sequence: 0, active: false, sealed: false, phase: "ready", receipts: {}, events: [] };
    }
    if (s.version !== 1 || !Number.isSafeInteger(s.sequence) || s.sequence < 0 || typeof s.active !== "boolean"
      || typeof s.sealed !== "boolean" || !Array.isArray(s.events) || s.events.length > 256
      || !s.receipts || typeof s.receipts !== "object" || Array.isArray(s.receipts)
      || Object.keys(s.receipts).length > 4096 || !["ready", "running", "settled", "closing"].includes(s.phase)) throw new Error("Invalid worker state");
    return s;
  }
  writeState(state: WorkerState): void { atomicPrivateJson(this.path("state.json"), state); }
  report(sequence: number, report: unknown): string { return this.artifact("report", sequence, report); }
  artifact(kind: "report" | "notification" | "outcome", sequence: number, report: unknown): string {
    const name = `${kind}-${sequence}-${randomBytes(8).toString("hex")}.json`;
    // Reports are independent immutable snapshots, not the bounded event ring.
    // Random suffix also retains a report orphaned by a crash before state commit.
    atomicPrivateJson(this.path(name), report);
    return this.path(name);
  }
}
