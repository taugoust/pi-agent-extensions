import { test } from "node:test";
import assert from "node:assert/strict";
import { waitForGroupSnapshot, type WaitGroup } from "./group-wait.ts";
const group = (id: string, statuses: string[]): WaitGroup => ({ job_id: id, status: statuses.includes("running") ? "running" : "completed", children: statuses.map((status, i) => ({ child: i + 1, status })) });
test("mixed wait_any observes a newly finished legacy child, ignoring previously finished native siblings", async () => {
  let reads = 0;
  const result = await waitForGroupSnapshot(async () => {
    reads++;
    return [group("tui", ["completed", "running"]), group("legacy", [reads < 2 ? "running" : "completed"])];
  }, "wait_any", 1000);
  assert.equal(reads, 2); assert.equal(result.terminal?.group?.job_id, "legacy"); assert.equal(result.timed_out, false);
});
test("mixed wait_all waits both snapshot backends and excludes newly started groups", async () => {
  let reads = 0;
  const result = await waitForGroupSnapshot(async () => {
    reads++;
    return [group("tui", [reads < 2 ? "running" : "completed"]), group("legacy", [reads < 3 ? "running" : "completed"]), ...(reads > 1 ? [group("later", ["running"])] : [])];
  }, "wait_all", 1000);
  assert.equal(reads, 3); assert.equal(result.groups.length, 2); assert.equal(result.timed_out, false);
});
test("wait timeout, empty snapshot and cancellation are observation-only", async () => {
  assert.equal((await waitForGroupSnapshot(async () => [group("live", ["running"])], "wait_any", 0)).timed_out, true);
  assert.equal((await waitForGroupSnapshot(async () => [], "wait_any", 0)).timed_out, false);
  const controller = new AbortController();
  const promise = waitForGroupSnapshot(async () => [group("live", ["running"])], "wait_all", 1000, controller.signal);
  setTimeout(() => controller.abort(new Error("observation cancelled")), 10);
  await assert.rejects(promise, /observation cancelled/);
});
