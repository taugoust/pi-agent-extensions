import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeTuiWorkerRequest, parseTuiWorkerPlacement, parseTuiWorkerRequest,
  publicTuiWorkerManifest, TUI_WORKER_MAX_FRAME_BYTES,
} from "../shared/tui-worker-protocol.ts";
import type { TuiWorkerManifest } from "../shared/tui-worker-protocol.ts";

const identity = {
  protocol: 1, requestId: "request-1", token: "a".repeat(64),
  ownerSessionId: "parent-session", taskId: "task-1", runtimeId: "runtime-1",
  groupId: `subagent-job-${"b".repeat(24)}`, childId: `subagent-child-${"c".repeat(24)}`,
  attempt: 1, workerEpoch: "d".repeat(32),
};
const placement = {
  socketPath: "/tmp/tmux-1000/default", serverEpoch: "server-1",
  sessionId: "$1", windowId: "@2", paneId: "%3", ownershipNonce: "e".repeat(64),
};

test("bounded commands preserve model text as data, including slash-looking instructions", () => {
  const request = { ...identity, operation: "prompt", mode: "steer", message: "/permission-gate off" };
  assert.deepEqual(decodeTuiWorkerRequest(Buffer.from(JSON.stringify(request))), request);
  // Protocol deliberately has no operator mode operation or command-dispatch flag.
  assert.throws(() => parseTuiWorkerRequest({ ...identity, operation: "set_gate_mode", mode: "off" }));
  assert.throws(() => parseTuiWorkerRequest({ ...request, expandPromptTemplates: true }));
});

test("rejects malformed, unknown, oversized and non-UTF8 requests", () => {
  const request = { ...identity, operation: "status" };
  for (const mutation of [
    { protocol: 2 }, { attempt: 0 }, { attempt: 1.5 }, { token: "short" },
    { childId: "../foreign" }, { workerEpoch: "" }, { requestId: "\n" },
  ]) assert.throws(() => parseTuiWorkerRequest({ ...request, ...mutation }));
  assert.throws(() => parseTuiWorkerRequest({ ...request, arbitrary: true }));
  const { token: _token, ...missing } = request;
  assert.throws(() => parseTuiWorkerRequest(missing));
  assert.throws(() => decodeTuiWorkerRequest(Buffer.alloc(TUI_WORKER_MAX_FRAME_BYTES + 1)));
  assert.throws(() => decodeTuiWorkerRequest(Buffer.from([0xff])));
  assert.throws(() => parseTuiWorkerRequest({ ...identity, operation: "events", afterSequence: -1 }));
  assert.throws(() => parseTuiWorkerRequest({ ...identity, operation: "prompt", mode: "steer", message: "é".repeat(32769) }));
  assert.throws(() => parseTuiWorkerRequest({ ...identity, operation: "prompt", mode: "steer", message: "  " }));
});

test("placement requires exact server/session/window/pane identities", () => {
  assert.deepEqual(parseTuiWorkerPlacement(placement), placement);
  for (const mutation of [
    { socketPath: "relative" }, { sessionId: "session-name" }, { windowId: "2" },
    { paneId: "3" }, { ownershipNonce: "" }, { serverEpoch: "" },
  ]) assert.throws(() => parseTuiWorkerPlacement({ ...placement, ...mutation }));
  assert.deepEqual(parseTuiWorkerRequest({ ...identity, operation: "promote", placement }),
    { ...identity, operation: "promote", placement });
});

test("cancel and idle-reap reservation are distinct operations", () => {
  assert.equal(parseTuiWorkerRequest({ ...identity, operation: "cancel" }).operation, "cancel");
  assert.equal(parseTuiWorkerRequest({ ...identity, operation: "prepare_reap" }).operation, "prepare_reap");
  assert.throws(() => parseTuiWorkerRequest({ ...identity, operation: "prepare_reap", force: true }));
});

test("public discovery strips control capability and clones nested placement", () => {
  const { token, requestId: _requestId, ...ids } = identity;
  const manifest: TuiWorkerManifest = {
    ...ids, protocol: 1, controlToken: token, controlSocket: "/tmp/worker/control.sock",
    sessionFile: "/tmp/worker/session.jsonl", placement, presentation: "background",
  };
  const exposed = publicTuiWorkerManifest(manifest);
  assert.equal(Object.hasOwn(exposed, "controlToken"), false);
  assert.equal(JSON.stringify(exposed).includes(token), false);
  exposed.placement.paneId = "%99";
  assert.equal(manifest.placement.paneId, "%3");
});
