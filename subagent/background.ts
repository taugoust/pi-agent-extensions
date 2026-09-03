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
export const MAX_BACKGROUND_SUBAGENTS = 8;
export const MAX_BACKGROUND_SUBAGENT_TEXT_BYTES = 50 * 1024;
const MAX_STATE_BYTES = 128 * 1024;
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TERMINAL_RECORDS = 100;
const SCHEMA_VERSION = 2;

export type BackgroundSubagentStatus = "running" | "cancelling" | "completed" | "failed" | "cancelled" | "lost";
export type BackgroundSubagentBackend = "native" | "agentsh";

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

type RuntimeRegistry = {
  controllers: Map<string, AbortController>;
  flushTimers: Map<string, NodeJS.Timeout>;
};

const RUNTIME_KEY = "__paeBackgroundSubagentRuntimeV2";
const MANAGERS_KEY = "__paeBackgroundSubagentManagersV2";

function runtimeRegistry(): RuntimeRegistry {
  const root = globalThis as Record<string, unknown>;
  const existing = root[RUNTIME_KEY] as RuntimeRegistry | undefined;
  if (existing) return existing;
  const created: RuntimeRegistry = { controllers: new Map(), flushTimers: new Map() };
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
  private initialized?: Promise<void>;
  private ownerStartToken = "";

  constructor(readonly root: string) {}

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
  }, runner: BackgroundSubagentRunner): Promise<BackgroundSubagentRecord> {
    await this.initialize();
    const active = [...this.records.values()].filter((record) => record.status === "running" || record.status === "cancelling");
    if (active.length >= MAX_BACKGROUND_SUBAGENTS) throw new Error(`Background subagent concurrency limit reached (${MAX_BACKGROUND_SUBAGENTS})`);
    const now = new Date().toISOString();
    const id = `subagent-job-${randomBytes(12).toString("hex")}`;
    const record: BackgroundSubagentRecord = {
      schemaVersion: SCHEMA_VERSION,
      id,
      sessionId: requiredString(input.sessionId, "session id", 512),
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
    this.records.set(id, record);
    try {
      await mkdir(this.jobDir(id), { mode: 0o700 });
      await this.persist(record);
    } catch (error) {
      this.records.delete(id);
      await rm(this.jobDir(id), { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    const controller = new AbortController();
    this.runtime.controllers.set(id, controller);
    void Promise.resolve().then(() => runner(controller.signal, (text) => this.updateProgress(id, text))).then(
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

  requestCancelSession(sessionId: string): void {
    for (const record of this.records.values()) {
      if (record.sessionId === sessionId && isBackgroundSubagentActive(record)) {
        this.runtime.controllers.get(record.id)?.abort(new Error("Owning Pi session shut down"));
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

export function backgroundSubagentLine(record: BackgroundSubagentRecord): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(record.createdAt)) / 1000));
  const age = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;
  return `${record.id}  ${record.status}  ${age}  ${record.backend}/${record.mode}  ${record.summary.replace(/\s+/g, " ")}`;
}
