import { createConnection, type Socket } from "node:net";
import { isAbsolute } from "node:path";
import { createBashTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  SUBAGENT_PERMISSION_MAX_COMMAND_BYTES,
  SUBAGENT_PERMISSION_MAX_CWD_BYTES,
  SUBAGENT_PERMISSION_MAX_FRAME_BYTES,
  SUBAGENT_PERMISSION_MAX_ID_BYTES,
  SUBAGENT_PERMISSION_MAX_REASON_BYTES,
  SUBAGENT_PERMISSION_MAX_REQUESTS,
  SUBAGENT_PERMISSION_MAX_TOOLS,
  SUBAGENT_PERMISSION_NATIVE_TOOLS,
  SUBAGENT_PERMISSION_BASH_TOOL,
  SUBAGENT_PERMISSION_PROTOCOL_VERSION,
  SUBAGENT_PERMISSION_SOCKET_ENV,
  SUBAGENT_PERMISSION_TOKEN_ENV,
} from "../shared/subagent-permission.js";

const CLAIM_KEY = "__paeNativeSubagentPermissionProxyClaimV1";
const HANDSHAKE_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

type JsonObject = Record<string, unknown>;
type Claim = { protocol: 1; socketPath: string; token: string; subagentId: string; client?: ParentPermissionClient; error?: Error };
type Waiter = { resolve(value: JsonObject): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function boundedError(error: unknown): string {
  const value = asError(error).message.replace(/[\r\n\x00-\x1f\x7f]+/g, " ");
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= SUBAGENT_PERMISSION_MAX_REASON_BYTES) return value;
  let end = SUBAGENT_PERMISSION_MAX_REASON_BYTES;
  while (end > 0) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)); }
    catch { end -= 1; }
  }
  return "permission relay error";
}

function ownEnvironment(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(process.env, name);
}

function claimEnvironment(): Claim | undefined {
  const root = globalThis as Record<string, unknown>;
  const existing = root[CLAIM_KEY] as Claim | undefined;
  const socketPresent = ownEnvironment(SUBAGENT_PERMISSION_SOCKET_ENV);
  const tokenPresent = ownEnvironment(SUBAGENT_PERMISSION_TOKEN_ENV);
  const socketPath = process.env[SUBAGENT_PERMISSION_SOCKET_ENV] ?? "";
  const token = process.env[SUBAGENT_PERMISSION_TOKEN_ENV] ?? "";
  if (socketPresent) delete process.env[SUBAGENT_PERMISSION_SOCKET_ENV];
  if (tokenPresent) delete process.env[SUBAGENT_PERMISSION_TOKEN_ENV];
  if (existing?.protocol === SUBAGENT_PERMISSION_PROTOCOL_VERSION) return existing;
  if (!socketPresent && !tokenPresent) return undefined;
  const claim: Claim = {
    protocol: SUBAGENT_PERMISSION_PROTOCOL_VERSION,
    socketPath,
    token,
    subagentId: process.env.PI_SUBAGENT_ID ?? "",
  };
  root[CLAIM_KEY] = claim;
  return claim;
}

const inheritedClaim = claimEnvironment();

function requiredString(value: unknown, name: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) throw new Error(`invalid ${name}`);
  if (Buffer.from(value, "utf8").toString("utf8") !== value || Buffer.byteLength(value, "utf8") > maximum) {
    throw new Error(`invalid ${name}`);
  }
  return value;
}

function exactKeys(value: JsonObject, required: readonly string[]): void {
  const allowed = new Set(required);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`unexpected field ${key}`);
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) throw new Error(`missing field ${key}`);
}

function validateClaim(claim: Claim): void {
  if (process.platform !== "linux") throw new Error("guarded native subagents currently require Linux");
  if (!isAbsolute(claim.socketPath) || claim.socketPath.includes("\0") || Buffer.byteLength(claim.socketPath, "utf8") > 4096) {
    throw new Error("invalid parent permission relay socket");
  }
  if (!/^[0-9a-f]{64}$/.test(claim.token)) throw new Error("invalid parent permission relay token");
  requiredString(claim.subagentId, "subagent id", SUBAGENT_PERMISSION_MAX_ID_BYTES);
}

class ParentPermissionClient {
  private readonly socket: Socket;
  private buffer = Buffer.alloc(0);
  private waiter?: Waiter;
  private fatal?: Error;
  private readyPromise?: Promise<void>;
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private requestNumber = 0;

  constructor(private readonly claim: Claim) {
    validateClaim(claim);
    this.socket = createConnection({ path: claim.socketPath });
    // Pi print-mode children may otherwise exit after their initial session event,
    // before the first model turn. Keep this authority channel referenced for the
    // child's full lifetime; session_shutdown closes it explicitly.
    this.socket.on("data", (chunk: Buffer) => this.receive(Buffer.from(chunk)));
    this.socket.on("error", (error) => this.fail(new Error(`parent permission relay transport failed: ${error.message}`)));
    this.socket.on("end", () => {
      if (!this.closing) this.fail(new Error("parent permission relay reached unexpected EOF"));
    });
    this.socket.on("close", () => {
      if (!this.fatal && !this.closing) this.fail(new Error("parent permission relay closed unexpectedly"));
    });
  }

  initialize(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.initializeOnce().catch((error) => {
        this.fail(asError(error));
        throw error;
      });
    }
    return this.readyPromise;
  }

  authorize(request: { command: string; cwd: string; toolCallId: string }, signal?: AbortSignal): Promise<{ allowed: boolean; reason: string; fatal: boolean }> {
    const operation = this.tail.then(async () => {
      await this.initialize();
      return await this.authorizeOnce(request, signal);
    });
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async close(): Promise<void> {
    if (this.fatal || this.closing) return;
    this.closing = true;
    try {
      await this.write({ v: SUBAGENT_PERMISSION_PROTOCOL_VERSION, type: "goodbye" });
    } catch {
      // The child is already shutting down; the parent treats a missing
      // goodbye as an abnormal relay failure.
    } finally {
      this.socket.destroy();
    }
  }

  private async initializeOnce(): Promise<void> {
    const response = await this.exchange({
      v: SUBAGENT_PERMISSION_PROTOCOL_VERSION,
      type: "hello",
      token: this.claim.token,
      subagent_id: this.claim.subagentId,
      pid: process.pid,
    }, HANDSHAKE_TIMEOUT_MS);
    exactKeys(response, ["v", "type", "service", "tools"]);
    if (response.v !== SUBAGENT_PERMISSION_PROTOCOL_VERSION || response.type !== "hello" || response.service !== "pi-subagent-permission-relay"
      || !Array.isArray(response.tools) || response.tools.length > SUBAGENT_PERMISSION_MAX_TOOLS
      || new Set(response.tools).size !== response.tools.length
      || response.tools.some((tool) => typeof tool !== "string"
        || !SUBAGENT_PERMISSION_NATIVE_TOOLS.includes(tool as typeof SUBAGENT_PERMISSION_NATIVE_TOOLS[number]))) {
      throw new Error("parent permission relay returned an invalid hello");
    }
  }

  private async authorizeOnce(
    request: { command: string; cwd: string; toolCallId: string },
    signal?: AbortSignal,
  ): Promise<{ allowed: boolean; reason: string; fatal: boolean }> {
    if (this.fatal) throw this.fatal;
    if (signal?.aborted) return { allowed: false, reason: "native subagent tool call was aborted", fatal: false };
    if (this.requestNumber >= SUBAGENT_PERMISSION_MAX_REQUESTS) throw new Error("parent permission relay request limit exceeded");
    const command = requiredString(request.command, "command", SUBAGENT_PERMISSION_MAX_COMMAND_BYTES);
    const cwd = requiredString(request.cwd, "cwd", SUBAGENT_PERMISSION_MAX_CWD_BYTES, true);
    const toolCallId = requiredString(request.toolCallId, "tool call id", SUBAGENT_PERMISSION_MAX_ID_BYTES);
    const id = `child-${process.pid}-${++this.requestNumber}`;

    let abort: (() => void) | undefined;
    if (signal) {
      abort = () => {
        void this.write({ v: 1, type: "cancel", id }).catch(() => undefined);
      };
      signal.addEventListener("abort", abort, { once: true });
    }
    try {
      const response = await this.exchange({
        v: SUBAGENT_PERMISSION_PROTOCOL_VERSION,
        type: "authorize",
        id,
        kind: "bash",
        command,
        cwd,
        tool_call_id: toolCallId,
      }, REQUEST_TIMEOUT_MS);
      exactKeys(response, ["v", "type", "id", "allowed", "reason", "fatal"]);
      if (response.v !== SUBAGENT_PERMISSION_PROTOCOL_VERSION || response.type !== "decision" || response.id !== id
        || typeof response.allowed !== "boolean" || typeof response.fatal !== "boolean") {
        throw new Error("parent permission relay returned an invalid decision");
      }
      const reason = requiredString(response.reason, "decision reason", SUBAGENT_PERMISSION_MAX_REASON_BYTES);
      if (signal?.aborted) return { allowed: false, reason: "native subagent tool call was aborted", fatal: false };
      return { allowed: response.allowed, reason, fatal: response.fatal };
    } finally {
      if (abort) signal!.removeEventListener("abort", abort);
    }
  }

  private async exchange(message: JsonObject, timeoutMs: number): Promise<JsonObject> {
    const response = this.read(timeoutMs);
    void response.catch(() => undefined);
    await this.write(message);
    return await response;
  }

  private async write(message: JsonObject): Promise<void> {
    if (this.fatal) throw this.fatal;
    const frame = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
    if (frame.length - 1 > SUBAGENT_PERMISSION_MAX_FRAME_BYTES) throw new Error("parent permission relay request is oversized");
    await new Promise<void>((resolve, reject) => {
      try {
        this.socket.write(frame, (error?: Error | null) => error ? reject(error) : resolve());
      } catch (error) {
        reject(error);
      }
    });
  }

  private read(timeoutMs: number): Promise<JsonObject> {
    if (this.fatal) return Promise.reject(this.fatal);
    if (this.waiter) return Promise.reject(new Error("parent permission relay has a concurrent read"));
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error("parent permission relay timed out");
        this.fail(error);
      }, timeoutMs);
      timer.unref?.();
      this.waiter = { resolve, reject, timer };
    });
  }

  private receive(chunk: Buffer): void {
    if (this.fatal || chunk.length === 0) return;
    if (!this.waiter) {
      this.fail(new Error("parent permission relay sent an unsolicited frame"));
      return;
    }
    if (this.buffer.length + chunk.length > SUBAGENT_PERMISSION_MAX_FRAME_BYTES + 1) {
      this.fail(new Error("parent permission relay response is oversized"));
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const newline = this.buffer.indexOf(0x0a);
    if (newline < 0) return;
    if (newline === 0 || newline > SUBAGENT_PERMISSION_MAX_FRAME_BYTES || newline !== this.buffer.length - 1) {
      this.fail(new Error("parent permission relay returned an invalid frame boundary"));
      return;
    }
    const frame = this.buffer.subarray(0, newline);
    this.buffer = Buffer.alloc(0);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("response is not an object");
    } catch (error) {
      this.fail(new Error(`parent permission relay returned malformed JSON: ${boundedError(error)}`));
      return;
    }
    const waiter = this.waiter;
    this.waiter = undefined;
    clearTimeout(waiter.timer);
    waiter.resolve(value as JsonObject);
  }

  private fail(error: Error): void {
    if (this.fatal) return;
    this.fatal = error;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.socket.destroy();
  }
}

function relayClient(claim: Claim): ParentPermissionClient {
  if (claim.error) throw claim.error;
  if (claim.client) return claim.client;
  try {
    claim.client = new ParentPermissionClient(claim);
    return claim.client;
  } catch (error) {
    claim.error = asError(error);
    throw claim.error;
  }
}

export default function nativeSubagentPermissionProxy(pi: ExtensionAPI) {
  if (!inheritedClaim) return;

  const childCwd = process.cwd();
  const bashTool = createBashTool(childCwd);
  let initializationError: Error | undefined;
  const initialize = async () => {
    if (initializationError) throw initializationError;
    try {
      await relayClient(inheritedClaim).initialize();
    } catch (error) {
      initializationError = asError(error);
      throw initializationError;
    }
  };

  // Wrap the built-in Bash implementation rather than authorizing in a
  // preflight hook. The exact command snapshot is checked inside execute(), after all
  // tool_call handlers have run and immediately before the built-in runner.
  const permissionBash = {
    ...bashTool,
    name: SUBAGENT_PERMISSION_BASH_TOOL,
    label: "bash (parent-approved)",
    description: "Execute a Bash command after authorization by the parent AgentSH Permission Gate.",
    async execute(
      toolCallId: string,
      params: Parameters<typeof bashTool.execute>[1],
      signal: Parameters<typeof bashTool.execute>[2],
      onUpdate: Parameters<typeof bashTool.execute>[3],
      _ctx: unknown,
    ) {
      let command: string;
      try {
        await initialize();
        command = requiredString(params.command, "command", SUBAGENT_PERMISSION_MAX_COMMAND_BYTES);
        const id = requiredString(toolCallId, "tool call id", SUBAGENT_PERMISSION_MAX_ID_BYTES);
        const result = await relayClient(inheritedClaim).authorize({
          command,
          cwd: childCwd,
          toolCallId: id,
        }, signal);
        if (!result.allowed) {
          if (result.fatal) throw new Error(result.reason);
          return {
            content: [{ type: "text" as const, text: `Blocked by parent AgentSH Permission Gate (${result.reason})` }],
            details: { permissionGate: signal?.aborted ? "aborted" : "denied" },
          };
        }
      } catch (error) {
        throw new Error(`Parent AgentSH Permission Gate failed closed: ${boundedError(error)}`);
      }
      // The built-in implementation observes a cancellation racing the final
      // authority response before it spawns the shell.
      return await bashTool.execute(toolCallId, { ...params, command }, signal, onUpdate);
    },
  };

  // Connect eagerly; the startup barrier below prevents the first model turn
  // until the parent authenticates, and execute() rechecks every command.
  void initialize().catch(() => undefined);

  pi.on("session_start", async () => {
    await initialize();
  });

  // Use a distinct tool name so a missing or broken proxy cannot expose Pi's
  // built-in Bash under the guarded child's CLI allowlist.
  pi.registerTool(permissionBash);

  pi.on("before_agent_start", async () => {
    await initialize();
  });

  pi.on("session_shutdown", async () => {
    try { await inheritedClaim.client?.close(); } catch {}
  });
}
