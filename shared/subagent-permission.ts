export const SUBAGENT_PERMISSION_AUTHORITY_KEY = "__paeSubagentPermissionAuthorityV1";
export const SUBAGENT_PERMISSION_SELECTION_KEY = "__paeSubagentPermissionSelectionV1";
export const SUBAGENT_PERMISSION_SOCKET_ENV = "PI_SUBAGENT_PERMISSION_SOCKET";
export const SUBAGENT_PERMISSION_TOKEN_ENV = "PI_SUBAGENT_PERMISSION_TOKEN";

export const SUBAGENT_PERMISSION_PROTOCOL_VERSION = 1;
export const SUBAGENT_PERMISSION_AUTHORITY_ABI = 2;
export const SUBAGENT_PERMISSION_MAX_FRAME_BYTES = 64 * 1024;
export const SUBAGENT_PERMISSION_MAX_COMMAND_BYTES = 32 * 1024;
export const SUBAGENT_PERMISSION_MAX_CWD_BYTES = 4 * 1024;
export const SUBAGENT_PERMISSION_MAX_ID_BYTES = 256;
export const SUBAGENT_PERMISSION_MAX_REASON_BYTES = 512;
export const SUBAGENT_PERMISSION_MAX_REQUESTS = 4096;
export const SUBAGENT_PERMISSION_NATIVE_TOOLS = ["read", "bash", "edit", "write"] as const;
export const SUBAGENT_PERMISSION_MAX_TOOLS = SUBAGENT_PERMISSION_NATIVE_TOOLS.length;
export const SUBAGENT_PERMISSION_BASH_TOOL = "parent_bash";
export const SUBAGENT_PERMISSION_RELOAD_DRAIN_TIMEOUT_MS = 30_000;
export const SUBAGENT_PERMISSION_RELOAD_REBIND_TIMEOUT_MS = 30_000;

export type SubagentPermissionSelection = {
  protocol: 1;
  selected: true;
  conflict: boolean;
};

export type SubagentPermissionRequest = {
  subagentId: string;
  label: string;
  task: string;
  toolCallId: string;
  command: string;
  cwd: string;
};

export type SubagentPermissionResult = {
  allowed: boolean;
  reason: string;
};

/** Parent-process authority published by the launcher-bound Permission Gate. */
export type SubagentPermissionTicket = Readonly<object>;

export type PreparedSubagentPermission = {
  ticket: SubagentPermissionTicket;
  result: SubagentPermissionResult;
};

export type SubagentPermissionAuthority = {
  authorityAbi: 2;
  protocol: 1;
  selected: true;
  /** True only while a newly launched child can safely capture this authority. */
  active: boolean;
  /** Aborted only for terminal authority loss, never for a reload suspension. */
  revoked: AbortSignal;
  waitUntilActive(signal?: AbortSignal): Promise<void>;
  prepare(request: SubagentPermissionRequest, signal?: AbortSignal): Promise<PreparedSubagentPermission>;
  commit(ticket: SubagentPermissionTicket, request: SubagentPermissionRequest): SubagentPermissionResult;
  abandon(ticket: SubagentPermissionTicket): void;
  authorize(request: SubagentPermissionRequest, signal?: AbortSignal): Promise<SubagentPermissionResult>;
};

export type SubagentPermissionAuthorityPhase = "unbound" | "active" | "draining" | "reloading" | "inactive" | "failed";

export type SubagentPermissionAuthorityDelegate = (
  request: SubagentPermissionRequest,
  callerSignal: AbortSignal | undefined,
  sessionSignal: AbortSignal,
) => Promise<SubagentPermissionResult>;

export type ReloadableSubagentPermissionAuthority = {
  authorityAbi: 2;
  protocol: 1;
  authority: SubagentPermissionAuthority;
  phase(): SubagentPermissionAuthorityPhase;
  bind(
    owner: symbol,
    sessionId: string,
    delegate: SubagentPermissionAuthorityDelegate,
    validateCommit?: () => void,
  ): void;
  beginReload(owner: symbol, sessionId: string): Promise<boolean>;
  deactivate(owner: symbol, error: Error): boolean;
  fail(error: Error): void;
};

type Deferred = {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // A reload may finish without a child waiting on the handoff promise.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function errorValue(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function validSessionId(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= 512;
}

function copyRequest(request: SubagentPermissionRequest): SubagentPermissionRequest {
  return Object.freeze({
    subagentId: request.subagentId,
    label: request.label,
    task: request.task,
    command: request.command,
    cwd: request.cwd,
    toolCallId: request.toolCallId,
  });
}

function sameRequest(left: SubagentPermissionRequest, right: SubagentPermissionRequest): boolean {
  return left.subagentId === right.subagentId
    && left.label === right.label
    && left.task === right.task
    && left.command === right.command
    && left.cwd === right.cwd
    && left.toolCallId === right.toolCallId;
}

function copyResult(result: SubagentPermissionResult): SubagentPermissionResult {
  if (!result || typeof result.allowed !== "boolean" || typeof result.reason !== "string" || result.reason.length === 0) {
    throw new Error("Parent AgentSH Permission Gate returned a malformed child authorization");
  }
  if (Buffer.from(result.reason, "utf8").toString("utf8") !== result.reason
    || Buffer.byteLength(result.reason, "utf8") > SUBAGENT_PERMISSION_MAX_REASON_BYTES) {
    throw new Error("Parent AgentSH Permission Gate returned an invalid child authorization reason");
  }
  return Object.freeze({ allowed: result.allowed, reason: result.reason });
}

/**
 * Stable process-local authority used by guarded children across a hot reload.
 * A reload drains requests using the old UI context, then queues new requests
 * until the replacement extension binds the exact same Pi session. Other
 * shutdown reasons permanently revoke this authority instance.
 */
export function createReloadableSubagentPermissionAuthority(
  rebindTimeoutMs = SUBAGENT_PERMISSION_RELOAD_REBIND_TIMEOUT_MS,
  drainTimeoutMs = Math.min(rebindTimeoutMs, SUBAGENT_PERMISSION_RELOAD_DRAIN_TIMEOUT_MS),
): ReloadableSubagentPermissionAuthority {
  if (!Number.isSafeInteger(rebindTimeoutMs) || rebindTimeoutMs < 1 || rebindTimeoutMs > 120_000
    || !Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 1 || drainTimeoutMs > 120_000) {
    throw new Error("Subagent Permission Gate reload timeouts must be between 1 and 120000 milliseconds");
  }

  let state: SubagentPermissionAuthorityPhase = "unbound";
  let binding: {
    owner: symbol;
    sessionId: string;
    delegate: SubagentPermissionAuthorityDelegate;
    validateCommit: () => void;
    controller: AbortController;
  } | undefined;
  let reloadOwner: symbol | undefined;
  let reloadSessionId = "";
  let reloadHandoff: Deferred | undefined;
  let drainWaiter: Deferred | undefined;
  let activeCalls = 0;
  let generation = 0;
  let terminalError: Error | undefined;
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  const revokedController = new AbortController();
  const tickets = new Map<SubagentPermissionTicket, {
    request: SubagentPermissionRequest;
    result: SubagentPermissionResult;
    binding: NonNullable<typeof binding>;
    generation: number;
  }>();

  const finishLease = () => {
    activeCalls -= 1;
    if (activeCalls === 0 && drainWaiter) {
      drainWaiter.resolve();
      drainWaiter = undefined;
    }
  };

  const terminate = (next: "inactive" | "failed", error: Error) => {
    if (state === "inactive" || state === "failed") return;
    terminalError = error;
    state = next;
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = undefined;
    binding?.controller.abort(error);
    revokedController.abort(error);
    binding = undefined;
    reloadOwner = undefined;
    reloadSessionId = "";
    reloadHandoff?.reject(error);
    reloadHandoff = undefined;
    drainWaiter?.resolve();
    drainWaiter = undefined;
  };

  const armReloadTimer = (message: string, timeoutMs: number) => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => terminate("failed", new Error(message)), timeoutMs);
  };

  const waitForReloadBinding = async (signal?: AbortSignal): Promise<void> => {
    const handoff = reloadHandoff;
    if (!handoff) throw terminalError ?? new Error("Parent AgentSH Permission Gate reload handoff is unavailable");
    if (signal?.aborted) throw errorValue(signal.reason ?? "Native subagent authorization was cancelled");
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => finish(errorValue(signal?.reason ?? "Native subagent authorization was cancelled"));
      signal?.addEventListener("abort", onAbort, { once: true });
      handoff.promise.then(() => finish(), (error) => finish(errorValue(error)));
    });
  };

  const waitUntilActive = async (signal?: AbortSignal): Promise<void> => {
    for (;;) {
      if (signal?.aborted) throw errorValue(signal.reason ?? "Native subagent launch was cancelled");
      if (state === "active" && binding) return;
      if (state !== "draining" && state !== "reloading") {
        throw terminalError ?? new Error("Parent AgentSH Permission Gate session is not active");
      }
      await waitForReloadBinding(signal);
    }
  };

  const prepare = async (
    request: SubagentPermissionRequest,
    signal?: AbortSignal,
  ): Promise<PreparedSubagentPermission> => {
    for (;;) {
      if (signal?.aborted) throw errorValue(signal.reason ?? "Native subagent authorization was cancelled");
      if (state === "draining" || state === "reloading") {
        await waitForReloadBinding(signal);
        continue;
      }
      const selected = binding;
      const selectedGeneration = generation;
      if (state !== "active" || !selected) {
        throw terminalError ?? new Error("Parent AgentSH Permission Gate session is not active");
      }

      // Keep this lease until the relay synchronously commits its encoded
      // response. beginReload therefore cannot cross an uncommitted allow.
      activeCalls += 1;
      let ticketCreated = false;
      try {
        const exactRequest = copyRequest(request);
        const result = copyResult(await selected.delegate(exactRequest, signal, selected.controller.signal));
        if ((state !== "active" && state !== "draining")
          || binding !== selected || generation !== selectedGeneration) {
          throw terminalError ?? new Error("Parent AgentSH Permission Gate authority changed during authorization");
        }
        if (signal?.aborted) throw errorValue(signal.reason ?? "Native subagent authorization was cancelled");
        const ticket = Object.freeze({});
        tickets.set(ticket, { request: exactRequest, result, binding: selected, generation: selectedGeneration });
        ticketCreated = true;
        return { ticket, result };
      } finally {
        if (!ticketCreated) finishLease();
      }
    }
  };

  const commit = (
    ticket: SubagentPermissionTicket,
    request: SubagentPermissionRequest,
  ): SubagentPermissionResult => {
    const prepared = tickets.get(ticket);
    if (!prepared) throw terminalError ?? new Error("Subagent Permission Gate authorization ticket is invalid or already used");
    tickets.delete(ticket);
    try {
      if (!sameRequest(prepared.request, request)) {
        throw new Error("Subagent Permission Gate authorization ticket does not match the exact request");
      }
      if ((state !== "active" && state !== "draining")
        || binding !== prepared.binding || generation !== prepared.generation) {
        throw terminalError ?? new Error("Subagent Permission Gate authorization ticket is stale");
      }
      try {
        prepared.binding.validateCommit();
      } catch (error) {
        const failure = errorValue(error);
        terminate("failed", failure);
        throw failure;
      }
      return prepared.result;
    } finally {
      finishLease();
    }
  };

  const abandon = (ticket: SubagentPermissionTicket): void => {
    if (!tickets.delete(ticket)) return;
    finishLease();
  };

  const authority: SubagentPermissionAuthority = Object.freeze({
    authorityAbi: 2 as const,
    protocol: SUBAGENT_PERMISSION_PROTOCOL_VERSION as 1,
    selected: true as const,
    get active() {
      return state === "active";
    },
    revoked: revokedController.signal,
    waitUntilActive,
    prepare,
    commit,
    abandon,
    async authorize(request: SubagentPermissionRequest, signal?: AbortSignal): Promise<SubagentPermissionResult> {
      const prepared = await prepare(request, signal);
      return commit(prepared.ticket, request);
    },
  });

  return {
    authorityAbi: 2 as const,
    protocol: SUBAGENT_PERMISSION_PROTOCOL_VERSION as 1,
    authority,
    phase: () => state,
    bind(owner, sessionId, delegate, validateCommit = () => undefined) {
      if (typeof owner !== "symbol" || !validSessionId(sessionId)
        || typeof delegate !== "function" || typeof validateCommit !== "function") {
        throw new Error("Invalid Subagent Permission Gate authority binding");
      }
      if (state !== "unbound" && state !== "reloading") {
        throw new Error(`Subagent Permission Gate authority cannot bind while ${state}`);
      }
      if (state === "reloading" && (reloadOwner === undefined || reloadOwner === owner || reloadSessionId !== sessionId)) {
        const error = new Error(reloadSessionId !== sessionId
          ? "Subagent Permission Gate reload tried to bind a different Pi session"
          : "Subagent Permission Gate reload tried to reuse the stale extension owner");
        terminate("failed", error);
        throw error;
      }
      const previousHandoff = reloadHandoff;
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = undefined;
      generation += 1;
      binding = { owner, sessionId, delegate, validateCommit, controller: new AbortController() };
      reloadOwner = undefined;
      reloadSessionId = "";
      reloadHandoff = undefined;
      terminalError = undefined;
      state = "active";
      previousHandoff?.resolve();
    },
    async beginReload(owner, sessionId) {
      if (state !== "active" || binding?.owner !== owner || binding.sessionId !== sessionId) return false;
      state = "draining";
      reloadOwner = owner;
      reloadSessionId = sessionId;
      reloadHandoff = deferred();
      armReloadTimer(
        `Parent AgentSH Permission Gate did not drain within ${drainTimeoutMs}ms for reload`,
        drainTimeoutMs,
      );
      if (activeCalls > 0) {
        drainWaiter = deferred();
        await drainWaiter.promise;
      }
      if (state !== "draining") return false;
      binding.controller.abort(new Error("Parent AgentSH Permission Gate session context was replaced by reload"));
      binding = undefined;
      state = "reloading";
      armReloadTimer(
        `Parent AgentSH Permission Gate did not rebind within ${rebindTimeoutMs}ms after reload`,
        rebindTimeoutMs,
      );
      return true;
    },
    deactivate(owner, error) {
      if (binding?.owner !== owner && reloadOwner !== owner) return false;
      terminate("inactive", errorValue(error));
      return true;
    },
    fail(error) {
      terminate("failed", errorValue(error));
    },
  };
}

export function currentSubagentPermissionSelection(): SubagentPermissionSelection | undefined {
  const value = (globalThis as Record<string, unknown>)[SUBAGENT_PERMISSION_SELECTION_KEY];
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Parent subagent Permission Gate selection is malformed");
  }
  const candidate = value as Partial<SubagentPermissionSelection>;
  if (candidate.protocol !== SUBAGENT_PERMISSION_PROTOCOL_VERSION || candidate.selected !== true
    || typeof candidate.conflict !== "boolean") {
    throw new Error("Parent subagent Permission Gate selection is malformed");
  }
  return candidate as SubagentPermissionSelection;
}

export function currentSubagentPermissionAuthority(): SubagentPermissionAuthority | undefined {
  const value = (globalThis as Record<string, unknown>)[SUBAGENT_PERMISSION_AUTHORITY_KEY];
  if (value === undefined) {
    if (currentSubagentPermissionSelection()?.selected) {
      throw new Error("Parent subagent Permission Gate was selected but its authority is unavailable");
    }
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Parent subagent Permission Gate authority is malformed");
  }
  const candidate = value as Partial<SubagentPermissionAuthority>;
  if (candidate.authorityAbi !== 2
    || candidate.protocol !== SUBAGENT_PERMISSION_PROTOCOL_VERSION || candidate.selected !== true
    || typeof candidate.active !== "boolean"
    || !candidate.revoked || typeof candidate.revoked.aborted !== "boolean"
    || typeof candidate.revoked.addEventListener !== "function"
    || typeof candidate.waitUntilActive !== "function"
    || typeof candidate.prepare !== "function" || typeof candidate.commit !== "function"
    || typeof candidate.abandon !== "function" || typeof candidate.authorize !== "function") {
    throw new Error("Parent subagent Permission Gate authority is malformed");
  }
  return candidate as SubagentPermissionAuthority;
}
