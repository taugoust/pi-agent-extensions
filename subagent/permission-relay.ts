import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  SUBAGENT_PERMISSION_MAX_COMMAND_BYTES,
  SUBAGENT_PERMISSION_MAX_CWD_BYTES,
  SUBAGENT_PERMISSION_MAX_FRAME_BYTES,
  SUBAGENT_PERMISSION_MAX_ID_BYTES,
  SUBAGENT_PERMISSION_MAX_REASON_BYTES,
  SUBAGENT_PERMISSION_MAX_REQUESTS,
  SUBAGENT_PERMISSION_MAX_TOOLS,
  SUBAGENT_PERMISSION_NATIVE_TOOLS,
  SUBAGENT_PERMISSION_PROTOCOL_VERSION,
  SUBAGENT_PERMISSION_SOCKET_ENV,
  SUBAGENT_PERMISSION_TOKEN_ENV,
  type SubagentPermissionAuthority,
} from "../shared/subagent-permission.js";

const HANDSHAKE_TIMEOUT_MS = 10_000;

type JsonObject = Record<string, unknown>;
type PendingRequest = { controller: AbortController; responded: boolean };

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function truncateUTF8(value: string, maximum: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximum) return value;
  let end = maximum;
  while (end > 0) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)); }
    catch { end -= 1; }
  }
  return "";
}

function boundedReason(error: unknown): string {
  return truncateUTF8(
    asError(error).message.replace(/[\r\n\x00-\x1f\x7f]+/g, " "),
    SUBAGENT_PERMISSION_MAX_REASON_BYTES,
  );
}

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

function parseFrame(frame: Buffer): JsonObject {
  if (frame.length === 0 || frame.length > SUBAGENT_PERMISSION_MAX_FRAME_BYTES) throw new Error("invalid relay frame size");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("relay frame is not an object");
  return value as JsonObject;
}

function processStartToken(pid: number): string {
  if (process.platform !== "linux") throw new Error("guarded native subagents currently require Linux process identity support");
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const close = stat.lastIndexOf(")");
  if (close < 0) throw new Error("could not parse child process identity");
  const token = stat.slice(close + 2).split(" ")[19];
  if (!token) throw new Error("child process start token is unavailable");
  return token;
}

function secureRuntimeRoot(): string {
  const configured = process.env.XDG_RUNTIME_DIR?.trim();
  const base = configured && path.isAbsolute(configured) ? configured : os.tmpdir();
  const root = fs.mkdtempSync(path.join(base, "pi-subagent-permission-"));
  fs.chmodSync(root, 0o700);
  const info = fs.lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0) {
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error("could not create a private subagent permission relay directory");
  }
  return root;
}

/** One-child, one-connection parent relay for native subagent Bash preflights. */
export class NativeSubagentPermissionRelay {
  readonly ready: Promise<void>;
  readonly failure: Promise<never>;
  readonly environment: Record<string, string>;

  private readonly root: string;
  private readonly socketPath: string;
  private readonly token: Buffer;
  private readonly server: net.Server;
  private readonly authority: SubagentPermissionAuthority;
  private readonly subagentId: string;
  private readonly label: string;
  private readonly task: string;
  private readonly expectedCwd: string;
  private readonly tools: string[];
  private readonly pending = new Map<string, PendingRequest>();
  private readonly seen = new Set<string>();
  private socket?: net.Socket;
  private buffer = Buffer.alloc(0);
  private expectedPid?: number;
  private expectedStartToken?: string;
  private hello = false;
  private closed = false;
  private readySettled = false;
  private failureSettled = false;
  private gracefulSettled = false;
  private readonly gracefulShutdown: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private rejectFailure!: (error: Error) => void;
  private resolveGraceful!: () => void;
  private rejectGraceful!: (error: Error) => void;
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private parentSignal?: AbortSignal;
  private parentAbort?: () => void;

  private constructor(options: {
    root: string;
    authority: SubagentPermissionAuthority;
    subagentId: string;
    label: string;
    task: string;
    cwd: string;
    tools: string[];
    signal?: AbortSignal;
  }) {
    this.root = options.root;
    this.socketPath = path.join(options.root, "relay.sock");
    this.token = randomBytes(32);
    this.authority = options.authority;
    this.subagentId = requiredString(options.subagentId, "subagent id", SUBAGENT_PERMISSION_MAX_ID_BYTES);
    this.label = requiredString(options.label, "subagent label", SUBAGENT_PERMISSION_MAX_ID_BYTES);
    this.task = truncateUTF8(requiredString(options.task, "subagent task", SUBAGENT_PERMISSION_MAX_FRAME_BYTES), 2048);
    this.expectedCwd = requiredString(options.cwd, "subagent cwd", SUBAGENT_PERMISSION_MAX_CWD_BYTES, true);
    if (!Array.isArray(options.tools) || options.tools.length > SUBAGENT_PERMISSION_MAX_TOOLS
      || new Set(options.tools).size !== options.tools.length
      || options.tools.some((tool) => !SUBAGENT_PERMISSION_NATIVE_TOOLS.includes(tool as typeof SUBAGENT_PERMISSION_NATIVE_TOOLS[number]))) {
      throw new Error("invalid guarded native subagent tool set");
    }
    this.tools = [...options.tools];
    this.environment = {
      [SUBAGENT_PERMISSION_SOCKET_ENV]: this.socketPath,
      [SUBAGENT_PERMISSION_TOKEN_ENV]: this.token.toString("hex"),
    };
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.failure = new Promise<never>((_resolve, reject) => {
      this.rejectFailure = reject;
    });
    this.gracefulShutdown = new Promise<void>((resolve, reject) => {
      this.resolveGraceful = resolve;
      this.rejectGraceful = reject;
    });
    void this.failure.catch(() => undefined);
    void this.gracefulShutdown.catch(() => undefined);
    // Keep a rejection observer attached even when launch fails before the
    // caller reaches its own await of the attestation promise.
    void this.ready.catch(() => undefined);
    this.server = net.createServer((socket) => this.accept(socket));
    this.server.on("error", (error) => this.close(new Error(`subagent permission relay server failed: ${error.message}`)));
    if (options.signal) {
      this.parentSignal = options.signal;
      this.parentAbort = () => this.close(asError(options.signal!.reason ?? new Error("parent subagent execution was aborted")));
      if (options.signal.aborted) this.parentAbort();
      else options.signal.addEventListener("abort", this.parentAbort, { once: true });
    }
  }

  static async create(options: {
    authority: SubagentPermissionAuthority;
    subagentId: string;
    label: string;
    task: string;
    cwd: string;
    tools: string[];
    signal?: AbortSignal;
  }): Promise<NativeSubagentPermissionRelay> {
    if (options.signal?.aborted) throw asError(options.signal.reason ?? new Error("parent subagent execution was aborted"));
    if (!options.authority.active) throw new Error("parent AgentSH Permission Gate is not active");
    const root = secureRuntimeRoot();
    let relay: NativeSubagentPermissionRelay;
    try {
      relay = new NativeSubagentPermissionRelay({ ...options, root });
    } catch (error) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
      throw error;
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        relay.server.once("error", onError);
        relay.server.listen(relay.socketPath, () => {
          relay.server.removeListener("error", onError);
          try {
            fs.chmodSync(relay.socketPath, 0o600);
            resolve();
          } catch (error) {
            reject(asError(error));
          }
        });
      });
      relay.handshakeTimer = setTimeout(() => relay.close(new Error("native subagent permission proxy did not connect in time")), HANDSHAKE_TIMEOUT_MS);
      relay.handshakeTimer.unref?.();
      return relay;
    } catch (error) {
      relay.close(asError(error));
      throw error;
    }
  }

  bindChild(pid: number | undefined): void {
    if (!Number.isSafeInteger(pid) || pid! < 1) {
      this.close(new Error("native subagent process ID is unavailable"));
      return;
    }
    try {
      this.expectedPid = pid;
      this.expectedStartToken = processStartToken(pid!);
    } catch (error) {
      this.close(asError(error));
    }
  }

  async waitForGracefulShutdown(timeoutMs = 1000): Promise<void> {
    if (this.gracefulSettled) return await this.gracefulShutdown;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.gracefulShutdown,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("native subagent permission proxy exited without authenticated goodbye")), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  close(reason: Error = new Error("native subagent permission relay closed"), reportFailure = true): void {
    if (this.closed) return;
    this.closed = true;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
    if (this.parentSignal && this.parentAbort) this.parentSignal.removeEventListener("abort", this.parentAbort);
    this.parentSignal = undefined;
    this.parentAbort = undefined;
    for (const pending of this.pending.values()) pending.controller.abort(reason);
    this.pending.clear();
    try { this.socket?.destroy(); } catch {}
    try { this.server.close(); } catch {}
    try { fs.unlinkSync(this.socketPath); } catch {}
    try { fs.rmSync(this.root, { recursive: true, force: true }); } catch {}
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(reason);
    }
    if (reportFailure && !this.failureSettled) {
      this.failureSettled = true;
      this.rejectFailure(reason);
    }
    if (reportFailure && !this.gracefulSettled) {
      this.gracefulSettled = true;
      this.rejectGraceful(reason);
    }
  }

  dispose(): void {
    this.close(new Error("native subagent permission relay disposed"), false);
  }

  private accept(socket: net.Socket): void {
    if (this.closed || this.socket) {
      socket.destroy();
      return;
    }
    this.socket = socket;
    socket.setNoDelay?.(true);
    socket.on("data", (chunk: Buffer) => this.receive(Buffer.from(chunk)));
    socket.on("error", (error) => this.close(new Error(`native subagent permission relay transport failed: ${error.message}`)));
    socket.on("close", () => {
      if (!this.closed) this.close(new Error("native subagent permission proxy disconnected"));
    });
  }

  private receive(chunk: Buffer): void {
    if (this.closed || chunk.length === 0) return;
    if (this.buffer.length + chunk.length > SUBAGENT_PERMISSION_MAX_FRAME_BYTES + 1) {
      this.close(new Error("native subagent permission relay receive buffer is oversized"));
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.buffer.length > SUBAGENT_PERMISSION_MAX_FRAME_BYTES) this.close(new Error("native subagent permission relay frame is oversized"));
        return;
      }
      const frame = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      try {
        this.handleFrame(parseFrame(frame));
      } catch (error) {
        this.close(new Error(`native subagent permission relay protocol violation: ${boundedReason(error)}`));
        return;
      }
      if (this.closed) return;
    }
  }

  private handleFrame(frame: JsonObject): void {
    if (frame.v !== SUBAGENT_PERMISSION_PROTOCOL_VERSION || typeof frame.type !== "string") throw new Error("invalid envelope");
    if (!this.hello) {
      exactKeys(frame, ["v", "type", "token", "subagent_id", "pid"]);
      if (frame.type !== "hello") throw new Error("first frame is not hello");
      const token = requiredString(frame.token, "token", 64);
      if (!/^[0-9a-f]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token, "hex"), this.token)) throw new Error("authentication failed");
      const subagentId = requiredString(frame.subagent_id, "subagent id", SUBAGENT_PERMISSION_MAX_ID_BYTES);
      if (subagentId !== this.subagentId) throw new Error("subagent identity does not match");
      if (!Number.isSafeInteger(frame.pid) || (frame.pid as number) < 1 || frame.pid !== this.expectedPid) throw new Error("child PID does not match");
      this.verifyChildIdentity();
      this.hello = true;
      this.retireListener();
      void this.send({ v: 1, type: "hello", service: "pi-subagent-permission-relay", tools: this.tools }).then(() => {
        if (this.closed || this.readySettled) return;
        this.readySettled = true;
        if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
        this.handshakeTimer = undefined;
        this.resolveReady();
      }).catch((error) => this.close(asError(error)));
      return;
    }

    if (frame.type === "goodbye") {
      exactKeys(frame, ["v", "type"]);
      if (this.pending.size > 0) throw new Error("goodbye received with a pending authorization");
      if (!this.gracefulSettled) {
        this.gracefulSettled = true;
        this.resolveGraceful();
      }
      this.dispose();
      return;
    }

    if (frame.type === "cancel") {
      exactKeys(frame, ["v", "type", "id"]);
      const id = requiredString(frame.id, "request id", SUBAGENT_PERMISSION_MAX_ID_BYTES);
      const pending = this.pending.get(id);
      // Cancellation may race the write callback for an already completed
      // decision. Ignore that known late frame; replying twice would corrupt
      // the next request on this sequential connection.
      if (!pending) {
        if (this.seen.has(id)) return;
        throw new Error("cancellation has no known request");
      }
      if (pending.responded) return;
      pending.responded = true;
      pending.controller.abort(new Error("native subagent tool call was aborted"));
      this.pending.delete(id);
      void this.send({ v: 1, type: "decision", id, allowed: false, reason: "native subagent tool call was aborted", fatal: false })
        .catch((error) => this.close(asError(error)));
      return;
    }

    exactKeys(frame, ["v", "type", "id", "kind", "command", "cwd", "tool_call_id"]);
    if (frame.type !== "authorize" || frame.kind !== "bash") throw new Error("unsupported request");
    if (this.seen.size >= SUBAGENT_PERMISSION_MAX_REQUESTS) throw new Error("request limit exceeded");
    if (this.pending.size > 0) throw new Error("concurrent authorization request");
    const id = requiredString(frame.id, "request id", SUBAGENT_PERMISSION_MAX_ID_BYTES);
    if (this.seen.has(id)) throw new Error("duplicate request id");
    const command = requiredString(frame.command, "command", SUBAGENT_PERMISSION_MAX_COMMAND_BYTES);
    const cwd = requiredString(frame.cwd, "cwd", SUBAGENT_PERMISSION_MAX_CWD_BYTES, true);
    if (cwd !== this.expectedCwd) throw new Error("child working directory does not match launch cwd");
    const childToolCallId = requiredString(frame.tool_call_id, "tool call id", SUBAGENT_PERMISSION_MAX_ID_BYTES);
    const toolCallId = `subagent-${createHash("sha256")
      .update(this.subagentId).update("\0").update(childToolCallId).digest("hex")}`;
    this.verifyChildIdentity();
    this.seen.add(id);
    const pending: PendingRequest = { controller: new AbortController(), responded: false };
    this.pending.set(id, pending);
    void this.authorize(id, pending, { command, cwd, toolCallId });
  }

  private async authorize(
    id: string,
    pending: PendingRequest,
    request: { command: string; cwd: string; toolCallId: string },
  ): Promise<void> {
    let allowed = false;
    let reason = "parent AgentSH Permission Gate denied the command";
    let fatalError: Error | undefined;
    try {
      if (!this.authority.active) throw new Error("parent AgentSH Permission Gate is no longer active");
      const result = await this.authority.authorize({
        subagentId: this.subagentId,
        label: this.label,
        task: this.task,
        ...request,
      }, pending.controller.signal);
      allowed = result.allowed;
      reason = result.reason;
      if (!this.authority.active) throw new Error("parent AgentSH Permission Gate session ended before authorization completed");
      if (allowed) this.verifyChildIdentity();
    } catch (error) {
      fatalError = asError(error);
      allowed = false;
      reason = `parent AgentSH Permission Gate failed closed: ${boundedReason(error)}`;
    }
    if (this.closed || pending.responded || this.pending.get(id) !== pending) return;
    pending.responded = true;
    this.pending.delete(id);
    try {
      await this.send({
        v: 1,
        type: "decision",
        id,
        allowed,
        reason: requiredString(reason || (allowed ? "allowed" : "denied"), "decision reason", SUBAGENT_PERMISSION_MAX_REASON_BYTES),
        fatal: Boolean(fatalError),
      });
      if (fatalError) this.close(fatalError);
    } catch (error) {
      this.close(asError(error));
    }
  }

  private verifyChildIdentity(): void {
    if (!this.expectedPid || !this.expectedStartToken) throw new Error("child process identity is not bound");
    if (processStartToken(this.expectedPid) !== this.expectedStartToken) throw new Error("child process identity changed");
  }

  private retireListener(): void {
    try { this.server.close(); } catch {}
    try { fs.unlinkSync(this.socketPath); } catch {}
    try { fs.rmdirSync(this.root); } catch {}
  }

  private async send(message: JsonObject): Promise<void> {
    if (this.closed || !this.socket || this.socket.destroyed) throw new Error("native subagent permission relay is unavailable");
    const frame = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
    if (frame.length - 1 > SUBAGENT_PERMISSION_MAX_FRAME_BYTES) throw new Error("native subagent permission relay response is oversized");
    await new Promise<void>((resolve, reject) => {
      try {
        this.socket!.write(frame, (error?: Error | null) => error ? reject(error) : resolve());
      } catch (error) {
        reject(error);
      }
    });
  }
}
