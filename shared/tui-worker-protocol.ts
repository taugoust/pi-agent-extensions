/**
 * Shared contract for a control endpoint hosted INSIDE a native Pi TUI.
 * No RPC-mode Pi, terminal keystroke injection, process spawning, or command
 * authorization belongs in this protocol. Transport authentication and durable
 * receipt storage are mandatory responsibilities of its eventual server.
 */
export const TUI_WORKER_PROTOCOL = 1 as const;
export const TUI_WORKER_MAX_FRAME_BYTES = 128 * 1024;
export const TUI_WORKER_MAX_MESSAGE_BYTES = 64 * 1024;
export const TUI_WORKER_MANIFEST_ENV = "PI_TUI_WORKER_MANIFEST";
/** Trusted launcher-set fields shared with topology/Paseo discovery. No secrets. */
export const TUI_WORKER_DISCOVERY_ENV = {
  ownerSessionId: "PI_HARNESS_PARENT_SESSION_ID",
  taskId: "PI_HARNESS_TASK_ID",
  groupId: "PI_HARNESS_GROUP_ID",
  childId: "PI_HARNESS_CHILD_ID",
  attempt: "PI_HARNESS_ATTEMPT",
  runtimeId: "PI_HARNESS_RUNTIME_ID",
  controlSocket: "PI_HARNESS_CONTROL_SOCKET",
} as const;

/** Resolve from the actual calling agent, never tmux's currently focused pane. */
export type TuiWorkerPlacement = {
  socketPath: string;
  serverEpoch: string;
  sessionId: string;
  windowId: string;
  paneId: string;
  ownershipNonce: string;
};

/** Private discovery data: never include controlToken in tool results or logs. */
export type TuiWorkerManifest = {
  protocol: typeof TUI_WORKER_PROTOCOL;
  ownerSessionId: string;
  taskId: string;
  runtimeId: string;
  groupId: string;
  childId: string;
  attempt: number;
  workerEpoch: string;
  controlSocket: string;
  controlToken: string;
  /** Separate operator channel verifies this hash; generic control never does. */
  operatorCapabilityHash?: string;
  launchMode?: "guard-only" | "none";
  foregroundOwner?: { pid: number; token: string };
  acceptance?: string[];
  tools?: string[];
  sessionFile: string;
  placement: TuiWorkerPlacement;
  panePid?: number;
  paneProcessToken?: string;
  presentation: "foreground-staged" | "background";
};

export type TuiWorkerIdentity = Pick<TuiWorkerManifest,
  "ownerSessionId" | "taskId" | "runtimeId" | "groupId" | "childId" | "attempt" | "workerEpoch">;

export type TuiWorkerJobParams = { action: "list" | "status" | "output" | "wait" | "cancel" | "reap" | "watches" | "events" | "ack" | "unwatch";
  job_id?: string; watch_id?: string; limit?: number; lines?: number; timeout_ms?: number; after_sequence?: number; through_sequence?: number };
/** Existing-job control only. No shell, start/adopt, foreign session, or scope override. */
export function parseTuiWorkerJobParams(value: unknown): TuiWorkerJobParams {
  const data = object(value);
  const fields: Record<string, [string[], string[]]> = {
    list: [[], ["limit"]], status: [["job_id"], []], output: [["job_id"], ["lines"]], wait: [["job_id"], ["lines", "timeout_ms"]],
    cancel: [["job_id"], []], reap: [["job_id"], []], watches: [[], []], events: [["watch_id"], ["after_sequence"]],
    ack: [["watch_id", "through_sequence"], []], unwatch: [["watch_id"], []],
  };
  const action = text(data.action, 32);
  if (!Object.hasOwn(fields, action)) throw new Error("Unsupported local job control action");
  const [required, optional] = fields[action];
  exactKeys(data, ["action", ...required, ...optional.filter(key => Object.hasOwn(data, key))]);
  if (data.job_id !== undefined) text(data.job_id, 64, /^job-[a-f0-9]{24}$/);
  if (data.watch_id !== undefined) text(data.watch_id, 64, /^watch-[a-f0-9]{24}$/);
  for (const [key, min, max] of [["limit", 1, 50], ["lines", 1, 2000], ["timeout_ms", 0, 30000], ["after_sequence", 0, Number.MAX_SAFE_INTEGER], ["through_sequence", 0, Number.MAX_SAFE_INTEGER]] as const) {
    if (data[key] !== undefined && integer(data[key], min) > max) throw new Error(`Invalid ${key}`);
  }
  return { ...data } as TuiWorkerJobParams;
}

export type TuiWorkerOperation =
  | { operation: "status" }
  | { operation: "events"; afterSequence: number }
  | { operation: "prompt"; mode: "steer" | "follow_up" | "interrupt"; message: string }
  | { operation: "cancel" }
  | { operation: "compact" }
  | { operation: "jobs"; params: TuiWorkerJobParams }
  // prepare_reap seals the input/control boundary before a launcher kills the
  // verified pane. It must reject a busy child; cancel is never implicit.
  | { operation: "prepare_reap" }
  | { operation: "promote"; placement: TuiWorkerPlacement };

export type TuiWorkerRequest = TuiWorkerIdentity & TuiWorkerOperation & {
  protocol: typeof TUI_WORKER_PROTOCOL;
  requestId: string;
  token: string;
};

export type TuiWorkerResponse = {
  protocol: typeof TUI_WORKER_PROTOCOL;
  requestId: string;
  workerEpoch: string;
} & (
  | { ok: true; receipt: "accepted" | "applied"; sequence: number; data?: unknown }
  | { ok: false; code: "unauthorized" | "stale" | "invalid" | "busy" | "sealed" | "ambiguous" | "unavailable"; message: string }
);

export type TuiWorkerEvent = {
  protocol: typeof TUI_WORKER_PROTOCOL;
  workerEpoch: string;
  sequence: number;
  timestamp: string;
  kind: "ready" | "running" | "settled" | "notification" | "outcome" | "cancelled" | "closing";
  data?: unknown;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected protocol object");
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error("Unexpected or missing protocol field");
  }
}
function text(value: unknown, maximum: number, pattern?: RegExp): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > maximum
    || value.includes("\0") || (pattern && !pattern.test(value))) throw new Error("Invalid protocol string");
  return value;
}
function integer(value: unknown, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error("Invalid protocol integer");
  return value as number;
}

export function parseTuiWorkerPlacement(value: unknown): TuiWorkerPlacement {
  const data = object(value);
  exactKeys(data, ["socketPath", "serverEpoch", "sessionId", "windowId", "paneId", "ownershipNonce"]);
  return {
    socketPath: text(data.socketPath, 4096, /^\//),
    serverEpoch: text(data.serverEpoch, 128, /^[a-zA-Z0-9:._-]+$/),
    sessionId: text(data.sessionId, 64, /^\$[0-9]+$/),
    windowId: text(data.windowId, 64, /^@[0-9]+$/),
    paneId: text(data.paneId, 64, /^%[0-9]+$/),
    ownershipNonce: text(data.ownershipNonce, 64, /^[a-f0-9]{64}$/),
  };
}

/** Validate only shape; caller must authenticate BEFORE disclosing worker state. */
export function parseTuiWorkerRequest(value: unknown): TuiWorkerRequest {
  const data = object(value);
  const base = ["protocol", "requestId", "token", "ownerSessionId", "taskId", "runtimeId", "groupId", "childId", "attempt", "workerEpoch", "operation"];
  const fields: Record<string, string[]> = {
    status: [], events: ["afterSequence"], prompt: ["mode", "message"],
    cancel: [], compact: [], jobs: ["params"], prepare_reap: [], promote: ["placement"],
  };
  const operation = text(data.operation, 32);
  if (!Object.hasOwn(fields, operation)) throw new Error("Unknown worker operation");
  exactKeys(data, [...base, ...fields[operation]]);
  if (data.protocol !== TUI_WORKER_PROTOCOL) throw new Error("Unsupported worker protocol");
  const identity = {
    protocol: TUI_WORKER_PROTOCOL,
    requestId: text(data.requestId, 128, /^[a-zA-Z0-9._:-]+$/),
    token: text(data.token, 64, /^[a-f0-9]{64}$/),
    ownerSessionId: text(data.ownerSessionId, 512),
    taskId: text(data.taskId, 128, /^[a-zA-Z0-9._:-]+$/),
    runtimeId: text(data.runtimeId, 128, /^[a-zA-Z0-9._:-]+$/),
    groupId: text(data.groupId, 64, /^subagent-job-[a-f0-9]{24}$/),
    childId: text(data.childId, 64, /^subagent-child-[a-f0-9]{24}$/),
    attempt: integer(data.attempt, 1),
    workerEpoch: text(data.workerEpoch, 64, /^[a-f0-9]{32}$/),
  };
  switch (operation) {
    case "jobs": return { ...identity, operation, params: parseTuiWorkerJobParams(data.params) };
    case "events": return { ...identity, operation, afterSequence: integer(data.afterSequence, 0) };
    case "prompt": {
      const mode = data.mode;
      if (mode !== "steer" && mode !== "follow_up" && mode !== "interrupt") throw new Error("Invalid prompt mode");
      const message = text(data.message, TUI_WORKER_MAX_MESSAGE_BYTES);
      if (!message.trim()) throw new Error("Empty prompt");
      return { ...identity, operation, mode, message };
    }
    case "promote": return { ...identity, operation, placement: parseTuiWorkerPlacement(data.placement) };
    case "status": case "cancel": case "compact": case "prepare_reap": return { ...identity, operation };
    default: throw new Error("Unknown worker operation");
  }
}

/** One bounded JSONL frame. Framing/backpressure is a transport responsibility. */
export function decodeTuiWorkerRequest(frame: Buffer): TuiWorkerRequest {
  if (frame.length > TUI_WORKER_MAX_FRAME_BYTES) throw new Error("Worker frame exceeds limit");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(frame);
  return parseTuiWorkerRequest(JSON.parse(source));
}

/** Public discovery view cannot accidentally serialize the bearer capability. */
export function publicTuiWorkerManifest(manifest: TuiWorkerManifest): Omit<TuiWorkerManifest, "controlToken" | "operatorCapabilityHash"> {
  // Explicit allow-list: a future private capability field must not leak merely
  // because it was added to the manifest schema.
  return structuredClone({ protocol: manifest.protocol, ownerSessionId: manifest.ownerSessionId,
    taskId: manifest.taskId, runtimeId: manifest.runtimeId, groupId: manifest.groupId,
    childId: manifest.childId, attempt: manifest.attempt, workerEpoch: manifest.workerEpoch,
    controlSocket: manifest.controlSocket, sessionFile: manifest.sessionFile, placement: manifest.placement,
    presentation: manifest.presentation, launchMode: manifest.launchMode,
    panePid: manifest.panePid, paneProcessToken: manifest.paneProcessToken, tools: manifest.tools });
}
