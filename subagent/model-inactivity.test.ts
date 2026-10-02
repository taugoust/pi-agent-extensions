import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelInactivityWatch } from "./model-inactivity.ts";

test("model inactivity timer resets on stream progress, warns once, and stops at turn end", async () => {
  const warnings: number[] = [];
  const watch = new ModelInactivityWatch(() => warnings.push(Date.now()), 15);
  watch.start();
  await new Promise(resolve => setTimeout(resolve, 8));
  watch.progress();
  await new Promise(resolve => setTimeout(resolve, 9));
  assert.equal(warnings.length, 0);
  await new Promise(resolve => setTimeout(resolve, 12));
  assert.equal(warnings.length, 1);
  watch.progress();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(warnings.length, 2, "progress starts a fresh inactivity window");
  watch.end();
  watch.start();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(warnings.length, 3, "a new turn gets a fresh warning window");
  watch.shutdown();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(warnings.length, 3, "shutdown clears the pending timer");
});

test("persistent warning status clears on progress, new turn, end, and shutdown", () => {
  const statuses: string[] = [];
  const watch = new ModelInactivityWatch(() => {}, 1000, setTimeout, clearTimeout, () => statuses.push("clear"));
  watch.start();
  watch.progress();
  watch.end();
  watch.start();
  watch.shutdown();
  assert.equal(statuses.length, 5);
});

test("turn end and shutdown clear pending inactivity timers", async () => {
  let warnings = 0;
  const watch = new ModelInactivityWatch(() => warnings++, 15);
  watch.start();
  watch.end();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(warnings, 0);
  watch.start();
  watch.shutdown();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(warnings, 0);
});
