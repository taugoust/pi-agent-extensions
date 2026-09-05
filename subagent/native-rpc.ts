import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { readFileSync, mkdtempSync, openSync, closeSync, readSync, writeSync, rmSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SubagentControlError,
  type NativeSubagentControlHandle,
  type SubagentControlMode,
  type SubagentControlResult,
} from "./control.js";

const MAX_RPC_FRAME_BYTES = 32 * 1024 * 1024;
const RPC_COMMAND_TIMEOUT_MS = 30_000;
const RPC_SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_NATIVE_SUBAGENT_CONTROL_MS = 24 * 60 * 60 * 1000;
const NATIVE_PROCESS_TERM_GRACE_MS = 5_000;
const PROCESS_GROUP_ANCHOR_TIMEOUT_MS = 10_000;

const POSIX_PROCESS_GROUP_WRAPPER = String.raw`
set -eu
term_grace_seconds=$1
control_path=$2
ready_path=$3
shift 3
exec 3< "$control_path"
(
  trap '' HUP INT TERM
  action=
  IFS= read -r action <&3 || true
  exec 3<&-
  if [ "$action" = complete ]; then
    exit 0
  fi
  sleep "$term_grace_seconds"
  kill -KILL 0
  exit 127
) 0</dev/null 2>/dev/null &
anchor_pid=$!
printf '%s\n' "$anchor_pid" > "$ready_path"
exec 3<&-
exec "$@"
`;

const DIALOG_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);
const FIRE_AND_FORGET_UI_METHODS = new Set([
  "notify",
  "setStatus",
  "setWidget",
  "setTitle",
  "set_editor_text",
]);

type JsonObject = Record<string, any>;

type QueueKind = "steering" | "followUp";

type QueuePosition = {
  kind: QueueKind;
  position: number;
};

type LogicalRunCollector = {
  mode: SubagentControlMode | "initial";
  baselineOrdinal: number;
  dispatchSequence: number;
  dispatchStreaming: boolean;
  acceptedSequence?: number;
  queueCandidate?: QueuePosition;
  queueTarget?: QueuePosition;
  deliveredAfterOrdinal?: number;
  deliveredSettledVersion?: number;
  handled?: boolean;
  onUpdate?: (text: string) => void;
};

type CommandReceipt = {
  response: JsonObject;
  sequence: number;
  settledVersion: number;
};

type PendingCommand = {
  command: string;
  collector?: LogicalRunCollector;
  resolve(value: CommandReceipt): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

type AssistantRecord = {
  ordinal: number;
  text: string;
};

export type NativeSubagentRpcExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type NativeSubagentRpcDiagnostics = {
  rawExit?: NativeSubagentRpcExit;
  trace: Array<{ event: string; elapsedMs: number; streaming: boolean; settledVersion: number; closingInput: boolean; terminationRequested: boolean }>;
};

export type NativeSubagentRpcOptions = {
  process: ChildProcessWithoutNullStreams;
  onEvent(event: JsonObject): void;
  terminateProcess(): void;
  /** Test override. Production control prompts have a 24-hour hard bound. */
  controlTimeoutMs?: number;
};

export type NativeSubagentProcess = {
  process: ChildProcessWithoutNullStreams;
  /** Resolves only after the independent process-group anchor is verified. */
  ready: Promise<void>;
  terminate(): void;
};

export type NativeSubagentProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Required on POSIX; callers can require an immutable shell for guarded launches. */
  shellPath?: string;
  /** Immutable mkfifo executable for guarded launches. */
  fifoPath?: string;
  /** Test override. Production callers leave this at the five-second default. */
  termGraceMs?: number;
};

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function messageText(message: any): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part: any) => part?.type === "text")
    .map((part: any) => String(part.text ?? ""))
    .join("");
}

function assistantText(message: any): string {
  return message?.role === "assistant" ? messageText(message) : "";
}

function boundedProtocolError(value: unknown): string {
  const message = asError(value).message.replace(/[\r\n\x00-\x1f\x7f]+/g, " ");
  return message.length > 2048 ? `${message.slice(0, 2048)}…` : message;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Subagent child prompt cancelled");
}

function raceSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function linuxProcessGroup(pid: number): { parentPid: number; processGroup: number; session: number } {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const close = stat.lastIndexOf(")");
  if (close < 0) throw new Error("could not parse native subagent process identity");
  const fields = stat.slice(close + 2).split(" ");
  const parentPid = Number(fields[1]);
  const processGroup = Number(fields[2]);
  const session = Number(fields[3]);
  if (![parentPid, processGroup, session].every(Number.isSafeInteger)) {
    throw new Error("native subagent process-group identity is unavailable");
  }
  return { parentPid, processGroup, session };
}

/**
 * Launch a POSIX child with a quiet group member that outlives a TERM-exiting
 * leader only during cancellation. The anchor retains the child's stdout pipe,
 * so Node's `close` boundary cannot precede its bounded escalation. It signals
 * with `kill(..., 0)` from inside its own group, so no stale numeric
 * process-group ID is signalled.
 */
export function spawnNativeSubagentProcess(
  command: string,
  args: readonly string[],
  options: NativeSubagentProcessOptions = {},
): NativeSubagentProcess {
  const termGraceMs = options.termGraceMs ?? NATIVE_PROCESS_TERM_GRACE_MS;
  if (!Number.isSafeInteger(termGraceMs) || termGraceMs < 1 || termGraceMs > 60_000) {
    throw new Error("native subagent termination grace must be an integer between 1 and 60000 milliseconds");
  }

  if (process.platform === "win32") {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let terminating = false;
    return {
      process: child,
      ready: Promise.resolve(),
      terminate() {
        if (terminating) return;
        terminating = true;
        try { child.kill("SIGTERM"); } catch {}
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            try { child.kill("SIGKILL"); } catch {}
          }
        }, termGraceMs).unref?.();
      },
    };
  }

  if (!options.shellPath) throw new Error("native subagent process-group launch requires a POSIX shell");
  if (!options.fifoPath) throw new Error("native subagent process-group launch requires mkfifo");
  // Bun's extra-stdio wrappers can close reused descriptors when a previous
  // ChildProcess is collected. Never give this lifetime-critical channel to
  // child_process: own a named FIFO descriptor directly and close it once.
  const channelDir = mkdtempSync(join(tmpdir(), "pi-subagent-group-"));
  const controlPath = join(channelDir, "control");
  const readyPath = join(channelDir, "ready");
  const fifo = spawnSync(options.fifoPath, ["-m", "600", controlPath], { timeout: 5000, stdio: "ignore" });
  if (fifo.error || fifo.status !== 0) {
    rmSync(channelDir, { recursive: true, force: true });
    throw new Error("could not create native subagent process-group control FIFO");
  }
  let controlFd: number;
  try { controlFd = openSync(controlPath, constants.O_RDWR); }
  catch (error) { rmSync(channelDir, { recursive: true, force: true }); throw error; }
  let child: ChildProcessWithoutNullStreams;
  try { child = spawn(options.shellPath, [
    "-c",
    POSIX_PROCESS_GROUP_WRAPPER,
    "pi-subagent-process-group",
    String(termGraceMs / 1000),
    controlPath,
    readyPath,
    command,
    ...args,
  ], {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  }); } catch (error) {
    closeSync(controlFd);
    rmSync(channelDir, { recursive: true, force: true });
    throw error;
  }
  let terminating = false;
  let controlFinished = false;

  const ready = new Promise<void>((resolve, reject) => {
    let settled = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    const timer = setTimeout(() => finish(new Error("native subagent process-group anchor did not start in time")), PROCESS_GROUP_ANCHOR_TIMEOUT_MS);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const verify = (line: string) => {
      if (!/^[1-9][0-9]*$/.test(line) || child.pid === undefined) {
        finish(new Error("native subagent process-group anchor returned an invalid identity"));
        return;
      }
      const anchorPid = Number(line);
      if (!Number.isSafeInteger(anchorPid) || anchorPid === child.pid) {
        finish(new Error("native subagent process-group anchor returned an invalid identity"));
        return;
      }
      if (process.platform === "linux") {
        try {
          const leader = linuxProcessGroup(child.pid);
          const anchor = linuxProcessGroup(anchorPid);
          if (leader.processGroup !== child.pid || leader.session !== child.pid
            || anchor.parentPid !== child.pid || anchor.processGroup !== child.pid || anchor.session !== child.pid) {
            throw new Error("native subagent process-group anchor does not belong to its launched group");
          }
        } catch (error) {
          finish(asError(error));
          return;
        }
      }
      finish();
    };
    const readIdentity = () => {
      try {
        const fd = openSync(readyPath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
        const bytes = Buffer.alloc(65);
        let size: number;
        try { size = readSync(fd, bytes, 0, bytes.length, 0); }
        finally { closeSync(fd); }
        if (size > 64) { finish(new Error("native subagent process-group anchor identity is oversized")); return; }
        const buffer = bytes.subarray(0, size).toString("utf8");
        if (buffer.endsWith("\n")) verify(buffer.slice(0, -1));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") finish(asError(error));
      }
    };
    const onError = (error: Error) => finish(new Error(`native subagent process-group launch failed: ${error.message}`));
    const onExit = () => finish(new Error("native subagent exited before its process-group anchor was ready"));
    child.once("error", onError);
    child.once("exit", onExit);
    poll = setInterval(readIdentity, 10);
    poll.unref?.();
    readIdentity();
  });
  // A spawn error can occur before the launcher reaches its explicit await.
  void ready.catch(() => undefined);

  const finishControl = (action: "complete" | "terminate"): Promise<void> => {
    if (controlFinished) return Promise.resolve();
    controlFinished = true;
    try { writeSync(controlFd, `${action}\n`); }
    catch { /* EOF also instructs the anchor to clean up its owned group. */ }
    finally { try { closeSync(controlFd); } catch {} }
    return Promise.resolve();
  };

  child.once("exit", () => {
    if (!terminating) void finishControl("complete");
  });
  child.once("close", () => {
    void finishControl("complete");
    try { rmSync(channelDir, { recursive: true, force: true }); } catch {}
  });

  return {
    process: child,
    ready,
    terminate() {
      if (terminating) return;
      terminating = true;
      // Write before TERM. Even if the leader exits immediately, the anchor
      // has inherited the marker and remains the unambiguous group owner until
      // it sends SIGKILL to its own group after the grace period.
      void ready.then(
        async () => {
          await finishControl("terminate");
          // The verified anchor still owns this process group until it receives
          // the termination marker and performs the bounded SIGKILL escalation.
          try {
            process.kill(-child.pid!, "SIGTERM");
          } catch {
            try { child.kill("SIGTERM"); } catch {}
          }
        },
        async () => {
          // Without a verified anchor, never signal a bare negative PID that
          // could have been reused as an unrelated process-group identity.
          // Close the private marker pipe so an unverified anchor cannot leak.
          await finishControl("complete");
          try { child.kill("SIGTERM"); } catch {}
        },
      );
    },
  };
}

/**
 * Owns the strict JSONL transport for one already-launched native Pi child.
 * The process and its launch authority never move through the model-facing API.
 */
export class NativeSubagentRpcSession implements NativeSubagentControlHandle {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly onEvent: (event: JsonObject) => void;
  private readonly terminateProcess: () => void;
  private readonly controlTimeoutMs: number;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly pendingCommands = new Map<string, PendingCommand>();
  private readonly changeListeners = new Set<() => void>();
  private readonly assistantRecords: AssistantRecord[] = [];
  private readonly exitPromise: Promise<NativeSubagentRpcExit>;
  private resolveExit!: (exit: NativeSubagentRpcExit) => void;
  private buffer = "";
  private commandNumber = 0;
  private frameSequence = 0;
  private assistantOrdinal = 0;
  private activeAssistantOrdinal: number | undefined;
  private activeAssistantTexts = new Map<number, string>();
  private settledVersion = 0;
  private userMessageCount = 0;
  private queueLengths: Record<QueueKind, number> = { steering: 0, followUp: 0 };
  private streaming = false;
  private initialPromptSent = false;
  private initialPromptAccepted = false;
  private initialPromptHandled = false;
  private closingInput = false;
  private stdoutEnded = false;
  private closed = false;
  private terminationRequested = false;
  private controlReservations = 0;
  private controlTail: Promise<void> = Promise.resolve();
  private controlCollector?: LogicalRunCollector;
  private shutdownTimer?: ReturnType<typeof setTimeout>;
  private fatal?: Error;
  private readonly startedAt = Date.now();
  private readonly lifecycleTrace: NativeSubagentRpcDiagnostics["trace"] = [];
  private rawExit?: NativeSubagentRpcExit;

  get diagnostics(): NativeSubagentRpcDiagnostics {
    return { rawExit: this.rawExit && { ...this.rawExit }, trace: this.lifecycleTrace.map((entry) => ({ ...entry })) };
  }

  private trace(event: string): void {
    this.lifecycleTrace.push({ event, elapsedMs: Date.now() - this.startedAt, streaming: this.streaming,
      settledVersion: this.settledVersion, closingInput: this.closingInput, terminationRequested: this.terminationRequested });
    if (this.lifecycleTrace.length > 64) this.lifecycleTrace.shift();
  }

  constructor(options: NativeSubagentRpcOptions) {
    this.proc = options.process;
    this.onEvent = options.onEvent;
    this.terminateProcess = options.terminateProcess;
    this.controlTimeoutMs = options.controlTimeoutMs ?? MAX_NATIVE_SUBAGENT_CONTROL_MS;
    if (!Number.isSafeInteger(this.controlTimeoutMs) || this.controlTimeoutMs < 1
      || this.controlTimeoutMs > MAX_NATIVE_SUBAGENT_CONTROL_MS) {
      throw new Error("native subagent control timeout must be an integer between 1 millisecond and 24 hours");
    }
    this.exitPromise = new Promise((resolve) => { this.resolveExit = resolve; });

    this.proc.stdout.on("data", (chunk: Buffer | string) => this.receive(chunk));
    this.proc.stdout.on("end", () => this.finishStdout());
    this.proc.stdout.on("error", (error) => {
      if (!this.closed && !this.terminationRequested) {
        this.fail(new Error(`native subagent RPC stdout failed: ${error.message}`));
      }
    });
    this.proc.stdin.on("error", (error) => {
      if (!this.closed && !this.closingInput && !this.terminationRequested) {
        this.fail(new Error(`native subagent RPC stdin failed: ${error.message}`));
      }
    });
    this.proc.on("error", (error) => this.fail(new Error(`native subagent process failed: ${error.message}`)));
    this.proc.on("exit", (code, signal) => {
      this.rawExit = { code, signal };
      this.trace("process_exit");
    });
    this.proc.on("close", (code, signal) => this.handleClose(code, signal));
  }

  get protocolError(): Error | undefined {
    return this.fatal;
  }

  isActive(): boolean {
    return !this.closed
      && !this.closingInput
      && !this.fatal
      && !this.terminationRequested
      && !this.initialPromptHandled
      && (this.settledVersion === 0 || this.streaming || this.controlReservations > 0);
  }

  async start(initialMessage: string): Promise<NativeSubagentRpcExit> {
    if (this.initialPromptSent) throw new Error("native subagent RPC initial prompt was already sent");
    this.initialPromptSent = true;
    this.notifyChange();
    const collector = this.armCollector("initial");
    try {
      const receipt = await this.sendCommand("prompt", { message: initialMessage }, collector);
      const disposition = await this.acceptedPromptDisposition(collector, receipt);
      this.initialPromptHandled = disposition === "handled";
      this.initialPromptAccepted = true;
      this.notifyChange();
      this.maybeCloseInput();
    } catch (error) {
      this.fail(asError(error));
    } finally {
      if (this.controlCollector === collector) this.controlCollector = undefined;
    }
    return await this.exitPromise;
  }

  terminate(reason: unknown = new Error("native subagent RPC process terminated")): void {
    if (this.closed || this.terminationRequested) return;
    this.terminationRequested = true;
    this.trace("terminate_requested");
    this.notifyChange();
    try {
      this.terminateProcess();
    } catch (error) {
      if (!this.fatal) {
        this.fatal = new Error(`could not terminate native subagent RPC process: ${boundedProtocolError(error)}`);
      }
    }
  }

  async acceptPrompt(mode: SubagentControlMode, message: string, signal?: AbortSignal): Promise<SubagentControlResult> {
    return await this.control(mode, message, signal, undefined, false);
  }

  async control(
    mode: SubagentControlMode,
    message: string,
    signal?: AbortSignal,
    onUpdate?: (text: string) => void,
    waitForResponse = true,
  ): Promise<SubagentControlResult> {
    if (signal?.aborted) throw abortError(signal);
    if (!this.isActive()) {
      throw new SubagentControlError("inactive", "The native subagent child is no longer active", "native");
    }

    if (!waitForResponse && this.controlReservations > 0) {
      throw new SubagentControlError("busy", "Another child control request is in progress; this prompt was not sent. Continue supervising rather than waiting on that request.", "native");
    }

    // Events have no originating prompt ID. Reserve the channel immediately,
    // then execute every accepted parent prompt in one deterministic sequence.
    this.controlReservations += 1;
    const preceding = this.controlTail;
    let release!: () => void;
    const completed = new Promise<void>((resolve) => { release = resolve; });
    this.controlTail = preceding.then(() => completed, () => completed);

    const internal = (async () => {
      // Cancellation may withdraw a command while it is still waiting for this
      // reservation. Once the first RPC frame is dispatched, however, the
      // session keeps owning the reservation until that logical command reaches
      // a terminal boundary (or the transport fails closed).
      await raceSignal(preceding, signal);
      this.requireOpenControlChannel();
      await this.waitForInitialRun(signal);
      if (signal?.aborted) throw abortError(signal);
      if (!waitForResponse) {
        if (mode === "interrupt") await this.abortCurrentRun();
        await this.sendCommand("prompt", {
          message,
          ...(mode === "interrupt" ? {} : { streamingBehavior: mode === "steer" ? "steer" : "followUp" }),
        });
        return { accepted: true, text: "Child prompt accepted; not waiting for the child to finish. Acceptance does not mean the message has been processed. Continue supervising and use status/output/result or bounded waits for progress." };
      }
      const guardedUpdate = onUpdate
        ? (text: string) => { if (!signal?.aborted) onUpdate(text); }
        : undefined;
      if (mode === "interrupt") return await this.interruptAndPrompt(message, guardedUpdate);
      return await this.promptCurrentRun(mode, message, guardedUpdate);
    })();
    const owned = internal.finally(() => {
      release();
      this.controlReservations -= 1;
      this.maybeCloseInput();
    });
    return await raceSignal(this.withControlDeadline(owned), signal);
  }

  private withControlDeadline<T>(operation: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new SubagentControlError(
          "timeout",
          "The native subagent child did not reach a terminal boundary before its bounded control deadline",
          "native",
        );
        this.fail(error);
        reject(error);
      }, this.controlTimeoutMs);
      timer.unref?.();
      operation.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private requireOpenControlChannel(): void {
    if (this.fatal) throw this.fatal;
    if (this.closed || this.closingInput || this.terminationRequested) {
      throw new SubagentControlError("inactive", "The native subagent child is no longer active", "native");
    }
  }

  private async waitForInitialRun(signal?: AbortSignal): Promise<void> {
    const ready = () => this.initialPromptAccepted
      && (this.settledVersion > 0 || (this.streaming && this.userMessageCount > 0));
    const handled = () => this.initialPromptAccepted && this.initialPromptHandled;
    if (!ready() && !handled()) await this.waitFor(() => ready() || handled(), signal);
    if (handled()) {
      throw new SubagentControlError(
        "inactive",
        "The native subagent child handled its initial prompt without starting an agent run",
        "native",
      );
    }
  }

  private async promptCurrentRun(
    mode: "steer" | "follow_up",
    message: string,
    onUpdate?: (text: string) => void,
  ): Promise<SubagentControlResult> {
    const collector = this.armCollector(mode, onUpdate);
    try {
      // Unlike the dedicated queue commands, prompt also starts a fresh run if
      // the previous one settles before Pi reads this frame.
      const receipt = await this.sendCommand("prompt", {
        message,
        streamingBehavior: mode === "steer" ? "steer" : "followUp",
      }, collector);
      return await this.finishAcceptedPrompt(collector, receipt);
    } finally {
      if (this.controlCollector === collector) this.controlCollector = undefined;
    }
  }

  private async abortCurrentRun(): Promise<void> {
    // Abort continues queued messages. Clear both queues first so interruption
    // means exactly "stop this logical run, then process the parent message".
    await this.sendCommand("clear_queue", {});

    const abortSettledVersion = this.settledVersion;
    const needsAbortBoundary = this.streaming;
    const abortCommand = this.sendCommand("abort", {});
    const abortBoundary = needsAbortBoundary
      ? this.waitFor(() => this.settledVersion > abortSettledVersion)
      : Promise.resolve();
    await Promise.all([abortCommand, abortBoundary]);
  }

  private async interruptAndPrompt(
    message: string,
    onUpdate?: (text: string) => void,
  ): Promise<SubagentControlResult> {
    await this.abortCurrentRun();
    this.requireOpenControlChannel();
    const collector = this.armCollector("interrupt", onUpdate);
    try {
      const receipt = await this.sendCommand("prompt", { message }, collector);
      return await this.finishAcceptedPrompt(collector, receipt);
    } finally {
      if (this.controlCollector === collector) this.controlCollector = undefined;
    }
  }

  private armCollector(
    mode: SubagentControlMode | "initial",
    onUpdate?: (text: string) => void,
  ): LogicalRunCollector {
    if (this.controlCollector) {
      throw new Error("native subagent RPC logical-run collector overlap");
    }
    const collector: LogicalRunCollector = {
      mode,
      baselineOrdinal: this.assistantOrdinal,
      dispatchSequence: this.frameSequence,
      dispatchStreaming: this.streaming,
      onUpdate,
    };
    this.controlCollector = collector;
    return collector;
  }

  private markCollectorDelivered(collector: LogicalRunCollector): void {
    if (collector.deliveredAfterOrdinal !== undefined) return;
    collector.deliveredAfterOrdinal = this.assistantOrdinal;
    collector.deliveredSettledVersion = this.settledVersion;
    this.notifyChange();
  }

  private async acceptedPromptDisposition(
    collector: LogicalRunCollector,
    _receipt: CommandReceipt,
  ): Promise<"delivered" | "handled"> {
    const state = (await this.sendCommand("get_state", {})).response.data;
    if (!state || typeof state.isStreaming !== "boolean" || !Number.isSafeInteger(state.pendingMessageCount)) {
      const error = new Error("native subagent RPC get_state returned invalid prompt state");
      this.fail(error);
      throw error;
    }

    if (collector.deliveredAfterOrdinal !== undefined) return "delivered";
    if (collector.queueTarget) {
      if (!state.isStreaming) {
        const error = new Error("native subagent RPC accepted a queued prompt after the child became idle");
        this.fail(error);
        throw error;
      }
      await this.waitFor(() => collector.deliveredAfterOrdinal !== undefined);
      return "delivered";
    }

    // A prompt response only means accepted, queued, or handled. Output frames
    // are ordered, so by the get_state response a direct run has already exposed
    // agent_start, while a queued run has exposed queue_update. With neither
    // boundary, the command/input extension handled the prompt. In particular,
    // an already-running unrelated agent must not be mistaken for this control.
    if (!state.isStreaming || collector.dispatchStreaming) {
      collector.handled = true;
      this.notifyChange();
      return "handled";
    }

    const error = new Error("native subagent RPC reported a running accepted prompt without a delivery boundary");
    this.fail(error);
    throw error;
  }

  private async finishAcceptedPrompt(
    collector: LogicalRunCollector,
    receipt: CommandReceipt,
  ): Promise<SubagentControlResult> {
    const disposition = await this.acceptedPromptDisposition(collector, receipt);
    if (disposition === "handled") {
      throw new SubagentControlError(
        "handled",
        "The native subagent child handled the control prompt without starting an agent run; no child response is available",
        "native",
      );
    }
    const deliveredAt = collector.deliveredSettledVersion!;
    await this.waitFor(() => this.settledVersion > deliveredAt);
    return this.collectorResult(collector);
  }

  private collectorResult(collector: LogicalRunCollector): SubagentControlResult {
    const baseline = collector.deliveredAfterOrdinal ?? collector.baselineOrdinal;
    const response = this.assistantRecords
      .filter((record) => record.ordinal > baseline && record.text.trim())
      .at(-1);
    return { text: response?.text ?? "" };
  }

  private waitFor(predicate: () => boolean, signal?: AbortSignal): Promise<void> {
    if (predicate()) return Promise.resolve();
    if (this.fatal) return Promise.reject(this.fatal);
    if (this.closed || this.terminationRequested) {
      return Promise.reject(new SubagentControlError("inactive", "The native subagent child is no longer active", "native"));
    }
    if (signal?.aborted) return Promise.reject(abortError(signal));

    return new Promise<void>((resolve, reject) => {
      const changed = () => {
        if (predicate()) {
          cleanup();
          resolve();
        } else if (this.fatal) {
          cleanup();
          reject(this.fatal);
        } else if (this.closed || this.terminationRequested) {
          cleanup();
          reject(new SubagentControlError("inactive", "The native subagent child is no longer active", "native"));
        }
      };
      const abort = () => {
        cleanup();
        reject(abortError(signal!));
      };
      const cleanup = () => {
        this.changeListeners.delete(changed);
        signal?.removeEventListener("abort", abort);
      };
      this.changeListeners.add(changed);
      signal?.addEventListener("abort", abort, { once: true });
      changed();
    });
  }

  private notifyChange(): void {
    for (const listener of [...this.changeListeners]) {
      try {
        listener();
      } catch {
        // A waiter owns its own rejection path.
      }
    }
  }

  private receive(chunk: Buffer | string): void {
    if (this.closed || this.fatal || this.stdoutEnded) return;
    let decoded: string;
    try {
      decoded = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    } catch (error) {
      this.fail(new Error(`native subagent RPC stdout is not valid UTF-8: ${boundedProtocolError(error)}`));
      return;
    }
    this.buffer += decoded;
    this.processBufferedFrames();
  }

  private processBufferedFrames(): void {
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) {
        this.fail(new Error("native subagent RPC returned an empty JSONL frame"));
        return;
      }
      if (Buffer.byteLength(line, "utf8") > MAX_RPC_FRAME_BYTES) {
        this.fail(new Error("native subagent RPC frame exceeds the 32 MiB limit"));
        return;
      }
      this.processLine(line);
      if (this.fatal) return;
    }
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_RPC_FRAME_BYTES) {
      this.fail(new Error("native subagent RPC frame exceeds the 32 MiB limit"));
    }
  }

  private finishStdout(): void {
    if (this.stdoutEnded) return;
    this.stdoutEnded = true;
    this.trace("stdout_end");
    if (this.closed || this.fatal) return;
    try {
      this.buffer += this.decoder.decode();
    } catch (error) {
      this.fail(new Error(`native subagent RPC stdout is not valid UTF-8: ${boundedProtocolError(error)}`));
      return;
    }
    if (this.buffer.length > 0) {
      this.fail(new Error("native subagent RPC stdout ended with a non-LF-terminated frame"));
      return;
    }
    // RPC has no shutdown response: after stdin EOF, clean stdout EOF followed
    // by process close is the complete shutdown handshake.
    if (!this.closingInput && !this.terminationRequested) {
      this.fail(new Error("native subagent RPC stdout ended before clean shutdown"));
    }
  }

  private processLine(line: string): void {
    let event: JsonObject;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("frame is not an object");
      event = parsed as JsonObject;
    } catch (error) {
      this.fail(new Error(`native subagent RPC returned malformed JSON: ${boundedProtocolError(error)}`));
      return;
    }

    const sequence = ++this.frameSequence;
    if (event.type === "response") {
      this.handleResponse(event, sequence);
      return;
    }
    if (event.type === "extension_ui_request") {
      this.handleExtensionUIRequest(event);
      return;
    }

    if (event.type === "agent_start") {
      this.streaming = true;
    } else if (event.type === "agent_settled") {
      this.streaming = false;
      this.settledVersion += 1;
    }
    if (["agent_start", "agent_end", "agent_settled", "message_start", "message_end", "turn_start", "turn_end", "compaction_start", "compaction_end", "auto_retry_start", "auto_retry_end", "extension_error"].includes(event.type)) {
      this.trace(event.type);
    }
    try {
      this.observeMessageEvent(event, sequence);
      this.onEvent(event);
    } catch {
      // State reconstruction failures must be visible, not silently lose output.
      // Do not copy arbitrary observer errors (which may include payloads).
      this.fail(new Error("native subagent RPC event observer failed"));
      return;
    }
    this.notifyChange();
    if (event.type === "agent_settled") queueMicrotask(() => this.maybeCloseInput());
  }

  private observeMessageEvent(event: JsonObject, sequence: number): void {
    const collector = this.controlCollector;
    if (event.type === "queue_update") {
      this.observeQueueUpdate(event, sequence, collector);
      return;
    }

    if (event.type === "agent_start" && collector
      && sequence > collector.dispatchSequence
      && !collector.queueCandidate && !collector.queueTarget) {
      this.markCollectorDelivered(collector);
    }

    if (event.type === "message_end" && event.message?.role === "user") {
      this.userMessageCount += 1;
      return;
    }

    if (event.type === "message_start" && event.message?.role === "assistant") {
      this.activeAssistantOrdinal = ++this.assistantOrdinal;
      this.activeAssistantTexts = new Map();
      if (Array.isArray(event.message.content)) {
        event.message.content.forEach((part: any, index: number) => {
          if (part?.type === "text") this.activeAssistantTexts.set(index, String(part.text ?? ""));
        });
      }
      this.emitControlUpdate();
      return;
    }

    if (event.type === "message_update" && this.activeAssistantOrdinal !== undefined) {
      const delta = event.assistantMessageEvent;
      const index = Number.isSafeInteger(delta?.contentIndex) ? delta.contentIndex : 0;
      if (delta?.type === "text_start") this.activeAssistantTexts.set(index, "");
      else if (delta?.type === "text_delta") {
        this.activeAssistantTexts.set(index, (this.activeAssistantTexts.get(index) ?? "") + String(delta.delta ?? ""));
      } else if (delta?.type === "text_end" && typeof delta.content === "string") {
        this.activeAssistantTexts.set(index, delta.content);
      }
      this.emitControlUpdate();
      return;
    }

    if (event.type === "message_end" && event.message?.role === "assistant") {
      const ordinal = this.activeAssistantOrdinal ?? ++this.assistantOrdinal;
      const text = assistantText(event.message);
      this.assistantRecords.push({ ordinal, text });
      if (this.assistantRecords.length > 256) {
        this.assistantRecords.splice(0, this.assistantRecords.length - 256);
      }
      this.activeAssistantOrdinal = undefined;
      this.activeAssistantTexts = new Map();
      if (this.collectorObservesOrdinal(collector, ordinal)) {
        try {
          collector?.onUpdate?.(text);
        } catch {
          // Tool update rendering is best effort.
        }
      }
    }
  }

  private observeQueueUpdate(
    event: JsonObject,
    sequence: number,
    collector: LogicalRunCollector | undefined,
  ): void {
    const next = {
      steering: Array.isArray(event.steering) ? event.steering.length : 0,
      followUp: Array.isArray(event.followUp) ? event.followUp.length : 0,
    };
    if (collector && sequence > collector.dispatchSequence) {
      const kind = collector.mode === "steer"
        ? "steering"
        : collector.mode === "follow_up"
          ? "followUp"
          : undefined;
      if (kind) {
        const previousLength = this.queueLengths[kind];
        const nextLength = next[kind];
        const position = collector.queueTarget ?? collector.queueCandidate;
        if (position?.kind === kind && nextLength < previousLength) {
          const removed = previousLength - nextLength;
          if (removed > position.position) {
            collector.queueCandidate = undefined;
            collector.queueTarget = undefined;
            this.markCollectorDelivered(collector);
          } else {
            position.position -= removed;
          }
        }
        if (collector.acceptedSequence === undefined && nextLength > previousLength) {
          // Pi appends the accepted prompt immediately before its response. Keep
          // only its queue ordinal; transformed text is deliberately irrelevant.
          collector.queueCandidate = { kind, position: nextLength - 1 };
        }
      }
    }
    this.queueLengths = next;
  }

  private collectorObservesOrdinal(
    collector: LogicalRunCollector | undefined,
    ordinal: number,
  ): collector is LogicalRunCollector {
    const baseline = collector?.deliveredAfterOrdinal;
    return baseline !== undefined && ordinal > baseline;
  }

  private emitControlUpdate(): void {
    const collector = this.controlCollector;
    const ordinal = this.activeAssistantOrdinal;
    if (ordinal === undefined || !this.collectorObservesOrdinal(collector, ordinal)) return;
    const text = [...this.activeAssistantTexts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map((entry) => entry[1])
      .join("");
    try {
      collector.onUpdate?.(text);
    } catch {
      // Tool update rendering is best effort.
    }
  }

  private handleResponse(response: JsonObject, sequence: number): void {
    const id = typeof response.id === "string" ? response.id : "";
    const pending = this.pendingCommands.get(id);
    if (!pending) {
      this.fail(new Error("native subagent RPC returned an unsolicited command response"));
      return;
    }
    this.pendingCommands.delete(id);
    clearTimeout(pending.timer);
    if (response.command !== pending.command) {
      const error = new Error(`native subagent RPC response command mismatch for ${pending.command}`);
      pending.reject(error);
      this.fail(error);
      return;
    }
    if (response.success !== true) {
      pending.reject(new Error(`native subagent RPC ${pending.command} failed: ${String(response.error ?? "unknown error")}`));
    } else {
      if (pending.collector) {
        pending.collector.acceptedSequence = sequence;
        pending.collector.queueTarget = pending.collector.queueCandidate;
        pending.collector.queueCandidate = undefined;
      }
      pending.resolve({ response, sequence, settledVersion: this.settledVersion });
    }
    this.maybeCloseInput();
  }

  private handleExtensionUIRequest(request: JsonObject): void {
    const method = typeof request.method === "string" ? request.method : "";
    const id = typeof request.id === "string" ? request.id : "";
    if (!id || Buffer.byteLength(id, "utf8") > 512) {
      this.fail(new Error("native subagent RPC returned an invalid extension UI request ID"));
      return;
    }
    if (FIRE_AND_FORGET_UI_METHODS.has(method)) return;
    if (!DIALOG_UI_METHODS.has(method)) {
      this.fail(new Error(`native subagent RPC requested unsupported extension UI method: ${method || "<missing>"}`));
      return;
    }

    // RPC reports ctx.hasUI=true. Native children have no independent user
    // authority, so every dialog must receive an explicit fail-closed answer.
    void this.writeFrame({ type: "extension_ui_response", id, cancelled: true })
      .catch((error) => this.fail(asError(error)));
  }

  private sendCommand(
    command: string,
    fields: JsonObject,
    collector?: LogicalRunCollector,
  ): Promise<CommandReceipt> {
    if (this.closed || this.closingInput || this.fatal || this.terminationRequested) {
      return Promise.reject(this.fatal ?? new Error("native subagent RPC control channel is closed"));
    }
    const id = `parent-${process.pid}-${++this.commandNumber}`;
    return new Promise<CommandReceipt>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pendingCommands.get(id);
        if (!pending) return;
        this.pendingCommands.delete(id);
        const error = new Error(`native subagent RPC ${command} command timed out`);
        pending.reject(error);
        this.fail(error);
      }, RPC_COMMAND_TIMEOUT_MS);
      timer.unref?.();
        this.pendingCommands.set(id, { command, collector, resolve, reject, timer });
      if (collector) {
        collector.dispatchSequence = this.frameSequence;
        collector.dispatchStreaming = this.streaming;
      }
      void this.writeFrame({ id, type: command, ...fields }).catch((error) => {
        const pending = this.pendingCommands.get(id);
        if (!pending) return;
        this.pendingCommands.delete(id);
        clearTimeout(pending.timer);
        const failure = new Error(`native subagent RPC ${command} write failed: ${boundedProtocolError(error)}`);
        pending.reject(failure);
        this.fail(failure);
      });
    });
  }

  private writeFrame(value: JsonObject): Promise<void> {
    let frame: Buffer;
    try {
      frame = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    } catch (error) {
      return Promise.reject(asError(error));
    }
    if (frame.byteLength - 1 > MAX_RPC_FRAME_BYTES) {
      return Promise.reject(new Error("native subagent RPC command is oversized"));
    }
    return new Promise<void>((resolve, reject) => {
      try {
        this.proc.stdin.write(frame, (error?: Error | null) => error ? reject(error) : resolve());
      } catch (error) {
        reject(error);
      }
    });
  }

  private maybeCloseInput(): void {
    if (this.closed
      || this.closingInput
      || this.fatal
      || this.terminationRequested
      || (this.settledVersion === 0 && !this.initialPromptHandled)
      || this.streaming
      || this.controlReservations > 0
      || this.pendingCommands.size > 0) return;
    this.closingInput = true;
    this.trace("stdin_end");
    try {
      this.proc.stdin.end();
    } catch (error) {
      this.fail(new Error(`native subagent RPC stdin close failed: ${boundedProtocolError(error)}`));
      return;
    }
    this.shutdownTimer = setTimeout(() => {
      if (!this.closed) {
        this.fatal ??= new Error("native subagent RPC process did not exit after stdin closed");
        this.terminate(this.fatal);
      }
    }, RPC_SHUTDOWN_TIMEOUT_MS);
    this.shutdownTimer.unref?.();
  }

  private fail(error: Error): void {
    if (this.closed || this.fatal) return;
    this.fatal = error;
    this.trace("protocol_failure");
    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingCommands.clear();
    this.notifyChange();
    this.terminate(error);
  }

  private handleClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.rawExit ??= { code, signal };
    this.trace("process_close");
    if (this.shutdownTimer) clearTimeout(this.shutdownTimer);
    this.shutdownTimer = undefined;
    if (!this.fatal && !this.closingInput && !this.terminationRequested) {
      this.fatal = new Error("native subagent RPC process exited before agent_settled");
    }
    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.fatal ?? new Error("native subagent RPC process exited"));
    }
    this.pendingCommands.clear();
    this.notifyChange();
    this.resolveExit({ code, signal });
  }
}
