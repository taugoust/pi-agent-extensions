import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ForgeEvents = ExtensionAPI["events"];
const CHANNEL = "pi-agent-extensions:forge-goal:request:v1";
export const FORGE_GOAL_READY_EVENT = "pi-agent-extensions:forge-goal:ready:v1";
export const FORGE_GOAL_WAKE_MESSAGE_TYPE = "forge-goal-wake";
export const FORGE_GOAL_GUARD_ENTRY = "forge-goal-completion-guard";

/**
 * Bridge scope is the shared pi.events bus, never an extension-specific API proxy.
 * Checks cover active goal_complete and explicitly authorized paused goal_manage
 * complete. Stable required keys persist as Goal session entries across resume and
 * runtime reload; no callback is retained across reload, so missing registration
 * denies completion. For saved child Goals the authenticated parent observes the
 * exact child marker and denies parent-side goals.complete; resume the child to
 * restore a fresh checker. Standalone saved records have no current-session Goal
 * activation and are outside this bridge.
 */
export interface ForgeGoalIdentity { goalId: string; activationId: string }
export interface ForgeGoalSnapshot extends ForgeGoalIdentity {
  status: "active" | "paused" | "blocked" | "usage_limited" | "budget_limited" | "complete";
  waiting: boolean;
  waitReason?: string;
}
export interface ForgeGoalBinding {
  ready(): boolean;
  snapshot(): ForgeGoalSnapshot | undefined;
  subscribe(identity: ForgeGoalIdentity): string | undefined;
  wake(identity: ForgeGoalIdentity, subscriptionId: string, message: string, batchToken?: string): boolean;
  hasDelivered(identity: ForgeGoalIdentity, batchToken: string): boolean | undefined;
  consume(identity: ForgeGoalIdentity, subscriptionId: string): boolean;
  unsubscribe(subscriptionId: string): void;
  registerGuard(identity: ForgeGoalIdentity, key: string, check: (identity: ForgeGoalIdentity, signal?: AbortSignal) => Promise<string | undefined>): () => void;
  checkGuards(identity: ForgeGoalIdentity, signal?: AbortSignal): Promise<string | undefined>;
}

interface Request { op: string; [key: string]: unknown; reply?: unknown }
function request<T>(events: ForgeEvents, payload: Request): T | undefined {
  try {
    events.emit(CHANNEL, payload);
    return payload.reply as T | undefined;
  } catch { return undefined; }
}

/** Goal extension's in-process bus listener. Dispose on session shutdown and rebind on start. */
export function bindForgeGoal(events: ForgeEvents, binding: ForgeGoalBinding): () => void {
  return events.on(CHANNEL, raw => {
    const r = raw as Request;
    if (!r || typeof r !== "object") return;
    switch (r.op) {
      case "ready": r.reply = binding.ready(); break;
      case "snapshot": r.reply = binding.ready() ? binding.snapshot() : undefined; break;
      case "subscribe": r.reply = binding.subscribe(r.identity as ForgeGoalIdentity); break;
      case "wake": r.reply = binding.wake(r.identity as ForgeGoalIdentity, String(r.subscriptionId), String(r.message), r.batchToken as string | undefined); break;
      case "receipt": r.reply = binding.hasDelivered(r.identity as ForgeGoalIdentity, String(r.batchToken)); break;
      case "consume": r.reply = binding.consume(r.identity as ForgeGoalIdentity, String(r.subscriptionId)); break;
      case "unsubscribe": r.reply = binding.unsubscribe(String(r.subscriptionId)); break;
      case "guard-register": r.reply = binding.registerGuard(r.identity as ForgeGoalIdentity, String(r.key), r.check as (identity: ForgeGoalIdentity, signal?: AbortSignal) => Promise<string | undefined>); break;
      case "guard-check": r.reply = binding.checkGuards(r.identity as ForgeGoalIdentity, r.signal as AbortSignal | undefined); break;
    }
  });
}

export function isForgeGoalReady(events: ForgeEvents): boolean {
  return request<boolean>(events, { op: "ready" }) ?? false;
}
export function getCurrentForgeGoal(events: ForgeEvents): ForgeGoalSnapshot | undefined {
  return request(events, { op: "snapshot" });
}
export function subscribeForgeGoalWake(events: ForgeEvents, identity: ForgeGoalIdentity): { subscriptionId: string; unsubscribe(): void } | undefined {
  const subscriptionId = request<string>(events, { op: "subscribe", identity });
  return subscriptionId ? { subscriptionId, unsubscribe: () => request(events, { op: "unsubscribe", subscriptionId }) } : undefined;
}
export function wakeForgeGoal(events: ForgeEvents, identity: ForgeGoalIdentity, subscriptionId: string, message: string, batchToken?: string): boolean {
  return request<boolean>(events, { op: "wake", identity, subscriptionId, message, batchToken }) ?? false;
}
export function hasDeliveredForgeGoalWake(events: ForgeEvents, identity: ForgeGoalIdentity, batchToken: string): boolean | undefined {
  if (request<boolean>(events, { op: "ready" }) !== true) return undefined;
  if (!/^[a-f0-9]{64}$/.test(batchToken)) return false;
  return request<boolean | undefined>(events, { op: "receipt", identity, batchToken });
}
export function consumeForgeGoalWake(events: ForgeEvents, identity: ForgeGoalIdentity, subscriptionId: string): boolean {
  return request<boolean>(events, { op: "consume", identity, subscriptionId }) ?? false;
}
export function registerForgeGoalCompletionGuard(
  events: ForgeEvents,
  identity: ForgeGoalIdentity,
  key: string,
  guard: (identity: ForgeGoalIdentity, signal?: AbortSignal) => Promise<string | undefined>,
): () => void {
  const unsubscribe = request<() => void>(events, { op: "guard-register", identity, key, check: guard });
  if (!unsubscribe) throw new Error("Goal completion guard registration failed closed");
  return unsubscribe;
}
export function checkForgeGoalCompletionGuards(events: ForgeEvents, identity: ForgeGoalIdentity, signal?: AbortSignal): Promise<string | undefined> {
  const check = request<Promise<string | undefined>>(events, { op: "guard-check", identity, signal });
  return check ?? Promise.resolve("Goal completion guard service is unavailable; completion was denied");
}

export function identityMatches(a: ForgeGoalIdentity, b: ForgeGoalIdentity): boolean {
  return !!a && a.goalId === b.goalId && a.activationId === b.activationId;
}
