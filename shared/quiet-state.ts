import { readExtensionDefaults } from "./extension-defaults.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { admitHarnessWake } from "./idle-admission.js";

// Quiet harness state.
//
// Background jobs, subagents and watches report updates here. Routine updates are only
// recorded as receipts in the session log. Three kinds of update may wake the model:
// - completions: a background job or subagent finished (sent only when idle),
// - watch alerts: a watch has new events (sent only when idle),
// - guidance: a worker asks the parent for an answer (paced, may steer).
// Idle-decision controls are a special kind of guidance that bypasses most gates.
//
// Every state change is persisted as a receipt so a restart or reload never loses or
// replays a wake.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QuietUpdate = {
  kind: "job" | "subagent" | "watch" | "notification";
  id: string;
  state?: string;
  child_id?: string;
  job_id?: string;
  displayName?: string;
  message?: string;
  requires_guidance?: boolean;
  /** Authenticated broker identity; supplied only by the owning launch adapter. */
  guidance?: {
    ownerSessionId: string;
    ownerRuntimeEpoch: string;
    taskId: string;
    childId: string;
    attempt: number;
    workerEpoch: string;
    workerRuntimeEpoch: string;
    requestId: string;
    goalId?: string;
  };
  /** Producer-confirmed background execution terminal state, not task delivery. */
  completion?: boolean;
  /** Owning-controller generated idle-decision request only, never model input. */
  admission_control?: {
    kind: "idle-decision" | "idle-decision-resolved";
    request_id: string;
    worker_epoch: string;
  };
  /** New running generation, scoped by job_id + child_id (worker attempt). */
  activity?: boolean;
  outcomes?: Array<{ child: number; task_id?: string; attempt?: number; state: string }>;
  through_sequence?: number;
  count?: number;
  overflow?: boolean;
};

export type QuietStateReceiptState =
  | "recorded"
  | "queued"
  | "dispatching"
  | "delivered"
  | "consumed";

export type QuietStateReceipt = {
  v: 1;
  key: string;
  revision: string;
  state: QuietStateReceiptState;
  at: number;
  update: QuietUpdate;
};

/** A queued update plus its identity, content hash and size. */
type Item = { key: string; revision: string; bytes: number; data: QuietUpdate; queuedAt: number };

type Stats = {
  accepted: number;
  duplicate: number;
  dropped: number;
  routineRecorded: number;
  guidanceDelivered: number;
  guidanceBytes: number;
  schedulingAttempts: number;
  disabled: number;
  receiptFailed: number;
  circuitBreaks: number;
};

/** Last delivery failure, persisted so status survives a restart. */
type Diagnostic = {
  cause: string;
  keys: string[];
  affected?: Array<{
    key: string;
    id: string;
    child_id?: string;
    guidance?: QuietUpdate["guidance"];
  }>;
  at: number;
  nextRetryAt: number;
  attempt: number;
};

/** Per-session state. It lives on globalThis so it survives an extension reload, so
 * field names must stay stable across versions. */
type Hub = {
  /** Dispatch intents whose 'queued' receipt could not be written yet. */
  unsent?: Map<string, Item>;
  brokerUpdates?: Map<string, QuietUpdate>;
  brokerReady?: boolean;
  brokerPending?: number;
  lastGuidanceChild?: string;
  ackTimer?: ReturnType<typeof setTimeout>;
  guidanceSource?: (ctx: any) => QuietUpdate[] | undefined;
  diagnostic?: Diagnostic;
  retryAt?: number;
  dispatching?: boolean;
  wakeAdmission?: AbortController;
  wakeItems?: Map<string, string>;
  pending: Map<string, Item>;
  inFlight: Map<string, Item>;
  receipts: Map<string, QuietStateReceipt>;
  /** Activity receipts that failed to persist and must be retried. */
  activityRetries?: Map<string, Item>;
  activityTimer?: ReturnType<typeof setTimeout>;
  /** Identifies the installQuietState instance that owns this session. */
  writer?: symbol;
  pi?: ExtensionAPI;
  ctx?: ExtensionContext;
  timer?: ReturnType<typeof setTimeout>;
  completionTimer?: ReturnType<typeof setTimeout>;
  guidanceDisabled?: boolean;
  ui: boolean;
  compacting: boolean;
  lastGuidanceAt: number;
  localDisabled: boolean;
  deliveryFailures: number;
  stats: Stats;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KEY = "__paeQuietHarnessStateV2";

// Custom entry and message types.
const MESSAGE_CUSTOM = "harness-state";
const NOTIFICATION_CUSTOM = "harness-child-notification";
const CONTROL_CUSTOM = "harness-state-control";
const DIAGNOSTIC_CUSTOM = "harness-state-delivery-diagnostic";
export const QUIET_STATE_RECEIPT_CUSTOM_TYPE = "harness-state-receipt";

// Size limits.
const MAX_PENDING = 512;
const MAX_ITEM_BYTES = 4096;
const MAX_UPDATE_BYTES = 3000;
const MAX_BATCH_BYTES = 6000;
const MAX_BATCH_ITEMS = 16;

// Timing.
const MIN_GUIDANCE_INTERVAL_MS = 30_000;
const MAX_RETRY_MS = 300_000;
const ACK_TIMEOUT_MS = 10_000;

// Identity formats.
const CHILD_ID_PATTERN = /^subagent-child-[0-9a-f]{24}$/;
const JOB_ID_PATTERN = /^(?:job|subagent-job)-[0-9a-f]{24}$/;
const WATCH_ID_PATTERN = /^watch-[0-9a-f]{24}$/;
const IDLE_REQUEST_ID_PATTERN = /^idle:[0-9a-f]{32}$/;
const WORKER_EPOCH_PATTERN = /^[0-9a-f]{32}$/;

/** Receipt states that mean an update needs no further delivery. */
const SETTLED_STATES = ["delivered", "consumed", "recorded"];

// Wake message openings.
const COMPLETION_PREFIX =
  "Background subagent finished. Read its result, then reap it when follow-up is complete.\n";
const JOB_COMPLETION_PREFIX =
  "Background job finished. Inspect its output, then reap it when no longer needed.\n";
const MIXED_COMPLETION_PREFIX =
  "Background work finished. Read each job’s output or subagent’s result, then reap it when no longer needed.\n";
/** Opening line of every wake message that contains watch alerts. */
export const WATCH_ALERT_PREFIX =
  "Watch alert. Read the new events with background_job events, then ack them.\n";
const GUIDANCE_PREFIX =
  "Worker guidance is pending. For structured requests use guidance list and reply to the exact authenticated target; subagent operation=prompt with child_id is only for legacy notices, not an awaited guidance answer or permission.\n";

// ---------------------------------------------------------------------------
// Preferences: environment kill switch and declarative defaults
// ---------------------------------------------------------------------------

const quietStateDefaults = readExtensionDefaults("quiet-state");
if (quietStateDefaults.enabled !== undefined && typeof quietStateDefaults.enabled !== "boolean")
  throw new Error("Invalid defaults/quiet-state.json enabled preference");

// Explicit environment values (including 0/false) override declarative defaults;
// a true kill switch still cannot be bypassed by session enable commands.
function quietStateEnvironment(): string | undefined {
  return process.env.PAE_QUIET_STATE_DISABLED ?? process.env.PI_QUIET_STATE_DISABLED;
}
function envDisabled(): boolean {
  return /^(1|true|yes|on)$/i.test(quietStateEnvironment() ?? "");
}
function defaultDisabled(): boolean {
  return quietStateEnvironment() === undefined && quietStateDefaults.enabled === false;
}
function disabled(hub?: Hub): boolean {
  return envDisabled() || hub?.localDisabled === true;
}

// ---------------------------------------------------------------------------
// Small helpers: hashing, sizes, keys and items
// ---------------------------------------------------------------------------

function revision(data: unknown): string {
  return createHash("sha256").update(JSON.stringify(data)).digest("hex");
}
function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
/** Broker guidance is keyed by its full authenticated identity; everything else by kind and id. */
function keyOf(data: QuietUpdate): string {
  const g = data.guidance;
  return g
    ? `guidance:${revision([g.ownerSessionId, g.ownerRuntimeEpoch, g.taskId, g.childId, g.attempt, g.workerEpoch, g.workerRuntimeEpoch, g.requestId, g.goalId ?? null])}`
    : `${data.kind}:${data.id}`;
}
function validUpdate(data: any): data is QuietUpdate {
  return (
    data &&
    ["job", "subagent", "watch", "notification"].includes(data.kind) &&
    typeof data.id === "string"
  );
}
function toItem(data: QuietUpdate, queuedAt = Date.now()): Item {
  const updateText = JSON.stringify(data);
  return {
    key: keyOf(data),
    revision: revision(data),
    bytes: bytes(updateText),
    data: clone(data),
    queuedAt,
  };
}
function isCustomEntry(entry: any, customType: string): boolean {
  return entry?.type === "custom" && entry.customType === customType;
}
/** Interleave items by group so one busy group cannot starve the others. Starts with the
 * group after `after`, which is the group that was served last. */
function roundRobin<T>(items: T[], group: (item: T) => string, after?: string): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = group(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }
  const keys = [...groups.keys()],
    index = after ? keys.indexOf(after) : -1;
  if (index >= 0) keys.push(...keys.splice(0, index + 1));
  const result: T[] = [];
  while (result.length < items.length)
    for (const key of keys) {
      const queue = groups.get(key)!;
      if (queue.length) result.push(queue.shift()!);
    }
  return result;
}
/** Wait at least one second before polling again. */
function nextPollMs(delayMs: number): number {
  return Math.max(delayMs, 1000);
}

// ---------------------------------------------------------------------------
// Update classification: completion, watch alert, guidance, control
// ---------------------------------------------------------------------------

function isCompletion(data: QuietUpdate): boolean {
  return (data.kind === "subagent" || data.kind === "job") && data.completion === true;
}
/** Which worker a completion belongs to. Newer completions replace older ones. */
function completionIdentity(data: QuietUpdate): string {
  return JSON.stringify([data.kind, data.job_id ?? data.id, data.child_id ?? data.id]);
}
function hasSequence(data: QuietUpdate): boolean {
  return Number.isSafeInteger(data.through_sequence) && data.through_sequence! >= 0;
}
/** New events on one of this session's watches. Delivered like completions:
 * idle-only, coalesced per watch, and consumed by events/ack/unwatch. */
function isWatchAlert(data: QuietUpdate): boolean {
  return data.kind === "watch" && data.requires_guidance !== true && hasSequence(data);
}
/** Completions and watch alerts wake the model, but only when it is idle. */
function isIdleWake(data: QuietUpdate): boolean {
  return isCompletion(data) || isWatchAlert(data);
}
/** A worker request that waits for a parent answer. */
function needsGuidance(data: QuietUpdate): boolean {
  return data.requires_guidance === true && !isCompletion(data);
}
/** A guidance request owned by the guidance broker (current or legacy form). */
function isBrokerGuidance(data: QuietUpdate): boolean {
  return !!data.guidance || (data.kind === "notification" && data.id.startsWith("guidance:"));
}
/** Guidance requests are paced and grouped per worker. */
function guidanceGroup(data: QuietUpdate): string {
  return data.guidance?.childId ?? data.child_id ?? data.id;
}
/** An idle-decision request from a subagent child, with an exact identity. */
function isControlRequest(data: QuietUpdate): boolean {
  return (
    data.kind === "notification" &&
    data.requires_guidance === true &&
    !!data.child_id &&
    CHILD_ID_PATTERN.test(data.child_id) &&
    data.admission_control?.kind === "idle-decision" &&
    IDLE_REQUEST_ID_PATTERN.test(data.admission_control.request_id) &&
    WORKER_EPOCH_PATTERN.test(data.admission_control.worker_epoch)
  );
}
/** The parent's answer to an idle-decision request. */
function isControlResolution(data: QuietUpdate): boolean {
  return (
    data.kind === "notification" &&
    !!data.child_id &&
    data.admission_control?.kind === "idle-decision-resolved"
  );
}
/** True when `resolution` answers the pending control request `request`. */
function resolvesControl(request: QuietUpdate, resolution: QuietUpdate): boolean {
  return (
    resolution.kind === "notification" &&
    resolution.child_id === request.child_id &&
    resolution.admission_control?.kind === "idle-decision-resolved" &&
    resolution.admission_control.request_id === request.admission_control?.request_id &&
    resolution.admission_control.worker_epoch === request.admission_control?.worker_epoch
  );
}
/** Gate the existing durable notification queue, not a duplicate wake message.
 * Only batches made entirely of producer-confirmed terminal completions or
 * identity-bound idle-decision controls use automatic compaction admission. */
function trustedAutonomousUpdate(data: QuietUpdate): boolean {
  if (isCompletion(data) || isControlRequest(data)) return true;
  if (isWatchAlert(data)) return WATCH_ID_PATTERN.test(data.id);
  if (data.requires_guidance !== true) return false;
  const validChild = typeof data.child_id === "string" && CHILD_ID_PATTERN.test(data.child_id);
  const validJob =
    typeof (data.job_id ?? data.id) === "string" &&
    JOB_ID_PATTERN.test(String(data.job_id ?? data.id));
  if (data.kind === "subagent") return validChild && validJob;
  if (data.kind === "job") return validJob;
  return data.kind === "notification" && validChild;
}

// ---------------------------------------------------------------------------
// Wake message text and size
// ---------------------------------------------------------------------------

function completionPrefix(updates: QuietUpdate[]): string {
  const watches = updates.some(isWatchAlert);
  const finished = updates.filter((u) => !isWatchAlert(u));
  if (!finished.length) return WATCH_ALERT_PREFIX;
  return (watches ? WATCH_ALERT_PREFIX : "") + finishedPrefix(finished);
}
function finishedPrefix(updates: QuietUpdate[]): string {
  const children = updates.some((u) => u.kind === "subagent"),
    jobs = updates.some((u) => u.kind === "job");
  if (children && jobs) return MIXED_COMPLETION_PREFIX;
  return children ? COMPLETION_PREFIX : JOB_COMPLETION_PREFIX;
}
/** Size of a completion/watch wake: message content plus details. */
function completionBatchBytes(updates: QuietUpdate[]): number {
  return (
    bytes(completionPrefix(updates) + JSON.stringify(updates)) + bytes(JSON.stringify({ updates }))
  );
}
/** Size of a guidance wake: message content plus details. */
function guidanceBatchBytes(updates: QuietUpdate[]): number {
  return bytes(GUIDANCE_PREFIX + JSON.stringify(updates)) + bytes(JSON.stringify({ updates }));
}

// ---------------------------------------------------------------------------
// Per-session state (the Hub)
// ---------------------------------------------------------------------------

function hubs(): Map<string, Hub> {
  const root = globalThis as any;
  return (root[KEY] ??= new Map<string, Hub>());
}
function session(ctx: any): string {
  return ctx.sessionManager.getSessionId();
}
function emptyStats(): Stats {
  return {
    accepted: 0,
    duplicate: 0,
    dropped: 0,
    routineRecorded: 0,
    guidanceDelivered: 0,
    guidanceBytes: 0,
    schedulingAttempts: 0,
    disabled: 0,
    receiptFailed: 0,
    circuitBreaks: 0,
  };
}
/** The hub for this session, created on first use. */
function hubFor(ctx: any): Hub {
  const id = session(ctx);
  let hub = hubs().get(id);
  if (!hub) {
    hub = {
      pending: new Map(),
      inFlight: new Map(),
      receipts: new Map(),
      ui: false,
      compacting: false,
      lastGuidanceAt: 0,
      localDisabled: defaultDisabled(),
      deliveryFailures: 0,
      stats: emptyStats(),
    };
    hubs().set(id, hub);
  }
  return hub;
}
function clearTimers(hub: Hub) {
  if (hub.ackTimer) clearTimeout(hub.ackTimer);
  hub.ackTimer = undefined;
  if (hub.timer) clearTimeout(hub.timer);
  if (hub.completionTimer) clearTimeout(hub.completionTimer);
  if (hub.activityTimer) clearTimeout(hub.activityTimer);
  hub.timer = undefined;
  hub.completionTimer = undefined;
  hub.activityTimer = undefined;
}
/** The queued item still has exactly this revision. */
function isStillPending(hub: Hub, item: Item): boolean {
  return hub.pending.get(item.key)?.revision === item.revision;
}
function guidancePending(hub: Hub) {
  return [...hub.pending.values()].some((item) => needsGuidance(item.data));
}
function controlPending(hub: Hub): boolean {
  return [...hub.pending.values()].some((item) => isControlRequest(item.data));
}
/** A control request that the parent has already answered. */
function controlResolved(hub: Hub, data: QuietUpdate): boolean {
  return (
    isControlRequest(data) &&
    [...hub.receipts.values()].some((receipt) => resolvesControl(data, receipt.update))
  );
}

// ---------------------------------------------------------------------------
// Receipts and persistence
// ---------------------------------------------------------------------------

function latestReceipt(hub: Hub, key: string) {
  return hub.receipts.get(key);
}
function hasSettledReceipt(hub: Hub, key: string): boolean {
  return SETTLED_STATES.includes(latestReceipt(hub, key)?.state ?? "");
}
/** This update needs no delivery. Guidance matches by key alone; others by revision. */
function alreadyHandled(hub: Hub, key: string, rev: string) {
  const receipt = latestReceipt(hub, key);
  return (
    !!receipt &&
    (key.startsWith("guidance:") || receipt.revision === rev) &&
    (receipt.state === "recorded" || receipt.state === "delivered" || receipt.state === "consumed")
  );
}
/** Parse a persisted receipt entry, or undefined if the entry is not a valid receipt. */
function receiptFrom(entry: any): QuietStateReceipt | undefined {
  if (!isCustomEntry(entry, QUIET_STATE_RECEIPT_CUSTOM_TYPE)) return undefined;
  const d = entry.data;
  if (
    d?.v !== 1 ||
    typeof d.key !== "string" ||
    typeof d.revision !== "string" ||
    !["recorded", "queued", "dispatching", "delivered", "consumed"].includes(d.state) ||
    typeof d.at !== "number" ||
    !validUpdate(d.update)
  )
    return undefined;
  return d;
}
function deliveredReceipt(key: string, item: Item, at: number): QuietStateReceipt {
  return { v: 1, key, revision: item.revision, state: "delivered", at, update: item.data };
}
/** Persist a receipt and remember it. Returns false (and reports) if the write fails. */
function appendReceipt(hub: Hub, item: Item, state: QuietStateReceiptState): boolean {
  const receipt: QuietStateReceipt = {
    v: 1,
    key: item.key,
    revision: item.revision,
    state,
    at: Date.now(),
    update: clone(item.data),
  };
  // Activity has its own fail-closed retry path; transient storage failures
  // must not trip the unrelated delivery circuit permanently after recovery.
  const failed = () => {
    hub.stats.receiptFailed++;
    if (item.data.activity !== true)
      reportFailure(hub, "Receipt persistence failed", [item.key], true, [item.data]);
    return false;
  };
  if (bytes(JSON.stringify(receipt)) > MAX_ITEM_BYTES || typeof hub.pi?.appendEntry !== "function")
    return failed();
  try {
    hub.pi.appendEntry(QUIET_STATE_RECEIPT_CUSTOM_TYPE, receipt);
  } catch {
    return failed();
  }
  hub.receipts.set(item.key, receipt);
  return true;
}
/** Record delivery. If the receipt write fails, still remember it in memory: the
 * persisted message itself prevents a replay after restart. */
function markDelivered(hub: Hub, item: Item, key = item.key): void {
  if (!appendReceipt(hub, item, "delivered"))
    hub.receipts.set(key, deliveredReceipt(key, item, Date.now()));
}
/** Return a not-yet-sent item to the queue, or remember it for a later retry. */
function requeueUnsent(hub: Hub, item: Item): void {
  if (appendReceipt(hub, item, "queued")) hub.unsent?.delete(item.key);
  else (hub.unsent ??= new Map()).set(item.key, item);
}

// ---------------------------------------------------------------------------
// Worker activity: a new worker generation makes older completions stale
// ---------------------------------------------------------------------------

/** An activity receipt at or past this item's sequence is already persisted. */
function activityAlreadyRecorded(hub: Hub, key: string, item: Item): boolean {
  const prior = latestReceipt(hub, key);
  return (
    prior?.update.activity === true &&
    hasSequence(prior.update) &&
    prior.update.through_sequence! >= item.data.through_sequence!
  );
}
function hasActivityRetry(hub: Hub, identity: string): boolean {
  return [...(hub.activityRetries?.values() ?? [])].some(
    (retry) => completionIdentity(retry.data) === identity,
  );
}
function hasNewerActivityRetry(hub: Hub, identity: string, sequence: number): boolean {
  return [...(hub.activityRetries?.values() ?? [])].some(
    (item) => completionIdentity(item.data) === identity && item.data.through_sequence! > sequence,
  );
}
/** A receipt shows newer activity, or an equal-or-newer completion that was already handled. */
function receiptSupersedes(receipt: QuietStateReceipt, identity: string, sequence: number) {
  const update = receipt.update;
  if (completionIdentity(update) !== identity || !hasSequence(update)) return false;
  const newerActivity =
    update.activity === true && receipt.state === "recorded" && update.through_sequence! > sequence;
  const handledCompletion =
    isCompletion(update) &&
    (receipt.state === "consumed" || receipt.state === "delivered") &&
    update.through_sequence! >= sequence;
  return newerActivity || handledCompletion;
}
/** This completion is out of date and must not wake the model. */
function completionSuperseded(hub: Hub, data: QuietUpdate): boolean {
  if (!isCompletion(data) || !hasSequence(data)) return false;
  const identity = completionIdentity(data);
  // Failed persistence must not make an already-observed old generation live
  // again. The retry high-water mark survives same-process extension reload.
  if (hasNewerActivityRetry(hub, identity, data.through_sequence!)) return true;
  return [...hub.receipts.values()].some((receipt) =>
    receiptSupersedes(receipt, identity, data.through_sequence!),
  );
}
function dropSupersededCompletions(hub: Hub): void {
  for (const [key, pending] of hub.pending)
    if (completionSuperseded(hub, pending.data)) hub.pending.delete(key);
}
function retryActivity(hub: Hub): void {
  for (const [key, item] of hub.activityRetries ?? []) {
    if (activityAlreadyRecorded(hub, key, item) || appendReceipt(hub, item, "recorded"))
      hub.activityRetries!.delete(key);
  }
}
function scheduleActivity(hub: Hub, delayMs: number): void {
  if (hub.activityTimer || !hub.activityRetries?.size || !hub.pi || !hub.ctx) return;
  hub.activityTimer = setTimeout(() => {
    hub.activityTimer = undefined;
    if (!hub.pi || !hub.ctx) return;
    retryActivity(hub);
    schedule(hub, nextPollMs(delayMs));
  }, delayMs);
  hub.activityTimer.unref?.();
}

// ---------------------------------------------------------------------------
// Restore from the session log
// ---------------------------------------------------------------------------

function branchEntries(ctx: any): any[] {
  return ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries?.() ?? [];
}
/** The updates carried by a harness-state wake message entry, if this is one. */
function messageUpdates(entry: any): QuietUpdate[] | undefined {
  const m = entry?.type === "message" ? entry.message : entry;
  return (entry?.type === "custom_message" || m?.role === "custom") &&
    m.customType === MESSAGE_CUSTOM &&
    Array.isArray(m.details?.updates)
    ? m.details.updates
    : undefined;
}
function entryTimestamp(entry: any): number | undefined {
  const timestamp =
    typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : entry.timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : undefined;
}

/** Rebuild the hub from the session log: receipts, controls, diagnostics and the queue. */
function restore(hub: Hub, ctx: any) {
  const entries = branchEntries(ctx);
  resetForRestore(hub);
  for (const entry of entries) {
    if (isCustomEntry(entry, DIAGNOSTIC_CUSTOM)) restoreDiagnostic(hub, entry.data);
    if (isCustomEntry(entry, CONTROL_CUSTOM) && entry.data?.v === 1)
      restoreControl(hub, entry.data);
    const receipt = receiptFrom(entry);
    if (receipt) hub.receipts.set(receipt.key, receipt);
    else restoreLegacyMessage(hub, entry);
  }
  for (const receipt of hub.receipts.values()) {
    restoreGuidancePacing(hub, receipt);
    requeueOpenReceipt(hub, receipt);
  }
  // Report sequence, not receipt time, orders child turns. Consuming an older
  // result later must not suppress a newer unseen completion after reload.
  for (const [key, item] of hub.pending)
    if (completionSuperseded(hub, item.data) || controlResolved(hub, item.data))
      hub.pending.delete(key);
  requeueRetainedGuidance(hub, entries);
  reportUncertainDispatch(
    hub,
    "Uncertain guidance dispatch retained across restore; inspect actual message history",
    uncertainDispatchKeys(hub, false),
  );
}
function resetForRestore(hub: Hub): void {
  hub.diagnostic = undefined;
  hub.retryAt = 0;
  hub.receipts.clear();
  hub.pending.clear();
  hub.inFlight.clear();
  hub.localDisabled = defaultDisabled();
  hub.guidanceDisabled = false;
  hub.lastGuidanceAt = 0;
  hub.lastGuidanceChild = undefined;
  hub.stats.guidanceDelivered = 0;
  hub.stats.guidanceBytes = 0;
}
function restoreDiagnostic(hub: Hub, data: any): void {
  hub.diagnostic = data?.cause ? data : undefined;
  hub.retryAt = hub.diagnostic?.nextRetryAt ?? 0;
}
/** Apply a persisted enable/disable/pause control. */
function restoreControl(hub: Hub, data: any): void {
  if (typeof data.disabled !== "boolean") return;
  // Quota-only pauses are obsolete, not operator opt-outs. Preserve all other controls.
  if (data.reason === "guidance-quota") return;
  if (data.reason === "compaction-pause") {
    hub.guidanceDisabled = data.disabled;
    return;
  }
  hub.localDisabled = data.disabled;
  if (!data.disabled) hub.guidanceDisabled = false;
}
/** Backward compatibility: pre-remediation hidden messages count as delivered and must never replay. */
function restoreLegacyMessage(hub: Hub, entry: any): void {
  for (const data of messageUpdates(entry) ?? []) {
    if (!validUpdate(data)) continue;
    const item = toItem(data),
      prior = hub.receipts.get(item.key);
    // A historical message is delivery evidence, not a new delivery now.
    // Preserve explicit receipts (including consumption), and never let an
    // older message acknowledge a newer revision of a queued request.
    const priorStillOpen =
      !!prior &&
      ["queued", "dispatching"].includes(prior.state) &&
      prior.revision === item.revision;
    if (prior && !priorStillOpen) continue;
    const at = entryTimestamp(entry) ?? prior?.at ?? 0;
    hub.receipts.set(item.key, deliveredReceipt(item.key, item, at));
  }
}
/** Rebuild guidance stats and the pacing clock from guidance receipts. */
function restoreGuidancePacing(hub: Hub, receipt: QuietStateReceipt): void {
  if (!needsGuidance(receipt.update)) return;
  if (receipt.state === "delivered") {
    hub.stats.guidanceDelivered++;
    hub.stats.guidanceBytes += bytes(JSON.stringify(receipt.update));
  }
  // An unacknowledged intent may have dispatched. Preserve pacing on
  // restart without treating uncertainty as a delivered receipt.
  const mayHaveSent = receipt.state === "delivered" || receipt.state === "dispatching";
  if (mayHaveSent && receipt.at >= hub.lastGuidanceAt) {
    hub.lastGuidanceAt = Math.min(Date.now(), receipt.at);
    hub.lastGuidanceChild = guidanceGroup(receipt.update);
  }
}
/** Put a queued or dispatching wake back into the pending queue. */
function requeueOpenReceipt(hub: Hub, receipt: QuietStateReceipt): void {
  const open = receipt.state === "queued" || receipt.state === "dispatching";
  const wakesModel = receipt.update.requires_guidance === true || isIdleWake(receipt.update);
  if (open && wakesModel) hub.pending.set(receipt.key, toItem(receipt.update, receipt.at));
}
/** Retained child notifications are operator-visible records. Routine notifications stay
 * retained only; explicit guidance is re-queued until delivered/consumed. */
function requeueRetainedGuidance(hub: Hub, entries: any[]): void {
  for (const entry of entries) {
    const data = isCustomEntry(entry, NOTIFICATION_CUSTOM) ? entry.data?.update : undefined;
    if (!validUpdate(data) || data.kind !== "notification") continue;
    const item = toItem(data, entry.data?.at ?? Date.now());
    if (
      alreadyHandled(hub, item.key, item.revision) ||
      hub.pending.has(item.key) ||
      hub.pending.size >= MAX_PENDING
    )
      continue;
    if (data.requires_guidance === true) hub.pending.set(item.key, item);
  }
}

// ---------------------------------------------------------------------------
// Failure reporting and status bar
// ---------------------------------------------------------------------------

/** Backoff doubles per attempt, capped at MAX_RETRY_MS. */
function retryBackoffMs(attempt: number): number {
  return Math.min(MAX_RETRY_MS, 1000 * 2 ** Math.min(attempt - 1, 9));
}
/** Short identity of each affected update, for the persisted diagnostic. */
function affectedUpdates(hub: Hub, keys: string[], updates: QuietUpdate[]) {
  return keys.slice(0, MAX_BATCH_ITEMS).flatMap((key) => {
    const data =
      updates.find((u) => keyOf(u) === key) ??
      hub.pending.get(key)?.data ??
      hub.receipts.get(key)?.update ??
      hub.brokerUpdates?.get(key);
    return data ? [{ key, id: data.id, child_id: data.child_id, guidance: data.guidance }] : [];
  });
}
/** Record and show a delivery failure. With `retry`, delivery resumes after a backoff;
 * without it, the operator must recover the affected keys. */
function reportFailure(
  hub: Hub,
  cause: string,
  keys: string[],
  retry = true,
  updates: QuietUpdate[] = [],
): void {
  cause = cause.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 500);
  const attempt = (hub.diagnostic?.cause === cause ? hub.diagnostic.attempt : 0) + 1;
  hub.retryAt = retry ? Date.now() + retryBackoffMs(attempt) : 0;
  const affected = affectedUpdates(hub, keys, updates);
  hub.diagnostic = {
    cause,
    keys: keys.slice(0, MAX_BATCH_ITEMS),
    affected,
    at: Date.now(),
    nextRetryAt: hub.retryAt,
    attempt,
  };
  try {
    hub.pi?.appendEntry(DIAGNOSTIC_CUSTOM, hub.diagnostic);
  } catch {
    hub.diagnostic.cause = cause + "; diagnostic persistence failed";
  }
  notifyFailure(hub, hub.diagnostic, retry);
  refreshStatus(hub);
}
function notifyFailure(hub: Hub, diagnostic: Diagnostic, retry: boolean): void {
  if (!hub.ctx?.hasUI) return;
  const recovery = retry
    ? "Automatic bounded backoff."
    : "Inspect guidance list and answer/dismiss, or retry-guidance with the exact key (may duplicate).";
  try {
    hub.ctx.ui.notify(
      `Harness delivery: ${diagnostic.cause}; ${hub.pending.size} pending. Inspect /harness-state status. ${recovery} `,
      "warning",
    );
  } catch {}
}
function clearFailure(hub: Hub): void {
  hub.diagnostic = undefined;
  hub.retryAt = 0;
  hub.deliveryFailures = 0;
  try {
    hub.pi?.appendEntry(DIAGNOSTIC_CUSTOM, { at: Date.now(), resolved: true });
  } catch {
    reportFailure(hub, "Recovery diagnostic persistence failed", []);
  }
}
/** The current diagnostic has keys, and every key passes `settled`. */
function diagnosticKeysSettled(hub: Hub, settled: (key: string) => boolean): boolean {
  return !!hub.diagnostic?.keys.length && hub.diagnostic.keys.every(settled);
}
/** Pending items with a 'dispatching' receipt that are not waiting for a requeue. Those
 * may or may not have been sent. With `expiredOnly`, only those past the ack timeout. */
function uncertainDispatchKeys(hub: Hub, expiredOnly: boolean): string[] {
  return [...hub.pending.values()]
    .filter(
      (item) =>
        latestReceipt(hub, item.key)?.state === "dispatching" &&
        !hub.unsent?.has(item.key) &&
        (!expiredOnly || Date.now() - latestReceipt(hub, item.key)!.at >= ACK_TIMEOUT_MS),
    )
    .map((item) => item.key)
    .slice(0, MAX_BATCH_ITEMS);
}
/** Report uncertain dispatches once; repeat only when the set of keys changes. */
function reportUncertainDispatch(hub: Hub, cause: string, keys: string[]): void {
  const alreadyReported =
    !!hub.diagnostic?.cause.startsWith("Uncertain guidance dispatch") &&
    JSON.stringify(hub.diagnostic.keys) === JSON.stringify(keys);
  if (keys.length && !alreadyReported) reportFailure(hub, cause, keys, false);
}
function statusBarText(hub: Hub): string | undefined {
  const guidance = [...hub.pending.values()].filter((item) => item.data.requires_guidance).length;
  if (disabled(hub)) return "quiet off";
  if (hub.compacting) return "quiet compacting";
  if (hub.guidanceDisabled) return "quiet guidance paused";
  if (hub.diagnostic) return `quiet delivery error (${guidance} pending): ${hub.diagnostic.cause}`;
  if (guidance) return `quiet guidance ${guidance}`;
  return undefined;
}
function refreshStatus(hub: Hub) {
  const ctx = hub.ctx;
  if (!ctx?.hasUI) return;
  const text = statusBarText(hub);
  try {
    ctx.ui.setStatus("quiet-state", text);
  } catch {}
}

// ---------------------------------------------------------------------------
// Wake admission (idle-admission gate before a wake is sent)
// ---------------------------------------------------------------------------

/** Abort the running admission once none of the items it covers is still pending. */
function revokeConsumedWake(hub: Hub): void {
  if (
    hub.wakeAdmission &&
    hub.wakeItems &&
    ![...hub.wakeItems].some(([key, rev]) => hub.pending.get(key)?.revision === rev)
  )
    hub.wakeAdmission.abort();
}
/** Ask the admission gate whether this batch may wake the model. */
async function admitBatch(hub: Hub, items: Item[]): Promise<boolean> {
  if (hub.wakeAdmission || !hub.ctx) return false;
  const controller = new AbortController(),
    writer = hub.writer,
    ctx = hub.ctx;
  hub.wakeAdmission = controller;
  hub.wakeItems = new Map(items.map((item) => [item.key, item.revision]));
  try {
    const decision = await admitHarnessWake(
      ctx,
      controller.signal,
      items.length > 0 && items.every((item) => trustedAutonomousUpdate(item.data)),
    );
    // The session may have changed owner or ended while we waited.
    const stale =
      controller.signal.aborted ||
      hub.writer !== writer ||
      !hub.ctx ||
      session(hub.ctx) !== session(ctx);
    if (stale) return false;
    if (decision === "continue") return true;
    // Explicit Cancel suppresses this exact wake revision, not retained history.
    for (const item of items)
      if (isStillPending(hub, item) && appendReceipt(hub, item, "consumed"))
        hub.pending.delete(item.key);
    return false;
  } catch {
    return false;
  } finally {
    if (hub.wakeAdmission === controller) {
      hub.wakeAdmission = undefined;
      hub.wakeItems = undefined;
    }
  }
}

// ---------------------------------------------------------------------------
// Guidance: acknowledgement from the message log
// ---------------------------------------------------------------------------

/** The session log holds a wake message that carried this item. */
function hasDeliveryMessage(hub: Hub, item: Item): boolean {
  const entries = hub.ctx?.sessionManager.getBranch?.() ?? [];
  return entries.some((entry: any) =>
    messageUpdates(entry)?.some(
      (u: QuietUpdate) =>
        validUpdate(u) &&
        keyOf(u) === item.key &&
        (item.data.guidance || revision(u) === item.revision),
    ),
  );
}
/** Settle dispatched guidance whose message is in the log, and surface stuck dispatches. */
function acknowledgeGuidance(hub: Hub): void {
  retryUnsent(hub);
  acknowledgeLoggedDispatches(hub);
  if (diagnosticKeysSettled(hub, (key) => hasSettledReceipt(hub, key))) clearFailure(hub);
  // Modal admission may cancel the acknowledgement timer. On the next safe
  // boundary, still surface expired intents instead of silently stranding them.
  const atSafeBoundary = !hub.ui && !hub.compacting && !hub.dispatching;
  if (atSafeBoundary && Date.now() >= (hub.retryAt ?? 0))
    reportUncertainDispatch(
      hub,
      "Uncertain guidance dispatch: no persisted message acknowledgement",
      uncertainDispatchKeys(hub, true),
    );
}
/** After the backoff, retry writing 'queued' receipts that failed earlier. */
function retryUnsent(hub: Hub): void {
  for (const [key, item] of Date.now() >= (hub.retryAt ?? 0) ? (hub.unsent ?? []) : []) {
    if (alreadyHandled(hub, key, item.revision)) hub.unsent!.delete(key);
    else requeueUnsent(hub, item);
  }
}
function acknowledgeLoggedDispatches(hub: Hub): void {
  for (const [key, item] of hub.pending)
    if (latestReceipt(hub, key)?.state === "dispatching" && hasDeliveryMessage(hub, item)) {
      // The message journal is independent delivery evidence if the receipt write fails.
      markDelivered(hub, item, key);
      hub.pending.delete(key);
      hub.stats.guidanceDelivered++;
    }
}

// ---------------------------------------------------------------------------
// Guidance: reconcile the queue with the guidance broker
// ---------------------------------------------------------------------------

function reconcileGuidance(hub: Hub): void {
  acknowledgeGuidance(hub);
  hub.brokerReady = false;
  const snapshot = readBrokerSnapshot(hub);
  if (!snapshot) return;
  hub.brokerReady = true;
  hub.brokerPending = snapshot.length;
  hub.brokerUpdates = new Map(snapshot.map((u) => [keyOf(u), u]));
  const updates = roundRobin(snapshot, guidanceGroup, hub.lastGuidanceChild);
  const live = new Set(updates.map(keyOf));
  retireStaleBrokerGuidance(hub, updates, live);
  queueNewBrokerRequests(hub, updates);
  const settledOrGone = (key: string) =>
    hasSettledReceipt(hub, key) || (key.startsWith("guidance:") && !live.has(key));
  if (diagnosticKeysSettled(hub, settledOrGone)) clearFailure(hub);
  revokeConsumedWake(hub);
}
/** This session's open broker requests, or undefined when the broker cannot answer. */
function readBrokerSnapshot(hub: Hub): QuietUpdate[] | undefined {
  if (!hub.guidanceSource || !hub.ctx) return undefined;
  let updates: QuietUpdate[] | undefined;
  try {
    updates = hub.guidanceSource(hub.ctx);
  } catch (error) {
    reportFailure(hub, `Broker reconciliation failed: ${String(error)}`, []);
    return undefined;
  }
  if (!updates) return undefined; // Startup/reload: never treat an unavailable snapshot as an empty broker.
  updates = updates.filter(
    (u) => validUpdate(u) && u.guidance?.ownerSessionId === session(hub.ctx),
  );
  if (updates.length > 1024) {
    reportFailure(hub, "Broker snapshot exceeds bounded request inventory", []);
    return undefined;
  }
  return updates;
}
/** Consume queued broker guidance that the broker no longer lists. */
function retireStaleBrokerGuidance(hub: Hub, updates: QuietUpdate[], live: Set<string>): void {
  for (const [key, item] of hub.pending) {
    if (!isBrokerGuidance(item.data) || live.has(key)) continue;
    if (!upgradeLegacyRequest(hub, key, item, updates)) continue;
    if (appendReceipt(hub, item, "consumed")) hub.pending.delete(key);
  }
}
/** Move a legacy request-ID-only queue entry to its broker key. Returns false only when
 * the replacement could not be persisted, so the old entry must be kept. */
function upgradeLegacyRequest(hub: Hub, key: string, item: Item, updates: QuietUpdate[]): boolean {
  const upgrade =
    !item.data.guidance &&
    updates.find(
      (u) => u.guidance?.requestId === item.data.id && u.child_id === item.data.child_id,
    );
  if (!upgrade) return true;
  const replacement = toItem(upgrade, item.queuedAt);
  // Move a stranded legacy queue entry, not a delivery tombstone. Write
  // the replacement before consuming the old key so a crash cannot lose it.
  if (
    alreadyHandled(hub, replacement.key, replacement.revision) ||
    hub.pending.has(replacement.key)
  )
    return true;
  const state = latestReceipt(hub, key)?.state === "dispatching" ? "dispatching" : "queued";
  if (!appendReceipt(hub, replacement, state)) return false;
  hub.pending.set(replacement.key, replacement);
  return true;
}
/** Queue broker requests that are not yet queued or handled. */
function queueNewBrokerRequests(hub: Hub, updates: QuietUpdate[]): void {
  for (const data of updates) {
    const item = toItem(data);
    if (alreadyHandled(hub, item.key, item.revision) || hub.pending.has(item.key)) continue;
    if (adoptLegacyReceipt(hub, data, item)) continue;
    if (item.bytes > MAX_UPDATE_BYTES || guidanceBatchBytes([data]) > MAX_BATCH_BYTES) {
      reportFailure(hub, "Broker request exceeds notification payload bound", [item.key]);
      continue;
    }
    if (hub.pending.size >= MAX_PENDING) {
      reportFailure(hub, "Notification queue full; broker waiter retained", [item.key]);
      return;
    }
    if (!appendReceipt(hub, item, "queued")) return;
    hub.pending.set(item.key, item);
  }
}
/** Upgrade old request-ID-only receipts without replaying historical deliveries. */
function adoptLegacyReceipt(hub: Hub, data: QuietUpdate, item: Item): boolean {
  const legacy = hub.receipts.get(`notification:${data.guidance!.requestId}`);
  const legacyHandled =
    legacy?.update.child_id === data.child_id && ["delivered", "consumed"].includes(legacy!.state);
  if (!legacyHandled) return false;
  appendReceipt(hub, item, legacy!.state);
  return true;
}

// ---------------------------------------------------------------------------
// Guidance: batching and delivery
// ---------------------------------------------------------------------------

/** Can this item join the next guidance batch? While idle-decision controls are
 * pending, only controls go out. */
function readyForGuidanceBatch(hub: Hub, item: Item, controls: boolean): boolean {
  if (!item.data.requires_guidance || isCompletion(item.data)) return false;
  if (latestReceipt(hub, item.key)?.state === "dispatching") return false;
  return controls ? isControlRequest(item.data) : !hub.wakeAdmission;
}
/** Oldest-first, fair across workers, within the batch item and byte limits. */
function selectBatch(hub: Hub) {
  const out: Item[] = [];
  const controls = controlPending(hub);
  const candidates = [...hub.pending.values()]
    .filter((item) => readyForGuidanceBatch(hub, item, controls))
    .sort((a, b) => a.queuedAt - b.queuedAt);
  for (const item of roundRobin(candidates, (i) => guidanceGroup(i.data), hub.lastGuidanceChild)) {
    if (out.length >= MAX_BATCH_ITEMS) break;
    const next = [...out, item];
    if (guidanceBatchBytes(next.map((i) => i.data)) > MAX_BATCH_BYTES) {
      if (!out.length)
        reportFailure(
          hub,
          "Oversized guidance payload; inspect exact request and dismiss or answer it",
          [item.key],
        );
      continue;
    }
    out.push(item);
  }
  return out;
}
/** Nothing should arm the guidance timer right now. */
function guidanceTimerBlocked(hub: Hub): boolean {
  if (hub.timer || hub.dispatching || hub.compacting || !hub.pi || !hub.ctx || disabled(hub))
    return true;
  // Pending idle-decision controls bypass the UI, pause and admission gates.
  const controls = controlPending(hub);
  if (!controls && (hub.ui || hub.guidanceDisabled || hub.wakeAdmission)) return true;
  return !guidancePending(hub) && !hub.retryAt;
}
/** Controls go out promptly. Other guidance keeps a minimum gap after the last send.
 * Never fire before the failure backoff ends. */
function guidanceWaitMs(hub: Hub, delayMs: number): number {
  const paced = controlPending(hub)
    ? delayMs
    : Math.max(delayMs, MIN_GUIDANCE_INTERVAL_MS - (Date.now() - hub.lastGuidanceAt), 0);
  return Math.max(paced, (hub.retryAt ?? 0) - Date.now());
}
/** The agent is busy or has queued messages; controls ignore busy but not queued messages. */
function busyForGuidance(hub: Hub): boolean {
  return (!hub.ctx!.isIdle() && !controlPending(hub)) || !!hub.ctx!.hasPendingMessages?.();
}
/** After admission, something changed that blocks this batch for now. */
function guidanceSendBlocked(hub: Hub, items: Item[]): boolean {
  const onlyControls = items.every((item) => isControlRequest(item.data));
  return (
    !hub.pi ||
    !hub.ctx ||
    hub.compacting ||
    disabled(hub) ||
    (!onlyControls && (!hub.ctx.isIdle() || hub.ctx.hasPendingMessages?.() || hub.ui))
  );
}

/** One run of the guidance timer: reconcile, select a batch, admit it and send it. */
async function runGuidanceTimer(hub: Hub, delayMs: number) {
  hub.timer = undefined;
  if (!hub.pi || !hub.ctx || (hub.ui && !controlPending(hub)) || hub.compacting || disabled(hub))
    return;
  if (hub.retryAt && Date.now() < hub.retryAt) {
    schedule(hub, Math.max(delayMs, hub.retryAt - Date.now()));
    return;
  }
  if (hub.retryAt) hub.retryAt = 0;
  reconcileGuidance(hub);
  if (busyForGuidance(hub)) {
    schedule(hub, nextPollMs(delayMs));
    return;
  }
  if (!guidancePending(hub)) {
    refreshStatus(hub);
    if (hub.retryAt) schedule(hub, 1000);
    return;
  }
  hub.stats.schedulingAttempts++;
  const items = selectBatch(hub);
  if (!items.length) return;
  if (!(await admitBatch(hub, items))) {
    schedule(hub, nextPollMs(delayMs));
    return;
  }
  if (guidanceSendBlocked(hub, items)) {
    schedule(hub, delayMs);
    return;
  }
  reconcileGuidance(hub);
  const current = items.filter(
    (item) => isStillPending(hub, item) && (!isBrokerGuidance(item.data) || hub.brokerReady),
  );
  if (!current.length) {
    schedule(hub, delayMs);
    return;
  }
  dispatchGuidance(hub, current, delayMs);
}
/** Mark the batch as dispatching, send it, then wait for the logged message as acknowledgement. */
function dispatchGuidance(hub: Hub, items: Item[], delayMs: number): void {
  const updates = items.map((i) => i.data),
    content = GUIDANCE_PREFIX + JSON.stringify(updates);
  if (!markDispatching(hub, items)) {
    schedule(hub, 1000);
    return;
  }
  hub.lastGuidanceAt = Date.now();
  hub.lastGuidanceChild = guidanceGroup(items.at(-1)!.data);
  hub.stats.guidanceBytes += guidanceBatchBytes(updates);
  hub.dispatching = true;
  try {
    // sendMessage is void in Pi: its return is NOT a delivery acknowledgement.
    // Only the actual persisted custom message may acknowledge this intent.
    hub.pi!.sendMessage(
      { customType: MESSAGE_CUSTOM, display: false, content, details: { updates } },
      { deliverAs: hub.ctx!.isIdle() ? "followUp" : "steer", triggerTurn: true },
    );
  } catch (error) {
    handleGuidanceSendError(hub, items, error);
  } finally {
    hub.dispatching = false;
  }
  acknowledgeGuidance(hub);
  if (items.some((item) => latestReceipt(hub, item.key)?.state === "dispatching"))
    startAckTimer(hub, items, delayMs);
  schedule(hub, delayMs);
}
/** Write 'dispatching' receipts for every item. If one fails, requeue the ones already
 * written and return false; nothing has been sent yet. */
function markDispatching(hub: Hub, items: Item[]): boolean {
  const prepared: Item[] = [];
  for (const item of items) {
    if (!appendReceipt(hub, item, "dispatching")) {
      // No send has occurred. These intents can safely return to the queue.
      for (const prior of prepared) requeueUnsent(hub, prior);
      return false;
    }
    prepared.push(item);
  }
  return true;
}
function handleGuidanceSendError(hub: Hub, items: Item[], error: unknown): void {
  acknowledgeGuidance(hub);
  if (!items.some((item) => hub.pending.has(item.key))) return;
  // Only an explicitly documented pre-acceptance rejection is retryable.
  const safe = (error as any)?.deliveryNotAccepted === true;
  if (safe) for (const item of items) requeueUnsent(hub, item);
  reportFailure(
    hub,
    `${safe ? "Transport rejected before acceptance" : "Uncertain guidance dispatch"}: ${String(error)}`,
    items.map((item) => item.key),
    safe,
  );
}
/** If no logged message acknowledges the batch in time, report it as uncertain. */
function startAckTimer(hub: Hub, items: Item[], delayMs: number): void {
  if (hub.ackTimer) clearTimeout(hub.ackTimer);
  hub.ackTimer = setTimeout(() => {
    hub.ackTimer = undefined;
    acknowledgeGuidance(hub);
    const uncertain = items.filter((item) => hub.pending.has(item.key));
    if (uncertain.length)
      reportFailure(
        hub,
        "Uncertain guidance dispatch: no persisted message acknowledgement",
        uncertain.map((item) => item.key),
        false,
      );
    schedule(hub, delayMs);
  }, ACK_TIMEOUT_MS);
  hub.ackTimer.unref?.();
}

// ---------------------------------------------------------------------------
// Completion and watch alert delivery (idle only)
// ---------------------------------------------------------------------------

function completionTimerBlocked(hub: Hub): boolean {
  return (
    !!hub.completionTimer ||
    !!hub.wakeAdmission ||
    hub.ui ||
    hub.compacting ||
    !hub.pi ||
    !hub.ctx ||
    disabled(hub)
  );
}
function scheduleCompletions(hub: Hub, delayMs: number) {
  if (completionTimerBlocked(hub)) return;
  if (![...hub.pending.values()].some((item) => isIdleWake(item.data))) return;
  hub.completionTimer = setTimeout(() => runCompletionTimer(hub, delayMs), delayMs);
  hub.completionTimer.unref?.();
}
/** The agent is not idle, or delivery is otherwise blocked. */
function completionSendBlocked(hub: Hub): boolean {
  return (
    !hub.pi ||
    !hub.ctx ||
    hub.ui ||
    hub.compacting ||
    disabled(hub) ||
    !!hub.ctx.hasPendingMessages?.() ||
    !hub.ctx.isIdle()
  );
}

/** One run of the completion timer: pick the latest wake per worker, admit and send. */
async function runCompletionTimer(hub: Hub, delayMs: number) {
  hub.completionTimer = undefined;
  if (hub.ui || hub.compacting || !hub.pi || !hub.ctx || disabled(hub)) return;
  // Let existing queued messages drain; never abort or interrupt active tools.
  if (hub.ctx.hasPendingMessages?.() || !hub.ctx.isIdle()) {
    scheduleCompletions(hub, nextPollMs(delayMs));
    return;
  }
  const latest = collectLatestWakes(hub);
  const items = fitCompletionBatch(latest);
  if (!items.length) return;
  consumeOlderWakeRevisions(hub, latest);
  const deliver = items.filter((item) => isStillPending(hub, item));
  if (!deliver.length) {
    scheduleCompletions(hub, nextPollMs(delayMs));
    return;
  }
  if (!(await admitBatch(hub, deliver))) {
    schedule(hub, nextPollMs(delayMs));
    return;
  }
  if (completionSendBlocked(hub)) {
    schedule(hub, nextPollMs(delayMs));
    return;
  }
  // Result reads, new worker generations and reload may race the decision.
  const admitted = deliver.filter(
    (item) => isStillPending(hub, item) && !completionSuperseded(hub, item.data),
  );
  if (!admitted.length) {
    schedule(hub, nextPollMs(delayMs));
    return;
  }
  sendCompletions(hub, admitted, delayMs);
}
/** Is `item` the same age or newer than `prior` for the same worker? */
function isSameOrNewerWake(item: Item, prior: Item): boolean {
  // Legacy reports have no sequence; retain their enqueue order. New
  // native reports are monotonic even when reads race scheduler polling.
  return hasSequence(prior.data) && hasSequence(item.data)
    ? prior.data.through_sequence! <= item.data.through_sequence!
    : prior.queuedAt <= item.queuedAt;
}
/** The newest pending wake per worker. Drops superseded completions from the queue. */
function collectLatestWakes(hub: Hub): Map<string, Item> {
  const latest = new Map<string, Item>();
  for (const [key, item] of hub.pending) {
    if (!isIdleWake(item.data)) continue;
    if (completionSuperseded(hub, item.data)) {
      hub.pending.delete(key);
      continue;
    }
    const identity = completionIdentity(item.data);
    // Hold even a later completion for this worker until its invalidation is
    // durable. Other workers remain independently deliverable.
    if (hasActivityRetry(hub, identity)) continue;
    const prior = latest.get(identity);
    if (!prior || isSameOrNewerWake(item, prior)) latest.set(identity, item);
  }
  return latest;
}
/** As many wakes as fit in one message. */
function fitCompletionBatch(latest: Map<string, Item>): Item[] {
  const items: Item[] = [];
  for (const item of latest.values()) {
    const updates = [...items, item].map((i) => i.data);
    if (items.length >= MAX_BATCH_ITEMS || completionBatchBytes(updates) > MAX_BATCH_BYTES) break;
    items.push(item);
  }
  return items;
}
/** Supersede every older queued revision for a child before delivery.
 * Safe idle-only dispatch means no historical completion steers an active
 * long tool run; sent messages cannot be retracted. */
function consumeOlderWakeRevisions(hub: Hub, latest: Map<string, Item>): void {
  for (const [key, item] of hub.pending) {
    if (!isIdleWake(item.data)) continue;
    const current = latest.get(completionIdentity(item.data));
    if (current && current.revision !== item.revision && appendReceipt(hub, item, "consumed"))
      hub.pending.delete(key);
  }
}
function sendCompletions(hub: Hub, items: Item[], delayMs: number): void {
  const updates = items.map((i) => i.data);
  try {
    hub.pi!.sendMessage(
      {
        customType: MESSAGE_CUSTOM,
        display: false,
        content: completionPrefix(updates) + JSON.stringify(updates),
        details: { updates },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  } catch {
    hub.deliveryFailures++;
    scheduleCompletions(hub, nextPollMs(delayMs));
    return;
  }
  hub.deliveryFailures = 0;
  for (const item of items) {
    // Only acknowledge accepted sends. The persisted message also deduplicates
    // recovery if appending the receipt fails after sendMessage succeeds.
    markDelivered(hub, item);
    if (isStillPending(hub, item)) hub.pending.delete(item.key);
  }
  scheduleCompletions(hub, nextPollMs(delayMs));
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/** Main entry point after any change: reconcile, then arm whichever timers have work. */
function schedule(hub: Hub, delayMs: number) {
  if (!hub.dispatching && Date.now() >= (hub.retryAt ?? 0)) reconcileGuidance(hub);
  scheduleActivity(hub, delayMs);
  scheduleCompletions(hub, delayMs);
  refreshStatus(hub);
  if (guidanceTimerBlocked(hub)) return;
  hub.timer = setTimeout(() => runGuidanceTimer(hub, delayMs), guidanceWaitMs(hub, delayMs));
  hub.timer.unref?.();
}

// ---------------------------------------------------------------------------
// The /harness-state command
// ---------------------------------------------------------------------------

/** Retained child findings on this branch. RPC children write a notification entry; native
 * children are only recorded as receipts. Both carry the same update, deduplicated by ID. */
function notificationEntries(ctx: any): QuietUpdate[] {
  const seen = new Set<string>(),
    out: QuietUpdate[] = [];
  for (const entry of branchEntries(ctx)) {
    if (entry?.type !== "custom") continue;
    const update =
      entry.customType === NOTIFICATION_CUSTOM ||
      entry.customType === QUIET_STATE_RECEIPT_CUSTOM_TYPE
        ? entry.data?.update
        : undefined;
    if (
      !validUpdate(update) ||
      update.kind !== "notification" ||
      typeof update.message !== "string" ||
      seen.has(update.id)
    )
      continue;
    seen.add(update.id);
    out.push(update);
  }
  return out;
}

const commandApis: WeakSet<object> = new WeakSet();
function installCommands(pi: any) {
  if (typeof pi.registerCommand !== "function" || commandApis.has(pi)) return;
  commandApis.add(pi);
  pi.registerCommand("harness-state", {
    description:
      "Show quiet harness-state status/notifications or disable/enable quiet model wakeups",
    handler: async (args: string, ctx: any) => {
      const hub = hubFor(ctx);
      restore(hub, ctx);
      if (Date.now() >= (hub.retryAt ?? 0)) reconcileGuidance(hub);
      const parts = (args || "status").trim().split(/\s+/);
      switch (parts[0]) {
        case "show":
          return showNotifications(pi, ctx);
        case "dismiss-guidance":
          return dismissGuidance(hub, ctx, parts);
        case "disable":
        case "off":
          return disableQuietState(pi, hub, ctx);
        case "retry-guidance":
          return retryGuidance(hub, ctx, parts);
        case "enable":
        case "on":
          return enableQuietState(pi, hub, ctx);
        default:
          return showStatus(hub, ctx);
      }
    },
  });
}
/** `show`: post the last 25 retained child notifications into the transcript. */
function showNotifications(pi: any, ctx: any): void {
  const notes = notificationEntries(ctx)
    .slice(-25)
    .map(
      (u, i) =>
        `${i + 1}. ${u.requires_guidance ? "[guidance]" : "[finding]"} ${u.displayName ?? "Subagent"}: ${u.message ?? ""}`,
    );
  const content = notes.length ? notes.join("\n") : "No retained child notifications.";
  pi.sendMessage(
    {
      customType: "harness-state-view",
      display: true,
      content,
      details: { count: notes.length },
    },
    { deliverAs: "nextTurn", triggerTurn: false },
  );
}
/** `dismiss-guidance all|<child_id>`: consume pending guidance without answering it. */
function dismissGuidance(hub: Hub, ctx: any, parts: string[]): void {
  const scope = parts[1];
  const validScope = scope === "all" || (!!scope && CHILD_ID_PATTERN.test(scope));
  if (parts.length !== 2 || !validScope) {
    ctx.ui.notify("Usage: /harness-state dismiss-guidance all|<exact child_id>", "warning");
    return;
  }
  const targets = [...hub.pending.values()].filter(
    (item) => needsGuidance(item.data) && (scope === "all" || item.data.child_id === scope),
  );
  let consumed = 0;
  for (const item of targets) {
    if (appendReceipt(hub, item, "consumed")) {
      hub.pending.delete(item.key);
      consumed++;
    }
  }
  ctx.ui.notify(
    `Dismissed ${consumed} pending guidance request(s)${scope === "all" ? "" : " for " + scope}; retained histories unchanged.`,
    "info",
  );
  refreshStatus(hub);
}
/** `disable` / `off`: stop all quiet wakeups for this session. */
function disableQuietState(pi: any, hub: Hub, ctx: any): void {
  hub.localDisabled = true;
  hub.pending.clear();
  clearTimers(hub);
  pi.appendEntry(CONTROL_CUSTOM, { v: 1, disabled: true, at: Date.now() });
  ctx.ui.notify(
    "harness-state disabled for this session. Re-enable with /harness-state enable. Env kill switch: PAE_QUIET_STATE_DISABLED=1",
    "warning",
  );
  refreshStatus(hub);
}
/** `retry-guidance <key>`: requeue one uncertain dispatch. May send it twice. */
function retryGuidance(hub: Hub, ctx: any, parts: string[]): void {
  const item = hub.pending.get(parts[1]);
  if (parts.length !== 2 || !item || latestReceipt(hub, item.key)?.state !== "dispatching") {
    ctx.ui.notify(
      "Usage: /harness-state retry-guidance <exact uncertain receipt key>; inspect status and message history first (may duplicate a wake).",
      "warning",
    );
    return;
  }
  if (appendReceipt(hub, item, "queued")) {
    clearFailure(hub);
    schedule(hub, 0);
  }
}
/** `enable` / `on`: resume quiet wakeups for this session. */
function enableQuietState(pi: any, hub: Hub, ctx: any): void {
  hub.localDisabled = false;
  hub.guidanceDisabled = false;
  hub.lastGuidanceAt = 0;
  pi.appendEntry(CONTROL_CUSTOM, { v: 1, disabled: false, at: Date.now() });
  ctx.ui.notify(
    "harness-state completion/guidance wakeups enabled for this session. Uncertain dispatches still require explicit recovery.",
    "info",
  );
  refreshStatus(hub);
  schedule(hub, 0);
}
/** Default mode: one status line with state, reason and counters. */
function showStatus(hub: Hub, ctx: any): void {
  ctx.ui.notify(statusLine(hub), "info");
}
function statusName(hub: Hub): string {
  if (disabled(hub)) return "disabled";
  return hub.guidanceDisabled ? "guidance-paused" : "active";
}
function statusReason(hub: Hub): string {
  if (envDisabled()) return "environment kill switch";
  if (hub.localDisabled) return "quiet-state preference/operator disable";
  const pauseReason = hub.guidanceDisabled
    ? "persisted guidance pause"
    : hub.compacting
      ? "compaction"
      : "none";
  return hub.diagnostic?.cause ?? pauseReason;
}
function statusLine(hub: Hub): string {
  const pending = [...hub.pending.values()];
  const uncertain = pending
    .filter((item) => latestReceipt(hub, item.key)?.state === "dispatching")
    .map((item) => ({ key: item.key, identity: item.data.guidance ?? item.data.id }));
  const { stats } = hub;
  const fields = [
    `status=${statusName(hub)}`,
    `reason=${statusReason(hub)}`,
    `diagnostic=${JSON.stringify(hub.diagnostic ?? null)}`,
    `uncertain=${JSON.stringify(uncertain)}`,
    "recovery=inspect-guidance-list/answer-or-dismiss;retry-guidance-exact-key-may-duplicate",
    `pendingBroker=${hub.brokerPending ?? "unavailable"}`,
    `pendingCompletions=${pending.filter((item) => isCompletion(item.data)).length}`,
    `pendingGuidance=${pending.filter((item) => item.data.requires_guidance).length}`,
    `receipts=${hub.receipts.size}`,
    `deliveredUpdates=${stats.guidanceDelivered}`,
    `guidanceBytes=${stats.guidanceBytes}`,
    `schedulingAttempts=${stats.schedulingAttempts}`,
    `routineRecorded=${stats.routineRecorded}`,
    `duplicates=${stats.duplicate}`,
    `dropped=${stats.dropped}`,
    `receiptFailed=${stats.receiptFailed}`,
    `circuitBreaks=${stats.circuitBreaks}`,
    `disabled=${disabled(hub)}`,
    "envKillSwitch=PAE_QUIET_STATE_DISABLED=1",
  ];
  return `harness-state: ${fields.join(" ")}`;
}

// ---------------------------------------------------------------------------
// Enqueue paths (used by installQuietState().enqueue)
// ---------------------------------------------------------------------------

/** Parent control resolution consumes only the exact authenticated child /
 * epoch / request. It is a retained record, never another model wake. */
function recordControlResolution(hub: Hub, data: QuietUpdate, delayMs: number): boolean {
  for (const [key, item] of hub.pending)
    if (
      isControlRequest(item.data) &&
      resolvesControl(item.data, data) &&
      appendReceipt(hub, item, "consumed")
    )
      hub.pending.delete(key);
  revokeConsumedWake(hub);
  const persisted = appendReceipt(
    hub,
    toItem({ ...data, requires_guidance: false, completion: false }),
    "recorded",
  );
  if (persisted) hub.stats.routineRecorded++;
  schedule(hub, delayMs);
  return persisted;
}
/** Activity invalidation must persist even while delivery is disabled, and
 * never move backwards when an older async observation arrives late. */
function recordWorkerActivity(hub: Hub, data: QuietUpdate, delayMs: number): boolean {
  if (data.kind !== "subagent" || !data.job_id || !data.child_id || !hasSequence(data))
    throw new Error("Invalid worker activity identity");
  let item = toItem({
    ...data,
    id: `${data.job_id}:${data.child_id}:activity`,
    completion: false,
    requires_guidance: false,
  });
  const retries = (hub.activityRetries ??= new Map());
  const retry = retries.get(item.key);
  if (retry && retry.data.through_sequence! > item.data.through_sequence!) item = retry;
  if (activityAlreadyRecorded(hub, item.key, item)) {
    retries.delete(item.key);
    return true;
  }
  // Reserve suppression before attempting the durable write, not after.
  retries.set(item.key, item);
  const persisted = appendReceipt(hub, item, "recorded");
  if (persisted) retries.delete(item.key);
  dropSupersededCompletions(hub);
  revokeConsumedWake(hub);
  schedule(hub, delayMs);
  return persisted;
}
function exceedsUpdateBudget(item: Item, data: QuietUpdate): boolean {
  return (
    item.bytes > MAX_UPDATE_BYTES ||
    (isIdleWake(data) && completionBatchBytes([data]) > MAX_BATCH_BYTES)
  );
}
/** Already queued, handled or out of date: accept without queueing again. */
function isDuplicateUpdate(hub: Hub, item: Item, data: QuietUpdate): boolean {
  if (completionSuperseded(hub, data) || alreadyHandled(hub, item.key, item.revision)) return true;
  // A completion with any settled receipt is never queued again, whatever its revision.
  if (isCompletion(data) && hasSettledReceipt(hub, item.key)) return true;
  // Broker guidance is deduplicated by key; everything else by exact revision.
  return data.guidance ? hub.pending.has(item.key) : isStillPending(hub, item);
}
/** A regular update: queue it if it may wake the model, otherwise just record it. */
function enqueueUpdate(hub: Hub, data: QuietUpdate, delayMs: number): boolean {
  if (controlResolved(hub, data)) {
    hub.stats.duplicate++;
    return true;
  }
  if (disabled(hub)) {
    hub.stats.disabled++;
    return false;
  }
  const item = toItem(data);
  if (exceedsUpdateBudget(item, data))
    throw new Error("Quiet state update exceeds its metadata budget");
  if (isDuplicateUpdate(hub, item, data)) {
    hub.stats.duplicate++;
    return true;
  }
  if (hub.pending.size >= MAX_PENDING && !hub.pending.has(item.key)) {
    hub.stats.dropped++;
    reportFailure(hub, "Notification queue full; producer must retain and retry", [item.key]);
    schedule(hub, delayMs);
    return false;
  }
  hub.stats.accepted++;
  if (data.requires_guidance === true || isIdleWake(data)) {
    if (!appendReceipt(hub, item, "queued")) {
      schedule(hub, delayMs);
      return false;
    }
    hub.pending.set(item.key, item);
    schedule(hub, delayMs);
    return true;
  }
  hub.pending.delete(item.key);
  if (!appendReceipt(hub, item, "recorded")) return false;
  hub.stats.routineRecorded++;
  refreshStatus(hub);
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Routine updates are receipts only; explicit guidance, background terminal completion and new watch events may wake the model. */
export function installQuietState(pi: ExtensionAPI, delayMs = 1000) {
  const writer = Symbol("quiet-harness-writer");
  let source: Hub["guidanceSource"];
  installCommands(pi);
  /** This instance's hub for the session, or undefined when another instance owns it. */
  const ownedHub = (ctx: any): Hub | undefined => {
    const hub = hubFor(ctx);
    return hub.writer === writer ? hub : undefined;
  };
  const restoreAndSchedule = (hub: Hub, ctx: any) => {
    restore(hub, ctx);
    schedule(hub, delayMs);
  };
  const endCompaction = async (_event: unknown, ctx: any) => {
    const hub = ownedHub(ctx);
    if (!hub) return;
    hub.compacting = false;
    restoreAndSchedule(hub, ctx);
  };

  pi.on("session_start", async (_event, ctx) => {
    const hub = hubFor(ctx);
    hub.wakeAdmission?.abort();
    hub.wakeAdmission = undefined;
    clearTimers(hub);
    hub.writer = writer;
    hub.pi = pi;
    hub.ctx = ctx;
    hub.guidanceSource = source ?? hub.guidanceSource;
    hub.dispatching = false;
    hub.ui = false;
    hub.compacting = false;
    restoreAndSchedule(hub, ctx);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    const hub = ownedHub(ctx);
    if (!hub) return;
    hub.ctx = ctx;
    restoreAndSchedule(hub, ctx);
  });
  pi.on("session_before_compact", async (_event, ctx) => {
    const hub = ownedHub(ctx);
    if (!hub) return;
    hub.compacting = true;
    clearTimers(hub);
    refreshStatus(hub);
  });
  pi.on("session_compact", endCompaction);
  pi.on("session_compact_failed", endCompaction);
  pi.on("ui_prompt_start", async (_event, ctx) => {
    const hub = ownedHub(ctx);
    if (!hub) return;
    hub.ui = true;
    clearTimers(hub);
    refreshStatus(hub);
  });
  pi.on("ui_prompt_end", async (_event, ctx) => {
    const hub = ownedHub(ctx);
    if (!hub) return;
    hub.ui = false;
    schedule(hub, delayMs);
  });
  pi.on("session_shutdown", async (event, ctx) => {
    const hub = ownedHub(ctx);
    if (!hub) return;
    hub.wakeAdmission?.abort();
    hub.wakeAdmission = undefined;
    clearTimers(hub);
    restore(hub, ctx);
    hub.writer = undefined;
    hub.pi = undefined;
    hub.ctx = undefined;
    if (event.reason !== "reload") hubs().delete(session(ctx));
  });
  pi.on("message_end", async (event: any, ctx) => {
    const hub = ownedHub(ctx);
    const isWakeMessage =
      event.message?.role === "custom" && event.message.customType === MESSAGE_CUSTOM;
    if (!hub || !isWakeMessage) return;
    acknowledgeGuidance(hub);
    if (!hub.dispatching) schedule(hub, delayMs);
  });

  return {
    setGuidanceSource(value: NonNullable<Hub["guidanceSource"]>) {
      source = value;
    },
    reconcile(ctx: ExtensionContext) {
      const hub = hubFor(ctx);
      hub.guidanceSource = source;
      schedule(hub, delayMs);
    },
    enqueue(ctx: ExtensionContext, data: QuietUpdate): boolean {
      const hub = hubFor(ctx);
      hub.pi = pi;
      hub.ctx = ctx;
      if (data.guidance && data.guidance.ownerSessionId !== session(ctx))
        throw new Error("Foreign guidance notification owner");
      if (isControlResolution(data)) return recordControlResolution(hub, data, delayMs);
      if (data.activity === true) return recordWorkerActivity(hub, data, delayMs);
      return enqueueUpdate(hub, data, delayMs);
    },
    consumeCompletion(
      ctx: ExtensionContext,
      jobId: string,
      childId?: string,
      terminalId?: string,
      throughSequence?: number,
    ) {
      const hub = hubFor(ctx);
      if (!childId || !terminalId) return;
      const data: QuietUpdate = {
        kind: "subagent",
        id: `${jobId}:${childId}:terminal:${terminalId}`,
        job_id: jobId,
        child_id: childId,
        completion: true,
        through_sequence: throughSequence,
      };
      const key = keyOf(data),
        existing = hub.pending.get(key);
      const target = toItem({
        ...existing?.data,
        ...data,
        through_sequence: throughSequence ?? existing?.data.through_sequence,
      });
      // Persist even when the direct result read wins the race with polling.
      // Unknown/legacy sequence numbers authorize consuming only this exact ID.
      if (!appendReceipt(hub, target, "consumed")) return;
      for (const [pendingKey, item] of hub.pending)
        if (pendingKey === key || completionSuperseded(hub, item.data))
          hub.pending.delete(pendingKey);
      revokeConsumedWake(hub);
      refreshStatus(hub);
    },
    consume(ctx: ExtensionContext, kind: QuietUpdate["kind"], id: string, through?: number) {
      const hub = hubFor(ctx);
      const key = `${kind}:${id}`;
      // Job callers consume only terminal reads/reap, never running status.
      // Persist a tombstone even before enqueue: an async notified check can lose
      // this race, and must not cause a delayed wake after the tool returned.
      const item =
        hub.pending.get(key) ??
        (kind === "job" && !hub.receipts.has(key)
          ? toItem({ kind, id, completion: true })
          : undefined);
      const coveredByThrough =
        through === undefined || (item?.data.through_sequence ?? 0) <= through;
      if (item && coveredByThrough && appendReceipt(hub, item, "consumed")) hub.pending.delete(key);
      revokeConsumedWake(hub);
      refreshStatus(hub);
    },
  };
}

// ---------------------------------------------------------------------------
// notifyParent: a child reports a finding or asks for guidance
// ---------------------------------------------------------------------------

const RECEIPT_NOT_PERSISTED =
  "Parent notification receipt could not be persisted; preserve the finding for your final report";

/** Only `message` (short, printable) and an optional boolean `requires_guidance`. */
function validNotificationParams(params: any): boolean {
  if (!params) return false;
  if (Object.keys(params).some((key) => !["message", "requires_guidance"].includes(key)))
    return false;
  const message = params.message;
  if (
    typeof message !== "string" ||
    !message.trim() ||
    message.length > 1000 ||
    Buffer.byteLength(message) > 2000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(message)
  )
    return false;
  return params.requires_guidance === undefined || typeof params.requires_guidance === "boolean";
}
/** Stable ID per child tool call, so a retried call is deduplicated. */
function notificationId(childId: string, toolCallId: string): string {
  return createHash("sha256")
    .update(childId + "\0" + toolCallId)
    .digest("hex")
    .slice(0, 24);
}
function recentNotificationCount(entries: any[], childId: string): number {
  return entries.filter(
    (e: any) => e.data?.update?.child_id === childId && e.data.at > Date.now() - 60000,
  ).length;
}
/** Persist a new notification and its receipt; guidance requests are also queued. */
function retainNotification(hub: Hub, data: QuietUpdate, childId: string, entries: any[]): void {
  if (hub.pending.size >= MAX_PENDING)
    throw new Error("Parent notification queue is full; retain the finding and retry later");
  if (recentNotificationCount(entries, childId) >= 5)
    throw new Error("Notification rate limit: at most five per minute per child; batch findings");
  hub.pi!.appendEntry(NOTIFICATION_CUSTOM, { at: Date.now(), update: data });
  const item = toItem(data);
  if (data.requires_guidance === true) {
    if (!appendReceipt(hub, item, "queued")) throw new Error(RECEIPT_NOT_PERSISTED);
    hub.pending.set(item.key, item);
  } else if (!appendReceipt(hub, item, "recorded")) throw new Error(RECEIPT_NOT_PERSISTED);
}

/** Identity is supplied by the owning RPC launch, never by child parameters. */
export function notifyParent(
  ownerSessionId: string,
  childId: string,
  toolCallId: string,
  params: any,
) {
  if (!validNotificationParams(params))
    throw new Error(
      "Invalid parent notification: concise message (1000 characters/2000 bytes) and optional requires_guidance boolean only",
    );
  if (!CHILD_ID_PATTERN.test(childId) || !toolCallId || toolCallId.length > 256)
    throw new Error("Invalid notification identity");
  const hub = hubs().get(ownerSessionId);
  if (!hub?.pi || !hub.ctx || session(hub.ctx) !== ownerSessionId || disabled(hub))
    throw new Error(
      "Parent notification service is unavailable; preserve the finding for your final report",
    );
  const id = notificationId(childId, toolCallId);
  const data: QuietUpdate = {
    kind: "notification",
    id,
    child_id: childId,
    message: params.message.trim(),
    requires_guidance: params.requires_guidance === true,
  };
  const entries = (hub.ctx.sessionManager.getBranch?.() ?? []).filter(
    (e: any) => e.type === "custom" && e.customType === NOTIFICATION_CUSTOM,
  );
  const previous = entries.find((e: any) => e.data?.update?.id === id);
  if (
    previous?.type === "custom" &&
    revision((previous.data as { update: QuietUpdate }).update) !== revision(data)
  )
    throw new Error("Notification ID was reused with different contents");
  if (!previous) retainNotification(hub, data, childId, entries);
  schedule(hub, 1000);
  return {
    content: [{ type: "text", text: "Queued for the parent; no reply yet." }],
    details: { notification_id: id, accepted: true, requires_guidance: data.requires_guidance },
  };
}
