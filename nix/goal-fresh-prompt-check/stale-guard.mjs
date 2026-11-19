// Usage: node stale-guard.mjs TEST_SCRIPT BUILD_ROOT
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const file = "goal-test-source/workflows/goal/lifecycle.ts";
const source = readFileSync(file, "utf8");
const marker = "    // Unlike a busy steer, this hook admits a fresh user-prompt run.";
assert.equal(source.split(marker).length, 2, "Mutant target must be unique");
const start = source.indexOf(marker);
const end = source.indexOf("    if (!ownedPromptGoalId && !ownedPromptBoundary)", start);
assert.ok(end > start);
writeFileSync(file, source.slice(0, start) + source.slice(end));
const result = spawnSync(
  process.execPath,
  [process.argv[2], process.argv[3] + "/goal-test-source", process.argv[3]],
  { encoding: "utf8", timeout: 30000 },
);
assert.equal(result.error, undefined);
assert.equal(result.signal, null);
assert.equal(result.status, 1);
assert.match(result.stderr, /Fresh unowned idle human tool must not be aborted/);
assert.match(result.stderr, /Operation aborted/);
console.log("KILLED: original Goal stale-tool guard rejects fresh idle input");
