import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SUBAGENT_CHILD_ID_PATTERN } from "./control.js";
import { validateOutcomeSummaries, type TaskOutcomeSummary } from "./outcome.js";
import {
  MAX_RETAINED_SUBAGENT_JOB_BYTES,
  MAX_RETAINED_SUBAGENT_REPORT_BYTES,
  MAX_SUBAGENT_RESULT_PAGE_BYTES,
  type RetainedSubagentReport,
} from "./result-artifact.js";

export const BACKGROUND_SUBAGENT_ID_PATTERN = /^subagent-job-[0-9a-f]{24}$/;
export const MAX_BACKGROUND_SUBAGENTS = 16;
export const MAX_BACKGROUND_SUBAGENT_WAIT_MS = 24 * 60 * 60 * 1000;
// Includes the Permission Gate's bounded pre-reload drain plus a full
// replacement-extension startup window.
export const BACKGROUND_SUBAGENT_RELOAD_ADOPTION_TIMEOUT_MS = 65_000;
export const MAX_BACKGROUND_SUBAGENT_TEXT_BYTES = 50 * 1024;
export const MAX_STATE_BYTES = 128 * 1024;
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TERMINAL_RECORDS = 100;
const SCHEMA_VERSION = 3;

export type BackgroundSubagentStatus = "running" | "cancelling" | "completed" | "failed" | "cancelled" | "lost";
export type BackgroundSubagentBackend = "native" | "agentsh";
export type BackgroundSubagentChildStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped" | "lost";

export type BackgroundSubagentChildDescriptor = {
  /** Optional only for records created before per-child identities existed. */
  childId?: string;
  taskId?: string;
  label: string;
  task?: string;
};

export type BackgroundSubagentChildProgress = Omit<BackgroundSubagentChildDescriptor, "childId"> & {
  /** Optional for update producers loaded before child identities were added. */
  childId?: string;
  child: number;
  status: BackgroundSubagentChildStatus;
};

export type BackgroundSubagentChild = BackgroundSubagentChildProgress & {
  updatedAt: string;
};

export type BackgroundSubagentArtifact = {
  child: number;
  /** Optional only for artifacts retained before per-child identities existed. */
  childId?: string;
  label: string;
  bytes: number;
  totalBytes: number;
  complete: boolean;
  sha256: string;
};

export type BackgroundSubagentRecord = {
  schemaVersion: 3;
  id: string;
  sessionId: string;
  backend: BackgroundSubagentBackend;
  mode: "single" | "parallel" | "chain";
  summary: string;
  children?: BackgroundSubagentChildDescriptor[];
  createdAt: string;
  updatedAt: string;
  ownerPid: number;
  ownerStartToken: string;
  status: BackgroundSubagentStatus;
  latest: string;
  result?: string;
  artifacts?: BackgroundSubagentArtifact[];
  taskOutcomes?: TaskOutcomeSummary[];
  error?: string;
};

export type BackgroundSubagentOutcome = {
  text: string;
  failed: boolean;
  reports?: RetainedSubagentReport[];
  taskOutcomes?: TaskOutcomeSummary[];
};

export type BackgroundSubagentResultPage = {
  child: number;
  childId?: string;
  label: string;
  offset: number;
  nextOffset?: number;
  bytes: number;
  totalBytes: number;
  sourceTotalBytes: number;
  complete: boolean;
  sha256: string;
  text: string;
};

export type BackgroundSubagentRunner = (
  signal: AbortSignal,
  update: (text: string) => void,
) => Promise<BackgroundSubagentOutcome>;

type BackgroundSessionPhase = "active" | "reloading" | "closed";

type RuntimeRegistry = {
  controllers: Map<string, AbortController>;
  flushTimers: Map<string, NodeJS.Timeout>;
  pendingLaunches: Map<string, { sessionId: string; controller: AbortController }>;
  sessions: Map<string, { phase: BackgroundSessionPhase; generation: number }>;
};

const RUNTIME_KEY = "__paeBackgroundSubagentRuntimeV3";
const NOTIFICATION_STATE_KEY = "__paeBackgroundSubagentNotificationV1";
const LEGACY_MANAGERS_KEY = "__paeBackgroundSubagentManagersV3";
const MANAGERS_KEY = "__paeBackgroundSubagentManagersV4";
const CHILD_TRACKER_KEY = "__paeBackgroundSubagentChildrenV1";
const MAX_TRACKED_CHILD_GROUPS = 256;

function runtimeRegistry(): RuntimeRegistry {
  const root = globalThis as Record<string, unknown>;
  const existing = root[RUNTIME_KEY] as Partial<RuntimeRegistry> | undefined;
  if (existing) {
    existing.controllers ??= new Map();
    existing.flushTimers ??= new Map();
    existing.pendingLaunches ??= new Map();
    existing.sessions ??= new Map();
    return existing as RuntimeRegistry;
  }
  const created: RuntimeRegistry = {
    controllers: new Map(),
    flushTimers: new Map(),
    pendingLaunches: new Map(),
    sessions: new Map(),
  };
  root[RUNTIME_KEY] = created;
  return created;
}

function boundedText(value: unknown, maximum = MAX_BACKGROUND_SUBAGENT_TEXT_BYTES): string {
  const text = typeof value === "string" ? value : value === undefined ? "" : String(value);
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maximum) return text;
  const suffix = Buffer.from(`\n\n… truncated at ${maximum} bytes`, "utf8");
  let prefix = bytes.subarray(0, Math.max(0, maximum - suffix.length));
  while (prefix.length > 0) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(prefix);
      break;
    } catch {
      prefix = prefix.subarray(0, -1);
    }
  }
  return Buffer.concat([prefix, suffix]).subarray(0, maximum).toString("utf8");
}

function requiredString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maximum) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function parseArtifacts(value: unknown): BackgroundSubagentArtifact[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error("invalid background subagent artifacts");
  const children = new Set<number>();
  const childIds = new Set<string>();
  const artifacts = value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid background subagent artifact");
    const artifact = entry as Record<string, unknown>;
    if (!Number.isSafeInteger(artifact.child) || (artifact.child as number) < 1 || (artifact.child as number) > 8
      || children.has(artifact.child as number)) throw new Error("invalid background subagent artifact child");
    children.add(artifact.child as number);
    const childId = artifact.childId === undefined
      ? undefined
      : requiredString(artifact.childId, "background subagent artifact child id", 64);
    if (childId && (!SUBAGENT_CHILD_ID_PATTERN.test(childId) || childIds.has(childId))) {
      throw new Error("invalid background subagent artifact child id");
    }
    if (childId) childIds.add(childId);
    if (!Number.isSafeInteger(artifact.bytes) || (artifact.bytes as number) < 0 || (artifact.bytes as number) > MAX_RETAINED_SUBAGENT_REPORT_BYTES) throw new Error("invalid background subagent artifact bytes");
    if (!Number.isSafeInteger(artifact.totalBytes) || (artifact.totalBytes as number) < (artifact.bytes as number)) throw new Error("invalid background subagent artifact total bytes");
    if (typeof artifact.complete !== "boolean") throw new Error("invalid background subagent artifact completeness");
    if (typeof artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(artifact.sha256)) throw new Error("invalid background subagent artifact checksum");
    return {
      child: artifact.child as number,
      ...(childId ? { childId } : {}),
      label: requiredString(artifact.label, "background subagent artifact label", 256),
      bytes: artifact.bytes as number,
      totalBytes: artifact.totalBytes as number,
      complete: artifact.complete,
      sha256: artifact.sha256,
    };
  });
  return artifacts.sort((a, b) => a.child - b.child);
}

function parseChildren(value: unknown): BackgroundSubagentChildDescriptor[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) throw new Error("invalid background subagent children");
  const ids = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid background subagent child");
    const child = entry as Record<string, unknown>;
    const allowed = new Set(["childId", "taskId", "label", "task"]);
    for (const key of Object.keys(child)) if (!allowed.has(key)) throw new Error(`unknown background subagent child field ${key}`);
    const childId = child.childId === undefined
      ? undefined
      : requiredString(child.childId, "background subagent child id", 64);
    if (childId && (!SUBAGENT_CHILD_ID_PATTERN.test(childId) || ids.has(childId))) {
      throw new Error("invalid background subagent child id");
    }
    if (childId) ids.add(childId);
    const taskId = child.taskId;
    if (taskId !== undefined && (typeof taskId !== "string" || !/^subagent-task-[0-9a-f]{24}$/.test(taskId))) throw new Error("Invalid task identity");
    return {
      ...(childId ? { childId } : {}),
      ...(taskId ? { taskId: taskId as string } : {}),
      label: requiredString(child.label, "background subagent child label", 256),
      ...(child.task === undefined ? {} : { task: requiredString(child.task, "background subagent child task", 2048) }),
    };
  });
}

function parseRecord(value: unknown): BackgroundSubagentRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("background subagent state must be an object");
  const data = value as Record<string, unknown>;
  const allowed = new Set(["schemaVersion", "id", "sessionId", "backend", "mode", "summary", "children", "createdAt", "updatedAt", "ownerPid", "ownerStartToken", "status", "latest", "result", "artifacts", "error", "taskOutcomes"]);
  for (const key of Object.keys(data)) if (!allowed.has(key)) throw new Error(`unknown background subagent field ${key}`);
  if (![1, 2, SCHEMA_VERSION].includes(data.schemaVersion as number)) throw new Error("unsupported background subagent state schema");
  const id = requiredString(data.id, "background subagent id", 64);
  if (!BACKGROUND_SUBAGENT_ID_PATTERN.test(id)) throw new Error("invalid background subagent id");
  if (data.backend !== "native" && data.backend !== "agentsh") throw new Error("invalid background subagent backend");
  if (data.mode !== "single" && data.mode !== "parallel" && data.mode !== "chain") throw new Error("invalid background subagent mode");
  if (!["running", "cancelling", "completed", "failed", "cancelled", "lost"].includes(String(data.status))) throw new Error("invalid background subagent status");
  if (!Number.isSafeInteger(data.ownerPid) || (data.ownerPid as number) < 1) throw new Error("invalid background subagent owner pid");
  for (const field of ["createdAt", "updatedAt"] as const) {
    if (!Number.isFinite(Date.parse(requiredString(data[field], field, 64)))) throw new Error(`invalid ${field}`);
  }
  if (data.schemaVersion !== SCHEMA_VERSION && data.children !== undefined) {
    throw new Error("legacy background subagent state cannot contain child identities");
  }
  const children = data.children === undefined ? undefined : parseChildren(data.children);
  const parsedArtifacts = data.artifacts === undefined ? undefined : parseArtifacts(data.artifacts);
  const taskOutcomes = data.taskOutcomes === undefined ? undefined : validateOutcomeSummaries(data.taskOutcomes);
  const artifacts = parsedArtifacts?.map((entry) => {
    const { childId: artifactChildId, ...artifact } = entry;
    if (children && entry.child > children.length) throw new Error("background subagent artifact child is outside its group");
    const descriptorChildId = children?.[entry.child - 1]?.childId;
    if (artifactChildId && descriptorChildId && artifactChildId !== descriptorChildId) {
      throw new Error("background subagent artifact child identity does not match its group");
    }
    // Child descriptors are the authority for controllable identities. Older
    // records and artifacts stay addressable by ordinal without acquiring an
    // identity merely because one appeared in artifact metadata.
    return {
      ...artifact,
      ...(descriptorChildId ? { childId: descriptorChildId } : {}),
    };
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    sessionId: requiredString(data.sessionId, "session id", 512),
    backend: data.backend,
    mode: data.mode,
    summary: requiredString(data.summary, "summary", 2048),
    ...(children ? { children } : {}),
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
    ownerPid: data.ownerPid as number,
    ownerStartToken: requiredString(data.ownerStartToken, "owner start token", 256),
    status: data.status as BackgroundSubagentStatus,
    latest: boundedText(data.latest),
    ...(data.result === undefined ? {} : { result: boundedText(data.result) }),
    ...(artifacts?.length ? { artifacts } : {}),
    ...(taskOutcomes ? {taskOutcomes} : {}),
    ...(data.error === undefined ? {} : { error: boundedText(data.error, 4096) }),
  };
}

async function processStartToken(pid: number): Promise<string | undefined> {
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const fields = stat.slice(close + 2).split(" ");
      return fields[19];
    } catch { return undefined; }
  }
  if (pid !== process.pid) return undefined;
  return `${pid}:${Math.floor(Date.now() - process.uptime() * 1000)}`;
}

async function writeAtomicBytes(path: string, value: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await writeFile(temporary, value, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

function serializeBoundedState(record: BackgroundSubagentRecord): string {
  const snapshot = structuredClone(record);
  const serialize = () => `${JSON.stringify(snapshot)}\n`;
  if (Buffer.byteLength(serialize(), "utf8") <= MAX_STATE_BYTES) return serialize();

  // Child tasks are optional diagnostic metadata and are the first fields to
  // discard; identities and result artifacts remain intact. In terminal records
  // latest normally duplicates result.
  if (snapshot.children) {
    snapshot.children = snapshot.children.map(({ task: _task, ...child }) => child);
  }
  if (snapshot.result !== undefined && snapshot.latest === snapshot.result) {
    snapshot.latest = "(terminal result retained below)";
  }

  type StringSlot = { owner: Record<string, any>; key: string; minimum: number };
  const slots = (): StringSlot[] => [
    ...(snapshot.error === undefined ? [] : [{ owner: snapshot as any, key: "error", minimum: 64 }]),
    { owner: snapshot as any, key: "summary", minimum: 64 },
    ...(snapshot.children ?? []).map((child) => ({ owner: child as any, key: "label", minimum: 16 })),
    ...(snapshot.artifacts ?? []).map((artifact) => ({ owner: artifact as any, key: "label", minimum: 16 })),
    { owner: snapshot as any, key: "latest", minimum: 64 },
    ...(snapshot.result === undefined ? [] : [{ owner: snapshot as any, key: "result", minimum: 64 }]),
  ];

  while (Buffer.byteLength(serialize(), "utf8") > MAX_STATE_BYTES) {
    let changed = false;
    for (const slot of slots()) {
      const value = slot.owner[slot.key];
      if (typeof value !== "string") continue;
      const bytes = Buffer.byteLength(value, "utf8");
      if (bytes <= slot.minimum) continue;
      const next = boundedText(value, Math.max(slot.minimum, Math.floor(bytes / 2)));
      slot.owner[slot.key] = next;
      changed = true;
      if (Buffer.byteLength(serialize(), "utf8") <= MAX_STATE_BYTES) break;
    }
    if (!changed) throw new Error("background subagent state exceeds its serialized size limit");
  }
  return serialize();
}

async function exists(path: string): Promise<boolean> {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}

type LegacyReloadAdopter = (sessionId: string) => boolean;

function legacyReloadAdopter(value: unknown, root: string): LegacyReloadAdopter | undefined {
  try {
    const candidate = value as {
      root?: unknown;
      managerAbiVersion?: unknown;
      adoptReload?: (sessionId: string) => unknown;
    } | undefined;
    // V3 did not carry an ABI marker. Never expose that object as the current
    // manager or call its storage/lifecycle methods; retain only the narrow
    // reload acknowledgement needed to disarm its already-running watchdog.
    if (!candidate || candidate.managerAbiVersion !== undefined || candidate.root !== root
      || typeof candidate.adoptReload !== "function") return undefined;
    return (sessionId) => {
      try { return candidate.adoptReload!.call(candidate, sessionId) === true; }
      catch { return false; }
    };
  } catch {
    return undefined;
  }
}

export class BackgroundSubagentManager {
  readonly managerAbiVersion = 4;
  private readonly records = new Map<string, BackgroundSubagentRecord>();
  private readonly runtime = runtimeRegistry();
  private readonly writeChains = new Map<string, Promise<void>>();
  private readonly reloadAdoptionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly migratedRecordIds = new Set<string>();
  private readonly adoptLegacyReload?: LegacyReloadAdopter;
  private initialized?: Promise<void>;
  private ownerStartToken = "";

  constructor(readonly root: string, legacyManager?: unknown) {
    this.adoptLegacyReload = legacyReloadAdopter(legacyManager, root);
  }

  private sessionState(sessionId: string): { phase: BackgroundSessionPhase; generation: number } {
    let state = this.runtime.sessions.get(sessionId);
    if (!state) {
      state = { phase: "active", generation: 1 };
      this.runtime.sessions.set(sessionId, state);
    }
    return state;
  }

  private clearReloadWatchdog(sessionId: string): void {
    const timer = this.reloadAdoptionTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.reloadAdoptionTimers.delete(sessionId);
  }

  private get jobsRoot(): string { return join(this.root, "jobs"); }
  private jobDir(id: string): string {
    if (!BACKGROUND_SUBAGENT_ID_PATTERN.test(id)) throw new Error(`Invalid background subagent ID: ${id}`);
    return join(this.jobsRoot, id);
  }
  private statePath(id: string): string { return join(this.jobDir(id), "state.json"); }
  private notifiedPath(id: string): string { return join(this.jobDir(id), "notified"); }
  private artifactPath(id: string, child: number): string {
    if (!Number.isSafeInteger(child) || child < 1 || child > 8) throw new Error("Invalid background subagent result child");
    return join(this.jobDir(id), `result-${child}.md`);
  }

  async initialize(): Promise<void> {
    if (!this.initialized) this.initialized = this.initializeOnce();
    return await this.initialized;
  }

  private async initializeOnce(): Promise<void> {
    await mkdir(this.jobsRoot, { recursive: true, mode: 0o700 });
    for (const directory of [this.root, this.jobsRoot]) {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${directory} is not a directory`);
      if (process.getuid && info.uid !== process.getuid()) throw new Error(`${directory} is owned by another user`);
      if ((info.mode & 0o077) !== 0) throw new Error(`${directory} must not be accessible by group or other users`);
    }
    this.ownerStartToken = await processStartToken(process.pid) ?? `${process.pid}:${Math.floor(Date.now() - process.uptime() * 1000)}`;
    const entries = await readdir(this.jobsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !BACKGROUND_SUBAGENT_ID_PATTERN.test(entry.name)) continue;
      try {
        const info = await lstat(this.statePath(entry.name));
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STATE_BYTES) continue;
        const record = parseRecord(JSON.parse(await readFile(this.statePath(entry.name), "utf8")));
        if ((record.status === "running" || record.status === "cancelling") &&
            (!this.runtime.controllers.has(record.id) || record.ownerPid !== process.pid || record.ownerStartToken !== this.ownerStartToken)) {
          record.status = "lost";
          record.updatedAt = new Date().toISOString();
          record.error = "The owning Pi process exited before this subagent reported a terminal result.";
          await this.persist(record);
        }
        this.records.set(record.id, record);
        if (this.adoptLegacyReload && isBackgroundSubagentActive(record)) {
          this.migratedRecordIds.add(record.id);
        }
      } catch {
        // Malformed records are ignored, never trusted or removed automatically.
      }
    }
    await this.prune();
  }

  private async refreshMigratedRecords(): Promise<void> {
    if (this.migratedRecordIds.size === 0) return;
    for (const id of [...this.migratedRecordIds]) {
      try {
        const info = await lstat(this.statePath(id));
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STATE_BYTES) continue;
        const persisted = parseRecord(JSON.parse(await readFile(this.statePath(id), "utf8")));
        const current = this.records.get(id);
        const terminalAdvance = Boolean(current && isBackgroundSubagentActive(current) && !isBackgroundSubagentActive(persisted));
        const regressesCancellation = current?.status === "cancelling" && persisted.status === "running";
        if (!current || terminalAdvance
          || (!regressesCancellation && Date.parse(persisted.updatedAt) > Date.parse(current.updatedAt))) {
          this.records.set(id, persisted);
        }
        if (!isBackgroundSubagentActive(persisted)) this.migratedRecordIds.delete(id);
      } catch {
        // A V3 owner may be between its atomic write and rename. Keep the last
        // trusted snapshot and retry on the next operation.
      }
    }
  }

  private async persist(record: BackgroundSubagentRecord): Promise<void> {
    const snapshot = structuredClone(record);
    const previous = this.writeChains.get(record.id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() =>
      writeAtomicBytes(this.statePath(record.id), serializeBoundedState(snapshot)),
    );
    this.writeChains.set(record.id, current);
    try { await current; }
    finally { if (this.writeChains.get(record.id) === current) this.writeChains.delete(record.id); }
  }

  async start(input: {
    sessionId: string;
    backend: BackgroundSubagentBackend;
    mode: "single" | "parallel" | "chain";
    summary: string;
    children?: BackgroundSubagentChildDescriptor[];
  }, runner: BackgroundSubagentRunner, launchSignal?: AbortSignal): Promise<BackgroundSubagentRecord> {
    const sessionId = requiredString(input.sessionId, "session id", 512);
    const session = this.sessionState(sessionId);
    const launchGeneration = session.generation;
    if (session.phase !== "active") throw new Error("Owning Pi session is not accepting background subagent launches");
    if (launchSignal?.aborted) {
      throw launchSignal.reason instanceof Error ? launchSignal.reason : new Error("Background subagent launch cancelled");
    }
    await this.initialize();
    await this.refreshMigratedRecords();
    if (session.phase !== "active" || session.generation !== launchGeneration) {
      throw new Error("Owning Pi session changed before background subagent launch");
    }
    if (launchSignal?.aborted) {
      throw launchSignal.reason instanceof Error ? launchSignal.reason : new Error("Background subagent launch cancelled");
    }
    const active = [...this.records.values()].filter((record) => record.status === "running" || record.status === "cancelling");
    if (active.length >= MAX_BACKGROUND_SUBAGENTS) throw new Error(`Background subagent concurrency limit reached (${MAX_BACKGROUND_SUBAGENTS})`);
    const now = new Date().toISOString();
    const id = `subagent-job-${randomBytes(12).toString("hex")}`;
    const children = input.children === undefined ? undefined : parseChildren(input.children);
    const record: BackgroundSubagentRecord = {
      schemaVersion: SCHEMA_VERSION,
      id,
      sessionId,
      backend: input.backend,
      mode: input.mode,
      summary: boundedText(input.summary, 2048) || "subagent task",
      ...(children ? { children } : {}),
      createdAt: now,
      updatedAt: now,
      ownerPid: process.pid,
      ownerStartToken: this.ownerStartToken,
      status: "running",
      latest: "(starting…)",
    };
    const controller = new AbortController();
    const abortPendingLaunch = () => controller.abort(
      launchSignal?.reason instanceof Error ? launchSignal.reason : new Error("Background subagent launch cancelled"),
    );
    if (launchSignal) launchSignal.addEventListener("abort", abortPendingLaunch, { once: true });
    this.runtime.controllers.set(id, controller);
    this.runtime.pendingLaunches.set(id, { sessionId, controller });
    this.records.set(id, record);
    const discardPendingLaunch = async () => {
      launchSignal?.removeEventListener("abort", abortPendingLaunch);
      this.runtime.pendingLaunches.delete(id);
      this.runtime.controllers.delete(id);
      this.records.delete(id);
      await rm(this.jobDir(id), { recursive: true, force: true }).catch(() => undefined);
    };
    try {
      await mkdir(this.jobDir(id), { mode: 0o700 });
      await this.persist(record);
    } catch (error) {
      await discardPendingLaunch();
      throw error;
    }
    if (controller.signal.aborted || session.phase !== "active" || session.generation !== launchGeneration) {
      const error = controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new Error("Owning Pi session changed before background subagent launch");
      await discardPendingLaunch();
      throw error;
    }
    launchSignal?.removeEventListener("abort", abortPendingLaunch);
    this.runtime.pendingLaunches.delete(id);
    let execution: Promise<BackgroundSubagentOutcome>;
    try {
      // Enter the runner before returning the launch record. This closes the
      // reload/shutdown gap between publishing a running job and acquiring its
      // backend transport or native child resources.
      execution = Promise.resolve(runner(controller.signal, (text) => this.updateProgress(id, text)));
    } catch (error) {
      execution = Promise.reject(error);
    }
    void execution.then(
      (outcome) => this.finish(id, controller.signal.aborted ? "cancelled" : outcome.failed ? "failed" : "completed", outcome.text, undefined, outcome.reports, outcome.taskOutcomes),
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        return this.finish(id, controller.signal.aborted ? "cancelled" : "failed", message, message);
      },
    ).catch(() => undefined);
    return structuredClone(record);
  }

  private updateProgress(id: string, text: string): void {
    const record = this.records.get(id);
    if (!record || (record.status !== "running" && record.status !== "cancelling")) return;
    record.latest = boundedText(text) || record.latest;
    record.updatedAt = new Date().toISOString();
    if (this.runtime.flushTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.runtime.flushTimers.delete(id);
      const current = this.records.get(id);
      if (current) void this.persist(current).catch(() => undefined);
    }, 500);
    timer.unref();
    this.runtime.flushTimers.set(id, timer);
  }

  private resolveReports(
    record: BackgroundSubagentRecord,
    reports: RetainedSubagentReport[],
  ): Array<RetainedSubagentReport & { child: number; childId?: string }> {
    const descriptors = record.children ?? [];
    const hasPersistedChildIdentities = descriptors.some((descriptor) => Boolean(descriptor.childId));
    const seen = new Set<number>();
    return reports.slice(0, 8).map((report) => {
      const explicitChild = report.child;
      if (explicitChild !== undefined
        && (!Number.isSafeInteger(explicitChild) || explicitChild < 1 || explicitChild > 8)) {
        throw new Error("retained subagent report has an invalid child ordinal");
      }
      if (report.childId !== undefined && !SUBAGENT_CHILD_ID_PATTERN.test(report.childId)) {
        throw new Error("retained subagent report has an invalid child identity");
      }
      const identityIndex = report.childId
        ? descriptors.findIndex((descriptor) => descriptor.childId === report.childId)
        : -1;
      if (report.childId && hasPersistedChildIdentities && identityIndex < 0) {
        throw new Error("retained subagent report child identity does not belong to its group");
      }
      const labelMatches = descriptors
        .map((descriptor, index) => descriptor.label === report.label ? index : -1)
        .filter((index) => index >= 0);
      const conventional = report.label.match(/^(?:task|step|child) ([1-8])$/i);
      const child = identityIndex >= 0
        ? identityIndex + 1
        : explicitChild
          ?? (labelMatches.length === 1 ? labelMatches[0] + 1 : undefined)
          ?? (conventional ? Number(conventional[1]) : undefined)
          ?? (record.mode === "single" && reports.length === 1 ? 1 : undefined);
      if (child === undefined) {
        throw new Error("retained parallel subagent report has no stable child identity");
      }
      if (identityIndex >= 0 && explicitChild !== undefined && explicitChild !== child) {
        throw new Error("retained subagent report child identity and ordinal disagree");
      }
      if (seen.has(child)) throw new Error(`duplicate retained subagent report for child ${child}`);
      seen.add(child);
      if (descriptors.length > 0 && child > descriptors.length) {
        throw new Error("retained subagent report child ordinal is outside its group");
      }
      const descriptorId = descriptors[child - 1]?.childId;
      if (report.childId && descriptorId && report.childId !== descriptorId) {
        throw new Error("retained subagent report child identity and ordinal disagree");
      }
      const { childId: _reportedChildId, ...reportWithoutIdentity } = report;
      return {
        ...reportWithoutIdentity,
        child,
        // Only the identity persisted before launch is controllable. Report
        // payloads from pre-identity producers cannot mint one retroactively.
        ...(descriptorId ? { childId: descriptorId } : {}),
      };
    }).sort((a, b) => a.child - b.child);
  }

  private async persistReports(
    record: BackgroundSubagentRecord,
    reports: RetainedSubagentReport[],
  ): Promise<BackgroundSubagentArtifact[]> {
    const artifacts: BackgroundSubagentArtifact[] = [];
    const selected = this.resolveReports(record, reports);
    const fairLimit = Math.min(MAX_RETAINED_SUBAGENT_REPORT_BYTES, Math.floor(MAX_RETAINED_SUBAGENT_JOB_BYTES / Math.max(1, selected.length)));
    for (const report of selected) {
      const source = Buffer.from(report.text, "utf8");
      let retained = source.subarray(0, fairLimit);
      while (retained.length > 0) {
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(retained);
          break;
        } catch {
          retained = retained.subarray(0, -1);
        }
      }
      await writeAtomicBytes(this.artifactPath(record.id, report.child), retained);
      artifacts.push({
        child: report.child,
        ...(report.childId ? { childId: report.childId } : {}),
        label: boundedText(report.label, 256) || `result ${report.child}`,
        bytes: retained.byteLength,
        totalBytes: Math.max(source.byteLength, report.totalBytes ?? 0),
        complete: report.complete !== false && retained.byteLength === source.byteLength,
        sha256: createHash("sha256").update(retained).digest("hex"),
      });
    }
    return artifacts;
  }

  private async finish(id: string, status: "completed" | "failed" | "cancelled", text: string, error?: string, reports?: RetainedSubagentReport[], taskOutcomes?: TaskOutcomeSummary[]): Promise<void> {
    const record = this.records.get(id);
    if (!record || !["running", "cancelling"].includes(record.status)) return;
    const timer = this.runtime.flushTimers.get(id);
    if (timer) clearTimeout(timer);
    this.runtime.flushTimers.delete(id);
    if (taskOutcomes) record.taskOutcomes = validateOutcomeSummaries(taskOutcomes);
    record.result = boundedText(text || record.latest || "(no output)");
    record.latest = record.result;
    if (error) record.error = boundedText(error, 4096);
    try {
      const retainedReports = reports?.filter((report) => report.text.trim()) ?? [];
      record.artifacts = await this.persistReports(record, retainedReports.length
        ? retainedReports
        : [{ child: 1, label: "result", text: text || record.latest || "(no output)" }]);
    } catch (artifactError) {
      record.error = boundedText([record.error, `Result artifact unavailable: ${artifactError instanceof Error ? artifactError.message : String(artifactError)}`].filter(Boolean).join("\n"), 4096);
    }
    record.status = status;
    record.updatedAt = new Date().toISOString();
    await this.persist(record);
    this.runtime.controllers.delete(id);
    if (![...this.records.values()].some(
      (candidate) => candidate.sessionId === record.sessionId && isBackgroundSubagentActive(candidate),
    )) this.clearReloadWatchdog(record.sessionId);
    await this.prune();
  }

  async get(id: string): Promise<BackgroundSubagentRecord> {
    await this.initialize();
    await this.refreshMigratedRecords();
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown background subagent: ${id}`);
    return structuredClone(record);
  }

  async readResult(
    id: string,
    childOrId: number | string | undefined = undefined,
    offset = 0,
    limit = MAX_SUBAGENT_RESULT_PAGE_BYTES,
  ): Promise<BackgroundSubagentResultPage> {
    const record = await this.get(id);
    if (isBackgroundSubagentActive(record)) throw new Error("Background subagent result is not ready");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Result offset must be a non-negative integer");
    if (!Number.isSafeInteger(limit) || limit < 4 || limit > MAX_SUBAGENT_RESULT_PAGE_BYTES) throw new Error(`Result limit must be between 4 and ${MAX_SUBAGENT_RESULT_PAGE_BYTES} bytes`);
    if (typeof childOrId === "number" && (!Number.isSafeInteger(childOrId) || childOrId < 1 || childOrId > 8)) {
      throw new Error("Result child must be an integer between 1 and 8");
    }
    if (typeof childOrId === "string" && !SUBAGENT_CHILD_ID_PATTERN.test(childOrId)) {
      throw new Error("Result child_id is invalid");
    }
    let artifacts = record.artifacts ?? [];
    const legacyResult = record.result || record.latest;
    if (artifacts.length === 0 && legacyResult) {
      const current = this.records.get(id);
      if (!current) throw new Error(`Unknown background subagent: ${id}`);
      current.artifacts = await this.persistReports(current, [{
        child: 1,
        label: "result",
        text: legacyResult,
        totalBytes: Buffer.byteLength(legacyResult, "utf8") + 1,
        complete: false,
      }]);
      await this.persist(current);
      artifacts = current.artifacts;
    }
    if (artifacts.length === 0) throw new Error("No retained result artifact is available for this background subagent");
    if (artifacts.length > 1 && childOrId === undefined) {
      throw new Error("Parallel and chain results require a child number or child_id");
    }
    let artifact: BackgroundSubagentArtifact | undefined;
    if (typeof childOrId === "string") {
      const descriptorIndex = record.children?.findIndex((child) => child.childId === childOrId) ?? -1;
      if (descriptorIndex >= 0) artifact = artifacts.find((candidate) => candidate.child === descriptorIndex + 1);
      if (!artifact) throw new Error(`Background subagent result child_id ${childOrId} is unavailable`);
    } else {
      const child = childOrId ?? artifacts[0].child;
      artifact = artifacts.find((candidate) => candidate.child === child);
      if (!artifact) throw new Error(`Background subagent result child ${child} is unavailable`);
    }
    const child = artifact.child;
    if (offset > artifact.bytes) throw new Error(`Result offset ${offset} exceeds retained size ${artifact.bytes}`);
    const path = this.artifactPath(id, child);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== artifact.bytes) throw new Error("Retained background subagent result identity is invalid");
    if (process.getuid && info.uid !== process.getuid()) throw new Error("Retained background subagent result is owned by another user");
    if ((info.mode & 0o077) !== 0) throw new Error("Retained background subagent result is not private");
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    const handle = await open(path, constants.O_RDONLY | noFollow);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size !== artifact.bytes || opened.dev !== info.dev || opened.ino !== info.ino) throw new Error("Retained background subagent result identity changed");
      const completeArtifact = await handle.readFile();
      if (createHash("sha256").update(completeArtifact).digest("hex") !== artifact.sha256) throw new Error("Retained background subagent result checksum mismatch");
      if (offset < artifact.bytes && (completeArtifact[offset] & 0xc0) === 0x80) throw new Error(`Result offset ${offset} is not a UTF-8 character boundary`);
      const bytesRead = Math.min(limit, artifact.bytes - offset);
      let retained = completeArtifact.subarray(offset, offset + bytesRead);
      let text = "";
      while (retained.length > 0) {
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(retained);
          break;
        } catch {
          retained = retained.subarray(0, -1);
        }
      }
      const nextOffset = offset + retained.byteLength < artifact.bytes ? offset + retained.byteLength : undefined;
      if (bytesRead > 0 && retained.byteLength === 0) throw new Error("Result limit ends before one complete UTF-8 character");
      const childId = record.children?.[child - 1]?.childId;
      return {
        child,
        ...(childId ? { childId } : {}),
        label: artifact.label,
        offset,
        ...(nextOffset === undefined ? {} : { nextOffset }),
        bytes: retained.byteLength,
        totalBytes: artifact.bytes,
        sourceTotalBytes: artifact.totalBytes,
        complete: artifact.complete,
        sha256: artifact.sha256,
        text,
      };
    } finally {
      await handle.close();
    }
  }

  async list(sessionId?: string, limit = 50): Promise<BackgroundSubagentRecord[]> {
    await this.initialize();
    await this.refreshMigratedRecords();
    return [...this.records.values()]
      .filter((record) => !this.runtime.pendingLaunches.has(record.id))
      .filter((record) => !sessionId || record.sessionId === sessionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, Math.min(limit, 1000)))
      .map((record) => structuredClone(record));
  }

  async wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<{ record: BackgroundSubagentRecord; timedOut: boolean }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Background subagent wait cancelled");
      const record = await this.get(id);
      if (!isBackgroundSubagentActive(record) || Date.now() >= deadline) return { record, timedOut: isBackgroundSubagentActive(record) };
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const delay = setTimeout(done, Math.min(100, Math.max(1, deadline - Date.now())));
        const abort = () => {
          clearTimeout(delay);
          signal?.removeEventListener("abort", abort);
          reject(signal?.reason instanceof Error ? signal.reason : new Error("Background subagent wait cancelled"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  }

  async cancel(id: string): Promise<BackgroundSubagentRecord> {
    await this.initialize();
    await this.refreshMigratedRecords();
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown background subagent: ${id}`);
    if (!isBackgroundSubagentActive(record)) return structuredClone(record);
    const controller = this.runtime.controllers.get(id);
    if (!controller) {
      record.status = "lost";
      record.updatedAt = new Date().toISOString();
      record.error = "The owning executor is unavailable; cancellation could not be confirmed.";
      await this.persist(record);
      return structuredClone(record);
    }
    record.status = "cancelling";
    record.updatedAt = new Date().toISOString();
    await this.persist(record);
    controller.abort(new Error("Background subagent cancelled by parent"));
    return (await this.wait(id, 5000)).record;
  }

  beginReloadAdoption(
    sessionId: string,
    timeoutMs = BACKGROUND_SUBAGENT_RELOAD_ADOPTION_TIMEOUT_MS,
  ): boolean {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new Error("Background subagent reload adoption timeout must be between 1 and 120000 milliseconds");
    }
    const session = this.sessionState(sessionId);
    session.phase = "reloading";
    session.generation += 1;
    const interruptedLaunch = new Error("Background subagent launch was interrupted by extension reload");
    for (const pending of this.runtime.pendingLaunches.values()) {
      if (pending.sessionId === sessionId) pending.controller.abort(interruptedLaunch);
    }
    const active = [...this.records.values()].some(
      (record) => record.sessionId === sessionId
        && !this.runtime.pendingLaunches.has(record.id)
        && isBackgroundSubagentActive(record),
    );
    this.clearReloadWatchdog(sessionId);
    if (!active) return false;
    const timer = setTimeout(() => {
      if (this.reloadAdoptionTimers.get(sessionId) !== timer) return;
      this.reloadAdoptionTimers.delete(sessionId);
      this.requestCancelSession(sessionId, new Error("Replacement subagent extension did not adopt running work after reload"));
    }, timeoutMs);
    this.reloadAdoptionTimers.set(sessionId, timer);
    return true;
  }

  activateSession(sessionId: string): boolean {
    // A deployed V3 manager may still own runner closures and its original
    // reload watchdog. Ask only its stable adoption boundary to release that
    // watchdog; never return or invoke it as the current manager ABI.
    const legacyAdopted = this.adoptLegacyReload?.(sessionId) === true;
    const session = this.sessionState(sessionId);
    const adopted = session.phase === "reloading";
    if (session.phase !== "active") {
      session.phase = "active";
      session.generation += 1;
    }
    this.clearReloadWatchdog(sessionId);
    return legacyAdopted || adopted;
  }

  adoptReload(sessionId: string): boolean {
    const legacyAdopted = this.adoptLegacyReload?.(sessionId) === true;
    const session = this.sessionState(sessionId);
    if (session.phase !== "reloading") return legacyAdopted;
    session.phase = "active";
    session.generation += 1;
    this.clearReloadWatchdog(sessionId);
    return true;
  }

  requestCancelSession(sessionId: string, reason = new Error("Owning Pi session shut down")): void {
    const session = this.sessionState(sessionId);
    session.phase = "closed";
    session.generation += 1;
    this.clearReloadWatchdog(sessionId);
    for (const pending of this.runtime.pendingLaunches.values()) {
      if (pending.sessionId === sessionId) pending.controller.abort(reason);
    }
    for (const record of this.records.values()) {
      if (record.sessionId === sessionId && isBackgroundSubagentActive(record)) {
        this.runtime.controllers.get(record.id)?.abort(reason);
      }
    }
  }

  async isNotified(id: string): Promise<boolean> {
    await this.initialize();
    return await exists(this.notifiedPath(id));
  }

  async markNotified(id: string): Promise<boolean> {
    await this.get(id);
    try {
      const handle = await open(this.notifiedPath(id), "wx", 0o600);
      await handle.close();
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }

  private async prune(): Promise<void> {
    const terminal = [...this.records.values()]
      .filter((record) => !isBackgroundSubagentActive(record))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const cutoff = Date.now() - TERMINAL_RETENTION_MS;
    for (let index = 0; index < terminal.length; index++) {
      const record = terminal[index];
      if (index < MAX_TERMINAL_RECORDS && Date.parse(record.updatedAt) >= cutoff) continue;
      this.records.delete(record.id);
      await rm(this.jobDir(record.id), { recursive: true, force: true });
    }
  }
}

function compatibleV4Manager(value: unknown, root: string): value is BackgroundSubagentManager {
  const candidate = value as Record<string, unknown> | undefined;
  return candidate?.managerAbiVersion === 4 && candidate.root === root
    && [
      "initialize", "start", "get", "list", "wait", "cancel", "readResult",
      "beginReloadAdoption", "activateSession", "adoptReload", "requestCancelSession",
      "isNotified", "markNotified",
    ].every((method) => typeof candidate[method] === "function");
}

export function sharedBackgroundSubagentManager(root: string): BackgroundSubagentManager {
  const globals = globalThis as Record<string, unknown>;
  let managers = globals[MANAGERS_KEY] as Map<string, BackgroundSubagentManager> | undefined;
  if (!(managers instanceof Map)) {
    managers = new Map();
    globals[MANAGERS_KEY] = managers;
  }
  let manager: BackgroundSubagentManager | undefined = managers.get(root);
  if (!compatibleV4Manager(manager, root)) {
    const legacyManagers = globals[LEGACY_MANAGERS_KEY];
    const legacy = legacyManagers instanceof Map ? legacyManagers.get(root) : undefined;
    manager = new BackgroundSubagentManager(root, legacy);
    managers.set(root, manager);
  }
  return manager;
}

export function isBackgroundSubagentActive(record: BackgroundSubagentRecord): boolean {
  return record.status === "running" || record.status === "cancelling";
}

export function isBackgroundSubagentChildActive(child: BackgroundSubagentChild): boolean {
  return child.status === "pending" || child.status === "running";
}

type TrackedChildGroup = {
  sessionId: string;
  children: Map<number, BackgroundSubagentChild>;
  updatedAt: string;
};

function inferredChildDescriptors(record: BackgroundSubagentRecord): BackgroundSubagentChildDescriptor[] {
  if (record.children?.length) return record.children.map((child) => ({ ...child }));
  const countMatch = record.summary.match(/^(?:parallel|chain) ([1-8]):/);
  const count = record.mode === "single"
    ? 1
    : Math.max(1, record.artifacts?.length ?? 0, Number(countMatch?.[1] ?? 1));
  return Array.from({ length: Math.min(8, count) }, (_, index) => ({
    label: record.artifacts?.[index]?.label || (record.mode === "chain" ? `step ${index + 1}` : record.mode === "parallel" ? `task ${index + 1}` : "subagent"),
  }));
}

function groupTerminalChildStatus(record: BackgroundSubagentRecord, child: BackgroundSubagentChild, failedPendingChild?: number): BackgroundSubagentChildStatus {
  if (record.status === "completed") return "completed";
  if (record.status === "cancelled") return "cancelled";
  if (record.status === "lost") return "lost";
  if (record.status === "failed" && child.status === "pending" && record.mode === "chain" && child.child !== failedPendingChild) return "skipped";
  return "failed";
}

/** Process-owned child progress, independent of the hot-reloadable manager class ABI. */
export class BackgroundSubagentChildTracker {
  readonly childIdentityVersion = 2;
  private readonly groups = new Map<string, TrackedChildGroup>();

  register(record: BackgroundSubagentRecord, descriptors: BackgroundSubagentChildDescriptor[] = inferredChildDescriptors(record)): void {
    const selected = descriptors.slice(0, 8);
    if (selected.length === 0) selected.push({ label: record.mode === "single" ? "subagent" : "child 1" });
    let group = this.groups.get(record.id);
    if (!group || group.sessionId !== record.sessionId) {
      group = { sessionId: record.sessionId, children: new Map(), updatedAt: record.updatedAt };
      this.groups.set(record.id, group);
    }
    const now = new Date().toISOString();
    for (let index = 0; index < selected.length; index++) {
      const descriptor = selected[index];
      const child = index + 1;
      const existing = group.children.get(child);
      const childId = SUBAGENT_CHILD_ID_PATTERN.test(descriptor.childId ?? "")
        ? descriptor.childId
        : existing?.childId;
      if (existing) {
        if (existing.childId && childId && existing.childId !== childId) continue;
        if (!existing.childId && childId) existing.childId = childId;
        if (descriptor.taskId) existing.taskId = descriptor.taskId;
        existing.label = boundedText(descriptor.label, 256) || existing.label;
        if (descriptor.task?.trim()) existing.task = boundedText(descriptor.task, 2048);
      } else {
        group.children.set(child, {
          ...(childId ? { childId } : {}),
          ...(descriptor.taskId ? {taskId:descriptor.taskId} : {}),
          child,
          label: boundedText(descriptor.label, 256) || `child ${child}`,
          ...(descriptor.task?.trim() ? { task: boundedText(descriptor.task, 2048) } : {}),
          status: "pending",
          updatedAt: now,
        });
      }
    }
    this.reconcile(record);
    this.prune(record.id);
  }

  update(jobId: string, progress: BackgroundSubagentChildProgress[]): void {
    const group = this.groups.get(jobId);
    if (!group) return;
    const now = new Date().toISOString();
    for (const candidate of progress.slice(0, 8)) {
      if (!Number.isSafeInteger(candidate.child) || candidate.child < 1 || candidate.child > 8) continue;
      const existing = group.children.get(candidate.child);
      if (existing && !isBackgroundSubagentChildActive(existing)) {
        if (isBackgroundSubagentChildActive({ ...existing, status: candidate.status })) continue;
        if (existing.status !== "completed" || candidate.status === "completed") continue;
      }
      const suppliedChildId = SUBAGENT_CHILD_ID_PATTERN.test(candidate.childId ?? "")
        ? candidate.childId
        : undefined;
      if (existing?.childId && suppliedChildId && existing.childId !== suppliedChildId) continue;
      // Registration is backed by the persisted group descriptor. Updates may
      // confirm that identity, but a legacy/pre-identity update cannot create it.
      const childId = existing?.childId;
      const next: BackgroundSubagentChild = {
        ...(childId ? { childId } : {}),
        child: candidate.child,
        label: boundedText(candidate.label, 256) || existing?.label || `child ${candidate.child}`,
        ...(candidate.task?.trim() ? { task: boundedText(candidate.task, 2048) } : existing?.task ? { task: existing.task } : {}),
        status: candidate.status,
        updatedAt: existing?.status === candidate.status ? existing.updatedAt : now,
      };
      group.children.set(candidate.child, next);
      group.updatedAt = now;
    }
  }

  reconcile(record: BackgroundSubagentRecord): BackgroundSubagentChild[] {
    if (!this.groups.has(record.id)) this.register(record, inferredChildDescriptors(record));
    const group = this.groups.get(record.id)!;
    if (!isBackgroundSubagentActive(record)) {
      const now = new Date().toISOString();
      const failedPendingChild = record.status === "failed" && record.mode === "chain"
        && ![...group.children.values()].some((child) => ["running", "failed", "cancelled", "lost"].includes(child.status))
        ? [...group.children.values()].filter((child) => child.status === "pending").sort((a, b) => a.child - b.child)[0]?.child
        : undefined;
      for (const child of group.children.values()) {
        if (!isBackgroundSubagentChildActive(child)) continue;
        child.status = groupTerminalChildStatus(record, child, failedPendingChild);
        child.updatedAt = now;
      }
      group.updatedAt = now;
    }
    const children = [...group.children.values()].sort((a, b) => a.child - b.child).map((child) => structuredClone(child));
    this.prune(record.id);
    return children;
  }

  removeSession(sessionId: string): void {
    for (const [id, group] of this.groups) if (group.sessionId === sessionId) this.groups.delete(id);
  }

  private prune(protectedId?: string): void {
    if (this.groups.size <= MAX_TRACKED_CHILD_GROUPS) return;
    const oldest = [...this.groups.entries()].sort((a, b) => a[1].updatedAt.localeCompare(b[1].updatedAt));
    for (const [id, group] of oldest) {
      if (this.groups.size <= MAX_TRACKED_CHILD_GROUPS) break;
      if (id !== protectedId && [...group.children.values()].every((child) => !isBackgroundSubagentChildActive(child))) this.groups.delete(id);
    }
    for (const [id] of oldest) {
      if (this.groups.size <= MAX_TRACKED_CHILD_GROUPS) break;
      if (id !== protectedId) this.groups.delete(id);
    }
  }
}

export function sharedBackgroundSubagentChildTracker(): BackgroundSubagentChildTracker {
  const root = globalThis as Record<string, unknown>;
  const existing = root[CHILD_TRACKER_KEY] as BackgroundSubagentChildTracker | undefined;
  if (existing?.childIdentityVersion === 2
    && typeof existing.register === "function" && typeof existing.update === "function"
    && typeof existing.reconcile === "function" && typeof existing.removeSession === "function") return existing;
  const created = new BackgroundSubagentChildTracker();
  root[CHILD_TRACKER_KEY] = created;
  return created;
}

async function waitPollDelay(timeoutMs: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, Math.max(1, Math.min(100, timeoutMs)));
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Background subagent wait cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export type BackgroundSubagentWaitAnyResult = {
  record?: BackgroundSubagentRecord;
  child?: BackgroundSubagentChild;
  timedOut: boolean;
  remainingChildren: number;
};

export async function waitForAnyBackgroundSubagentChild(
  manager: BackgroundSubagentManager,
  tracker: BackgroundSubagentChildTracker,
  records: BackgroundSubagentRecord[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<BackgroundSubagentWaitAnyResult> {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Background subagent wait cancelled");
  const activeRecords = records.filter(isBackgroundSubagentActive);
  const initialChildren = activeRecords.map((record) => ({ record, children: tracker.reconcile(record) }));
  const candidates = initialChildren.flatMap(({ record, children }) => children
    .filter(isBackgroundSubagentChildActive)
    .map((child) => ({ jobId: record.id, child: child.child })));
  if (candidates.length === 0) return { timedOut: false, remainingChildren: 0 };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Background subagent wait cancelled");
    const current = new Map<string, BackgroundSubagentRecord>();
    for (const record of activeRecords) current.set(record.id, await manager.get(record.id));
    let remainingChildren = 0;
    let terminal: { record: BackgroundSubagentRecord; child: BackgroundSubagentChild } | undefined;
    for (const candidate of candidates) {
      const record = current.get(candidate.jobId)!;
      const child = tracker.reconcile(record).find((item) => item.child === candidate.child);
      if (child && !isBackgroundSubagentChildActive(child)) terminal ??= { record, child };
      else if (child) remainingChildren += 1;
    }
    if (terminal) return { ...terminal, timedOut: false, remainingChildren };
    if (Date.now() >= deadline) return { timedOut: true, remainingChildren };
    await waitPollDelay(deadline - Date.now(), signal);
  }
}

export async function waitForAllBackgroundSubagentGroups(
  manager: BackgroundSubagentManager,
  records: BackgroundSubagentRecord[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ records: BackgroundSubagentRecord[]; timedOut: boolean }> {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Background subagent wait cancelled");
  const active = records.filter(isBackgroundSubagentActive);
  if (active.length === 0) return { records: [], timedOut: false };
  const waited = await Promise.all(active.map((record) => manager.wait(record.id, timeoutMs, signal)));
  return {
    records: waited.map((entry) => entry.record),
    timedOut: waited.some((entry) => entry.timedOut),
  };
}

export function backgroundSubagentsSurviveShutdown(reason: unknown): boolean {
  return reason === "reload";
}

export type BackgroundSubagentNotificationState = {
  idlePending: Set<string>;
  idleInFlight: Set<string>;
  deliveryClaims: Map<string, symbol>;
  consumed: Set<string>;
  consumptionPending: Set<string>;
};

export function sharedBackgroundSubagentNotificationState(): BackgroundSubagentNotificationState {
  const root = globalThis as Record<string, unknown>;
  const existing = root[NOTIFICATION_STATE_KEY] as Partial<BackgroundSubagentNotificationState> | undefined;
  if (existing?.idlePending instanceof Set && existing.idleInFlight instanceof Set
    && existing.deliveryClaims instanceof Map && existing.consumed instanceof Set
    && existing.consumptionPending instanceof Set) {
    return existing as BackgroundSubagentNotificationState;
  }
  if (existing?.idlePending instanceof Set && existing.idleInFlight instanceof Set) {
    const migrated: BackgroundSubagentNotificationState = {
      idlePending: existing.idlePending,
      idleInFlight: existing.idleInFlight,
      // Legacy state used a Set for transient old-owner claims. Preserve the
      // accepted-message sets, but claims themselves cannot cross that ABI.
      deliveryClaims: existing.deliveryClaims instanceof Map
        ? existing.deliveryClaims
        : new Map<string, symbol>(),
      consumed: existing.consumptionPending instanceof Set && existing.consumed instanceof Set
        ? existing.consumed
        : new Set<string>(),
      consumptionPending: existing.consumptionPending instanceof Set
        ? existing.consumptionPending
        : new Set<string>(),
    };
    root[NOTIFICATION_STATE_KEY] = migrated;
    return migrated;
  }
  const created: BackgroundSubagentNotificationState = {
    idlePending: new Set<string>(),
    idleInFlight: new Set<string>(),
    deliveryClaims: new Map<string, symbol>(),
    consumed: new Set<string>(),
    consumptionPending: new Set<string>(),
  };
  root[NOTIFICATION_STATE_KEY] = created;
  return created;
}

export function backgroundSubagentLine(record: BackgroundSubagentRecord): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(record.createdAt)) / 1000));
  const age = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;
  return `${record.id}  ${record.status}  ${age}  ${record.backend}/${record.mode}  ${record.summary.replace(/\s+/g, " ")}`;
}
