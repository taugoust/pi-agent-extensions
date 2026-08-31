/**
 * Permission Gate Extension
 *
 * In ordinary Pi sessions this retains the legacy, toggleable regex prompt.
 * When AgentSH passes AGENTSH_PERMISSION_GATE_FD, AgentSH owns classification
 * and this extension becomes a bounded client for that inherited authority
 * channel. Full AgentSH sandbox/supervised modes suppress the legacy gate.
 *
 * Credit for the original legacy gate: Mic92
 * (https://github.com/Mic92/dotfiles)
 */

import { Socket } from "node:net";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

const CAPABILITY_GATE_MARKER = "__paeSandboxCapabilityGateActive";
const GATE_CLAIM_KEY = "__paeAgentSHPermissionGateClaimV1";
const PASEO_REMOTE_UI_KEY = "__piPaseoRemoteUiV1";
const GATE_FD_ENV = "AGENTSH_PERMISSION_GATE_FD";
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

type FrameWaiter = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

type GateClaim = {
  protocol: 1;
  rawFD: string;
  timeoutRaw?: string;
  client?: AgentSHPermissionGateClient;
  error?: Error;
};

function ownEnvironment(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(process.env, name);
}

/**
 * Claim the launcher-owned marker once per process and remove it before any
 * model-requested child process can inherit it. The global claim survives Pi's
 * in-process extension reload/session replacement lifecycle.
 */
function claimInheritedGate(): GateClaim | undefined {
  const root = globalThis as Record<string, unknown>;
  const existing = root[GATE_CLAIM_KEY] as GateClaim | undefined;
  const markerPresent = ownEnvironment(GATE_FD_ENV);
  const rawFD = markerPresent ? process.env[GATE_FD_ENV] ?? "" : undefined;
  if (markerPresent) delete process.env[GATE_FD_ENV];

  if (existing?.protocol === PROTOCOL_VERSION && typeof existing.rawFD === "string") {
    return existing;
  }
  if (!markerPresent) return undefined;

  const claim: GateClaim = {
    protocol: PROTOCOL_VERSION,
    rawFD: rawFD!,
    timeoutRaw: process.env[GATE_TIMEOUT_ENV],
  };
  root[GATE_CLAIM_KEY] = claim;
  return claim;
}

const inheritedGateClaim = claimInheritedGate();

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

function parseGateFD(raw: string): number {
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${GATE_FD_ENV} is malformed`);
  }
  const fd = Number(raw);
  if (!Number.isSafeInteger(fd) || fd < 3 || fd > 1_048_575) {
    throw new Error(`${GATE_FD_ENV} is not a valid inherited descriptor`);
  }
  return fd;
}

function gateClient(claim: GateClaim): AgentSHPermissionGateClient {
  if (claim.error) throw claim.error;
  if (claim.client) return claim.client;
  try {
    claim.client = new AgentSHPermissionGateClient(
      parseGateFD(claim.rawFD),
      configuredTimeout(claim.timeoutRaw),
    );
    return claim.client;
  } catch (error) {
    claim.error = asError(error);
    throw claim.error;
  }
}

/** Capture full AgentSH modes before asynchronous extension startup/order. */
function fullAgentSHMode(): boolean {
  const env = process.env;
  return env.PI_SUPERVISED === "1"
    || env.PI_AUTO === "1"
    || env.PI_AGENTSH_REMOTE === "ssh"
    || env.PI_AGENTSH_READ_MODE === "supervised"
    || Boolean(env.AGENTSH_SESSION_SUPERVISOR)
    || Boolean(env.PI_AGENTSH_MOCK_SUPERVISOR)
    || env.PI_AGENTSH_ENABLE === "1"
    || Boolean(env.AGENTSH_CHILD_CAPABILITY);
}

function isSuppressedBySandboxMarker(): boolean {
  return (globalThis as Record<string, unknown>)[CAPABILITY_GATE_MARKER] === true;
}

function paseoRemoteSelect(
  title: string,
  options: string[],
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
    return Promise.resolve(bridge.select(title, options, { signal })).catch(() => undefined);
  } catch {
    return Promise.resolve(undefined);
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
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
  #ready?: Promise<void>;
  #tail: Promise<void> = Promise.resolve();
  #requestNumber = 0;

  constructor(fd: number, timeoutMs: number) {
    this.timeoutMs = timeoutMs;
    this.#socket = new Socket({ fd, readable: true, writable: true });
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
    request: { command: string; cwd: string; toolCallId: string },
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
    request: { command: string; cwd: string; toolCallId: string },
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

function promptTitle(metadata: PromptMetadata): string {
  const lines = [metadata.title];
  if (metadata.message) lines.push("", metadata.message);
  if (metadata.labels.length > 0 && !metadata.message) {
    lines.push("", `Detected: ${metadata.labels.join(", ")}`);
  }
  lines.push("", "Command:", metadata.commandPreview);
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
): Promise<PromptResolution> {
  if (!ctx.hasUI) return { kind: "cancel", reason: "no UI available" };

  const deadline = promptDeadline([ctx.signal, transportSignal], timeoutMs);
  try {
    const title = promptTitle(metadata);
    const options = [DENY_CHOICE, ALLOW_CHOICE];
    const remote = paseoRemoteSelect(title, options, deadline.signal);
    let choice: string | undefined;
    try {
      const selection = remote === null
        ? ctx.ui.select(title, options, { signal: deadline.signal })
        : remote;
      choice = await abortableSelection(selection, deadline.signal);
    } catch {
      choice = undefined;
    }

    if (ctx.signal?.aborted) return { kind: "cancel", reason: "caller aborted" };
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

function gateStatus(ctx: ExtensionContext, state: "ready" | "waiting" | "error" = "ready"): void {
  if (!ctx.hasUI) return;
  const color = state === "error" ? "error" : state === "waiting" ? "warning" : "success";
  const text = state === "error" ? "AgentSH gate ✗" : state === "waiting" ? "AgentSH gate ?" : "AgentSH gate ■";
  ctx.ui.setStatus("permission-gate", ctx.ui.theme.fg(color, text));
}

export default function permissionGate(pi: ExtensionAPI) {
  let enabled = true;
  let failureReported = false;
  const suppressLegacySynchronously = !inheritedGateClaim && fullAgentSHMode();
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

  const legacySuppressed = () => suppressLegacySynchronously || isSuppressedBySandboxMarker();

  const reportGateFailure = (ctx: ExtensionContext, error: unknown) => {
    gateStatus(ctx, "error");
    if (failureReported) return;
    failureReported = true;
    const message = `AgentSH Permission Gate failed closed: ${boundedError(error)}`;
    if (ctx.hasUI) ctx.ui.notify(message, "error");
    else process.stderr.write(`[permission-gate] ${message}\n`);
  };

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
        ctx.ui.setStatus("permission-gate", undefined);
        ctx.ui.notify("Legacy permission prompts are suppressed because AgentSH owns this session", "info");
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
    if (inheritedGateClaim) {
      gateStatus(ctx, "waiting");
      try {
        await (eagerInitialization ?? gateClient(inheritedGateClaim).initialize());
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

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;

    if (inheritedGateClaim) {
      gateStatus(ctx, "waiting");
      try {
        const command = (event.input as { command?: unknown }).command;
        if (typeof command !== "string") {
          throw new Error("Bash command is missing or malformed");
        }
        if (typeof event.toolCallId !== "string" || event.toolCallId.length === 0) {
          throw new Error("Bash tool call ID is missing or malformed");
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
        return undefined;
      } catch (error) {
        reportGateFailure(ctx, error);
        return {
          block: true,
          reason: `AgentSH Permission Gate failed closed: ${boundedError(error)}`,
        };
      }
    }

    // A configured full supervisor is authoritative. Suppress this local gate
    // even before sandbox's asynchronous session_start has attached.
    if (legacySuppressed()) {
      if (ctx.hasUI) ctx.ui.setStatus("permission-gate", undefined);
      return undefined;
    }
    if (!enabled) return undefined;

    const command = (event.input as { command?: unknown }).command;
    if (typeof command !== "string") return undefined;
    const matched = dangerousPatterns.filter((candidate) => candidate.pattern.test(command));
    if (matched.length === 0) return undefined;

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
      const title = `⚠️  Dangerous command detected (${labels}):\n\n  ${command}\n\nAllow?`;
      const remote = paseoRemoteSelect(title, ["Yes", "No"], ctx.signal);
      choice = remote === null
        ? await ctx.ui.select(title, ["Yes", "No"], { signal: ctx.signal })
        : await remote;
    } catch {
      choice = undefined;
    } finally {
      pi.events.emit("permission-gate:resolved");
    }

    if (choice !== "Yes") {
      return { block: true, reason: `Blocked by user (${labels})` };
    }
    return undefined;
  });
}
