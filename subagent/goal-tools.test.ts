import assert from "node:assert/strict";
import { test } from "node:test";
import { dedicatedGoalTools, DEDICATED_GOAL_TOOLS } from "./goal-tools.ts";
import { createDelegatedGoalExecutor } from "./goal-executor.ts";

test("dedicated bootstrap narrows parent capability; every denied goal tool fails closed", async () => {
  const normal = ["read", "bash", "edit", ...DEDICATED_GOAL_TOOLS];
  const before = [...normal];
  assert.deepEqual(dedicatedGoalTools(normal), [...DEDICATED_GOAL_TOOLS]);
  assert.deepEqual(normal, before, "normal worker tool list remains untouched");
  assert.deepEqual(dedicatedGoalTools([...normal, "questionnaire"]), [...DEDICATED_GOAL_TOOLS, "questionnaire"]);
  assert.ok(!dedicatedGoalTools(normal).includes("questionnaire"), "optional questions cannot widen the parent allowlist");
  assert.ok(dedicatedGoalTools([...normal,"goal_reference"]).includes("goal_reference"));
  assert.ok(!dedicatedGoalTools([...normal.filter(tool=>tool!=="read"),"goal_reference"]).includes("goal_reference"),"registration never grants read capability");
  for (const denied of DEDICATED_GOAL_TOOLS) {
    assert.throws(() => dedicatedGoalTools(normal.filter(tool => tool !== denied)), new RegExp(denied));
  }
  let launches = 0;
  const executor = createDelegatedGoalExecutor({ sessionId: "s", runtimeId: "r",
    executionUnavailableReason: () => "goal_complete denied by effective parent policy",
    async launch() { launches++; throw new Error("must not launch"); },
  });
  assert.equal(executor.executionAvailable(), false);
  // Snapshot/capability checks are pure: no worker starts on registry reads/reload.
  executor.executionUnavailableReason(); executor.executionAvailable();
  assert.equal(launches, 0);
  await assert.rejects(executor.start({ id: "g", child: null } as any), /goal_complete denied/);
  assert.equal(launches, 0);
});
