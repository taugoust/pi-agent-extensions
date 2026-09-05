import { randomBytes } from "node:crypto";
import { constants, writeFileSync } from "node:fs";
import { access, lstat, open, readFile, realpath, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative } from "node:path";
import { processStartToken, type JobProcessBackend } from "./tmux.js";
import { JobStore } from "./store.js";
import {
  JOB_SCHEMA_VERSION,
  type JobMetadata,
  type JobRecord,
  type JobResult,
  type OutputSnapshot,
} from "./types.js";

const MAX_COMMAND_BYTES = 32 * 1024;
const MAX_ENVIRONMENT_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2000;
const MAX_RUNNING = 8;
const MAX_RUNNING_PER_CWD = 4;
const MAX_WAIT_MS = 30_000;
const STARTING_GRACE_MS = 30_000;

export type StartRequest = {
  command: string;
  cwd: string;
  name?: string;
  sessionId?: string;
  childId?: string;
  infrastructure?: boolean;
};

function result(status: JobResult["status"], exitCode: number | null, reason?: string, signal?: string): JobResult {
  return {
    schemaVersion: JOB_SCHEMA_VERSION,
    status,
    exitCode,
    finishedAt: new Date().toISOString(),
    ...(reason === undefined ? {} : { reason }),
    ...(signal === undefined ? {} : { signal }),
  };
}

function abortError(): Error {
  const error = new Error("Background job wait was cancelled; the job is still running");
  error.name = "AbortError";
  return error;
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    function finish() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(abortError());
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function sanitizeOutput(text: string): string {
  return text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[P_^][\s\S]*?\x1b\\/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export function boundedTail(text: string): { text: string; truncated: boolean } {
  const clean = sanitizeOutput(text);
  const lines = clean.split("\n");
  let selected = lines.length > MAX_OUTPUT_LINES ? lines.slice(-MAX_OUTPUT_LINES) : lines;
  let value = selected.join("\n");
  let truncated = selected.length !== lines.length;
  let bytes = Buffer.from(value, "utf8");
  if (bytes.length > MAX_OUTPUT_BYTES) {
    bytes = bytes.subarray(bytes.length - MAX_OUTPUT_BYTES);
    while (bytes.length > 0 && (bytes[0]! & 0xc0) === 0x80) bytes = bytes.subarray(1);
    value = bytes.toString("utf8");
    truncated = true;
  }
  return { text: value, truncated };
}

export function snapshotEnvironment(environment: NodeJS.ProcessEnv = process.env): Buffer {
  const entries: Buffer[] = [];
  for (const [name, value] of Object.entries(environment).sort(([a], [b]) => a.localeCompare(b))) {
    if (value === undefined || name === "TMUX" || name === "TMUX_PANE") continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value.includes("\0")) continue;
    entries.push(Buffer.from(`${name}=${value}\0`, "utf8"));
  }
  const bytes = Buffer.concat(entries);
  if (bytes.length > MAX_ENVIRONMENT_BYTES) throw new Error("Background job environment exceeds 1 MiB");
  return bytes;
}

export async function resolveExecutable(name: string, environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (isAbsolute(name)) {
    await access(name, constants.X_OK);
    return await realpath(name);
  }
  for (const directory of (environment.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try { await access(candidate, constants.X_OK); return await realpath(candidate); } catch {}
  }
  throw new Error(`Required executable not found in PATH: ${name}`);
}

export class BackgroundJobManager {
  constructor(readonly store: JobStore, readonly backend: JobProcessBackend) {}

  async start(request: StartRequest, signal?: AbortSignal): Promise<JobRecord> {
    if (signal?.aborted) throw abortError();
    if (!request.command || Buffer.byteLength(request.command, "utf8") > MAX_COMMAND_BYTES) {
      throw new Error("Background job command must be between 1 and 32768 UTF-8 bytes");
    }
    if (request.name !== undefined && (!request.name.trim() || Buffer.byteLength(request.name, "utf8") > 80)) {
      throw new Error("Background job name must be between 1 and 80 UTF-8 bytes");
    }
    const cwd = await realpath(request.cwd);
    const shell = await resolveExecutable("bash");
    const environment = snapshotEnvironment();

    return await this.store.withLock(async () => {
      const records = await this.list(1000, false);
      await this.prune(records);
      const active = records.filter((record) => !record.metadata.observed && !record.metadata.infrastructure && (record.status === "starting" || record.status === "running"));
      if (!request.infrastructure && active.length >= MAX_RUNNING) throw new Error(`Background job limit reached (${MAX_RUNNING} running)`);
      if (!request.infrastructure && active.filter((record) => record.metadata.cwd === cwd).length >= MAX_RUNNING_PER_CWD) {
        throw new Error(`Background job limit reached for ${cwd} (${MAX_RUNNING_PER_CWD} running)`);
      }

      const id = `job-${randomBytes(12).toString("hex")}`;
      const metadata: JobMetadata = {
        schemaVersion: JOB_SCHEMA_VERSION,
        id,
        ...(request.name === undefined ? {} : { name: request.name.trim() }),
        command: request.command,
        cwd,
        shell,
        createdAt: new Date().toISOString(),
        ownerPid: process.pid,
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        ...(request.childId ? { childId: request.childId } : {}),
        ...(request.infrastructure ? { infrastructure: true } : {}),
      };
      await this.store.create(metadata, request.command, environment);
      const cancelPath = join(this.store.jobDir(id), "cancel-requested");
      let acceptingAbort = true;
      const onAbort = () => {
        if (!acceptingAbort) return;
        try { writeFileSync(cancelPath, "start aborted\n", { mode: 0o600, flag: "wx" }); } catch {}
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        if (signal?.aborted) {
          onAbort();
          const cancelled = result("cancelled", null, "start was aborted before launch", "SIGTERM");
          await this.store.publishResult(id, cancelled);
          throw abortError();
        }
        const launch = await this.backend.launch(id, cwd, this.store.jobDir(id), shell);
        await this.store.writeLaunch(id, launch);
        const cancelled = await this.store.readResult(id);
        if (cancelled || signal?.aborted || await this.store.exists(join(this.store.jobDir(id), "cancel-requested"))) {
          await this.backend.kill(id, launch).catch(() => undefined);
          await Promise.all([
            import("node:fs/promises").then(({ rm }) => rm(this.store.path(id, "environment"), { force: true })).catch(() => undefined),
            import("node:fs/promises").then(({ rm }) => rm(this.store.path(id, "command"), { force: true })).catch(() => undefined),
          ]);
          if (!cancelled) await this.store.publishResult(id, result("cancelled", null, "start was cancelled during launch", "SIGTERM"));
          if (signal?.aborted) throw abortError();
          return await this.get(id);
        }
        await writeFile(join(this.store.jobDir(id), "launch-ready"), "ready\n", { mode: 0o600, flag: "wx" });
        if (signal?.aborted || await this.store.exists(join(this.store.jobDir(id), "cancel-requested"))) {
          await this.backend.kill(id, launch).catch(() => undefined);
          await this.store.publishResult(id, result("cancelled", null, "start was cancelled as its launch gate opened", "SIGTERM"));
          if (signal?.aborted) throw abortError();
          return await this.get(id);
        }
        return { metadata, launch, status: "running" };
      } catch (error) {
        await Promise.all([
          import("node:fs/promises").then(({ rm }) => rm(this.store.path(id, "environment"), { force: true })).catch(() => undefined),
          import("node:fs/promises").then(({ rm }) => rm(this.store.path(id, "command"), { force: true })).catch(() => undefined),
        ]);
        await this.store.publishResult(id, result("failed", 125, `launch failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1024)));
        throw error;
      } finally {
        acceptingAbort = false;
        signal?.removeEventListener("abort", onAbort);
      }
    });
  }

  private async commandProcess(id: string): Promise<{ pid: number } | undefined> {
    const identity = await this.store.readProcess(id);
    if (!identity) return undefined;
    try {
      return await processStartToken(identity.pid) === identity.startToken ? { pid: identity.pid } : undefined;
    } catch { return undefined; }
  }

  private async signalCommandProcess(id: string, signal: NodeJS.Signals): Promise<boolean> {
    const processIdentity = await this.commandProcess(id);
    if (!processIdentity) return false;
    try { process.kill(-processIdentity.pid, signal); return true; }
    catch { return false; }
  }

  async adopt(request: { pid: number; logPath: string; cwd: string; sessionId: string; childId?: string; name?: string }): Promise<JobRecord> {
    if (process.platform !== "linux" || !Number.isSafeInteger(request.pid) || request.pid < 1) throw new Error("adopt requires a Linux process identity");
    const cwd = await realpath(request.cwd);
    const logPath = await realpath(request.logPath);
    const processCwd = await realpath(`/proc/${request.pid}/cwd`);
    for (const candidate of [logPath, processCwd]) {
      const rel = relative(cwd, candidate);
      if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("Adopted process and log must be within the delegated cwd");
    }
    const owner = await lstat(`/proc/${request.pid}`);
    const log = await lstat(logPath);
    if (owner.uid !== process.getuid?.() || log.uid !== process.getuid?.() || !log.isFile()) throw new Error("Adoption requires same-user process and regular log");
    const startToken = await processStartToken(request.pid);
    return await this.store.withLock(async () => {
      const records = await this.list(1000);
      const existing = records.find(r => r.metadata.sessionId === request.sessionId && r.metadata.childId === request.childId && r.metadata.observed?.pid === request.pid && r.metadata.observed?.startToken === startToken && r.metadata.observed?.logPath === logPath);
      if (existing) return existing;
      const metadata: JobMetadata = { schemaVersion: 1, id: `job-${randomBytes(12).toString("hex")}`, name: request.name,
        command: "(adopted process; observation only)", shell: "", cwd, createdAt: new Date().toISOString(), ownerPid: process.pid,
        sessionId: request.sessionId, childId: request.childId,
        observed: { pid: request.pid, startToken, logPath, logDevice: log.dev, logInode: log.ino } };
      // shell remains nonempty for compatibility with the existing metadata schema.
      metadata.shell = "(external)";
      if (await processStartToken(request.pid) !== startToken) throw new Error("Process identity changed during adoption");
      await this.store.create(metadata, "", Buffer.alloc(0));
      return { metadata, status: "running" };
    });
  }

  async get(id: string, reconcile = true): Promise<JobRecord> {
    const metadata = await this.store.readMetadata(id);
    const terminal = await this.store.readResult(id);
    const launch = await this.store.readLaunch(id);
    if (terminal) return { metadata, launch, result: terminal, status: terminal.status };
    if (metadata.observed) {
      try {
        if (await processStartToken(metadata.observed.pid) === metadata.observed.startToken) return { metadata, status: "running" };
      } catch {}
      const ended = result("lost", null, "Observed process ended or changed identity; exit status is unavailable (not a success assertion)");
      if (reconcile) await this.store.publishResult(id, ended);
      return { metadata, result: ended, status: "lost" };
    }
    if (!launch) {
      if (reconcile && Date.now() - Date.parse(metadata.createdAt) > STARTING_GRACE_MS) {
        const lost = result("lost", null, "launch metadata was never published");
        await this.store.publishResult(id, lost);
        return { metadata, result: await this.store.readResult(id) ?? lost, status: "lost" };
      }
      return { metadata, status: "starting" };
    }
    const pane = await this.backend.paneState(id, launch);
    if (pane.exists && !pane.dead) return { metadata, launch, status: "running" };
    await sleep(50);
    const lateResult = await this.store.readResult(id);
    if (lateResult) return { metadata, launch, result: lateResult, status: lateResult.status };
    if (await this.commandProcess(id)) return { metadata, launch, status: "running" };
    if (!reconcile) return { metadata, launch, status: "lost" };
    const lost = result("lost", null, pane.dead ? "tmux pane exited without a result" : "owned tmux pane is missing or has a different process identity");
    await this.store.publishResult(id, lost);
    const final = await this.store.readResult(id) ?? lost;
    return { metadata, launch, result: final, status: final.status };
  }

  async list(limit = 50, reconcile = true): Promise<JobRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("List limit must be between 1 and 1000");
    const ids = await this.store.listIds();
    const records: JobRecord[] = [];
    for (const id of ids) {
      try { records.push(await this.get(id, reconcile)); } catch {}
    }
    records.sort((a, b) => b.metadata.createdAt.localeCompare(a.metadata.createdAt));
    return records.slice(0, limit);
  }

  async output(id: string): Promise<OutputSnapshot> {
    const record = await this.get(id);
    if (record.metadata.observed) {
      const observed = record.metadata.observed;
      const fd = await open(observed.logPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await fd.stat();
        if (!info.isFile() || info.dev !== observed.logDevice || info.ino !== observed.logInode) throw new Error("Adopted log identity changed; re-adopt explicitly");
        const bytes = Buffer.alloc(Math.min(info.size, 64 * 1024));
        const { bytesRead } = await fd.read(bytes, 0, bytes.length, Math.max(0, info.size - bytes.length));
        const bounded = boundedTail(bytes.subarray(0, bytesRead).toString("utf8"));
        return { ...bounded, truncated: bounded.truncated || info.size > bytes.length, source: "log" };
      } finally { await fd.close(); }
    }
    let raw = "";
    let source: OutputSnapshot["source"] = "none";
    try {
      const outputPath = this.store.path(id, "output.log");
      const info = await lstat(outputPath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Background job output is not a regular file");
      if (info.size > 1024 * 1024) throw new Error("Background job output exceeds its persistent 1 MiB bound");
      raw = await readFile(outputPath, "utf8");
      source = "log";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!raw && record.launch) {
      raw = await this.backend.capture(id, record.launch);
      source = raw ? "pane" : "none";
    }
    const bounded = boundedTail(raw);
    if (record.result) await this.store.markNotified(id);
    return { ...bounded, source };
  }

  async wait(id: string, timeoutMs = 1000, signal?: AbortSignal): Promise<{ record: JobRecord; timedOut: boolean }> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_WAIT_MS) {
      throw new Error(`Wait timeout must be an integer between 0 and ${MAX_WAIT_MS}ms`);
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (signal?.aborted) throw abortError();
      const record = await this.get(id);
      if (record.result) {
        await this.store.markNotified(id);
        return { record, timedOut: false };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { record, timedOut: true };
      await sleep(Math.min(200, remaining), signal);
    }
  }

  async signal(id: string, signal: "SIGINT" | "SIGTERM"): Promise<JobRecord> {
    const record = await this.get(id);
    if (record.metadata.observed) throw new Error("Adopted jobs are observation-only; no signal authority was acquired");
    if (record.status !== "running" || !record.launch) throw new Error(`Background job ${id} is not running`);
    try { await this.backend.signal(id, record.launch, signal); }
    catch (error) {
      if (!(await this.signalCommandProcess(id, signal))) throw error;
    }
    return record;
  }

  async cancel(id: string): Promise<JobRecord> {
    const record = await this.get(id);
    if (record.metadata.observed) throw new Error("Adopted jobs are observation-only; no cancellation authority was acquired");
    if (record.result) {
      if (record.status === "lost" && await this.commandProcess(id)) {
        await this.signalCommandProcess(id, "SIGKILL");
        if (await this.commandProcess(id)) throw new Error(`Failed to terminate lost background job ${id}`);
      }
      return record;
    }
    try {
      const marker = await open(join(this.store.jobDir(id), "cancel-requested"), "wx", 0o600);
      await marker.close();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (!record.launch) {
      const cancelled = result("cancelled", null, "cancelled before launch", "SIGTERM");
      await this.store.publishResult(id, cancelled);
      return await this.get(id);
    }
    try { await this.backend.signal(id, record.launch, "SIGTERM"); }
    catch { await this.signalCommandProcess(id, "SIGTERM"); }
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const terminal = await this.store.readResult(id);
      if (terminal) return await this.get(id);
      await sleep(100);
    }
    await this.signalCommandProcess(id, "SIGKILL");
    await this.backend.kill(id, record.launch).catch(() => undefined);
    if (await this.commandProcess(id)) throw new Error(`Failed to terminate background job ${id}`);
    await this.store.publishResult(id, result("cancelled", null, "cancelled by background_job", "SIGKILL"));
    return await this.get(id);
  }

  private async prune(records: JobRecord[]): Promise<void> {
    const terminal = records
      .filter((record) => record.result)
      .sort((a, b) => b.metadata.createdAt.localeCompare(a.metadata.createdAt));
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const expired = terminal.filter((record, index) => index >= 100 || Date.parse(record.result!.finishedAt) < cutoff);
    for (const record of expired) {
      if (record.launch) await this.backend.kill(record.metadata.id, record.launch).catch(() => undefined);
      await this.store.remove(record.metadata.id).catch(() => undefined);
    }
  }

  async remove(id: string): Promise<void> {
    const record = await this.get(id);
    if (record.status === "starting" || record.status === "running") {
      throw new Error(`Background job ${id} is still running; cancel it first`);
    }
    if (record.launch) await this.backend.kill(id, record.launch).catch(() => undefined);
    await this.store.remove(id);
  }
}
