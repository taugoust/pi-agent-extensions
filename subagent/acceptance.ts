// Explicit gate parsing and typed-output validation adapted from nicobailon/pi-subagents
// src/runs/shared/acceptance.ts at 3ce6185a. MIT, Copyright (c) 2026 Nico Bailon.
// See agents/LICENSE and THIRD_PARTY.md. No upstream shell runner or cache is used.
import { createHash, randomBytes } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, readSync, opendirSync, lstatSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import type { JobParams } from "../shared/background-job.ts";

export type VerificationGate = { command: string; timeoutMs?: number; output?: "json"; schema?: Record<string, unknown>;
  verdict?: { path: string[]; equals: string | number | boolean | null } };
export type VerificationIdentity = { ownerSessionId: string; taskId: string; childId: string; attempt: number; workerEpoch: string; runtimeId: string; cwd: string };
export type VerificationStatus = "not-configured" | "checking" | "passed" | "failed" | "unavailable" | "interrupted" | "cancelled" | "timed-out" | "stale";
export type VerificationRun = { gate: VerificationGate; status: VerificationStatus; startedAt: string; finishedAt?: string; durationMs?: number;
  jobId?: string; dispatchId?: string; exitCode: number | null; signal?: string; stdout: string; stderr: string; truncated: boolean; error?: string;
  structuredOutput?: unknown; businessVerdict?: boolean; workspaceBefore?: string; workspaceAfter?: string;
  dispatchState?: "not-dispatched" | "intent" | "observed" | "cleanup-pending" | "cleaned"; evidenceCaptured?: boolean };
export type VerificationRecord = { version: 1; identity: VerificationIdentity; contract: string; status: VerificationStatus; runs: VerificationRun[] };
export type VerificationJobs = { start(callId: string, command: string, signal?: AbortSignal): Promise<any>;
  execute(callId: string, params: JobParams, signal?: AbortSignal): Promise<any>;
  /** Trusted supervisor metadata lookup, not a model-provided job ID/name claim. */
  resolve?(callId: string, command: string, jobId?: string): Promise<string | null | undefined>;
  /** Re-read actual supervisor result/streams and bind them to this dispatch/cwd/command. */
  attest?(run: VerificationRun, identity: VerificationIdentity): Promise<boolean> };
// Process-private receipts are intentionally not serialized. Worker JSON, even a
// perfectly shaped record with matching fingerprints, is never verification authority.
const liveReceipts = new WeakMap<VerificationRecord, string>();
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const scalar = (v: unknown) => v === null || typeof v === "string" || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v);

/** Intentionally bounded, local JSON Schema subset; unsupported keywords fail closed. */
function schemaCheck(schema: unknown, value: unknown, validateOnly = false, depth = 0): boolean {
  if (depth > 16 || !object(schema)) throw new Error("Invalid or overly nested gate.schema");
  const supported = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength", "description", "title"]);
  for (const k of Object.keys(schema)) if (!supported.has(k)) throw new Error(`Unsupported gate.schema keyword: ${k}`);
  if (schema.type !== undefined && !["object", "array", "string", "number", "integer", "boolean", "null"].includes(schema.type)) throw new Error("Invalid gate.schema.type");
  if (schema.properties !== undefined && !object(schema.properties)) throw new Error("Invalid gate.schema.properties");
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((k: unknown) => typeof k !== "string"))) throw new Error("Invalid gate.schema.required");
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") throw new Error("Invalid gate.schema.additionalProperties");
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.some((v: unknown) => !scalar(v)))) throw new Error("gate.schema.enum supports nonempty scalar arrays only");
  if (Object.hasOwn(schema, "const") && !scalar(schema.const)) throw new Error("gate.schema.const supports scalars only");
  for (const k of ["minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength"]) if (schema[k] !== undefined && (typeof schema[k] !== "number" || !Number.isFinite(schema[k]) || (k !== "minimum" && k !== "maximum" && (!Number.isSafeInteger(schema[k]) || schema[k] < 0)))) throw new Error(`Invalid gate.schema.${k}`);
  for (const nested of Object.values(schema.properties ?? {})) schemaCheck(nested, undefined, true, depth + 1);
  if (schema.items !== undefined) schemaCheck(schema.items, undefined, true, depth + 1);
  if (validateOnly) return true;
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (schema.type && !(schema.type === type || schema.type === "integer" && typeof value === "number" && Number.isInteger(value))) return false;
  if (schema.enum && !schema.enum.some((v: unknown) => v === value) || Object.hasOwn(schema, "const") && schema.const !== value) return false;
  if (object(value)) {
    if (schema.required?.some((k: string) => !Object.hasOwn(value, k))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(k => !Object.hasOwn(schema.properties ?? {}, k))) return false;
    for (const [k, nested] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(value, k) && !schemaCheck(nested, value[k], false, depth + 1)) return false;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.items && value.some(v => !schemaCheck(schema.items, v, false, depth + 1))) return false;
  }
  if (typeof value === "string" && (schema.minLength !== undefined && [...value].length < schema.minLength || schema.maxLength !== undefined && [...value].length > schema.maxLength)) return false;
  if (typeof value === "number" && (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)) return false;
  return true;
}

/** Adapted from upstream parseGateInput; no cwd/env/allowFailure or inferred gates. */
export function validateVerification(input: unknown): VerificationGate[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length < 1 || input.length > 8 || Buffer.byteLength(JSON.stringify(input)) > 32 * 1024) throw new Error("verification requires 1–8 bounded explicit gates");
  return input.map(g => {
    if (!object(g)) throw new Error("verification gate must be an object");
    for (const k of Object.keys(g)) if (!["command", "timeoutMs", "output", "schema", "verdict"].includes(k)) throw new Error(`gate.${k} is not supported`);
    if (typeof g.command !== "string" || !g.command.trim() || Buffer.byteLength(g.command) > 8192) throw new Error("gate requires a bounded non-empty command");
    if (g.output !== undefined && g.output !== "json") throw new Error('gate.output must be "json"');
    if (g.timeoutMs !== undefined && (!Number.isSafeInteger(g.timeoutMs) || g.timeoutMs < 1 || g.timeoutMs > 600_000)) throw new Error("gate.timeoutMs must be 1–600000");
    if (g.schema !== undefined) { if (g.output !== "json") throw new Error('gate.schema requires output: "json"'); schemaCheck(g.schema, undefined, true); }
    if (g.verdict !== undefined && (g.output !== "json" || !object(g.verdict) || Object.keys(g.verdict).some(k => !["path", "equals"].includes(k)) || !Array.isArray(g.verdict.path) || g.verdict.path.length > 16 || g.verdict.path.some((k: unknown) => typeof k !== "string" || k.length > 256) || !Object.hasOwn(g.verdict, "equals") || !scalar(g.verdict.equals))) throw new Error("gate.verdict requires JSON output, path and scalar equals");
    return structuredClone(g) as VerificationGate;
  });
}
export const verificationContract = (gates: VerificationGate[]) => hash(JSON.stringify(gates));
export function initialVerification(identity: VerificationIdentity, gates: VerificationGate[]): VerificationRecord {
  return { version: 1, identity: structuredClone(identity), contract: verificationContract(gates), status: gates.length ? "interrupted" : "not-configured", runs: [] };
}

/** Cwd tree bytes/modes, including untracked/ignored files, excluding only .git metadata.
 * No git/shell execution, environment fingerprint, cache, or claim of full reproducibility.
 * Refuse symlinks/special files and oversized trees rather than omit relevant inputs. */
export function workspaceIdentity(cwd: string): string {
  const actualCwd = realpathSync(cwd), digest = createHash("sha256");
  let root = actualCwd;
  // Include sibling inputs when cwd is nested inside a Git worktree. Do not run
  // git or follow its metadata links; this is a byte-tree identity, not a revision claim.
  for (let directory = actualCwd; ; directory = dirname(directory)) {
    try { lstatSync(join(directory, ".git")); root = directory; break; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    if (dirname(directory) === directory) break;
  }
  let files = 0, bytes = 0;
  const visit = (directory: string, relative: string, depth: number) => {
    if (depth > 64) throw new Error("Workspace identity depth limit exceeded");
    const handle = opendirSync(directory), names: string[] = [];
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        if (entry.name === ".git") continue;
        if (names.length + files >= 20_000) throw new Error("Workspace identity file limit exceeded");
        names.push(entry.name);
      }
    } finally { handle.closeSync(); }
    for (const name of names.sort()) {
      if (name === ".git") continue;
      if (++files > 20_000) throw new Error("Workspace identity file limit exceeded");
      const path = join(directory, name), key = `${relative}/${name}`, s = lstatSync(path);
      if (s.isSymbolicLink() || !s.isDirectory() && !s.isFile()) throw new Error(`Workspace identity unsupported entry: ${key}`);
      digest.update(JSON.stringify([key, s.mode]));
      if (s.isDirectory()) visit(path, key, depth + 1);
      else {
        if ((bytes += s.size) > 64 * 1024 * 1024) throw new Error("Workspace identity byte limit exceeded");
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const before = fstatSync(fd), content = createHash("sha256"), chunk = Buffer.alloc(Math.min(s.size + 1, 64 * 1024));
          let length = 0, count = 0;
          while (length <= s.size && (count = readSync(fd, chunk, 0, Math.min(chunk.length, s.size + 1 - length), null)) > 0) { content.update(chunk.subarray(0, count)); length += count; }
          const after = fstatSync(fd);
          if (length !== s.size || before.ino !== s.ino || before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error("Workspace changed during identity capture");
          digest.update(content.digest("hex"));
        } finally { closeSync(fd); }
      }
    }
  };
  digest.update(JSON.stringify({ root, cwd: actualCwd })); visit(root, "", 0); return digest.digest("hex");
}

/** Adapted from upstream applyTypedVerifyOutput. Literal streams are never trimmed. */
export function applyTypedVerifyOutput(gate: VerificationGate, run: VerificationRun): void {
  if (run.status !== "passed" || gate.output !== "json") return;
  try {
    if (!run.stdout.trim()) throw new Error('output: "json" command printed nothing on stdout');
    if (run.truncated) throw new Error('output: "json" stdout/stderr was truncated');
    const value = JSON.parse(run.stdout);
    if (gate.schema && !schemaCheck(gate.schema, value)) throw new Error('output: "json" stdout does not match gate.schema');
    run.structuredOutput = value;
    if (gate.verdict) {
      let actual: unknown = value;
      for (const key of gate.verdict.path) actual = object(actual) && Object.hasOwn(actual, key) ? actual[key] : undefined;
      run.businessVerdict = actual === gate.verdict.equals;
      if (!run.businessVerdict) throw new Error("Configured business verdict rejected output (command exit remains 0)");
    }
  } catch (e) { run.status = "failed"; run.error = String(e).slice(0, 1024); }
}

function captureEvidence(run: VerificationRun, response: any): void {
  const d = response?.details;
  if (!d || d.job_id !== run.jobId || !["completed", "failed", "cancelled", "lost"].includes(d.status)
    || response?.isError && d.status !== "failed" || d.streams?.available !== true
    || typeof d.streams.stdout !== "string" || typeof d.streams.stderr !== "string"
    || d.exit_code !== null && !Number.isSafeInteger(d.exit_code)
    || Buffer.byteLength(d.streams.stdout) > 50 * 1024 || Buffer.byteLength(d.streams.stderr) > 50 * 1024) throw new Error("Literal terminal verification evidence unavailable/invalid; retain job logs");
  run.stdout = d.streams.stdout; run.stderr = d.streams.stderr;
  run.truncated = !!(d.streams.stdout_truncated || d.streams.stderr_truncated);
  run.exitCode = d.exit_code;
  if (typeof d.signal === "string") run.signal = d.signal;
}

async function cleanupVerificationRun(run: VerificationRun, identity: VerificationIdentity, jobs: VerificationJobs, persist: () => void): Promise<void> {
  if (run.dispatchState === "cleaned" || run.dispatchState === "not-dispatched") return;
  if (!run.dispatchId || !jobs.resolve) throw new Error("Supervised dispatch resolution unavailable; retain intent and job logs");
  // Even an unavailable/throwing start may have launched a durable process. Resolve
  // by trusted backend metadata, never by a persisted arbitrary job ID alone.
  const resolved = await jobs.resolve(run.dispatchId, run.gate.command, run.jobId);
  if (resolved === null) { run.dispatchState = "not-dispatched"; persist(); return; }
  if (!resolved) throw new Error("Dispatch outcome unconfirmed; retain intent for later recovery, never replay");
  if (!/^job-[a-f0-9]{24}$/.test(resolved)) throw new Error("Invalid resolved verification job");
  run.jobId = resolved; run.dispatchState = "cleanup-pending";
  let durable = true;
  try { persist(); } catch { durable = false; }
  const status = await jobs.execute(run.dispatchId, { action: "status", job_id: resolved });
  if (status?.details?.job_id !== resolved) throw new Error("Verification cleanup ownership/observation unavailable");
  if (["running", "starting"].includes(status.details.status)) {
    const cancelled = await jobs.execute(run.dispatchId, { action: "cancel", job_id: resolved });
    if (cancelled?.isError) throw new Error("Verification cancellation refused");
  } else if (!["completed", "failed", "cancelled", "lost"].includes(status.details.status)) throw new Error("Verification cleanup terminal status unavailable");
  const output = await jobs.execute(run.dispatchId, { action: "output", job_id: resolved });
  captureEvidence(run, output);
  if (!jobs.attest || !await jobs.attest(run, identity)) throw new Error("Verification cleanup evidence attestation unavailable; retain logs");
  run.evidenceCaptured = true;
  if (!durable) throw new Error("Evidence persistence failed; terminal job retained for recovery");
  persist(); // Literal supervisor evidence is durable BEFORE any destructive removal.
  const reaped = await jobs.execute(run.dispatchId, { action: "reap", job_id: resolved });
  if (reaped?.isError) throw new Error("Verification job cleanup refused");
  run.dispatchState = "cleaned"; persist();
}

/** Supervised jobs only. Persist BEFORE dispatch and after every observed transition.
 * No automatic replay: restart is interrupted, with durable job IDs left for recovery/cleanup. */
export async function runVerification(record: VerificationRecord, gates: VerificationGate[], jobs: VerificationJobs | undefined,
  persist: () => void, signal?: AbortSignal): Promise<void> {
  record.status = "checking"; record.runs = []; persist();
  for (const gate of gates) {
    const started = Date.now();
    const run: VerificationRun = { gate, status: "checking", startedAt: new Date(started).toISOString(), exitCode: null, stdout: "", stderr: "", truncated: false };
    record.runs.push(run); persist();
    const callId = `verify:${record.identity.workerEpoch}:${randomBytes(12).toString("hex")}`;
    run.dispatchId = callId; run.dispatchState = "not-dispatched"; persist();
    const deadline = started + (gate.timeoutMs ?? 120_000);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), gate.timeoutMs ?? 120_000);
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    try {
      if (signal?.aborted) { run.status = "cancelled"; break; }
      if (!jobs) throw new Error("Supervised verification backend/permission unavailable");
      run.workspaceBefore = workspaceIdentity(record.identity.cwd); persist();
      if (Date.now() >= deadline) { run.status = "timed-out"; break; }
      run.dispatchState = "intent"; persist();
      const result = await jobs.start(callId, gate.command, combined);
      const details = result?.details;
      if (result?.isError || !/^job-[a-f0-9]{24}$/.test(details?.job_id ?? "")) throw new Error("Verification job start unavailable or ambiguous; inspect owned jobs, never replay automatically");
      run.jobId = details.job_id; run.dispatchState = "observed"; persist();
      let terminal: any;
      for (;;) {
        if (signal?.aborted || Date.now() >= deadline) {
          run.status = signal?.aborted ? "cancelled" : "timed-out";
          await jobs.execute(callId, { action: "cancel", job_id: run.jobId });
          terminal = await jobs.execute(callId, { action: "output", job_id: run.jobId }); break;
        }
        terminal = await jobs.execute(callId, { action: "wait", job_id: run.jobId, timeout_ms: Math.min(1000, Math.max(0, deadline - Date.now())), lines: 2000 });
        if (terminal?.isError && !["completed", "failed", "cancelled", "lost"].includes(terminal?.details?.status)) throw new Error("Verification job observation failed");
        if (["completed", "failed", "cancelled", "lost"].includes(terminal?.details?.status)) break;
        if (terminal?.details?.job_id !== run.jobId || !["running", "starting"].includes(terminal?.details?.status)) throw new Error("Verification supervisor state unavailable");
      }
      const d = terminal?.details;
      captureEvidence(run, terminal);
      if (!jobs.attest || !await jobs.attest(run, record.identity)) throw new Error("Live supervisor attestation unavailable or evidence mismatched");
      run.evidenceCaptured = true;
      if (run.truncated) run.error = "Literal verification streams were truncated; verification cannot pass";
      if (signal?.aborted) run.status = "cancelled";
      else if (timeout.signal.aborted) run.status = "timed-out";
      if (run.status === "checking") run.status = d.status === "completed" && run.exitCode === 0 && !run.truncated ? "passed" : "failed";
      applyTypedVerifyOutput(gate, run);
      run.workspaceAfter = workspaceIdentity(record.identity.cwd);
      if (run.status === "passed" && run.workspaceBefore !== run.workspaceAfter) run.status = "stale";
    } catch (e) { run.status = signal?.aborted ? "cancelled" : timeout.signal.aborted ? "timed-out" : "unavailable"; run.error = String(e).slice(0, 1024); }
    finally {
      clearTimeout(timer);
      run.finishedAt = new Date().toISOString(); run.durationMs = Date.now() - started;
      // Evidence becomes durable before job logs may be removed. On storage failure
      // still cancel active execution, but retain terminal logs for manual recovery.
      let durable = true;
      try { persist(); } catch { durable = false; run.status = "unavailable"; }
      if (jobs) {
        try { await cleanupVerificationRun(run, record.identity, jobs, () => { if (!durable) throw new Error("Evidence persistence failed"); persist(); }); }
        catch (e) { if (!["timed-out", "cancelled"].includes(run.status)) run.status = "unavailable"; run.error = `Cleanup incomplete (${run.jobId ?? run.dispatchId}): ${String(e).slice(0, 1024)}`; if (durable) persist(); }
      }
      if (!durable) throw new Error(`Verification evidence persistence failed; inspect retained job ${run.jobId ?? "(dispatch unconfirmed)"}`);
    }
    if (run.status !== "passed") break;
  }
  record.status = !gates.length ? "not-configured" : record.runs.length === gates.length && record.runs.every(r => r.status === "passed") ? "passed" : record.runs.find(r => r.status !== "passed")?.status ?? "interrupted";
  if (record.status === "passed" && new Set(record.runs.map(r => r.workspaceAfter)).size !== 1) record.status = "stale";
  persist();
  if (record.status === "passed" && record.runs.every(run => run.evidenceCaptured && run.dispatchState === "cleaned")) liveReceipts.set(record, hash(JSON.stringify(record)));
}
export async function recoverVerification(record: VerificationRecord, jobs: VerificationJobs | undefined, persist: () => void): Promise<void> {
  if (!record.runs.some(r => !["cleaned", "not-dispatched"].includes(r.dispatchState ?? "") && (r.dispatchId || r.jobId))) return;
  record.status = "interrupted"; persist();
  if (!jobs) return; // No backend authority: retain IDs/intents, never replay or accept.
  for (const run of record.runs) {
    if (run.dispatchState === "cleaned" || run.dispatchState === "not-dispatched") continue;
    try {
      await cleanupVerificationRun(run, record.identity, jobs, persist);
      run.status = "interrupted"; run.finishedAt = new Date().toISOString(); persist();
    } catch (e) { run.status = "unavailable"; run.error = `Cleanup incomplete (${run.jobId ?? run.dispatchId}): ${String(e).slice(0, 1024)}`; persist(); }
  }
}
export function verificationSummary(record: VerificationRecord) {
  return { ...record, runs: record.runs.map(({ stdout, stderr, structuredOutput, ...run }) => ({ ...run,
    stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr), structuredOutputAvailable: structuredOutput !== undefined })) };
}
export function currentVerification(record: VerificationRecord | undefined, identity: VerificationIdentity, gates: VerificationGate[]): VerificationRecord {
  if (!gates.length) return initialVerification(identity, gates);
  if (!record || record.version !== 1 || record.contract !== verificationContract(gates) || JSON.stringify(record.identity) !== JSON.stringify(identity)
    || !Array.isArray(record.runs) || record.runs.length > gates.length) return initialVerification(identity, gates);
  const result = structuredClone(record);
  for (const [index, run] of result.runs.entries()) {
    if (!run || JSON.stringify(run.gate) !== JSON.stringify(gates[index]) || typeof run.stdout !== "string" || typeof run.stderr !== "string"
      || Buffer.byteLength(run.stdout) > 50 * 1024 || Buffer.byteLength(run.stderr) > 50 * 1024 || typeof run.truncated !== "boolean"
      || run.exitCode !== null && !Number.isSafeInteger(run.exitCode)) return initialVerification(identity, gates);
    if (run.status === "passed" && (run.exitCode !== 0 || run.truncated || !/^[a-f0-9]{64}$/.test(run.workspaceAfter ?? "") || run.workspaceBefore !== run.workspaceAfter)) run.status = "failed";
    applyTypedVerifyOutput(gates[index], run);
  }
  if (result.status === "passed" && liveReceipts.get(record) !== hash(JSON.stringify(record))) result.status = "interrupted";
  if (result.status === "passed" && result.runs.some(run => run.status !== "passed")) result.status = "failed";
  if (result.status === "checking") result.status = "interrupted";
  if (result.status === "passed") {
    try { const now = workspaceIdentity(identity.cwd); if (result.runs.length !== gates.length || result.runs.some(r => r.status !== "passed" || r.workspaceAfter !== now)) result.status = "stale"; }
    catch { result.status = "unavailable"; }
  }
  return result;
}
