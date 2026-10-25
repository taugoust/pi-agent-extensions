import assert from "node:assert/strict";
import { test } from "node:test";
import type { TuiWorkerManifest, TuiWorkerResponse } from "../shared/tui-worker-protocol.ts";
import { validateLiveEvents, validateLiveStatus } from "./live-conversation.ts";

const manifest = {
  protocol: 1, ownerSessionId: "owner", taskId: "task-1", runtimeId: "runtime-1", groupId: `subagent-job-${"a".repeat(24)}`,
  childId: `subagent-child-${"b".repeat(24)}`, attempt: 2, workerEpoch: "c".repeat(32), controlToken: "d".repeat(64),
  controlSocket: "/private/worker.sock", sessionFile: "/private/session.jsonl", presentation: "background",
  placement: { socketPath: "/tmp/tmux", serverEpoch: "1:2", sessionId: "$1", windowId: "@1", paneId: "%1", ownershipNonce: "e".repeat(64) },
} as TuiWorkerManifest;
const identity = { ownerSessionId: manifest.ownerSessionId, taskId: manifest.taskId, runtimeId: manifest.runtimeId,
  groupId: manifest.groupId, childId: manifest.childId, attempt: manifest.attempt, workerEpoch: manifest.workerEpoch, sessionFile: manifest.sessionFile };
const statusReply = (data = {}, response: Record<string, unknown> = {}) => ({ protocol: 1, requestId: "status", workerEpoch: manifest.workerEpoch,
  ok: true, receipt: "applied", sequence: 4, data: { ...identity, sequence: 4, active: true, phase: "running", liveText: "partial delta", ...data }, ...response }) as unknown as TuiWorkerResponse;
const start = { protocol: 1, workerEpoch: manifest.workerEpoch, sequence: 3, timestamp: new Date().toISOString(), kind: "conversation_tool_start",
  data: { toolCallId: "call-1", name: "read", arguments: { path: "README.md" } } };
const end = { protocol: 1, workerEpoch: manifest.workerEpoch, sequence: 4, timestamp: new Date().toISOString(), kind: "conversation_tool_end",
  data: { toolCallId: "call-1", name: "read", result: { text: "done" }, status: "completed" } };
const eventReply = (events: unknown[] = [start, end], data = {}, response: Record<string, unknown> = {}) => ({ protocol: 1, requestId: "events",
  workerEpoch: manifest.workerEpoch, ok: true, receipt: "applied", sequence: 4,
  data: { oldestSequence: 1, nextSequence: events.at(-1) ? (events.at(-1) as any).sequence : 2, events, ...data }, ...response }) as unknown as TuiWorkerResponse;

test("live status validates exact worker owner/session/task/attempt/runtime/epoch and bounded delta", () => {
  assert.equal(validateLiveStatus(statusReply(), manifest)?.liveText, "partial delta");
  for (const [key, value] of [["ownerSessionId", "other"], ["taskId", "other"], ["runtimeId", "other"], ["groupId", "other"],
    ["childId", "other"], ["attempt", 99], ["workerEpoch", "f".repeat(32)], ["sessionFile", "/other/session.jsonl"]] as const) {
    assert.throws(() => validateLiveStatus(statusReply({ [key]: value }), manifest), /identity/i, key);
  }
  assert.throws(() => validateLiveStatus(statusReply({ liveText: "x".repeat(16 * 1024 + 1) }), manifest), /Malformed/);
  assert.throws(() => validateLiveStatus(statusReply({ interactions: [{ detail: "x".repeat(100 * 1024) }] }), manifest), /envelope/);
  assert.throws(() => validateLiveStatus(statusReply({ sequence: 3 }), manifest), /Malformed/);
  const legacy = statusReply();
  for (const key of Object.keys(identity)) delete (legacy.data as any)[key];
  assert.equal(validateLiveStatus(legacy, manifest), undefined, "old loaded worker without identity echo falls back to retained history");
  const partial = statusReply(); delete (partial.data as any).taskId;
  assert.throws(() => validateLiveStatus(partial, manifest), /Incomplete/);
});

test("live event page validates epoch, monotonic sequence, cursor and byte bound", () => {
  const events = validateLiveEvents(eventReply(), manifest, 2);
  assert.deepEqual(events.map(event => event.sequence), [3, 4]);
  assert.throws(() => validateLiveEvents(eventReply([start, { ...end, sequence: 3 }]), manifest, 2), /ordering/);
  assert.throws(() => validateLiveEvents(eventReply([start, { ...end, workerEpoch: "f".repeat(32) }]), manifest, 2), /identity/);
  assert.throws(() => validateLiveEvents(eventReply([start], { nextSequence: 2 }), manifest, 2), /cursor/);
  assert.deepEqual(validateLiveEvents(eventReply([start], { oldestSequence: 3 }), manifest, 2), [start], "oldest=cursor+1 is a complete page boundary");
  assert.throws(() => validateLiveEvents(eventReply([end], { oldestSequence: 4 }), manifest, 2), /history gap/, "missing ring events cannot claim complete tool state");
  assert.throws(() => validateLiveEvents(eventReply([start], {}, { workerEpoch: "f".repeat(32) }), manifest, 2), /envelope/);
  assert.throws(() => validateLiveEvents(eventReply([start], { events: [{ ...start, data: { toolCallId: "call-1", name: "x", arguments: "x".repeat(5000) } }] }), manifest, 2), /arguments/);
  for (const toolCallId of ["bad/id", "bad\nname", "x".repeat(129)]) {
    const invalid = { ...start, data: { ...start.data, toolCallId } };
    assert.throws(() => validateLiveEvents(eventReply([invalid]), manifest, 2), /tool event/);
  }
  const codex = { ...start, data: { ...start.data, toolCallId: "call_123|fc_456" } };
  assert.equal(validateLiveEvents(eventReply([codex]), manifest, 2)[0].data.toolCallId, "call_123|fc_456");
  const huge = { ...start, kind: "other", data: "x".repeat(100 * 1024) };
  assert.throws(() => validateLiveEvents(eventReply([huge]), manifest, 2), /byte bound|Malformed/);
});

test("live tool completion supersedes its running event using event order", () => {
  const events = validateLiveEvents(eventReply(), manifest, 2);
  const tools = new Map<string, string>();
  for (const event of events) if (event.kind === "conversation_tool_start") tools.set(event.data.toolCallId, "running");
  assert.equal(tools.get("call-1"), "running");
  for (const event of events) if (event.kind === "conversation_tool_end") tools.set(event.data.toolCallId, event.data.status);
  assert.equal(tools.get("call-1"), "completed");
});
