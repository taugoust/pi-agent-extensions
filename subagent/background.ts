import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
const MAX_STATE_BYTES = 128 * 1024;
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TERMINAL_RECORDS = 100;
const SCHEMA_VERSION = 2;

export type BackgroundSubagentStatus = "running" | "cancelling" | "completed" | "failed" | "cancelled" | "lost";
export type BackgroundSubagentBackend = "native" | "agentsh";
export type BackgroundSubagentChildStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped" | "lost";

export type BackgroundSubagentChildDescriptor = {
  label: string;
  task?: string;
};

export type BackgroundSubagentChildProgress = BackgroundSubagentChildDescriptor & {
  child: number;
  status: BackgroundSubagentChildStatus;
};

export type BackgroundSubagentChild = BackgroundSubagentChildProgress & {
  updatedAt: string;
};

export type BackgroundSubagentArtifact = {
  child: number;
  label: string;
  bytes: number;
  totalBytes: number;
  complete: boolean;
  sha256: string;
};

export type BackgroundSubagentRecord = {
  schemaVersion: 2;
  id: string;
  sessionId: string;
  backend: BackgroundSubagentBackend;
  mode: "single" | "parallel" | "chain";
  summary: string;
  createdAt: string;
  updatedAt: string;
  ownerPid: number;
  ownerStartToken: string;
  status: BackgroundSubagentStatus;
  latest: string;
  result?: string;
  artifacts?: BackgroundSubagentArtifact[];
  error?: string;
};

export type BackgroundSubagentOutcome = {
  text: string;
  failed: boolean;
  reports?: RetainedSubagentReport[];
};

export type BackgroundSubagentResultPage = {
  child: number;
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
const MANAGERS_KEY = "__paeBackgroundSubagentManagersV3";
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
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid background subagent artifact");
    const artifact = entry as Record<string, unknown>;
    if (!Number.isSafeInteger(artifact.child) || artifact.child !== index + 1) throw new Error("invalid background subagent artifact child");
    if (!Number.isSafeInteger(artifact.bytes) || (artifact.bytes as number) < 0 || (artifact.bytes as number) > MAX_RETAINED_SUBAGENT_REPORT_BYTES) throw new Error("invalid background subagent artifact bytes");
    if (!Number.isSafeInteger(artifact.totalBytes) || (artifact.totalBytes as number) < (artifact.bytes as number)) throw new Error("invalid background subagent artifact total bytes");
    if (typeof artifact.complete !== "boolean") throw new Error("invalid background subagent artifact completeness");
    if (typeof artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(artifact.sha256)) throw new Error("invalid background subagent artifact checksum");
    return {
      child: artifact.child as number,
      label: requiredString(artifact.label, "background subagent artifact label", 256),
      bytes: artifact.bytes as number,
      totalBytes: artifact.totalBytes as number,
      complete: artifact.complete,
      sha256: artifact.sha256,
    };
  });
}

function parseRecord(value: unknown): BackgroundSubagentRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("background subagent state must be an object");
  const data = value as Record<string, unknown>;
  const allowed = new Set(["schemaVersion", "id", "sessionId", "backend", "mode", "summary", "createdAt", "updatedAt", "ownerPid", "ownerStartToken", "status", "latest", "result", "artifacts", "error"]);
  for (const key of Object.keys(data)) if (!allowed.has(key)) throw new Error(`unknown background subagent field ${key}`);
  if (data.schemaVersion !== 1 && data.schemaVersion !== SCHEMA_VERSION) throw new Error("unsupported background subagent state schema");
  const id = requiredString(data.id, "background subagent id", 64);
  if (!BACKGROUND_SUBAGENT_ID_PATTERN.test(id)) throw new Error("invalid background subagent id");
  if (data.backend !== "native" && data.backend !== "agentsh") throw new Error("invalid background subagent backend");
  if (data.mode !== "single" && data.mode !== "parallel" && data.mode !== "chain") throw new Error("invalid background subagent mode");
  if (!["running", "cancelling", "completed", "failed", "cancelled", "lost"].includes(String(data.status))) throw new Error("invalid background subagent status");
  if (!Number.isSafeInteger(data.ownerPid) || (data.ownerPid as number) < 1) throw new Error("invalid background subagent owner pid");
  for (const field of ["createdAt", "updatedAt"] as const) {
    if (!Number.isFinite(Date.parse(requiredString(data[field], field, 64)))) throw new Error(`invalid ${field}`);
  }
  const artifacts = data.artifacts === undefined ? undefined : parseArtifacts(data.artifacts);
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    sessionId: requiredString(data.sessionId, "session id", 512),
    backend: data.backend,
    mode: data.mode,
    summary: requiredString(data.summary, "summary", 2048),
    createdAt: data.createdAt as string,
    updatedAt: data.updatedAt as string,
    ownerPid: data.ownerPid as number,
    ownerStartToken: requiredString(data.ownerStartToken, "owner start token", 256),
    status: data.status as BackgroundSubagentStatus,
    latest: boundedText(data.latest),
    ...(data.result === undefined ? {} : { result: boundedText(data.result) }),
    ...(artifacts?.length ? { artifacts } : {}),
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

async function writeAtomic(path: string, value: unknown): Promise<void> {
  await writeAtomicBytes(path, `${JSON.stringify(value)}\n`);
}

async function exists(path: string): Promise<boolean> {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}

export class BackgroundSubagentManager {
  private readonly records = new Map<string, BackgroundSubagentRecord>();
  private readonly runtime = runtimeRegistry();
  private readonly writeChains = new Map<string, Promise<void>>();
  private readonly reloadAdoptionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private initialized?: Promise<void>;
  private ownerStartToken = "";

  constructor(readonly root: string) {}

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
      } catch {
        // Malformed records are ignored, never trusted or removed automatically.
      }
    }
    await this.prune();
  }

  private async persist(record: BackgroundSubagentRecord): Promise<void> {
    const snapshot = structuredClone(record);
    const previous = this.writeChains.get(record.id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => writeAtomic(this.statePath(record.id), snapshot));
    this.writeChains.set(record.id, current);
    try { await current; }
    finally { if (this.writeChains.get(record.id) === current) this.writeChains.delete(record.id); }
  }

  async start(input: {
    sessionId: string;
    backend: BackgroundSubagentBackend;
    mode: "single" | "parallel" | "chain";
    summary: string;
  }, runner: BackgroundSubagentRunner, launchSignal?: AbortSignal): Promise<BackgroundSubagentRecord> {
    const sessionId = requiredString(input.sessionId, "session id", 512);
    const session = this.sessionState(sessionId);
    const launchGeneration = session.generation;
    if (session.phase !== "active") throw new Error("Owning Pi session is not accepting background subagent launches");
    if (launchSignal?.aborted) {
      throw launchSignal.reason instanceof Error ? launchSignal.reason : new Error("Background subagent launch cancelled");
    }
    await this.initialize();
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
    const record: BackgroundSubagentRecord = {
      schemaVersion: SCHEMA_VERSION,
      id,
      sessionId,
      backend: input.backend,
      mode: input.mode,
      summary: boundedText(input.summary, 2048) || "subagent task",
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
      (outcome) => this.finish(id, controller.signal.aborted ? "cancelled" : outcome.failed ? "failed" : "completed", outcome.text, undefined, outcome.reports),
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

  private async persistReports(id: string, reports: RetainedSubagentReport[]): Promise<BackgroundSubagentArtifact[]> {
    const artifacts: BackgroundSubagentArtifact[] = [];
    const selected = reports.slice(0, 8);
    const fairLimit = Math.min(MAX_RETAINED_SUBAGENT_REPORT_BYTES, Math.floor(MAX_RETAINED_SUBAGENT_JOB_BYTES / Math.max(1, selected.length)));
    for (let index = 0; index < selected.length; index++) {
      const report = selected[index];
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
      await writeAtomicBytes(this.artifactPath(id, index + 1), retained);
      artifacts.push({
        child: index + 1,
        label: boundedText(report.label, 256) || `result ${index + 1}`,
        bytes: retained.byteLength,
        totalBytes: Math.max(source.byteLength, report.totalBytes ?? 0),
        complete: report.complete !== false && retained.byteLength === source.byteLength,
        sha256: createHash("sha256").update(retained).digest("hex"),
      });
    }
    return artifacts;
  }

  private async finish(id: string, status: "completed" | "failed" | "cancelled", text: string, error?: string, reports?: RetainedSubagentReport[]): Promise<void> {
    const record = this.records.get(id);
    if (!record || !["running", "cancelling"].includes(record.status)) return;
    const timer = this.runtime.flushTimers.get(id);
    if (timer) clearTimeout(timer);
    this.runtime.flushTimers.delete(id);
    record.result = boundedText(text || record.latest || "(no output)");
    record.latest = record.result;
    if (error) record.error = boundedText(error, 4096);
    try {
      const retainedReports = reports?.filter((report) => report.text.trim()) ?? [];
      record.artifacts = await this.persistReports(id, retainedReports.length ? retainedReports : [{ label: "result", text: text || record.latest || "(no output)" }]);
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
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown background subagent: ${id}`);
    return structuredClone(record);
  }

  async readResult(id: string, child: number | undefined = undefined, offset = 0, limit = MAX_SUBAGENT_RESULT_PAGE_BYTES): Promise<BackgroundSubagentResultPage> {
    const record = await this.get(id);
    if (isBackgroundSubagentActive(record)) throw new Error("Background subagent result is not ready");
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Result offset must be a non-negative integer");
    if (!Number.isSafeInteger(limit) || limit < 4 || limit > MAX_SUBAGENT_RESULT_PAGE_BYTES) throw new Error(`Result limit must be between 4 and ${MAX_SUBAGENT_RESULT_PAGE_BYTES} bytes`);
    let artifacts = record.artifacts ?? [];
    const legacyResult = record.result || record.latest;
    if (artifacts.length === 0 && legacyResult) {
      const current = this.records.get(id);
      if (!current) throw new Error(`Unknown background subagent: ${id}`);
      current.artifacts = await this.persistReports(id, [{ label: "result", text: legacyResult, totalBytes: Buffer.byteLength(legacyResult, "utf8") + 1, complete: false }]);
      await this.persist(current);
      artifacts = current.artifacts;
    }
    if (artifacts.length === 0) throw new Error("No retained result artifact is available for this background subagent");
    if (artifacts.length > 1 && child === undefined) throw new Error("Parallel and chain results require a child number");
    child ??= 1;
    const artifact = artifacts.find((candidate) => candidate.child === child);
    if (!artifact) throw new Error(`Background subagent result child ${child} is unavailable`);
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
      return {
        child,
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
    const session = this.sessionState(sessionId);
    const adopted = session.phase === "reloading";
    if (session.phase !== "active") {
      session.phase = "active";
      session.generation += 1;
    }
    this.clearReloadWatchdog(sessionId);
    return adopted;
  }

  adoptReload(sessionId: string): boolean {
    const session = this.sessionState(sessionId);
    if (session.phase !== "reloading") return false;
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

export function sharedBackgroundSubagentManager(root: string): BackgroundSubagentManager {
  const globals = globalThis as Record<string, unknown>;
  let managers = globals[MANAGERS_KEY] as Map<string, BackgroundSubagentManager> | undefined;
  if (!managers) {
    managers = new Map();
    globals[MANAGERS_KEY] = managers;
  }
  let manager = managers.get(root);
  if (!manager) {
    manager = new BackgroundSubagentManager(root);
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
      if (existing) {
        existing.label = boundedText(descriptor.label, 256) || existing.label;
        if (descriptor.task?.trim()) existing.task = boundedText(descriptor.task, 2048);
      } else {
        group.children.set(child, {
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
      const next: BackgroundSubagentChild = {
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
  if (existing && typeof existing.register === "function" && typeof existing.update === "function"
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
