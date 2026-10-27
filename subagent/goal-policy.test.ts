import assert from "node:assert/strict";
import { test } from "node:test";
import { dedicatedGoalPolicy, sameGoalLimits } from "./goal-policy.ts";

test("dedicated policy transports only explicitly confirmed validated limits", () => {
  const input = { continuationLimits: { automaticTurns: 7, noProgressTurns: 5 } };
  const policy = dedicatedGoalPolicy(input);
  assert.deepEqual(policy, input);
  input.continuationLimits.automaticTurns = 999;
  assert.equal(policy.continuationLimits.automaticTurns, 7);
  assert(sameGoalLimits(policy.continuationLimits, { automaticTurns: 7, noProgressTurns: 5 }));
  assert(!sameGoalLimits(policy.continuationLimits, { automaticTurns: 3, noProgressTurns: 2 }));
  assert.deepEqual(dedicatedGoalPolicy({ continuationLimits: { automaticTurns: null, noProgressTurns: null } }).continuationLimits, { automaticTurns: null, noProgressTurns: null });
  for (const bad of [undefined, {}, { continuationLimits: {} }, { continuationLimits: { automaticTurns: 0, noProgressTurns: 2 } },
    { continuationLimits: { automaticTurns: 7.5, noProgressTurns: 2 } },
    { continuationLimits: { automaticTurns: 7, noProgressTurns: 5, tools: ["bash"] } },
    { ...policy, provider: "not-authorized" }, { ...policy, rpc: { enabled: true } }]) {
    assert.throws(() => dedicatedGoalPolicy(bad), /confirmed|continuation limits/);
  }
});
