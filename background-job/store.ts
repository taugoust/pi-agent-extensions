import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { processStartToken } from "./tmux.ts";
import { validatePaneIdentity } from "./external-pane.ts";
import {
  access,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { constants as osConstants, hostname } from "node:os";
import {
  JOB_ID_PATTERN,
  JOB_SCHEMA_VERSION,
  type JobLaunch,
  type JobMetadata,
  type JobProcess,
  type JobResult,
} from "./types.ts";

const MAX_JSON_BYTES = 128 * 1024;
const LOCK_WAIT_MS = 5_000;
const LOCK_EMPTY_STALE_MS = 30_000;
const LOCK_OWNER_PATTERN = /^owner-[a-f0-9]{32}$/;
const LOCK_RETIRED_PATTERN = /^\.lock-retired-[a-f0-9]{32}$/;

function isLockContention(error: unknown): boolean {
  const failure = error as NodeJS.ErrnoException;
  const staleErrno = osConstants.errno.ESTALE;
  return (
    ["EEXIST", "ENOTEMPTY", "ENOENT", "ESTALE"].includes(failure.code ?? "") ||
    (typeof staleErrno === "number" &&
      (failure.errno === -staleErrno || failure.errno === staleErrno))
  );
}

type LockOwner = {
  hostname: string;
  machineId: string;
  bootId: string;
  pidNamespace: string;
  pid: number;
  startToken: string;
  token: string;
  createdAt: number;
};

async function readMachineId(): Promise<string> {
  for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    const value = await readFile(path, "utf8").catch(() => "");
    if (value.trim()) return value.trim();
  }
  return "";
}

const REMOVE_RETRIES = 5;
const REMOVE_RETRY_MS = 20;
const REMOVAL_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const TOMBSTONE = /^(job-[0-9a-f]{24})\.removing-[0-9]+(?:-[a-f0-9]{16})?$/;

type ReaderGate = {
  count: number;
  waiting: number;
  removals: number;
  closing: boolean;
  idle?: () => void;
  waitingIdle?: () => void;
  open: (() => void)[];
  removeTail: Promise<void>;
};

const activeReaders = new Map<string, ReaderGate>();

type RemovalVerification = {
  metadata: JobMetadata;
  launch?: JobLaunch;
  result?: JobResult;
};

/** True for a `<id>.removing-<pid>[-<nonce>]` directory left by an interrupted removal. */
function isTombstoneOf(id: string, name: string): boolean {
  return TOMBSTONE.exec(name)?.[1] === id;
}

function matchesRemovalVerification(
  intent: RemovalVerification,
  verification: RemovalVerification,
): boolean {
  return (
    JSON.stringify(intent.metadata) === JSON.stringify(verification.metadata) &&
    JSON.stringify(intent.launch) === JSON.stringify(verification.launch) &&
    JSON.stringify(intent.result) === JSON.stringify(verification.result)
  );
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`unknown field ${JSON.stringify(key)}`);
  }
  for (const key of required) {
    if (!(key in value)) throw new Error(`missing field ${JSON.stringify(key)}`);
  }
}

function string(value: unknown, label: string, maximum: number, empty = false): string {
  if (typeof value !== "string" || (!empty && value.length === 0)) {
    throw new Error(`${label} must be ${empty ? "a" : "a non-empty"} string`);
  }
  if (Buffer.byteLength(value, "utf8") > maximum) throw new Error(`${label} is oversized`);
  return value;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} must be an integer >= ${minimum}`);
  }
  return value as number;
}

function iso(value: unknown, label: string): string {
  const text = string(value, label, 64);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label} is not an ISO timestamp`);
  return text;
}

export function parseMetadata(value: unknown): JobMetadata {
  const data = object(value, "job metadata");
  exactKeys(
    data,
    ["schemaVersion", "id", "command", "cwd", "shell", "createdAt", "ownerPid"],
    [
      "name",
      "sessionId",
      "childId",
      "observed",
      "infrastructure",
      "verification",
      "pane",
      "ownerToken",
    ],
  );
  if (data.schemaVersion !== JOB_SCHEMA_VERSION) throw new Error("unsupported job metadata schema");
  if (data.verification !== undefined && data.verification !== true)
    throw new Error("invalid verification job marker");
  const id = string(data.id, "job id", 64);
  if (!JOB_ID_PATTERN.test(id)) throw new Error("invalid job id");
  return {
    schemaVersion: JOB_SCHEMA_VERSION,
    id,
    ...(data.name === undefined ? {} : { name: string(data.name, "job name", 80) }),
    command: string(data.command, "job command", 32 * 1024),
    cwd: string(data.cwd, "job cwd", 4096),
    shell: string(data.shell, "job shell", 4096),
    createdAt: iso(data.createdAt, "job creation time"),
    ownerPid: integer(data.ownerPid, "owner pid", 1),
    ...(data.ownerToken === undefined
      ? {}
      : { ownerToken: string(data.ownerToken, "owner token", 256) }),
    ...(data.pane === undefined ? {} : { pane: validatePaneIdentity(data.pane) }),
    ...(data.sessionId === undefined
      ? {}
      : { sessionId: string(data.sessionId, "session id", 512) }),
    ...(data.childId === undefined ? {} : { childId: string(data.childId, "child id", 128) }),
    ...(data.observed === undefined ? {} : { observed: parseObserved(data.observed) }),
    ...(data.infrastructure === true ? { infrastructure: true } : {}),
    ...(data.verification === true ? { verification: true as const } : {}),
  };
}

function parseObserved(value: unknown): NonNullable<JobMetadata["observed"]> {
  const data = object(value, "observed job");
  exactKeys(data, ["pid", "startToken", "logPath", "logDevice", "logInode"]);
  return {
    pid: integer(data.pid, "pid", 1),
    startToken: string(data.startToken, "start token", 256),
    logPath: string(data.logPath, "log path", 4096),
    logDevice: integer(data.logDevice, "log device"),
    logInode: integer(data.logInode, "log inode"),
  };
}

export function parseLaunch(value: unknown): JobLaunch {
  const data = object(value, "job launch");
  exactKeys(
    data,
    ["schemaVersion", "windowId", "paneId", "panePid", "paneStartToken", "launchedAt"],
    ["socketPath", "sessionId", "serverPid", "serverStartToken", "ownershipToken"],
  );
  if (
    data.socketPath === undefined &&
    ["sessionId", "serverPid", "serverStartToken", "ownershipToken"].some(
      (key) => data[key] !== undefined,
    )
  )
    throw new Error("Incomplete saved tmux placement");
  const placement =
    data.socketPath === undefined
      ? {}
      : {
          socketPath: string(data.socketPath, "socket path", 4096),
          sessionId: string(data.sessionId, "tmux session id", 64),
          serverPid: integer(data.serverPid, "tmux server pid", 1),
          serverStartToken: string(data.serverStartToken, "server start token", 256),
          ownershipToken: string(data.ownershipToken, "ownership token", 64),
        };
  if (
    data.socketPath !== undefined &&
    (!String(data.socketPath).startsWith("/") ||
      String(data.socketPath).includes("\0") ||
      !/^\$[0-9]+$/.test(String(data.sessionId)) ||
      !/^[a-f0-9]{32}$/.test(String(data.ownershipToken)))
  )
    throw new Error("Invalid saved tmux placement");
  if (data.schemaVersion !== JOB_SCHEMA_VERSION) throw new Error("unsupported job launch schema");
  const windowId = string(data.windowId, "window id", 64);
  const paneId = string(data.paneId, "pane id", 64);
  if (!/^@[0-9]+$/.test(windowId) || !/^%[0-9]+$/.test(paneId))
    throw new Error("invalid tmux identity");
  return {
    schemaVersion: JOB_SCHEMA_VERSION,
    ...placement,
    windowId,
    paneId,
    panePid: integer(data.panePid, "pane pid", 1),
    paneStartToken: string(data.paneStartToken, "pane start token", 256),
    launchedAt: iso(data.launchedAt, "launch time"),
  };
}

export function parseProcess(value: unknown): JobProcess {
  const data = object(value, "job process");
  exactKeys(data, ["schemaVersion", "pid", "startToken", "startedAt"]);
  if (data.schemaVersion !== JOB_SCHEMA_VERSION) throw new Error("unsupported job process schema");
  return {
    schemaVersion: JOB_SCHEMA_VERSION,
    pid: integer(data.pid, "process pid", 1),
    startToken: string(data.startToken, "process start token", 256),
    startedAt: iso(data.startedAt, "process start time"),
  };
}

export function parseResult(value: unknown): JobResult {
  const data = object(value, "job result");
  exactKeys(
    data,
    ["schemaVersion", "status", "exitCode", "finishedAt"],
    ["signal", "reason", "output"],
  );
  if (data.schemaVersion !== JOB_SCHEMA_VERSION) throw new Error("unsupported job result schema");
  if (!["completed", "failed", "cancelled", "lost"].includes(String(data.status))) {
    throw new Error("invalid job result status");
  }
  if (data.exitCode !== null) integer(data.exitCode, "exit code", 0);
  return {
    schemaVersion: JOB_SCHEMA_VERSION,
    status: data.status as JobResult["status"],
    exitCode: data.exitCode as number | null,
    finishedAt: iso(data.finishedAt, "finish time"),
    ...(data.signal === undefined ? {} : { signal: string(data.signal, "signal", 32) }),
    ...(data.reason === undefined ? {} : { reason: string(data.reason, "reason", 1024, true) }),
    ...(data.output === undefined ? {} : { output: parseOutputTiming(data.output) }),
  };
}

function parseOutputTiming(value: unknown): NonNullable<JobResult["output"]> {
  const data = object(value, "job output timing");
  exactKeys(data, ["bytes", "finalSecondBytes", "durationMs"], []);
  return {
    bytes: integer(data.bytes, "output bytes", 0),
    finalSecondBytes: integer(data.finalSecondBytes, "final-second output bytes", 0),
    durationMs: integer(data.durationMs, "job duration", 0),
  };
}

async function readJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.mode & 0o077 || (process.getuid && info.uid !== process.getuid()))
      throw new Error(`${path} is not a private regular file`);
    if (info.size > MAX_JSON_BYTES) throw new Error(`${path} is oversized`);
    const bytes = Buffer.alloc(MAX_JSON_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_JSON_BYTES) throw new Error(`${path} is oversized`);
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")) as unknown;
  } finally {
    await file.close();
  }
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

export class JobStore {
  readonly runtimeRoot: string;

  constructor(
    readonly root: string,
    runtimeRoot?: string,
  ) {
    this.runtimeRoot = runtimeRoot ?? join(root, "runtime");
  }

  get jobsRoot(): string {
    return join(this.root, "jobs");
  }
  get socketPath(): string {
    return join(this.runtimeRoot, "tmux.sock");
  }
  get tmuxConfigPath(): string {
    return join(this.runtimeRoot, "tmux.conf");
  }

  jobDir(id: string): string {
    if (!JOB_ID_PATTERN.test(id)) throw new Error(`Invalid background job ID: ${id}`);
    return join(this.jobsRoot, id);
  }

  path(
    id: string,
    name:
      | "metadata.json"
      | "launch.json"
      | "process.json"
      | "result.json"
      | "result.lock"
      | "command"
      | "environment"
      | "output.log"
      | "output-position.json"
      | "stdout.log"
      | "stderr.log"
      | "notified"
      | "retrieved-at",
  ): string {
    return join(this.jobDir(id), name);
  }

  async initialize(): Promise<void> {
    await mkdir(this.jobsRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.runtimeRoot, { recursive: true, mode: 0o700 });
    await writeFile(
      this.tmuxConfigPath,
      "set-option -g @pi_background_server v1\nset-option -g remain-on-exit on\nset-option -g remain-on-exit-format ''\nset-option -g history-limit 2000\nset-option -g status off\n",
      { mode: 0o600 },
    );
    await Promise.all([
      this.assertPrivateDirectory(this.root),
      this.assertPrivateDirectory(this.jobsRoot),
      this.assertPrivateDirectory(this.runtimeRoot),
    ]);
    await this.cleanupPendingRemovals();
    await this.cleanupLegacyRemovals();
  }

  private async assertPrivateDirectory(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${path} is not a directory`);
    if (process.getuid && info.uid !== process.getuid())
      throw new Error(`${path} is owned by another user`);
    if ((info.mode & 0o077) !== 0)
      throw new Error(`${path} must not be accessible by group or other users`);
  }

  async create(metadata: JobMetadata, command: string, environment: Buffer): Promise<void> {
    const dir = this.jobDir(metadata.id);
    await mkdir(dir, { mode: 0o700 });
    try {
      await writeFile(this.path(metadata.id, "command"), command, { mode: 0o600, flag: "wx" });
      await writeFile(this.path(metadata.id, "environment"), environment, {
        mode: 0o600,
        flag: "wx",
      });
      await writeAtomic(this.path(metadata.id, "metadata.json"), metadata);
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }

  async writeLaunch(id: string, launch: JobLaunch): Promise<void> {
    await writeAtomic(this.path(id, "launch.json"), launch);
  }

  async readMetadata(id: string): Promise<JobMetadata> {
    return parseMetadata(await readJson(this.path(id, "metadata.json")));
  }

  async readLaunch(id: string): Promise<JobLaunch | undefined> {
    try {
      return parseLaunch(await readJson(this.path(id, "launch.json")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async readProcess(id: string): Promise<JobProcess | undefined> {
    try {
      return parseProcess(await readJson(this.path(id, "process.json")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async readResult(id: string): Promise<JobResult | undefined> {
    try {
      return parseResult(await readJson(this.path(id, "result.json")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async publishResult(id: string, result: JobResult): Promise<boolean> {
    const target = this.path(id, "result.json");
    const temporary = `${target}.candidate-${process.pid}-${Math.random().toString(16).slice(2)}`;
    await writeFile(temporary, `${JSON.stringify(result)}\n`, { mode: 0o600, flag: "wx" });
    try {
      await link(temporary, target);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async readRetrieved(id: string): Promise<number | undefined> {
    try {
      const raw = await readFile(this.path(id, "retrieved-at"), "utf8");
      const value = Number(raw.trim());
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid retrieval timestamp");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /** Caller must hold withRetentionLock from snapshot through this write. */
  async markRetrieved(id: string, at = Date.now()): Promise<void> {
    await writeAtomic(this.path(id, "retrieved-at"), at);
  }

  /** Cross-process exclusion for snapshots, expiry and session preservation.
   * Publish a nonempty lock directory atomically. Never steal a live owner's
   * lock based on age (a paused process may still be inside its critical section).
   */
  async withRetentionLock<T>(operation: () => Promise<T>): Promise<T> {
    const lock = join(this.root, ".retention-lock");
    const ownerFile = `owner-${process.pid}-${randomBytes(16).toString("hex")}`;
    const candidate = `${lock}.${ownerFile}`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    await mkdir(candidate, { mode: 0o700 });
    try {
      await writeFile(join(candidate, ownerFile), await processStartToken(process.pid), {
        mode: 0o600,
        flag: "wx",
      });
      for (;;) {
        try {
          await rename(candidate, lock);
          break;
        } catch (error) {
          if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
            throw error;
          await this.releaseDeadRetentionOwner(lock);
          if (Date.now() >= deadline)
            throw new Error("Timed out acquiring background-job retention lock");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      try {
        return await operation();
      } finally {
        // Remove only our unique owner file. Concurrent dead-owner recovery
        // cannot remove a successor: its atomically published dir is nonempty.
        await rm(join(lock, ownerFile), { force: true });
        await rmdir(lock).catch(() => undefined);
      }
    } finally {
      await rm(candidate, { recursive: true, force: true });
    }
  }

  private async releaseDeadRetentionOwner(lock: string): Promise<void> {
    try {
      const owners = await readdir(lock);
      if (owners.length !== 1) return;
      const match = /^owner-([0-9]+)-[a-f0-9]{32}$/.exec(owners[0]);
      if (!match) return;
      const pid = Number(match[1]);
      const savedToken = await readFile(join(lock, owners[0]), "utf8");
      let dead = false;
      try {
        dead = (await processStartToken(pid)) !== savedToken;
      } catch {
        try {
          process.kill(pid, 0);
        } catch (error) {
          dead = (error as NodeJS.ErrnoException).code === "ESRCH";
        }
      }
      if (!dead) return;
      await rm(join(lock, owners[0]), { force: true });
      await rmdir(lock).catch(() => undefined);
    } catch {
      /* Unknown ownership retains the lock; callers time out safely. */
    }
  }

  async isNotified(id: string): Promise<boolean> {
    return await this.exists(this.path(id, "notified"));
  }

  async markNotified(id: string): Promise<boolean> {
    try {
      const handle = await open(this.path(id, "notified"), "wx", 0o600);
      await handle.close();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }

  async listIds(): Promise<string[]> {
    await this.initialize();
    const entries = await readdir(this.jobsRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && JOB_ID_PATTERN.test(entry.name))
      .map((entry) => entry.name);
  }

  /** Enumerate already-initialized retained jobs without creating/changing state. */
  async listIdsReadOnly(): Promise<string[]> {
    const entries = await readdir(this.jobsRoot, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isDirectory() && !entry.isSymbolicLink() && JOB_ID_PATTERN.test(entry.name),
      )
      .map((entry) => entry.name);
  }

  private readerGate(id: string): ReaderGate {
    const key = this.path(id, "metadata.json");
    let gate = activeReaders.get(key);
    if (!gate) {
      gate = {
        count: 0,
        waiting: 0,
        removals: 0,
        closing: false,
        open: [],
        removeTail: Promise.resolve(),
      };
      activeReaders.set(key, gate);
    }
    return gate;
  }

  async withReader<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const gate = this.readerGate(id);
    while (gate.closing) {
      gate.waiting++;
      try {
        await new Promise<void>((resolve) => gate.open.push(resolve));
      } finally {
        gate.waiting--;
        if (gate.waiting === 0) gate.waitingIdle?.();
      }
    }
    gate.count++;
    try {
      return await operation();
    } finally {
      gate.count--;
      if (gate.count === 0) {
        gate.idle?.();
        if (!gate.closing && gate.waiting === 0 && gate.removals === 0)
          activeReaders.delete(this.path(id, "metadata.json"));
      }
    }
  }

  private async withRemovalGate<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const gate = this.readerGate(id);
    let release!: () => void;
    const previous = gate.removeTail;
    gate.removals++;
    gate.removeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    gate.closing = true;
    try {
      if (gate.count > 0) {
        await new Promise<void>((resolve) => {
          gate.idle = resolve;
        });
      }
      return await operation();
    } finally {
      gate.closing = false;
      gate.removals--;
      const hadWaitingReaders = gate.waiting > 0;
      for (const open of gate.open.splice(0)) open();
      if (hadWaitingReaders) {
        await new Promise<void>((resolve) => {
          gate.waitingIdle = resolve;
        });
        if (gate.count > 0) {
          await new Promise<void>((resolve) => {
            gate.idle = resolve;
          });
        }
      }
      release();
      if (gate.count === 0 && gate.waiting === 0 && gate.removals === 0)
        activeReaders.delete(this.path(id, "metadata.json"));
    }
  }

  private removalIntentPath(id: string): string {
    this.jobDir(id);
    return join(this.jobsRoot, `.${id}.removal.json`);
  }

  private async cleanupPendingRemovals(): Promise<void> {
    const entries = await readdir(this.jobsRoot);
    for (const name of entries) {
      const match = /^\.(job-[0-9a-f]{24})\.removal\.json$/.exec(name);
      if (!match) continue;
      const id = match[1];
      let intent: Awaited<ReturnType<JobStore["readRemovalIntent"]>>;
      try {
        intent = await this.readRemovalIntent(id);
      } catch {
        continue;
      }
      if (!intent) continue;
      try {
        // If the source vanished, its rename has completed; list tombstones afterward.
        const sourceExistsBeforeListing = await this.exists(this.jobDir(id));
        const entriesAfterSourceCheck = await readdir(this.jobsRoot);
        const currentEntries = sourceExistsBeforeListing
          ? entriesAfterSourceCheck
          : await readdir(this.jobsRoot);
        const leftovers = currentEntries.filter((entry) => isTombstoneOf(id, entry));
        let complete = true;
        for (const leftover of leftovers) {
          try {
            complete = (await this.removeTree(join(this.jobsRoot, leftover))) && complete;
          } catch {
            complete = false;
          }
        }
        const sourceRemains = await this.exists(this.jobDir(id));
        const remainingEntries = sourceRemains ? [] : await readdir(this.jobsRoot);
        const tombstoneRemains = remainingEntries.some((entry) => isTombstoneOf(id, entry));
        if (complete && !sourceRemains && !tombstoneRemains) {
          const current = await this.readRemovalIntent(id);
          if (!current) continue;
          if (current.cleanedAt !== undefined) {
            if (Date.now() - current.cleanedAt >= REMOVAL_RECEIPT_TTL_MS)
              await rm(this.removalIntentPath(id), { force: true });
          } else if (current.reapVerified) {
            await writeAtomic(this.removalIntentPath(id), {
              ...current,
              cleanedAt: Date.now(),
            });
          } else {
            await rm(this.removalIntentPath(id), { force: true });
          }
        }
      } catch {
        /* Keep this intent and tombstone for a later cleanup attempt. */
      }
    }
  }

  private async cleanupLegacyRemovals(): Promise<void> {
    const entries = await readdir(this.jobsRoot, { withFileTypes: true });
    for (const entry of entries) {
      const match = TOMBSTONE.exec(entry.name);
      if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (await this.exists(this.removalIntentPath(match[1]))) continue;
      try {
        await this.removeTree(join(this.jobsRoot, entry.name));
      } catch {
        /* An inaccessible legacy tombstone must not block unrelated jobs. */
      }
    }
  }

  isRemovalReceiptExpired(intent: { cleanedAt?: number }): boolean {
    return (
      intent.cleanedAt !== undefined && Date.now() - intent.cleanedAt >= REMOVAL_RECEIPT_TTL_MS
    );
  }

  async readRemovalIntent(id: string): Promise<
    | {
        metadata: JobMetadata;
        launch?: JobLaunch;
        result?: JobResult;
        reapVerified?: true;
        cleanedAt?: number;
      }
    | undefined
  > {
    try {
      const raw = object(await readJson(this.removalIntentPath(id)), "job removal intent");
      exactKeys(raw, ["metadata"], ["launch", "result", "reapVerified", "cleanedAt"]);
      const metadata = parseMetadata(raw.metadata);
      const result = raw.result === undefined ? undefined : parseResult(raw.result);
      const launch = raw.launch === undefined ? undefined : parseLaunch(raw.launch);
      if (raw.reapVerified !== undefined && raw.reapVerified !== true)
        throw new Error("Invalid reap authorization in removal intent");
      const cleanedAt =
        raw.cleanedAt === undefined ? undefined : integer(raw.cleanedAt, "cleanup time", 1);
      if (metadata.id !== id) throw new Error("job removal intent ID mismatch");
      return {
        metadata,
        ...(launch ? { launch } : {}),
        ...(result ? { result } : {}),
        ...(raw.reapVerified === true ? { reapVerified: true as const } : {}),
        ...(cleanedAt === undefined ? {} : { cleanedAt }),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async remove(id: string, verification?: RemovalVerification): Promise<void> {
    await this.withRemovalGate(id, () => this.removeLocked(id, verification));
  }

  private async removeLocked(id: string, verification?: RemovalVerification): Promise<void> {
    const source = this.jobDir(id);
    const intentPath = this.removalIntentPath(id);
    let intent = await this.readRemovalIntent(id);
    if (intent?.cleanedAt !== undefined && !(await this.exists(source))) {
      await rm(intentPath, { force: true });
      return;
    }
    if (intent?.cleanedAt !== undefined) {
      await rm(intentPath, { force: true });
      intent = undefined;
    }
    if (intent && verification) {
      if (!matchesRemovalVerification(intent, verification)) {
        await rm(intentPath, { force: true });
        intent = undefined;
      } else if (!intent.reapVerified) {
        intent = { ...intent, reapVerified: true };
        await writeAtomic(intentPath, intent);
      }
    }
    if (!intent) {
      const metadata = await this.readMetadata(id);
      const result = await this.readResult(id);
      const launch = await this.readLaunch(id);
      if (verification && !matchesRemovalVerification({ metadata, launch, result }, verification))
        throw new Error(`Background job ${id} changed during cleanup`);
      intent = {
        metadata,
        ...(launch ? { launch } : {}),
        ...(result ? { result } : {}),
        ...(verification ? { reapVerified: true as const } : {}),
      };
      await writeAtomic(intentPath, intent);
    }

    const target = `${source}.removing-${process.pid}-${randomBytes(8).toString("hex")}`;
    if (await this.exists(source)) await rename(source, target);
    const leftovers = (await readdir(this.jobsRoot)).filter((name) => isTombstoneOf(id, name));
    for (const name of leftovers) {
      if (!(await this.removeTree(join(this.jobsRoot, name)))) return;
    }
    await rm(intentPath, { force: true });
  }

  protected async removeOnce(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }

  protected async removeTree(path: string): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.removeOnce(path);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return true;
        if (!["ENOTEMPTY", "EBUSY"].includes(code ?? "")) throw error;
        if (attempt >= REMOVE_RETRIES) return false;
        await new Promise((resolve) => setTimeout(resolve, REMOVE_RETRY_MS * (attempt + 1)));
      }
    }
  }

  async replaceMetadata(metadata: JobMetadata): Promise<void> {
    const valid = parseMetadata(metadata);
    await writeAtomic(this.path(valid.id, "metadata.json"), valid);
  }

  async withLock<T>(operation: (assertOwned: () => Promise<void>) => Promise<T>): Promise<T> {
    await this.initialize();
    await this.sweepRetiredLockOwners();
    const lock = join(this.root, ".lock");
    const owner = await this.createLockOwner();
    const ownerName = `owner-${owner.token}`;
    const ownerPath = join(lock, ownerName);
    const candidate = join(this.root, `.lock-candidate-${owner.token}`);
    const deadline = Date.now() + LOCK_WAIT_MS;
    let acquired = false;
    try {
      await mkdir(candidate, { mode: 0o700 });
      await writeFile(join(candidate, ownerName), `${JSON.stringify(owner)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      while (!acquired) {
        try {
          acquired = await this.publishLockCandidate(lock, candidate);
          if (!acquired && (await this.hasLockOwner(ownerPath, owner))) acquired = true;
        } catch (error) {
          if (!isLockContention(error)) throw error;
        }
        if (acquired) continue;
        await this.releaseDeadLockOwner(lock);
        if (Date.now() >= deadline) throw await this.lockTimeoutError(lock);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const assertOwned = async () => {
        if (!(await this.hasLockOwner(ownerPath, owner))) {
          throw new Error("Background-job state lock ownership lost");
        }
      };
      await assertOwned();
      try {
        const result = await operation(assertOwned);
        await assertOwned();
        return result;
      } catch (error) {
        await assertOwned();
        throw error;
      }
    } finally {
      try {
        if (acquired) {
          if (!(await this.hasLockOwner(ownerPath, owner))) {
            throw new Error("Background-job state lock ownership lost");
          }
          if (!(await this.retireLockOwner(lock, ownerName))) {
            throw new Error("Background-job state lock ownership lost");
          }
        }
      } finally {
        await rm(candidate, { recursive: true, force: true });
      }
    }
  }

  private async createLockOwner(): Promise<LockOwner> {
    const token = randomBytes(16).toString("hex");
    const [machineId, bootId, pidNamespace, startToken] = await Promise.all([
      readMachineId(),
      readFile("/proc/sys/kernel/random/boot_id", "utf8").catch(() => ""),
      readlink("/proc/self/ns/pid").catch(() => ""),
      processStartToken(process.pid),
    ]);
    return {
      hostname: hostname(),
      machineId,
      bootId: bootId.trim(),
      pidNamespace,
      pid: process.pid,
      startToken,
      token,
      createdAt: Date.now(),
    };
  }

  private async lockTimeoutError(lock: string): Promise<Error> {
    let host = "unknown";
    let pid = "unknown";
    let age = "unknown";
    let legacyToken: string | undefined;
    try {
      const names = await readdir(lock);
      if (names.length === 1 && names[0] === "owner") {
        const value = await readFile(join(lock, "owner"), "utf8");
        legacyToken = value.trim().slice(0, 256);
        const match = /^([0-9]+)-([0-9]+)-/.exec(value);
        if (match) {
          pid = match[1];
          age = `${Math.max(0, Date.now() - Number(match[2]))}ms`;
        }
      } else if (names.length === 1 && LOCK_OWNER_PATTERN.test(names[0])) {
        const owner = JSON.parse(await readFile(join(lock, names[0]), "utf8")) as LockOwner;
        host = typeof owner.hostname === "string" ? owner.hostname : host;
        pid = Number.isSafeInteger(owner.pid) ? String(owner.pid) : pid;
        age = Number.isSafeInteger(owner.createdAt)
          ? `${Math.max(0, Date.now() - owner.createdAt)}ms`
          : age;
      }
    } catch {}
    const action = legacyToken
      ? `; legacy token=${JSON.stringify(legacyToken)} host=unknown; ` +
        "verify the old owner is not running before manually clearing this lock"
      : "";
    return new Error(
      `Timed out acquiring the background-job state lock at ${lock}; ` +
        `blocking owner host=${host} pid=${pid} age=${age}${action}`,
    );
  }

  private async publishLockCandidate(lock: string, candidate: string): Promise<boolean> {
    let before;
    try {
      before = await lstat(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (isLockContention(error)) return false;
        throw error;
      }
      try {
        await rename(candidate, lock);
        return true;
      } catch (publishError) {
        if (["EEXIST", "ENOTEMPTY"].includes((publishError as NodeJS.ErrnoException).code ?? ""))
          return false;
        throw publishError;
      }
    }
    if (!before.isDirectory() || (await readdir(lock)).length !== 0) return false;
    if (Date.now() - before.mtimeMs < LOCK_EMPTY_STALE_MS) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
    let after;
    try {
      after = await lstat(lock);
    } catch {
      return false;
    }
    if (
      !after.isDirectory() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      Date.now() - after.mtimeMs < LOCK_EMPTY_STALE_MS ||
      (await readdir(lock)).length !== 0
    )
      return false;
    try {
      await rename(candidate, lock);
      return true;
    } catch (error) {
      if (["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
        return false;
      throw error;
    }
  }

  private async retireLockOwner(lock: string, ownerName: string): Promise<boolean> {
    const retired = join(this.root, `.lock-retired-${ownerName.slice("owner-".length)}`);
    try {
      // Move open readers out of .lock before NFS can leave a .nfs entry there.
      // Only this generation's unique filename moves, never a successor's directory.
      await rename(join(lock, ownerName), retired);
    } catch (error) {
      if (isLockContention(error)) return false;
      throw error;
    }
    await this.removeLockDirectory(lock);
    await this.removeRetiredLockOwner(retired, Date.now() + 1_000);
    return true;
  }

  private async removeRetiredLockOwner(path: string, deadline: number): Promise<void> {
    for (;;) {
      try {
        await rm(path, { force: true });
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EBUSY" && !isLockContention(error)) return;
        if (Date.now() >= deadline) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  private async sweepRetiredLockOwners(): Promise<void> {
    const deadline = Date.now() + 1_000;
    const names = await readdir(this.root).catch(() => []);
    const retired = names.filter((name) => LOCK_RETIRED_PATTERN.test(name)).slice(0, 32);
    for (const name of retired) {
      if (Date.now() >= deadline) return;
      await this.removeRetiredLockOwner(join(this.root, name), deadline);
    }
  }

  private async removeLockDirectory(lock: string): Promise<void> {
    const deadline = Date.now() + 1_000;
    for (;;) {
      try {
        await rmdir(lock);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return;
        if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "EBUSY") return;
        if (Date.now() >= deadline) return;
        let entries: string[];
        try {
          entries = await readdir(lock);
        } catch {
          return;
        }
        if (entries.some((name) => !/^\.nfs[0-9a-f]+$/i.test(name))) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  private async hasLockOwner(path: string, owner: LockOwner): Promise<boolean> {
    try {
      return (await readFile(path, "utf8")) === `${JSON.stringify(owner)}\n`;
    } catch {
      return false;
    }
  }

  private async releaseDeadLockOwner(lock: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(lock);
    } catch {
      return;
    }
    if (names.length !== 1 || !LOCK_OWNER_PATTERN.test(names[0])) return;
    const ownerPath = join(lock, names[0]);
    let owner: LockOwner;
    let contents: string;
    try {
      contents = await readFile(ownerPath, "utf8");
      owner = JSON.parse(contents) as LockOwner;
    } catch {
      return;
    }
    if (
      !owner ||
      typeof owner.hostname !== "string" ||
      !owner.hostname.trim() ||
      typeof owner.machineId !== "string" ||
      !owner.machineId.trim() ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid < 1 ||
      typeof owner.token !== "string" ||
      owner.token !== names[0].slice("owner-".length) ||
      typeof owner.startToken !== "string" ||
      !owner.startToken ||
      typeof owner.bootId !== "string" ||
      !owner.bootId.trim() ||
      typeof owner.pidNamespace !== "string" ||
      !owner.pidNamespace.trim() ||
      !Number.isSafeInteger(owner.createdAt)
    )
      return;
    const machineId = await readMachineId();
    if (!machineId || owner.machineId !== machineId) return;
    const bootId = await readFile("/proc/sys/kernel/random/boot_id", "utf8").catch(() => "");
    if (!bootId.trim()) return;
    let dead = owner.bootId !== bootId.trim();
    if (!dead) {
      if (owner.hostname !== hostname()) return;
      const pidNamespace = await readlink("/proc/self/ns/pid").catch(() => "");
      if (!pidNamespace || owner.pidNamespace !== pidNamespace) return;
      try {
        dead = (await processStartToken(owner.pid)) !== owner.startToken;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ESRCH") {
          try {
            process.kill(owner.pid, 0);
          } catch (probeError) {
            dead = (probeError as NodeJS.ErrnoException).code === "ESRCH";
          }
        }
      }
    }
    if (!dead || (await readFile(ownerPath, "utf8").catch(() => "")) !== contents) return;
    await this.retireLockOwner(lock, names[0]);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}
