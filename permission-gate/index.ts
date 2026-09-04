/**
 * Permission Gate Extension
 *
 * In ordinary Pi sessions this retains the legacy, toggleable regex prompt.
 * When AgentSH passes its private Permission Gate rendezvous, AgentSH owns
 * classification and this extension becomes a bounded client for that
 * authority channel. Full AgentSH sandbox/supervised modes suppress the legacy gate.
 *
 * Credit for the original legacy gate: Mic92
 * (https://github.com/Mic92/dotfiles)
 */

import { createConnection, Socket } from "node:net";
import { isAbsolute } from "node:path";
import {
  agentSHRuntimeDisposition,
  classifyAgentSHStartup,
  type AgentSHRuntimeState,
  type AgentSHStartupClassification,
} from "../shared/agentsh-mode.js";
import { applyBashCommandTransforms } from "../shared/bash-command-transform.js";
import {
  SUBAGENT_PERMISSION_AUTHORITY_KEY,
  SUBAGENT_PERMISSION_SELECTION_KEY,
  createReloadableSubagentPermissionAuthority,
  type ReloadableSubagentPermissionAuthority,
  type SubagentPermissionRequest,
} from "../shared/subagent-permission.js";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

const GATE_CLAIM_KEY = "__paeAgentSHPermissionGateClaimV1";
const COMMAND_AUTHORITY_KEY = "__paeCommandAuthorityV1";
const PASEO_REMOTE_UI_KEY = "__piPaseoRemoteUiV1";
const GATE_SOCKET_ENV = "AGENTSH_PERMISSION_GATE_SOCKET";
const GATE_TIMEOUT_ENV = "PI_AGENTSH_PERMISSION_GATE_TIMEOUT_MS";

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_COMMAND_BYTES = 32 * 1024;
const MAX_CWD_BYTES = 4 * 1024;
const MAX_ID_BYTES = 256;
const MAX_REQUESTS = 4096;
const MAX_JSON_DEPTH = 64;
const MAX_PROMPT_PREVIEW_BYTES = 4 * 1024;
const MAX_PROMPT_LABELS = 64;
const DEFAULT_GATE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_NODE_TIMEOUT_MS = 2_147_483_647;

const DENY_CHOICE = "Deny";
const ALLOW_CHOICE = "Allow";

const dangerousPatterns: { pattern: RegExp; label: string }[] = [
  { pattern: /\brm\s+(-[^\s]*r|--recursive)/, label: "recursive delete" },
  { pattern: /\bsudo\b/, label: "sudo" },
  { pattern: /\bssh\b/, label: "ssh" },
  { pattern: /\bchmod\b.*777/, label: "world-writable permissions" },
  { pattern: />\s*\/dev\/[sh]d[a-z]/, label: "raw device redirect" },
  { pattern: /\bgit\s+push\s+.*(-f\b|--force\b)/, label: "force push" },
  { pattern: /\bgit\s+reset\s+--hard\b/, label: "hard reset" },
  { pattern: /\bgit\s+clean\s+-[^\s]*f/, label: "git clean" },
  {
    pattern: /\bgit\s+checkout\s+(\S+\s+)?--\s/,
    label: "git checkout (reset files)",
  },
  {
    pattern: /\bgit\s+checkout\s+\.\s*($|[;&|])/,
    label: "git checkout (reset all files)",
  },
  { pattern: /\bgit\s+restore\b/, label: "git restore" },
  { pattern: /\bclan\s+machines\s+update\b/, label: "deploy to machine" },
  { pattern: /\bcurl\b.*\|\s*(ba)?sh\b/, label: "pipe curl to shell" },
  { pattern: /\bwget\b.*\|\s*(ba)?sh\b/, label: "pipe wget to shell" },
  { pattern: /\bgh\s+issue\s+create\b/, label: "create GitHub issue" },
  {
    pattern: /\bgh\s+issue\s+(close|delete|edit|comment)\b/,
    label: "modify GitHub issue",
  },
  { pattern: /\bgh\s+pr\s+create\b/, label: "create GitHub PR" },
  {
    pattern: /\bgh\s+pr\s+(close|merge|edit|comment|review)\b/,
    label: "modify GitHub PR",
  },
  {
    pattern: /\bgh\s+repo\s+(create|delete|rename|archive)\b/,
    label: "modify GitHub repo",
  },
  {
    pattern: /\bgh\s+release\s+(create|delete|edit)\b/,
    label: "modify GitHub release",
  },
  {
    pattern: /\btea\s+(issue|pr)\s+create\b/,
    label: "create Gitea issue/PR",
  },
  {
    pattern: /\btea\s+(issue|pr)\s+(close|edit)\b/,
    label: "modify Gitea issue/PR",
  },
  { pattern: /\btea\s+comment\b/, label: "Gitea comment" },
  { pattern: /\bmsmtp\b/, label: "send email" },
];

type PaseoRemoteUi = {
  isConnected(): boolean;
  select(
    title: string,
    options: string[],
    settings?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
  selectMirrored?(
    title: string,
    options: string[],
    localSelect: (signal: AbortSignal) => Promise<string | undefined>,
    settings?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
};

type JsonObject = Record<string, unknown>;

type PromptMetadata = {
  title: string;
  message: string;
  labels: string[];
  commandPreview: string;
  commandTruncated: boolean;
};

type PromptResolution =
  | { kind: "resolve"; decision: "allow" | "deny" }
  | { kind: "cancel"; reason: string };

type AuthorizationResult = {
  allowed: boolean;
  reason: string;
};

type CommandReceipt = { command: string; cwd: string };
type CommandAuthority = {
  protocol: 1;
  active: boolean;
  consume(toolCallId: string, command: string, cwd: string): boolean;
};

type FrameWaiter = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

type GateClaim = {
  protocol: 1;
  rawSocket: string;
  timeoutRaw?: string;
  startup: AgentSHStartupClassification;
  client?: AgentSHPermissionGateClient;
  error?: Error;
  subagentAuthority?: ReloadableSubagentPermissionAuthority;
};

function ownEnvironment(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(process.env, name);
}

/**
 * Claim the launcher-owned marker once per process and remove it before any
 * model-requested child process can inherit it. The global claim survives Pi's
 * in-process extension reload/session replacement lifecycle.
 */
function claimInheritedGate(startup: AgentSHStartupClassification): GateClaim | undefined {
  const root = globalThis as Record<string, unknown>;
  const existing = root[GATE_CLAIM_KEY] as GateClaim | undefined;
  const socketPresent = ownEnvironment(GATE_SOCKET_ENV);
  const rawSocket = socketPresent ? process.env[GATE_SOCKET_ENV] ?? "" : undefined;
  if (socketPresent) delete process.env[GATE_SOCKET_ENV];

  if (existing?.protocol === PROTOCOL_VERSION && typeof existing.rawSocket === "string") {
    if (!existing.startup
      || (existing.startup.kind !== "guard-only" && existing.startup.kind !== "conflict")
      || existing.startup.protocol !== "permission-gate") {
      existing.startup = {
        kind: startup.kind === "full" || startup.kind === "conflict" ? "conflict" : "guard-only",
        protocol: "permission-gate",
        startSupervisor: startup.startSupervisor,
      };
    }
    return existing;
  }
  if (!socketPresent) return undefined;

  const claim: GateClaim = {
    protocol: PROTOCOL_VERSION,
    rawSocket: rawSocket!,
    timeoutRaw: process.env[GATE_TIMEOUT_ENV],
    startup,
  };
  root[GATE_CLAIM_KEY] = claim;
  return claim;
}

// Capture the guard/full distinction before claiming and deleting the private
// Permission Gate marker from the process environment.
const importedAgentSHStartup = classifyAgentSHStartup(process.env);
const inheritedGateClaim = claimInheritedGate(importedAgentSHStartup);
if (inheritedGateClaim) {
  (globalThis as Record<string, unknown>)[SUBAGENT_PERMISSION_SELECTION_KEY] = {
    protocol: 1,
    selected: true,
    conflict: inheritedGateClaim.startup.kind === "conflict",
  };
}

function configuredTimeout(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_GATE_TIMEOUT_MS;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${GATE_TIMEOUT_ENV} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > MAX_NODE_TIMEOUT_MS) {
    throw new Error(`${GATE_TIMEOUT_ENV} must be between 1 and ${MAX_NODE_TIMEOUT_MS}`);
  }
  return value;
}

function parseGateSocket(raw: string): string {
  if (!isAbsolute(raw) || raw.includes("\0") || Buffer.byteLength(raw, "utf8") > MAX_CWD_BYTES) {
    throw new Error(`${GATE_SOCKET_ENV} is not a valid absolute Unix socket path`);
  }
  return raw;
}

function gateClient(claim: GateClaim): AgentSHPermissionGateClient {
  if (claim.error) throw claim.error;
  if (claim.client) return claim.client;
  try {
    claim.client = new AgentSHPermissionGateClient(
      parseGateSocket(claim.rawSocket),
      configuredTimeout(claim.timeoutRaw),
    );
    return claim.client;
  } catch (error) {
    claim.error = asError(error);
    throw claim.error;
  }
}

function gateSubagentAuthority(claim: GateClaim): ReloadableSubagentPermissionAuthority {
  const existing = claim.subagentAuthority;
  if (existing?.authorityAbi === 2 && existing.protocol === PROTOCOL_VERSION) {
    const phase = existing.phase();
    if (phase === "unbound" || phase === "reloading") return existing;
    if (phase === "active" || phase === "draining") {
      existing.fail(new Error("Overlapping Permission Gate extension runtimes cannot share child authority"));
    }
  }
  const created = createReloadableSubagentPermissionAuthority();
  claim.subagentAuthority = created;
  return created;
}

function paseoRemoteSelect(
  title: string,
  options: string[],
  localSelect: (signal: AbortSignal) => Promise<string | undefined>,
  signal?: AbortSignal,
): Promise<string | undefined> | null {
  const bridge = (globalThis as Record<string, unknown>)[PASEO_REMOTE_UI_KEY] as
    | PaseoRemoteUi
    | undefined;
  if (!bridge || typeof bridge.isConnected !== "function" || typeof bridge.select !== "function") {
    return null;
  }
  try {
    if (!bridge.isConnected()) return null;
    if (typeof bridge.selectMirrored === "function") {
      return Promise.resolve(bridge.selectMirrored(title, options, localSelect, { signal })).catch(() => undefined);
    }
    return Promise.resolve(bridge.select(title, options, { signal })).catch(() => undefined);
  } catch {
    return Promise.resolve(undefined);
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateUTF8(value: string, maximum: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximum) return value;
  let end = maximum;
  while (end > 0) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return "";
}

function exactUTF8(value: string, field: string, maximum: number, allowEmpty = true): string {
  if ((!allowEmpty && value.length === 0) || Buffer.from(value, "utf8").toString("utf8") !== value) {
    throw new Error(`AgentSH Permission Gate ${field} is not valid UTF-8`);
  }
  if (byteLength(value) > maximum) {
    throw new Error(`AgentSH Permission Gate ${field} exceeds ${maximum} bytes`);
  }
  return value;
}

function plainObject(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`AgentSH Permission Gate ${name} must be an object`);
  }
  return value as JsonObject;
}

function exactKeys(
  object: JsonObject,
  name: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new Error(`AgentSH Permission Gate ${name} contains unknown field ${JSON.stringify(key)}`);
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
      throw new Error(`AgentSH Permission Gate ${name} is missing field ${JSON.stringify(key)}`);
    }
  }
}

function protocolEnvelope(object: JsonObject, type: string, id?: string): void {
  if (object.v !== PROTOCOL_VERSION || object.type !== type) {
    throw new Error(`AgentSH Permission Gate returned an invalid ${type} envelope`);
  }
  if (id !== undefined && object.id !== id) {
    throw new Error("AgentSH Permission Gate response ID does not match the request");
  }
}

function parseHelloResponse(value: unknown): void {
  const object = plainObject(value, "hello response");
  exactKeys(object, "hello response", ["v", "type", "service", "capabilities"]);
  protocolEnvelope(object, "hello");
  if (object.service !== "agentsh-permission-gate") {
    throw new Error("AgentSH Permission Gate hello named an unexpected service");
  }
  if (!Array.isArray(object.capabilities) || object.capabilities.length > 16) {
    throw new Error("AgentSH Permission Gate hello has invalid capabilities");
  }
  const capabilities = object.capabilities.map((value) => {
    if (typeof value !== "string") throw new Error("AgentSH Permission Gate capability must be a string");
    return exactUTF8(value, "capability", 64, false);
  });
  if (new Set(capabilities).size !== capabilities.length
    || !["bash", "resolve", "cancel"].every((capability) => capabilities.includes(capability))) {
    throw new Error("AgentSH Permission Gate does not advertise the required capabilities");
  }
}

function parsePrompt(value: unknown): PromptMetadata {
  const object = plainObject(value, "prompt metadata");
  exactKeys(
    object,
    "prompt metadata",
    ["title", "message", "labels", "command_preview"],
    ["command_truncated"],
  );
  if (typeof object.title !== "string" || typeof object.message !== "string"
    || typeof object.command_preview !== "string" || !Array.isArray(object.labels)) {
    throw new Error("AgentSH Permission Gate returned malformed prompt metadata");
  }
  if (object.command_truncated !== undefined && typeof object.command_truncated !== "boolean") {
    throw new Error("AgentSH Permission Gate returned malformed prompt truncation metadata");
  }
  if (object.labels.length > MAX_PROMPT_LABELS) {
    throw new Error("AgentSH Permission Gate returned too many prompt labels");
  }
  const labels = object.labels.map((label) => {
    if (typeof label !== "string") throw new Error("AgentSH Permission Gate prompt label must be a string");
    return exactUTF8(label, "prompt label", 256, false);
  });
  return {
    title: exactUTF8(object.title, "prompt title", 1024, false),
    message: exactUTF8(object.message, "prompt message", 4096),
    labels,
    commandPreview: exactUTF8(
      object.command_preview,
      "command preview",
      MAX_PROMPT_PREVIEW_BYTES,
      false,
    ),
    commandTruncated: object.command_truncated === true,
  };
}

function parseDecisionResponse(
  value: unknown,
  id: string,
): { decision: "allow" } | { decision: "prompt"; prompt: PromptMetadata } {
  const object = plainObject(value, "decision response");
  exactKeys(object, "decision response", ["v", "type", "id", "decision"], ["prompt"]);
  protocolEnvelope(object, "decision", id);
  if (object.decision === "allow") {
    if (object.prompt !== undefined && object.prompt !== null) {
      throw new Error("AgentSH Permission Gate attached a prompt to an allow decision");
    }
    return { decision: "allow" };
  }
  if (object.decision === "prompt" && object.prompt !== undefined && object.prompt !== null) {
    return { decision: "prompt", prompt: parsePrompt(object.prompt) };
  }
  throw new Error("AgentSH Permission Gate returned an unsupported decision");
}

function parseCompleteResponse(
  value: unknown,
  id: string,
): { decision: "allow" | "deny"; reason: string } {
  const object = plainObject(value, "complete response");
  exactKeys(object, "complete response", ["v", "type", "id", "decision"], ["reason"]);
  protocolEnvelope(object, "complete", id);
  if (object.decision !== "allow" && object.decision !== "deny") {
    throw new Error("AgentSH Permission Gate returned an unsupported completion decision");
  }
  if (object.reason !== undefined && typeof object.reason !== "string") {
    throw new Error("AgentSH Permission Gate returned a malformed completion reason");
  }
  return {
    decision: object.decision,
    reason: object.reason === undefined
      ? ""
      : exactUTF8(object.reason, "completion reason", 512),
  };
}

/**
 * JSON.parse accepts duplicate object names. Check the complete JSON grammar
 * first so ambiguous protocol frames are rejected rather than last-key-wins.
 */
function parseStrictJSON(text: string): unknown {
  let index = 0;

  const fail = (message: string): never => {
    throw new Error(`AgentSH Permission Gate returned malformed JSON (${message})`);
  };
  const whitespace = () => {
    while (index < text.length && /[\t\n\r ]/.test(text[index]!)) index += 1;
  };
  const string = (): string => {
    if (text[index] !== '"') fail("expected string");
    const start = index;
    index += 1;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      const character = text[index++]!;
      if (character === '"') {
        try {
          return JSON.parse(text.slice(start, index)) as string;
        } catch {
          fail("invalid string escape");
        }
      }
      if (code < 0x20) fail("control character in string");
      if (character !== "\\") continue;
      if (index >= text.length) fail("unterminated escape");
      const escape = text[index++]!;
      if ('"\\/bfnrt'.includes(escape)) continue;
      if (escape !== "u" || !/^[0-9a-fA-F]{4}$/.test(text.slice(index, index + 4))) {
        fail("invalid string escape");
      }
      index += 4;
    }
    return fail("unterminated string");
  };
  const value = (depth: number): void => {
    if (depth > MAX_JSON_DEPTH) fail("maximum nesting depth exceeded");
    whitespace();
    const character = text[index];
    if (character === "{") {
      index += 1;
      whitespace();
      const keys = new Set<string>();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      for (;;) {
        whitespace();
        const key = string();
        if (keys.has(key)) fail(`duplicate field ${JSON.stringify(key)}`);
        keys.add(key);
        whitespace();
        if (text[index++] !== ":") fail("expected colon");
        value(depth + 1);
        whitespace();
        const separator = text[index++];
        if (separator === "}") return;
        if (separator !== ",") fail("expected object separator");
      }
    }
    if (character === "[") {
      index += 1;
      whitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      for (;;) {
        value(depth + 1);
        whitespace();
        const separator = text[index++];
        if (separator === "]") return;
        if (separator !== ",") fail("expected array separator");
      }
    }
    if (character === '"') {
      string();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }
    const number = text.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (!number) fail("invalid value");
    index += number[0].length;
  };

  value(0);
  whitespace();
  if (index !== text.length) fail("trailing data");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fail("invalid JSON");
  }
}

class AgentSHPermissionGateClient {
  readonly timeoutMs: number;
  readonly #socket: Socket;
  #buffer = Buffer.alloc(0);
  #waiter?: FrameWaiter;
  #fatal?: Error;
  #failureController = new AbortController();
  #failureHandler?: (error: Error) => void;
  #ready?: Promise<void>;
  #tail: Promise<void> = Promise.resolve();
  #requestNumber = 0;

  constructor(socketPath: string, timeoutMs: number) {
    this.timeoutMs = timeoutMs;
    this.#socket = createConnection({ path: socketPath });
    this.#socket.unref();
    this.#socket.on("data", (chunk: Buffer) => this.#receive(Buffer.from(chunk)));
    this.#socket.on("end", () => this.#end());
    this.#socket.on("error", (error) => this.#fail(new Error(`AgentSH Permission Gate transport error: ${error.message}`)));
    this.#socket.on("close", () => {
      if (!this.#fatal) this.#fail(new Error("AgentSH Permission Gate transport closed unexpectedly"));
    });
  }

  get failure(): Error | undefined {
    return this.#fatal;
  }

  setFailureHandler(handler: (error: Error) => void): void {
    this.#failureHandler = handler;
    if (this.#fatal) handler(this.#fatal);
  }

  initialize(): Promise<void> {
    if (this.#ready) return this.#ready;
    this.#ready = this.#initialize().catch((error) => {
      const failure = asError(error);
      this.#fail(failure);
      throw failure;
    });
    return this.#ready;
  }

  authorize(
    request: { command: string; cwd: string; toolCallId: string; sessionId?: string },
    signal: AbortSignal | undefined,
    prompt: (
      metadata: PromptMetadata,
      timeoutMs: number,
      transportSignal: AbortSignal,
    ) => Promise<PromptResolution>,
  ): Promise<AuthorizationResult> {
    const operation = this.#tail.then(async () => {
      await this.initialize();
      return await this.#authorize(request, signal, prompt);
    }).catch((error) => {
      const failure = asError(error);
      this.#fail(failure);
      throw failure;
    });
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #initialize(): Promise<void> {
    parseHelloResponse(await this.#exchange(
      { v: PROTOCOL_VERSION, type: "hello", client: "pi-permission-gate" },
      "hello",
    ));
  }

  async #authorize(
    request: { command: string; cwd: string; toolCallId: string; sessionId?: string },
    signal: AbortSignal | undefined,
    prompt: (
      metadata: PromptMetadata,
      timeoutMs: number,
      transportSignal: AbortSignal,
    ) => Promise<PromptResolution>,
  ): Promise<AuthorizationResult> {
    if (this.#fatal) throw this.#fatal;
    if (signal?.aborted) return { allowed: false, reason: "Permission Gate tool call was aborted" };
    if (this.#requestNumber >= MAX_REQUESTS) {
      throw this.#protocolFailure("request limit exceeded");
    }

    exactUTF8(request.command, "command", MAX_COMMAND_BYTES, false);
    exactUTF8(request.cwd, "cwd", MAX_CWD_BYTES);
    exactUTF8(request.toolCallId, "tool call ID", MAX_ID_BYTES, false);
    if (request.sessionId !== undefined) exactUTF8(request.sessionId, "session ID", MAX_ID_BYTES, false);

    const id = `pi-${process.pid}-${++this.#requestNumber}`;
    // Install the bounded reader before writing. A fast local broker can reply
    // before Node invokes the write callback, and unsolicited frames are fatal.
    const decision = parseDecisionResponse(await this.#exchange({
      v: PROTOCOL_VERSION,
      type: "authorize",
      id,
      kind: "bash",
      command: request.command,
      cwd: request.cwd,
      tool_call_id: request.toolCallId,
      ...(request.sessionId === undefined ? {} : { session_id: request.sessionId }),
    }, "authorization decision"), id);
    if (this.#fatal) throw this.#fatal;
    if (decision.decision === "allow") {
      return signal?.aborted
        ? { allowed: false, reason: "Permission Gate tool call was aborted" }
        : { allowed: true, reason: "allowed by AgentSH Permission Gate" };
    }

    let resolution: PromptResolution;
    if (signal?.aborted) {
      resolution = { kind: "cancel", reason: "caller aborted" };
    } else {
      try {
        resolution = await prompt(
          decision.prompt,
          this.timeoutMs,
          this.#failureController.signal,
        );
        if (this.#fatal) throw this.#fatal;
      } catch {
        resolution = {
          kind: "cancel",
          reason: signal?.aborted ? "caller aborted" : "authorization prompt failed",
        };
      }
    }

    if (signal?.aborted) resolution = { kind: "cancel", reason: "caller aborted" };
    let finish: JsonObject;
    if (resolution.kind === "cancel") {
      exactUTF8(resolution.reason, "cancellation reason", 512, false);
      finish = {
        v: PROTOCOL_VERSION,
        type: "cancel",
        id,
        reason: resolution.reason,
      };
    } else {
      finish = {
        v: PROTOCOL_VERSION,
        type: "resolve",
        id,
        decision: resolution.decision,
      };
    }

    const complete = parseCompleteResponse(
      await this.#exchange(finish, "authorization completion"),
      id,
    );
    if (this.#fatal) throw this.#fatal;
    const expected = resolution.kind === "cancel" ? "deny" : resolution.decision;
    if (complete.decision !== expected) {
      throw this.#protocolFailure("completion decision does not match the submitted resolution");
    }
    if (signal?.aborted) {
      return { allowed: false, reason: "Permission Gate tool call was aborted" };
    }
    return {
      allowed: complete.decision === "allow",
      reason: complete.reason || (complete.decision === "allow"
        ? "allowed by AgentSH Permission Gate"
        : "denied by AgentSH Permission Gate"),
    };
  }

  async #exchange(message: JsonObject, phase: string): Promise<unknown> {
    const response = this.#readFrame(phase);
    // Keep a rejection observer attached while a slow/failed write is awaited.
    // Awaiting the original promise below still propagates the same failure.
    void response.catch(() => undefined);
    await this.#writeFrame(message);
    return await response;
  }

  async #writeFrame(message: JsonObject): Promise<void> {
    if (this.#fatal) throw this.#fatal;
    const frame = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
    if (frame.length - 1 > MAX_FRAME_BYTES) {
      throw this.#protocolFailure("outgoing frame is oversized");
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#failureController.signal.removeEventListener("abort", onTransportFailure);
        if (error) reject(error);
        else resolve();
      };
      const onTransportFailure = () => finish(
        this.#fatal ?? new Error("AgentSH Permission Gate transport failed"),
      );
      const timer = setTimeout(() => {
        const error = new Error("AgentSH Permission Gate timed out writing a protocol frame");
        this.#fail(error);
        finish(error);
      }, this.timeoutMs);
      this.#failureController.signal.addEventListener("abort", onTransportFailure, { once: true });
      try {
        this.#socket.write(frame, (error?: Error | null) => finish(error ? asError(error) : undefined));
      } catch (error) {
        finish(asError(error));
      }
    });
  }

  #readFrame(phase: string): Promise<unknown> {
    if (this.#fatal) return Promise.reject(this.#fatal);
    if (this.#waiter) return Promise.reject(this.#protocolFailure("concurrent frame read"));

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#fail(new Error(`AgentSH Permission Gate timed out waiting for ${phase}`));
      }, this.timeoutMs);
      this.#waiter = { resolve, reject, timer };
    });
  }

  #receive(chunk: Buffer): void {
    if (this.#fatal || chunk.length === 0) return;
    if (!this.#waiter) {
      this.#fail(new Error("AgentSH Permission Gate sent an unsolicited frame"));
      return;
    }
    if (this.#buffer.length + chunk.length > MAX_FRAME_BYTES + 1) {
      this.#fail(new Error("AgentSH Permission Gate receive buffer is oversized"));
      return;
    }
    this.#buffer = Buffer.concat([this.#buffer, chunk]);

    const newline = this.#buffer.indexOf(0x0a);
    if (newline < 0) {
      if (this.#buffer.length > MAX_FRAME_BYTES) {
        this.#fail(new Error("AgentSH Permission Gate frame exceeds 65536 bytes"));
      }
      return;
    }
    if (newline === 0 || newline > MAX_FRAME_BYTES) {
      this.#fail(new Error("AgentSH Permission Gate returned an empty or oversized frame"));
      return;
    }
    if (newline !== this.#buffer.length - 1) {
      this.#fail(new Error("AgentSH Permission Gate sent coalesced unsolicited data"));
      return;
    }
    const bytes = this.#buffer.subarray(0, newline);
    this.#buffer = Buffer.alloc(0);

    let value: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      value = parseStrictJSON(text);
    } catch (error) {
      this.#fail(asError(error));
      return;
    }

    const waiter = this.#waiter;
    this.#waiter = undefined;
    clearTimeout(waiter.timer);
    waiter.resolve(value);
  }

  #end(): void {
    if (this.#fatal) return;
    this.#fail(new Error(this.#buffer.length > 0
      ? "AgentSH Permission Gate ended with an unterminated frame"
      : "AgentSH Permission Gate reached unexpected EOF"));
  }

  #protocolFailure(message: string): Error {
    const error = new Error(`AgentSH Permission Gate protocol violation: ${message}`);
    this.#fail(error);
    return error;
  }

  #fail(error: Error): void {
    if (this.#fatal) return;
    this.#fatal = error;
    this.#failureController.abort(error);
    try { this.#failureHandler?.(error); } catch {}
    if (this.#waiter) {
      const waiter = this.#waiter;
      this.#waiter = undefined;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#socket.destroy();
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function boundedError(error: unknown): string {
  return asError(error).message.replace(/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, " ").slice(0, 500);
}

function safePromptText(value: string): string {
  return value
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[P_^][\s\S]*?\x1b\\/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}

function promptTitle(metadata: PromptMetadata): string {
  const lines = [safePromptText(metadata.title)];
  if (metadata.message) lines.push("", safePromptText(metadata.message));
  if (metadata.labels.length > 0 && !metadata.message) {
    lines.push("", `Detected: ${metadata.labels.map(safePromptText).join(", ")}`);
  }
  lines.push("", "Command:", safePromptText(metadata.commandPreview));
  if (metadata.commandTruncated) lines.push("[command preview truncated by AgentSH]");
  return lines.join("\n");
}

function promptDeadline(
  parents: readonly (AbortSignal | undefined)[],
  timeoutMs: number,
): {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener(): void }> = [];
  let timeout = false;
  for (const signal of parents) {
    if (!signal) continue;
    const listener = () => controller.abort(signal.reason);
    if (signal.aborted) {
      listener();
      break;
    }
    signal.addEventListener("abort", listener, { once: true });
    listeners.push({ signal, listener });
  }
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort(new Error("Permission Gate prompt timed out"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeout,
    dispose() {
      clearTimeout(timer);
      for (const { signal, listener } of listeners) {
        signal.removeEventListener("abort", listener);
      }
    },
  };
}

function abortableSelection(
  selection: Promise<string | undefined>,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (choice: string | undefined) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve(choice);
    };
    const abort = () => finish(undefined);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(selection).then(finish, () => finish(undefined));
  });
}

async function resolveAgentSHPrompt(
  ctx: ExtensionContext,
  metadata: PromptMetadata,
  timeoutMs: number,
  transportSignal: AbortSignal,
  callerSignal: AbortSignal | undefined = ctx.signal,
): Promise<PromptResolution> {
  if (!ctx.hasUI) return { kind: "cancel", reason: "no UI available" };

  const deadline = promptDeadline([callerSignal, transportSignal], timeoutMs);
  try {
    const title = promptTitle(metadata);
    const options = [DENY_CHOICE, ALLOW_CHOICE];
    const localSelect = (signal: AbortSignal) => ctx.ui.select(title, options, { signal });
    const remote = paseoRemoteSelect(title, options, localSelect, deadline.signal);
    let choice: string | undefined;
    try {
      const selection = remote ?? localSelect(deadline.signal);
      choice = await abortableSelection(selection, deadline.signal);
    } catch {
      choice = undefined;
    }

    if (callerSignal?.aborted) return { kind: "cancel", reason: "caller aborted" };
    if (deadline.timedOut()) return { kind: "cancel", reason: "authorization prompt timed out" };
    if (transportSignal.aborted) {
      throw transportSignal.reason ?? new Error("AgentSH Permission Gate transport failed");
    }
    if (choice === ALLOW_CHOICE) return { kind: "resolve", decision: "allow" };
    if (choice === DENY_CHOICE) return { kind: "resolve", decision: "deny" };
    return { kind: "cancel", reason: "authorization prompt cancelled" };
  } finally {
    deadline.dispose();
  }
}

function linkedAbortSignal(parents: readonly (AbortSignal | undefined)[]): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener(): void }> = [];
  for (const signal of parents) {
    if (!signal) continue;
    const listener = () => controller.abort(signal.reason);
    if (signal.aborted) {
      listener();
      break;
    }
    signal.addEventListener("abort", listener, { once: true });
    listeners.push({ signal, listener });
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const { signal, listener } of listeners) signal.removeEventListener("abort", listener);
    },
  };
}

function childPromptMetadata(metadata: PromptMetadata, request: SubagentPermissionRequest): PromptMetadata {
  const task = truncateUTF8(safePromptText(request.task).replace(/\s+/g, " "), 512);
  const origin = `Requested by native subagent ${safePromptText(request.label)}${task ? `\nTask: ${task}` : ""}`;
  return {
    ...metadata,
    message: metadata.message ? `${origin}\n${metadata.message}` : origin,
  };
}

function gateStatus(ctx: ExtensionContext, state: "ready" | "waiting" | "error" = "ready"): void {
  if (!ctx.hasUI) return;
  const color = state === "error" ? "error" : state === "waiting" ? "warning" : "success";
  const text = state === "error" ? "AgentSH gate ✗" : state === "waiting" ? "AgentSH gate ?" : "AgentSH gate ■";
  ctx.ui.setStatus("permission-gate", ctx.ui.theme.fg(color, text));
}

function stablePiSessionId(ctx: ExtensionContext): string {
  const value = (ctx.sessionManager as { getSessionId?(): unknown }).getSessionId?.();
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 512) {
    throw new Error("AgentSH Permission Gate requires a stable Pi session ID");
  }
  return value;
}

export default function permissionGate(pi: ExtensionAPI) {
  let sessionContext: ExtensionContext | undefined;
  let activePiSessionId: string | undefined;
  const authorityOwner = Symbol("permission-gate-extension-runtime");
  let subagentAuthority = inheritedGateClaim ? gateSubagentAuthority(inheritedGateClaim) : undefined;
  const publishSubagentAuthority = () => {
    if (subagentAuthority) {
      (globalThis as Record<string, unknown>)[SUBAGENT_PERMISSION_AUTHORITY_KEY] = subagentAuthority.authority;
    }
  };
  publishSubagentAuthority();
  const commandReceipts = new Map<string, CommandReceipt>();
  const commandAuthority: CommandAuthority = {
    protocol: 1,
    active: true,
    consume(toolCallId, command, cwd) {
      const receipt = commandReceipts.get(toolCallId);
      commandReceipts.delete(toolCallId);
      return receipt?.command === command && receipt.cwd === cwd;
    },
  };
  (globalThis as Record<string, unknown>)[COMMAND_AUTHORITY_KEY] = commandAuthority;
  const authorizeBackgroundStart = (event: { toolName: string; toolCallId?: unknown }, command: string, cwd: string) => {
    if (event.toolName !== "background_job" || typeof event.toolCallId !== "string") return;
    if (commandReceipts.size >= MAX_REQUESTS) commandReceipts.clear();
    commandReceipts.set(event.toolCallId, { command, cwd });
  };

  let enabled = true;
  let failureReported = false;
  const agentSHStartup = inheritedGateClaim
    ? inheritedGateClaim.startup
    : classifyAgentSHStartup(process.env);
  const suppressLegacySynchronously = !inheritedGateClaim && agentSHStartup.kind === "full";
  // This inherited channel is process-scoped rather than a normal session
  // resource. Start hello at factory time so AgentSH's launch handshake is not
  // delayed behind unrelated session_start handlers; retain the promise for
  // the first session/tool call and observe rejection immediately.
  const eagerInitialization = inheritedGateClaim
    ? (() => {
        try {
          return gateClient(inheritedGateClaim).initialize();
        } catch (error) {
          return Promise.reject(asError(error));
        }
      })()
    : undefined;
  void eagerInitialization?.catch(() => undefined);

  const runtimeDisposition = () => {
    const api = (globalThis as Record<string, any>).__AGENTSH_PI__;
    let state: AgentSHRuntimeState | undefined;
    try {
      state = api && typeof api.getSupervisorState !== "function"
        ? { configured: true, active: false }
        : api?.getSupervisorState?.();
    } catch {
      state = { configured: true, active: false };
    }
    const disposition = agentSHRuntimeDisposition(agentSHStartup, state);
    if (disposition.kind === "full" && typeof api?.exec !== "function") {
      return { kind: "unavailable" as const, protocol: disposition.protocol };
    }
    return disposition;
  };
  const legacySuppressed = () => {
    const disposition = runtimeDisposition();
    return suppressLegacySynchronously
      || disposition.kind === "full"
      || disposition.kind === "unavailable";
  };

  const reportGateFailure = (
    ctx: ExtensionContext,
    error: unknown,
    failedAuthority = subagentAuthority,
  ) => {
    failedAuthority?.fail(asError(error));
    if (sessionContext !== ctx) return;
    gateStatus(ctx, "error");
    if (failureReported) return;
    failureReported = true;
    const message = `AgentSH Permission Gate failed closed: ${boundedError(error)}`;
    if (ctx.hasUI) ctx.ui.notify(message, "error");
    else process.stderr.write(`[permission-gate] ${message}\n`);
  };

  const authorizeSubagent = async (
    boundAuthority: ReloadableSubagentPermissionAuthority,
    request: SubagentPermissionRequest,
    signal: AbortSignal | undefined,
    sessionSignal: AbortSignal,
  ) => {
    if (!inheritedGateClaim) throw new Error("parent AgentSH Permission Gate is not configured");
    const ctx = sessionContext;
    if (!ctx || sessionSignal.aborted) {
      throw new Error("parent AgentSH Permission Gate session is not active");
    }
    if (agentSHStartup.kind === "conflict" || runtimeDisposition().kind !== "guard-only") {
      throw new Error("parent AgentSH Permission Gate is no longer the sole active command authority");
    }
    exactUTF8(request.subagentId, "subagent ID", MAX_ID_BYTES - "subagent:".length, false);
    exactUTF8(request.label, "subagent label", MAX_ID_BYTES, false);
    exactUTF8(request.task, "subagent task", 2048, false);
    exactUTF8(request.command, "command", MAX_COMMAND_BYTES, false);
    exactUTF8(request.cwd, "cwd", MAX_CWD_BYTES);
    exactUTF8(request.toolCallId, "tool call ID", MAX_ID_BYTES, false);

    const linked = linkedAbortSignal([signal, sessionSignal]);
    gateStatus(ctx, "waiting");
    try {
      const result = await gateClient(inheritedGateClaim).authorize(
        {
          command: request.command,
          cwd: request.cwd,
          toolCallId: request.toolCallId,
          sessionId: `subagent:${request.subagentId}`,
        },
        linked.signal,
        async (metadata, timeoutMs, transportSignal) => {
          pi.events.emit("permission-gate:waiting");
          try {
            return await resolveAgentSHPrompt(
              ctx,
              childPromptMetadata(metadata, request),
              timeoutMs,
              transportSignal,
              linked.signal,
            );
          } finally {
            pi.events.emit("permission-gate:resolved");
          }
        },
      );
      if (sessionSignal.aborted || sessionContext !== ctx) {
        throw new Error("parent AgentSH Permission Gate session ended before authorization completed");
      }
      failureReported = false;
      gateStatus(ctx, "ready");
      if (runtimeDisposition().kind !== "guard-only") {
        throw new Error("parent AgentSH Permission Gate ceased to be the sole command authority before execution");
      }
      return result;
    } catch (error) {
      reportGateFailure(ctx, error, boundAuthority);
      throw error;
    } finally {
      linked.dispose();
    }
  };

  if (inheritedGateClaim?.client) {
    inheritedGateClaim.client.setFailureHandler((error) => {
      subagentAuthority?.fail(error);
      if (sessionContext) reportGateFailure(sessionContext, error);
    });
  }

  pi.registerCommand("permission-gate", {
    description: "Toggle the legacy dangerous-command gate or show AgentSH gate status",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      if (inheritedGateClaim) {
        const failure = inheritedGateClaim.error ?? inheritedGateClaim.client?.failure;
        gateStatus(ctx, failure ? "error" : "ready");
        ctx.ui.notify(
          failure
            ? `AgentSH Permission Gate is mandatory and failed closed: ${boundedError(failure)}`
            : "AgentSH Permission Gate is launcher-owned and cannot be disabled in this session",
          failure ? "error" : "info",
        );
        return;
      }
      if (legacySuppressed()) {
        const unavailable = runtimeDisposition().kind === "unavailable";
        ctx.ui.setStatus("permission-gate", undefined);
        ctx.ui.notify(
          unavailable
            ? "Full AgentSH mode is selected but its supervisor is unavailable; native Bash is blocked"
            : "Legacy permission prompts are suppressed because AgentSH owns this session",
          unavailable ? "error" : "info",
        );
        return;
      }

      enabled = !enabled;
      if (enabled) {
        ctx.ui.setStatus("permission-gate", ctx.ui.theme.fg("warning", "gate ■"));
        ctx.ui.notify("Permission gate enabled — dangerous commands require approval", "info");
      } else {
        ctx.ui.setStatus("permission-gate", undefined);
        ctx.ui.notify("Permission gate disabled", "info");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    commandAuthority.active = true;
    commandReceipts.clear();
    sessionContext = ctx;
    if (inheritedGateClaim) {
      gateStatus(ctx, "waiting");
      try {
        const client = gateClient(inheritedGateClaim);
        await (eagerInitialization ?? client.initialize());
        if (client.failure) throw client.failure;
        if (!subagentAuthority || subagentAuthority.phase() === "inactive" || subagentAuthority.phase() === "failed") {
          subagentAuthority = gateSubagentAuthority(inheritedGateClaim);
          publishSubagentAuthority();
        }
        const boundAuthority = subagentAuthority;
        activePiSessionId = stablePiSessionId(ctx);
        boundAuthority.bind(
          authorityOwner,
          activePiSessionId,
          async (request, signal, sessionSignal) => await authorizeSubagent(
            boundAuthority,
            request,
            signal,
            sessionSignal,
          ),
          () => {
            if (sessionContext !== ctx) {
              throw new Error("Parent AgentSH Permission Gate session changed before child authorization commit");
            }
            if (client.failure) throw client.failure;
            if (runtimeDisposition().kind !== "guard-only") {
              throw new Error("Parent AgentSH Permission Gate ceased to be the sole command authority before child authorization commit");
            }
          },
        );
        failureReported = false;
        gateStatus(ctx, "ready");
      } catch (error) {
        reportGateFailure(ctx, error);
      }
      return;
    }
    if (!ctx.hasUI) return;
    if (enabled && !legacySuppressed()) {
      ctx.ui.setStatus("permission-gate", ctx.ui.theme.fg("warning", "gate ■"));
    } else {
      ctx.ui.setStatus("permission-gate", undefined);
    }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    commandAuthority.active = false;
    commandReceipts.clear();
    try {
      if (subagentAuthority) {
        const reason = event.reason ?? "quit";
        const sessionId = activePiSessionId ?? stablePiSessionId(ctx);
        if (reason === "reload") {
          const began = await subagentAuthority.beginReload(authorityOwner, sessionId);
          if (!began && subagentAuthority.phase() !== "failed" && subagentAuthority.phase() !== "inactive") {
            subagentAuthority.fail(new Error("Child Permission Gate authority could not enter reload handoff"));
          }
        } else {
          subagentAuthority.deactivate(
            authorityOwner,
            new Error(`Parent Pi session shut down (${reason}); child command authority was revoked`),
          );
        }
      }
    } catch (error) {
      subagentAuthority?.fail(asError(error));
      if (ctx.hasUI) gateStatus(ctx, "error");
    } finally {
      sessionContext = undefined;
      activePiSessionId = undefined;
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    const input = event.input as { action?: unknown; command?: unknown };
    const isBash = event.toolName === "bash";
    const isBackgroundStart = event.toolName === "background_job" && input.action === "start";
    if (!isBash && !isBackgroundStart) return undefined;
    const sealAuthorizedBashInput = () => {
      if (isBash) Object.freeze(input);
    };
    if (isBash) {
      try {
        applyBashCommandTransforms(input);
      } catch (error) {
        if (inheritedGateClaim) reportGateFailure(ctx, error);
        return {
          block: true,
          reason: `Bash command transformation failed closed: ${boundedError(error)}`,
        };
      }
    }

    if (inheritedGateClaim) {
      if (agentSHStartup.kind === "conflict") {
        gateStatus(ctx, "error");
        return {
          block: true,
          reason: "Conflicting AgentSH guard-only and full-supervisor authorities were selected; refusing command execution",
        };
      }
      gateStatus(ctx, "waiting");
      try {
        const command = input.command;
        if (typeof command !== "string") {
          throw new Error("Command is missing or malformed");
        }
        if (typeof event.toolCallId !== "string" || event.toolCallId.length === 0) {
          throw new Error("Command tool call ID is missing or malformed");
        }
        if (typeof ctx.cwd !== "string") throw new Error("Bash working directory is missing");

        const client = gateClient(inheritedGateClaim);
        const result = await client.authorize(
          { command, cwd: ctx.cwd, toolCallId: event.toolCallId },
          ctx.signal,
          async (metadata, timeoutMs, transportSignal) => {
            pi.events.emit("permission-gate:waiting");
            try {
              return await resolveAgentSHPrompt(ctx, metadata, timeoutMs, transportSignal);
            } finally {
              pi.events.emit("permission-gate:resolved");
            }
          },
        );
        failureReported = false;
        gateStatus(ctx, "ready");
        if (!result.allowed) {
          return { block: true, reason: `Blocked by AgentSH Permission Gate (${result.reason})` };
        }
        if (runtimeDisposition().kind === "unavailable") {
          return {
            block: true,
            reason: "AgentSH Permission Gate allowed the command intent, but full AgentSH mode is unavailable; refusing native command execution",
          };
        }
        authorizeBackgroundStart(event, command, ctx.cwd);
        sealAuthorizedBashInput();
        return undefined;
      } catch (error) {
        reportGateFailure(ctx, error);
        return {
          block: true,
          reason: `AgentSH Permission Gate failed closed: ${boundedError(error)}`,
        };
      }
    }

    // A selected full supervisor is authoritative. Never let its unavailable
    // state turn into native Bash fallback; once active, suppress only this
    // duplicate local gate and let the sandbox frontend dispatch.
    const disposition = runtimeDisposition();
    if (disposition.kind === "unavailable") {
      if (ctx.hasUI) ctx.ui.setStatus("permission-gate", undefined);
      return {
        block: true,
        reason: "Full AgentSH mode is selected but its supervisor is unavailable; refusing native command execution",
      };
    }
    if (disposition.kind === "full" || legacySuppressed()) {
      if (ctx.hasUI) ctx.ui.setStatus("permission-gate", undefined);
      if (typeof input.command === "string") authorizeBackgroundStart(event, input.command, ctx.cwd);
      return undefined;
    }

    const command = input.command;
    if (typeof command !== "string") return undefined;
    if (!enabled) {
      authorizeBackgroundStart(event, command, ctx.cwd);
      sealAuthorizedBashInput();
      return undefined;
    }
    const matched = dangerousPatterns.filter((candidate) => candidate.pattern.test(command));
    if (matched.length === 0) {
      authorizeBackgroundStart(event, command, ctx.cwd);
      sealAuthorizedBashInput();
      return undefined;
    }

    const labels = matched.map((match) => match.label).join(", ");
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Dangerous command blocked (${labels}) — no UI for confirmation`,
      };
    }

    pi.events.emit("permission-gate:waiting");
    let choice: string | undefined;
    try {
      const title = `⚠️  Dangerous command detected (${safePromptText(labels)}):\n\n  ${safePromptText(command)}\n\nAllow?`;
      const options = ["Yes", "No"];
      const localSelect = (signal: AbortSignal) => ctx.ui.select(title, options, { signal });
      const remote = paseoRemoteSelect(title, options, localSelect, ctx.signal);
      choice = await (remote ?? localSelect(ctx.signal ?? new AbortController().signal));
    } catch {
      choice = undefined;
    } finally {
      pi.events.emit("permission-gate:resolved");
    }

    if (choice !== "Yes") {
      return { block: true, reason: `Blocked by user (${labels})` };
    }
    authorizeBackgroundStart(event, command, ctx.cwd);
    sealAuthorizedBashInput();
    return undefined;
  });
}
