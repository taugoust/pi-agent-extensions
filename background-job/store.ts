import { constants } from "node:fs";
import { validatePaneIdentity } from './external-pane.js';
import {
  access,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  JOB_ID_PATTERN,
  JOB_SCHEMA_VERSION,
  type JobLaunch,
  type JobMetadata,
  type JobProcess,
  type JobResult,
} from "./types.js";

const MAX_JSON_BYTES = 128 * 1024;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

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
  exactKeys(data, ["schemaVersion", "id", "command", "cwd", "shell", "createdAt", "ownerPid"], ["name", "sessionId", "childId", "observed", "infrastructure", "pane", "ownerToken"]);
  if (data.schemaVersion !== JOB_SCHEMA_VERSION) throw new Error("unsupported job metadata schema");
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
    ...(data.ownerToken === undefined ? {} : {ownerToken:string(data.ownerToken,'owner token',256)}),
    ...(data.pane === undefined ? {} : {pane:validatePaneIdentity(data.pane)}),
    ...(data.sessionId === undefined ? {} : { sessionId: string(data.sessionId, "session id", 512) }),
    ...(data.childId === undefined ? {} : { childId: string(data.childId, "child id", 128) }),
    ...(data.observed === undefined ? {} : { observed: parseObserved(data.observed) }),
    ...(data.infrastructure === true ? { infrastructure: true } : {}),
  };
}

function parseObserved(value: unknown): NonNullable<JobMetadata["observed"]> {
  const data = object(value, "observed job");
  exactKeys(data, ["pid", "startToken", "logPath", "logDevice", "logInode"]);
  return { pid: integer(data.pid, "pid", 1), startToken: string(data.startToken, "start token", 256),
    logPath: string(data.logPath, "log path", 4096), logDevice: integer(data.logDevice, "log device"), logInode: integer(data.logInode, "log inode") };
}

export function parseLaunch(value: unknown): JobLaunch {
  const data = object(value, "job launch");
  exactKeys(data, ["schemaVersion", "windowId", "paneId", "panePid", "paneStartToken", "launchedAt"]);
  if (data.schemaVersion !== JOB_SCHEMA_VERSION) throw new Error("unsupported job launch schema");
  const windowId = string(data.windowId, "window id", 64);
  const paneId = string(data.paneId, "pane id", 64);
  if (!/^@[0-9]+$/.test(windowId) || !/^%[0-9]+$/.test(paneId)) throw new Error("invalid tmux identity");
  return {
    schemaVersion: JOB_SCHEMA_VERSION,
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
  exactKeys(data, ["schemaVersion", "status", "exitCode", "finishedAt"], ["signal", "reason"]);
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
  };
}

async function readJson(path: string): Promise<unknown> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${path} is not a regular file`);
  if (info.size > MAX_JSON_BYTES) throw new Error(`${path} is oversized`);
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as unknown;
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

export class JobStore {
  readonly runtimeRoot: string;

  constructor(readonly root: string, runtimeRoot?: string) {
    this.runtimeRoot = runtimeRoot ?? join(root, "runtime");
  }

  get jobsRoot(): string { return join(this.root, "jobs"); }
  get socketPath(): string { return join(this.runtimeRoot, "tmux.sock"); }
  get tmuxConfigPath(): string { return join(this.runtimeRoot, "tmux.conf"); }

  jobDir(id: string): string {
    if (!JOB_ID_PATTERN.test(id)) throw new Error(`Invalid background job ID: ${id}`);
    return join(this.jobsRoot, id);
  }

  path(id: string, name: "metadata.json" | "launch.json" | "process.json" | "result.json" | "result.lock" | "command" | "environment" | "output.log" | "notified"): string {
    return join(this.jobDir(id), name);
  }

  async initialize(): Promise<void> {
    await mkdir(this.jobsRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.runtimeRoot, { recursive: true, mode: 0o700 });
    await writeFile(this.tmuxConfigPath, "set-option -g @pi_background_server v1\nset-option -g remain-on-exit on\nset-option -g remain-on-exit-format ''\nset-option -g history-limit 2000\nset-option -g status off\n", { mode: 0o600 });
    await Promise.all([this.assertPrivateDirectory(this.root), this.assertPrivateDirectory(this.jobsRoot), this.assertPrivateDirectory(this.runtimeRoot)]);
  }

  private async assertPrivateDirectory(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${path} is not a directory`);
    if (process.getuid && info.uid !== process.getuid()) throw new Error(`${path} is owned by another user`);
    if ((info.mode & 0o077) !== 0) throw new Error(`${path} must not be accessible by group or other users`);
  }

  async create(metadata: JobMetadata, command: string, environment: Buffer): Promise<void> {
    const dir = this.jobDir(metadata.id);
    await mkdir(dir, { mode: 0o700 });
    try {
      await writeFile(this.path(metadata.id, "command"), command, { mode: 0o600, flag: "wx" });
      await writeFile(this.path(metadata.id, "environment"), environment, { mode: 0o600, flag: "wx" });
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
    try { return parseLaunch(await readJson(this.path(id, "launch.json"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  async readProcess(id: string): Promise<JobProcess | undefined> {
    try { return parseProcess(await readJson(this.path(id, "process.json"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  async readResult(id: string): Promise<JobResult | undefined> {
    try { return parseResult(await readJson(this.path(id, "result.json"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
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
    return entries.filter((entry) => entry.isDirectory() && JOB_ID_PATTERN.test(entry.name)).map((entry) => entry.name);
  }

  async remove(id: string): Promise<void> {
    const source = this.jobDir(id);
    const target = `${source}.removing-${process.pid}`;
    await rename(source, target);
    await rm(target, { recursive: true, force: true });
  }

  async replaceMetadata(metadata: JobMetadata): Promise<void> {
    const valid = parseMetadata(metadata);
    await writeAtomic(this.path(valid.id, 'metadata.json'), valid);
  }

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.initialize();
    const lock = join(this.root, ".lock");
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        await mkdir(lock, { mode: 0o700 });
        await writeFile(join(lock, "owner"), token, { mode: 0o600, flag: "wx" });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const info = await stat(lock);
          if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
            const stale = `${lock}.stale-${token}`;
            await rename(lock, stale);
            await rm(stale, { recursive: true, force: true });
            continue;
          }
        } catch {}
        if (Date.now() >= deadline) throw new Error("Timed out acquiring the background-job state lock");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    const heartbeat = setInterval(() => {
      const now = new Date();
      void import("node:fs/promises").then(({ utimes }) => utimes(lock, now, now)).catch(() => undefined);
    }, 5000);
    heartbeat.unref();
    try { return await operation(); }
    finally {
      clearInterval(heartbeat);
      try {
        if ((await readFile(join(lock, "owner"), "utf8")) === token) {
          const released = `${lock}.released-${token}`;
          await rename(lock, released);
          await rm(released, { recursive: true, force: true });
        }
      } catch {}
    }
  }

  async exists(path: string): Promise<boolean> {
    try { await access(path, constants.F_OK); return true; } catch { return false; }
  }
}
