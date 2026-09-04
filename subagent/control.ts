import { randomBytes } from "node:crypto";

export const SUBAGENT_CHILD_ID_PATTERN = /^subagent-child-[0-9a-f]{24}$/;
export const MAX_SUBAGENT_CONTROL_MESSAGE_BYTES = 64 * 1024;

export type SubagentControlMode = "steer" | "follow_up" | "interrupt";
export type SubagentChildBackend = "native" | "agentsh";

export type SubagentChildIdentity = {
  childId: string;
  child: number;
  label: string;
  task?: string;
};

export type SubagentControlResult = {
  text: string;
};

export type NativeSubagentControlHandle = {
  isActive(): boolean;
  control(
    mode: SubagentControlMode,
    message: string,
    signal?: AbortSignal,
    onUpdate?: (text: string) => void,
  ): Promise<SubagentControlResult>;
};

type ChildControlState = "pending" | "active" | "terminal";

type ChildControlRecord = {
  childId: string;
  sessionId: string;
  backend: SubagentChildBackend;
  state: ChildControlState;
  createdAt: number;
  updatedAt: number;
  handle?: NativeSubagentControlHandle;
};

type ChildControlRegistry = {
  records: Map<string, ChildControlRecord>;
};

const REGISTRY_KEY = "__paeSubagentChildControlV1";
const MAX_TERMINAL_CHILDREN = 512;

function registry(): ChildControlRegistry {
  const root = globalThis as Record<string, unknown>;
  const existing = root[REGISTRY_KEY] as Partial<ChildControlRegistry> | undefined;
  if (existing?.records instanceof Map) return existing as ChildControlRegistry;
  const created: ChildControlRegistry = { records: new Map() };
  root[REGISTRY_KEY] = created;
  return created;
}

function requiredSessionId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 512) {
    throw new Error("subagent child control requires a stable Pi session ID");
  }
  return value;
}

function requiredChildId(value: unknown): string {
  if (typeof value !== "string" || !SUBAGENT_CHILD_ID_PATTERN.test(value)) {
    throw new Error("invalid subagent child_id");
  }
  return value;
}

function pruneTerminalRecords(state: ChildControlRegistry): void {
  const terminal = [...state.records.values()]
    .filter((record) => record.state === "terminal")
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const record of terminal.slice(MAX_TERMINAL_CHILDREN)) state.records.delete(record.childId);
}

export class SubagentControlError extends Error {
  constructor(
    readonly code: "unknown" | "ownership" | "capability" | "inactive" | "busy" | "handled" | "timeout",
    message: string,
    readonly backend?: SubagentChildBackend,
  ) {
    super(message);
    this.name = "SubagentControlError";
  }
}

export function createSubagentChildId(): string {
  return `subagent-child-${randomBytes(12).toString("hex")}`;
}

/** Reserve immutable child identities before execution so pending children are visible immediately. */
export function reserveSubagentChildren(
  sessionIdValue: string,
  backend: SubagentChildBackend,
  children: readonly SubagentChildIdentity[],
): void {
  const sessionId = requiredSessionId(sessionIdValue);
  const state = registry();
  const now = Date.now();
  const reserved = new Set<string>();
  for (const child of children) {
    const childId = requiredChildId(child.childId);
    if (reserved.has(childId) || state.records.has(childId)) {
      throw new Error(`subagent child identity collision: ${childId}`);
    }
    reserved.add(childId);
  }
  for (const child of children) {
    state.records.set(child.childId, {
      childId: child.childId,
      sessionId,
      backend,
      state: "pending",
      createdAt: now,
      updatedAt: now,
    });
  }
  pruneTerminalRecords(state);
}

/** Bind the one live RPC transport that owns this exact native child process. */
export function bindNativeSubagentControl(
  sessionIdValue: string,
  childIdValue: string,
  handle: NativeSubagentControlHandle,
): void {
  const sessionId = requiredSessionId(sessionIdValue);
  const childId = requiredChildId(childIdValue);
  const state = registry();
  const record = state.records.get(childId);
  if (!record || record.sessionId !== sessionId || record.backend !== "native") {
    throw new Error(`cannot bind unreserved native subagent child: ${childId}`);
  }
  if (record.state === "terminal") throw new Error(`cannot bind terminal native subagent child: ${childId}`);
  if (record.handle && record.handle !== handle) throw new Error(`native subagent child already has a control owner: ${childId}`);
  record.handle = handle;
  record.state = "active";
  record.updatedAt = Date.now();
}

export function completeSubagentChildren(sessionIdValue: string, children: readonly SubagentChildIdentity[]): void {
  const sessionId = requiredSessionId(sessionIdValue);
  const state = registry();
  const now = Date.now();
  for (const child of children) {
    const record = state.records.get(child.childId);
    if (!record || record.sessionId !== sessionId) continue;
    record.handle = undefined;
    record.state = "terminal";
    record.updatedAt = now;
  }
  pruneTerminalRecords(state);
}

/**
 * Prompt an already-running native child. Ownership is checked before backend
 * capability or liveness so a foreign opaque ID never discloses child state.
 */
export async function controlSubagentChild(
  sessionIdValue: string,
  childIdValue: string,
  mode: SubagentControlMode,
  message: string,
  signal?: AbortSignal,
  onUpdate?: (text: string) => void,
): Promise<SubagentControlResult> {
  const sessionId = requiredSessionId(sessionIdValue);
  const childId = requiredChildId(childIdValue);
  const state = registry();
  const record = state.records.get(childId);
  if (!record) throw new SubagentControlError("unknown", `Unknown subagent child: ${childId}`);
  if (record.sessionId !== sessionId) {
    throw new SubagentControlError("ownership", `Subagent child ${childId} belongs to a different Pi session`);
  }
  if (record.backend !== "native") {
    throw new SubagentControlError(
      "capability",
      `Subagent child ${childId} uses the ${record.backend} backend, which does not support parent conversation control`,
      record.backend,
    );
  }
  const handle = record.handle;
  if (record.state === "active" && handle && !handle.isActive()) {
    record.handle = undefined;
    record.state = "terminal";
    record.updatedAt = Date.now();
  }
  if (record.state !== "active" || !handle || !handle.isActive()) {
    throw new SubagentControlError(
      "inactive",
      record.state === "pending"
        ? `Subagent child ${childId} is pending and has no active control channel yet`
        : `Subagent child ${childId} is terminal and cannot be prompted again`,
      record.backend,
    );
  }
  return await handle.control(mode, message, signal, onUpdate);
}

/** Drop all identities when a Pi session really ends; reload deliberately keeps them. */
export function removeSubagentControlSession(sessionIdValue: string): void {
  const sessionId = requiredSessionId(sessionIdValue);
  const state = registry();
  for (const [childId, record] of state.records) {
    if (record.sessionId === sessionId) state.records.delete(childId);
  }
}

/** Test/status helper that reveals no prompt transport or authority object. */
export function subagentChildControlState(
  sessionIdValue: string,
  childIdValue: string,
): { backend: SubagentChildBackend; state: ChildControlState } | undefined {
  const sessionId = requiredSessionId(sessionIdValue);
  const childId = requiredChildId(childIdValue);
  const record = registry().records.get(childId);
  if (!record || record.sessionId !== sessionId) return undefined;
  if (record.state === "active" && record.handle && !record.handle.isActive()) {
    record.handle = undefined;
    record.state = "terminal";
    record.updatedAt = Date.now();
  }
  return { backend: record.backend, state: record.state };
}
