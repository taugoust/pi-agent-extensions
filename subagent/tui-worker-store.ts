import { constants, openSync, closeSync, readFileSync, readSync, writeSync, ftruncateSync, writeFileSync, fsyncSync, fstatSync, renameSync, unlinkSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
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
  /** Durable fail-closed budget: never replenished by reload, steering or repeated outcomes. */
  autoContinuation?: { used: boolean; inhibited: boolean };
  jobCleanup?: { workerEpoch: string; artifact: string };
  interactions?: Array<import("../shared/foreground-tasks.ts").TaskInteraction & { resolvedAt?: string; cancelledAt?: string; answer?: import("../shared/foreground-tasks.ts").TaskInteractionAnswer }>;
};
export const MAX_WORKER_STATE_BYTES = 16 * 1024 * 1024;
export const MAX_WORKER_TIMELINE_BYTES = 16 * 1024 * 1024;

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
  if (m.foregroundOwner !== undefined && (!Number.isSafeInteger(m.foregroundOwner.pid) || m.foregroundOwner.pid < 1
    || typeof m.foregroundOwner.token !== "string" || !/^[a-zA-Z0-9:._-]{1,256}$/.test(m.foregroundOwner.token))) throw new Error("Invalid foreground owner identity");
  if (m.execution === "rpc-headless") {
    if (m.presentation !== "headless-foreground" || m.placement !== undefined || m.panePid !== undefined || m.paneProcessToken !== undefined || !Number.isSafeInteger(m.processPid) || (m.processPid ?? 0) < 1
      || typeof m.processToken !== "string" || !/^[a-zA-Z0-9:._-]{1,256}$/.test(m.processToken)
      || m.fifoPath !== join(dirname(m.sessionFile), "stdin.fifo") || !m.foregroundOwner || m.foregroundOwner.pid === m.processPid
      || (m.runtimePid === undefined) !== (m.runtimeProcessToken === undefined)
      || m.runtimePid !== undefined && (!Number.isSafeInteger(m.runtimePid) || m.runtimePid < 1
        || typeof m.runtimeProcessToken !== "string" || !/^[a-zA-Z0-9:._-]{1,256}$/.test(m.runtimeProcessToken))
      || m.launchMode === "guard-only" && !m.operatorCapabilityHash) throw new Error("Invalid headless worker identity");
  } else {
    if (m.execution !== undefined && m.execution !== "tmux") throw new Error("Invalid execution kind");
    if (!m.placement) throw new Error("TUI worker placement is required");
    parseTuiWorkerPlacement(m.placement);
  }
  for (const path of [m.controlSocket, m.sessionFile]) {
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) throw new Error("Invalid worker path");
  }
  if (Buffer.byteLength(m.controlSocket) > 100) throw new Error("Worker socket path is too long");
  if (m.presentation !== "foreground-staged" && m.presentation !== "background" && m.presentation !== "headless-foreground") throw new Error("Invalid presentation");
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
  readState(reconcileTimeline = false): WorkerState {
    let s: WorkerState;
    try { s = readPrivateJson(this.path("state.json")) as WorkerState; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      s = { version: 1, sequence: 0, active: false, sealed: false, phase: "ready", receipts: {}, events: [] };
    }
    if (s.version !== 1 || !Number.isSafeInteger(s.sequence) || s.sequence < 0 || typeof s.active !== "boolean"
      || typeof s.sealed !== "boolean" || !Array.isArray(s.events) || s.events.length > 256
      || !s.receipts || typeof s.receipts !== "object" || Array.isArray(s.receipts)
      || Object.keys(s.receipts).length > 4096 || !["ready", "running", "settled", "closing"].includes(s.phase)) throw new Error("Invalid worker state");
    if (s.autoContinuation !== undefined && (!s.autoContinuation || typeof s.autoContinuation.used !== "boolean" || typeof s.autoContinuation.inhibited !== "boolean")) throw new Error("Invalid worker continuation state");
    if (s.interactions !== undefined && (!Array.isArray(s.interactions) || s.interactions.length > 64
      || s.interactions.some(item => !item || typeof item.id !== "string" || typeof item.workerEpoch !== "string"
        || item.workerEpoch !== this.readManifest().workerEpoch || !item.request || !["permission", "questionnaire"].includes(item.request.kind)))) throw new Error("Invalid worker interactions");
    if (reconcileTimeline) {
      const latest = this.readTimeline().at(-1)?.sequence;
      if (latest !== undefined && latest > s.sequence) s.sequence = latest;
    }
    return s;
  }
  writeState(state: WorkerState): void { atomicPrivateJson(this.path("state.json"), state); }
  appendTimeline(event: TuiWorkerEvent): void {
    const path = this.path("timeline.jsonl");
    const bytes = Buffer.from(`${JSON.stringify(event)}\n`);
    const fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())
        || stat.size + bytes.length > MAX_WORKER_TIMELINE_BYTES) throw new Error("Worker timeline capacity or ownership check failed");
      if (stat.size > 0) {
        const last = Buffer.alloc(1);
        readSync(fd, last, 0, 1, stat.size - 1);
        if (last[0] !== 10) {
          const chunkSize = 4096; let cursor = stat.size, boundary = -1;
          while (cursor > 0 && boundary < 0) {
            const start = Math.max(0, cursor - chunkSize), chunk = Buffer.alloc(cursor - start);
            readSync(fd, chunk, 0, chunk.length, start);
            const newline = chunk.lastIndexOf(10);
            if (newline >= 0) boundary = start + newline + 1;
            else cursor = start;
          }
          ftruncateSync(fd, Math.max(0, boundary));
        }
      }
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      fsyncSync(fd);
    } finally { closeSync(fd); }
  }
  readRpcLogTail(kind: "stdout" | "stderr", maximum = 512 * 1024): string {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 2 * 1024 * 1024) throw new Error("Invalid RPC log read bound");
    const fd = openSync(this.path(`rpc.${kind}.log`), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe RPC worker log");
      const length = Math.min(stat.size, maximum), buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, Math.max(0, stat.size - length));
      return buffer.toString("utf8");
    } finally { closeSync(fd); }
  }
  trimRpcLogs(maximum = 512 * 1024): void {
    if (!Number.isSafeInteger(maximum) || maximum < 1024 || maximum > 2 * 1024 * 1024) throw new Error("Invalid RPC log bound");
    for (const name of ["rpc.stdout.log", "rpc.stderr.log"]) {
      let fd: number;
      try { fd = openSync(this.path(name), constants.O_RDWR | constants.O_NOFOLLOW); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe RPC worker log");
        if (stat.size <= maximum) continue;
        const tail = Buffer.alloc(maximum);
        let read = 0;
        while (read < tail.length) { const count = readSync(fd, tail, read, tail.length - read, stat.size - maximum + read); if (!count) break; read += count; }
        ftruncateSync(fd, 0);
        let written = 0;
        while (written < read) written += writeSync(fd, tail, written, read - written, written);
        fsyncSync(fd);
      } finally { closeSync(fd); }
    }
  }
  readTimeline(): TuiWorkerEvent[] {
    const path = this.path("timeline.jsonl");
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_WORKER_TIMELINE_BYTES || (stat.mode & 0o077) !== 0
        || (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe worker timeline");
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) break; offset += count; }
      const completeEnd = bytes.subarray(0, offset).lastIndexOf(10) + 1;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, completeEnd));
      const events: TuiWorkerEvent[] = [];
      const workerEpoch = this.readManifest().workerEpoch;
      let previousSequence = 0;
      for (const line of text.split("\n")) {
        if (!line) continue;
        const event = JSON.parse(line);
        if (event?.protocol !== 1 || event.workerEpoch !== workerEpoch || !Number.isSafeInteger(event.sequence) || event.sequence <= previousSequence
          || typeof event.timestamp !== "string" || typeof event.kind !== "string") throw new Error("Invalid worker timeline event");
        previousSequence = event.sequence;
        events.push(event as TuiWorkerEvent);
      }
      return events;
    } finally { closeSync(fd); }
  }
  report(sequence: number, report: unknown): string { return this.artifact("report", sequence, report); }
  artifact(kind: "report" | "notification" | "outcome" | "job-cleanup", sequence: number, report: unknown): string {
    const name = `${kind}-${sequence}-${randomBytes(8).toString("hex")}.json`;
    // Reports are independent immutable snapshots, not the bounded event ring.
    // Random suffix also retains a report orphaned by a crash before state commit.
    atomicPrivateJson(this.path(name), report);
    return this.path(name);
  }
}
