import type { TuiWorkerManifest, TuiWorkerResponse } from "../shared/tui-worker-protocol.ts";

type Pinned = Pick<TuiWorkerManifest, "ownerSessionId" | "taskId" | "runtimeId" | "groupId" | "childId" | "attempt" | "workerEpoch" | "sessionFile">;
const identityKeys = ["ownerSessionId", "taskId", "runtimeId", "groupId", "childId", "attempt", "workerEpoch", "sessionFile"] as const;
const MAX_EVENT_BYTES = 96 * 1024;
const MAX_STATUS_BYTES = 96 * 1024;
const MAX_LIVE_TEXT_BYTES = 16 * 1024;

function object(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function safeSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
function matchesIdentity(data: Record<string, any>, manifest: Pinned): "legacy" | "valid" {
  const present = identityKeys.filter(key => Object.hasOwn(data, key));
  if (present.length === 0) return "legacy";
  if (present.length !== identityKeys.length) throw new Error("Incomplete live worker identity");
  if (identityKeys.some(key => data[key] !== manifest[key])) throw new Error("Live worker identity changed");
  return "valid";
}

/** Validate the authenticated status payload against the exact immutable launch manifest. */
export function validateLiveStatus(response: TuiWorkerResponse, manifest: Pinned): Record<string, any> | undefined {
  if (!response.ok || response.workerEpoch !== manifest.workerEpoch || !object(response.data)
    || Buffer.byteLength(JSON.stringify(response)) > MAX_STATUS_BYTES) throw new Error("Invalid live status envelope");
  const data = response.data;
  if (matchesIdentity(data, manifest) === "legacy") return undefined; // Old loaded worker: retained transcript only.
  if (!safeSequence(response.sequence) || !safeSequence(data.sequence) || data.sequence !== response.sequence
    || typeof data.active !== "boolean" || !["ready", "running", "settled", "closing"].includes(data.phase)
    || typeof data.sessionFile !== "string" || data.sessionFile !== manifest.sessionFile
    || typeof data.liveText !== "string" || Buffer.byteLength(data.liveText) > MAX_LIVE_TEXT_BYTES) {
    throw new Error("Malformed live status payload");
  }
  return data;
}

/** Validate bounded event pagination and each event's epoch/sequence before projecting tool state. */
export function validateLiveEvents(response: TuiWorkerResponse, manifest: Pinned, afterSequence: number): any[] {
  if (!safeSequence(afterSequence) || !response.ok || response.workerEpoch !== manifest.workerEpoch
    || !safeSequence(response.sequence) || !object(response.data)) throw new Error("Invalid live event envelope");
  const data = response.data;
  if (!safeSequence(data.oldestSequence) || !safeSequence(data.nextSequence) || !Array.isArray(data.events)
    || data.events.length > 256 || Buffer.byteLength(JSON.stringify(data)) > MAX_EVENT_BYTES
    || data.nextSequence < afterSequence || data.nextSequence > response.sequence
    || data.oldestSequence > response.sequence) throw new Error("Malformed live event page");
  if (data.oldestSequence > afterSequence + 1) throw new Error("Live event history gap; partial tool state is not authoritative");
  let previous = afterSequence;
  for (const event of data.events) {
    if (!object(event) || event.protocol !== 1 || event.workerEpoch !== manifest.workerEpoch
      || !safeSequence(event.sequence) || event.sequence <= previous || event.sequence > response.sequence
      || typeof event.timestamp !== "string" || event.timestamp.length > 64 || !Number.isFinite(Date.parse(event.timestamp))
      || typeof event.kind !== "string" || event.kind.length > 64) throw new Error("Invalid live event identity or ordering");
    previous = event.sequence;
    if (event.kind === "conversation_tool_start" || event.kind === "conversation_tool_end") {
      const value = event.data;
      if (!object(value) || typeof value.toolCallId !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(value.toolCallId)
        || typeof value.name !== "string" || !value.name || Buffer.byteLength(value.name) > 128) throw new Error("Invalid conversation tool event");
      if (event.kind === "conversation_tool_start" && (!Object.hasOwn(value, "arguments") || Buffer.byteLength(JSON.stringify(value.arguments)) > 4096))
        throw new Error("Invalid conversation tool arguments");
      if (event.kind === "conversation_tool_end" && (!Object.hasOwn(value, "result") || Buffer.byteLength(JSON.stringify(value.result)) > 4096
        || !["completed", "failed"].includes(value.status))) throw new Error("Invalid conversation tool result");
    }
  }
  if (data.events.length && data.nextSequence !== previous) throw new Error("Live event cursor mismatch");
  return data.events;
}
