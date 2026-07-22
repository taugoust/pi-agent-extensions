import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import type {
  AgentSHActor,
  AgentSHExecResult,
  AgentSHPiAPI,
  AgentSHReadFileResult,
} from "../sandbox/api.js";

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_ATTACH_BYTES = 4 * 1024 * 1024;
const AGENTSH_MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_BINARY_READ_LINES = 2_147_483_647;
const NIX_HINT =
  "Install tools with Nix, for example: nix shell nixpkgs#poppler_utils nixpkgs#imagemagick";

type ExecOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  cwd?: string;
};

export type PdfExecResult = {
  stdout: string;
  stderr: string;
  stdoutTruncated?: boolean;
  stdoutTotalBytes?: number;
};

export type PdfAttachmentRead = {
  size: number;
  data?: string;
  skippedReason?: string;
};

export interface PdfBackend {
  readonly kind: "native" | "agentsh";
  readonly cwd: string;
  resolvePath(inputPath: string, label: string): string;
  exec(command: string, args: string[], options?: ExecOptions): Promise<PdfExecResult>;
  requireReadableFile(path: string, label: string, signal?: AbortSignal): Promise<void>;
  mkdir(path: string, signal?: AbortSignal): Promise<void>;
  exists(path: string, signal?: AbortSignal): Promise<boolean>;
  readdir(path: string, signal?: AbortSignal): Promise<string[]>;
  writeText(path: string, content: string, signal?: AbortSignal): Promise<void>;
  readAttachment(path: string, maxBytes: number, signal?: AbortSignal): Promise<PdfAttachmentRead>;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("PDF operation was cancelled");
  error.name = "AbortError";
  throw error;
}

function isUrlLike(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function validatePath(inputPath: string, label: string): string {
  if (!inputPath || inputPath.trim() === "") {
    throw new Error(`${label} is required.`);
  }
  if (isUrlLike(inputPath)) {
    throw new Error(`${label} must be a file path, not a URL: ${inputPath}`);
  }
  return inputPath;
}

function validateAttachmentLimit(maxBytes: number): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxAttachBytes must be a positive integer.");
  }
  return maxBytes;
}

function timeoutMilliseconds(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("timeoutMs must be a positive number.");
  }
  return Math.ceil(timeout);
}

export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function commandString(command: string, args: string[]): string {
  return [command, ...args.map(shellQuote)].join(" ");
}

class NativePdfBackend implements PdfBackend {
  readonly kind = "native" as const;

  constructor(readonly cwd: string) {}

  resolvePath(inputPath: string, label: string): string {
    return resolve(this.cwd, validatePath(inputPath, label));
  }

  exec(
    command: string,
    args: string[],
    options: ExecOptions = {},
  ): Promise<PdfExecResult> {
    const timeoutMs = timeoutMilliseconds(options.timeoutMs);
    return new Promise((resolvePromise, reject) => {
      execFile(
        command,
        args,
        {
          cwd: options.cwd,
          signal: options.signal,
          timeout: timeoutMs,
          maxBuffer: 20 * 1024 * 1024,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          if (error) {
            if (options.signal?.aborted || error.name === "AbortError") {
              reject(error);
              return;
            }
            const err = error as NodeJS.ErrnoException & {
              code?: string | number;
              killed?: boolean;
              signal?: string;
            };
            if (err.code === "ENOENT") {
              reject(new Error(`Missing required command: ${command}. ${NIX_HINT}`));
              return;
            }
            const message = [
              `Command failed: ${commandString(command, args)}`,
              err.signal ? `Signal: ${err.signal}` : undefined,
              err.killed ? `Process was killed or timed out after ${timeoutMs}ms.` : undefined,
              stderr ? `stderr:\n${stderr.trim()}` : undefined,
              stdout ? `stdout:\n${stdout.trim()}` : undefined,
            ]
              .filter(Boolean)
              .join("\n");
            reject(new Error(message));
            return;
          }
          resolvePromise({ stdout: stdout ?? "", stderr: stderr ?? "" });
        },
      );
    });
  }

  async requireReadableFile(path: string, label: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    try {
      await access(path, fsConstants.R_OK);
      const info = await stat(path);
      if (!info.isFile()) throw new Error(`${label} is not a file: ${path}`);
    } catch (error) {
      if (error instanceof Error && error.message.includes("is not a file")) throw error;
      throw new Error(`${label} is not readable: ${path}`);
    }
    throwIfAborted(signal);
  }

  async mkdir(path: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await mkdir(path, { recursive: true });
    throwIfAborted(signal);
  }

  async exists(path: string, signal?: AbortSignal): Promise<boolean> {
    throwIfAborted(signal);
    try {
      await access(path, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async readdir(path: string, signal?: AbortSignal): Promise<string[]> {
    throwIfAborted(signal);
    const entries = await readdir(path);
    throwIfAborted(signal);
    return entries;
  }

  async writeText(path: string, content: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await writeFile(path, content, { encoding: "utf8", signal });
  }

  async readAttachment(path: string, maxBytes: number, signal?: AbortSignal): Promise<PdfAttachmentRead> {
    const limit = validateAttachmentLimit(maxBytes);
    throwIfAborted(signal);
    const info = await stat(path);
    if (info.size > limit) {
      return {
        size: info.size,
        skippedReason: `Image is ${info.size} bytes, larger than maxAttachBytes=${limit}.`,
      };
    }
    const data = await readFile(path, { encoding: "base64", signal });
    const actualSize = Buffer.byteLength(data, "base64");
    if (actualSize > limit) {
      return {
        size: actualSize,
        skippedReason: `Image grew to ${actualSize} bytes while being read, larger than maxAttachBytes=${limit}.`,
      };
    }
    return { size: actualSize, data };
  }
}

function numericField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(value: unknown): boolean {
  return value === true;
}

function resultExitCode(result: AgentSHExecResult): number {
  const value = result.exitCode ?? result.exit_code;
  return typeof value === "number" && Number.isFinite(value) ? value : 1;
}

function resultWasTruncated(result: AgentSHExecResult): boolean {
  return booleanField(result.stdout_truncated) || booleanField(result.stdoutTruncated);
}

class AgentSHPdfBackend implements PdfBackend {
  readonly kind = "agentsh" as const;
  readonly cwd: string;
  readonly #api: AgentSHPiAPI;
  readonly #actor: AgentSHActor;

  constructor(
    api: AgentSHPiAPI,
    controlPlaneCwd: string,
    toolCallId: string,
    toolName: string,
  ) {
    this.#api = api;
    this.cwd = api.toSupervisorPath(".", controlPlaneCwd);
    this.#actor = {
      kind: "extension",
      label: `Pi ${toolName} tool`,
      tool_call_id: toolCallId,
    };
  }

  resolvePath(inputPath: string, label: string): string {
    return this.#api.toSupervisorPath(validatePath(inputPath, label), this.cwd);
  }

  async #execCommand(command: string, options: ExecOptions = {}): Promise<AgentSHExecResult> {
    throwIfAborted(options.signal);
    try {
      return await this.#api.exec(
        {
          command,
          cwd: options.cwd ?? this.cwd,
          timeout_ms: timeoutMilliseconds(options.timeoutMs),
          actor: this.#actor,
        },
        { signal: options.signal },
      );
    } catch (error) {
      if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
      throw new Error(`AgentSH PDF command failed: ${command}\n${asError(error).message}`, { cause: error });
    }
  }

  async exec(command: string, args: string[], options: ExecOptions = {}): Promise<PdfExecResult> {
    const rendered = commandString(command, args);
    const result = await this.#execCommand(rendered, options);
    const exitCode = resultExitCode(result);
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    if (exitCode !== 0) {
      if (exitCode === 127) {
        throw new Error(
          `Missing required command in the AgentSH supervisor runtime: ${command}. ` +
            "Install Poppler and ImageMagick on the AgentSH host and start a new supervised session." +
            (stderr.trim() ? `\nstderr:\n${stderr.trim()}` : ""),
        );
      }
      const failure = result.normalizedFailure?.message;
      const message = [
        `AgentSH command failed (${exitCode}): ${rendered}`,
        failure ? `AgentSH: ${failure}` : undefined,
        stderr.trim() ? `stderr:\n${stderr.trim()}` : undefined,
        stdout.trim() ? `stdout:\n${stdout.trim()}` : undefined,
      ]
        .filter(Boolean)
        .join("\n");
      throw new Error(message);
    }
    return {
      stdout,
      stderr,
      stdoutTruncated: resultWasTruncated(result),
      stdoutTotalBytes: numericField(result.stdout_total_bytes) ?? numericField(result.stdoutTotalBytes),
    };
  }

  async requireReadableFile(path: string, label: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.#api.readFile(path, {
        cwd: this.cwd,
        maxBytes: 1,
        limit: 1,
        actor: this.#actor,
        signal,
      });
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
      throw new Error(`${label} is not readable through the AgentSH supervisor: ${path}\n${asError(error).message}`, {
        cause: error,
      });
    }
  }

  async mkdir(path: string, signal?: AbortSignal): Promise<void> {
    await this.exec("mkdir", ["-p", "--", path], { signal, timeoutMs: 30_000 });
  }

  async exists(path: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.#execCommand(`test -e ${shellQuote(path)}`, {
      signal,
      timeoutMs: 10_000,
    });
    const exitCode = resultExitCode(result);
    if (exitCode === 0) return true;
    if (exitCode === 1) return false;
    throw new Error(`AgentSH could not test whether output exists (${exitCode}): ${path}`);
  }

  async readdir(path: string, signal?: AbortSignal): Promise<string[]> {
    const quoted = shellQuote(path);
    const script = [
      `dir=${quoted}`,
      "for entry in \"$dir\"/* \"$dir\"/.[!.]* \"$dir\"/..?*; do",
      "  if [ -e \"$entry\" ] || [ -L \"$entry\" ]; then",
      "    printf '%s\\0' \"${entry##*/}\"",
      "  fi",
      "done",
    ].join("\n");
    const result = await this.#execCommand(script, { signal, timeoutMs: 30_000 });
    const exitCode = resultExitCode(result);
    if (exitCode !== 0) {
      throw new Error(`AgentSH could not list PDF output directory (${exitCode}): ${path}`);
    }
    if (resultWasTruncated(result)) {
      throw new Error(`AgentSH truncated the directory listing for ${path}; use a narrower output directory.`);
    }
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    return stdout.split("\0").filter(Boolean);
  }

  async writeText(path: string, content: string, signal?: AbortSignal): Promise<void> {
    await this.#api.writeFile(path, content, {
      cwd: this.cwd,
      actor: this.#actor,
      signal,
    });
  }

  async readAttachment(path: string, maxBytes: number, signal?: AbortSignal): Promise<PdfAttachmentRead> {
    const requestedLimit = validateAttachmentLimit(maxBytes);
    const effectiveLimit = Math.min(requestedLimit, AGENTSH_MAX_FILE_BYTES);
    const result = await this.#api.readFile(path, {
      cwd: this.cwd,
      maxBytes: effectiveLimit,
      limit: MAX_BINARY_READ_LINES,
      actor: this.#actor,
      signal,
    });
    return decodeAgentSHAttachment(path, result, requestedLimit, effectiveLimit);
  }
}

function decodeAgentSHAttachment(
  path: string,
  result: AgentSHReadFileResult,
  requestedLimit: number,
  effectiveLimit: number,
): PdfAttachmentRead {
  const content = typeof result.content === "string"
    ? result.content
    : typeof result.base64 === "string"
      ? result.base64
      : undefined;
  const encoding = typeof result.encoding === "string" ? result.encoding.toLowerCase() : undefined;
  let data: string | undefined;
  let decodedSize: number | undefined;
  if (content !== undefined) {
    if (encoding === "base64" || result.base64 === content) {
      data = content;
      decodedSize = Buffer.byteLength(content, "base64");
    } else if (encoding === "utf-8" || encoding === "utf8" || encoding === undefined) {
      const bytes = Buffer.from(content, "utf8");
      data = bytes.toString("base64");
      decodedSize = bytes.length;
    } else {
      throw new Error(`AgentSH returned unsupported ${encoding} encoding for image attachment ${path}.`);
    }
  }

  const size = numericField(result.size) ?? decodedSize;
  if (size === undefined) {
    throw new Error(`AgentSH read_file returned no size for image attachment ${path}.`);
  }
  const truncated = result.truncated === true || result.byte_truncated === true;
  if (size > requestedLimit) {
    return {
      size,
      skippedReason: `Image is ${size} bytes, larger than maxAttachBytes=${requestedLimit}.`,
    };
  }
  if (size > effectiveLimit || truncated) {
    const reportedCap = numericField(result.max_bytes) ?? effectiveLimit;
    return {
      size,
      skippedReason:
        `Image could not be attached because AgentSH's bounded read returned at most ${reportedCap} bytes` +
        (requestedLimit > AGENTSH_MAX_FILE_BYTES ? ` (requested maxAttachBytes=${requestedLimit})` : "") +
        ".",
    };
  }
  if (data === undefined) {
    throw new Error(`AgentSH read_file returned no content for image attachment ${path}.`);
  }
  if (decodedSize !== size) {
    throw new Error(
      `AgentSH image attachment size mismatch for ${path}: metadata reports ${size} bytes, decoded ${decodedSize}.`,
    );
  }
  return { size, data };
}

function supervisionRequired(): boolean {
  return [
    "PI_AUTO",
    "PI_SUPERVISED",
    "PI_AGENTSH_REMOTE",
    "PI_AGENTSH_READ_MODE",
    "AGENTSH_SESSION_SUPERVISOR",
  ].some((name) => Boolean(process.env[name]?.trim()));
}

function sharedAgentSHAPI(): AgentSHPiAPI | undefined {
  const api = globalThis.__AGENTSH_PI__;
  if (!api || typeof api.getSupervisorState !== "function") return undefined;
  return api;
}

export function createPdfBackend(
  controlPlaneCwd: string,
  toolCallId: string,
  toolName: string,
): PdfBackend {
  const api = sharedAgentSHAPI();
  if (api) {
    const state = api.getSupervisorState();
    if (state.active) {
      if (typeof api.toSupervisorPath !== "function") {
        throw new Error(
          "The active AgentSH sandbox extension is too old for supervised PDF tools: toSupervisorPath is unavailable.",
        );
      }
      const cwd = process.env.PI_AGENTSH_REMOTE_CWD?.trim() || controlPlaneCwd;
      return new AgentSHPdfBackend(api, cwd, toolCallId, toolName);
    }
    if (supervisionRequired()) {
      throw new Error(
        `PDF tools require the active AgentSH supervisor, but it is ${state.status}` +
          (state.lastError ? `: ${state.lastError}` : "."),
      );
    }
  } else if (supervisionRequired()) {
    throw new Error(
      "PDF tools require the AgentSH sandbox extension in this supervised session; refusing to access the trusted parent filesystem.",
    );
  }
  return new NativePdfBackend(controlPlaneCwd);
}
