import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTuiWorkerJobParams } from "../shared/tui-worker-protocol.ts";

test("child-local job control cannot start shells or override ownership scope", () => {
  const job_id = `job-${"a".repeat(24)}`, watch_id = `watch-${"b".repeat(24)}`;
  for (const params of [{ action: "list", limit: 50 }, { action: "output", job_id, lines: 2000 }, { action: "wait", job_id, timeout_ms: 30000 },
    { action: "cancel", job_id }, { action: "reap", job_id }, { action: "watches" }, { action: "events", watch_id }, { action: "ack", watch_id, through_sequence: 10 }, { action: "unwatch", watch_id }]) assert.deepEqual(parseTuiWorkerJobParams(params), params);
  for (const params of [{ action: "start", command: "false" }, { action: "adopt", pane_id: "%1" }, { action: "signal", job_id, signal: "SIGTERM" },
    { action: "list", sessionId: "foreign" }, { action: "list", childId: "foreign" }, { action: "list", cwd: "/" }, { action: "list", limit: 51 },
    { action: "wait", job_id, timeout_ms: 30001 }, { action: "output", job_id: "../foreign" }, { action: "ack", watch_id }]) assert.throws(() => parseTuiWorkerJobParams(params));
});
