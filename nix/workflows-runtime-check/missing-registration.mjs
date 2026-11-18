// Usage: node missing-registration.mjs PROBE PI EXTENSION
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.execPath,
  [...process.argv.slice(2), "--expect", "deliberately-unregistered-command"],
  { encoding: "utf8", timeout: 30000 },
);
assert.equal(result.error, undefined);
assert.equal(result.signal, null);
assert.equal(result.status, 1);
assert.match(result.stderr, /Missing registered command deliberately-unregistered-command/);
console.log("PASS missing-registration negative control");
