import { test } from "node:test";
import assert from "node:assert/strict";
import { setDedicatedGoalEnvironment } from "./goal-environment.ts";
test("ordinary nested worker drops inherited dedicated identity without changing gate/routing/profile authority", () => {
  const env = { PI_DEDICATED_GOAL_CHILD: "1", PI_DEDICATED_GOAL_BINDING: "old-parent-entry", AGENTSH_PERMISSION_GATE_SOCKET: "/private/gate", PI_SESSION_ROUTING_FILE: "/private/route", USER_POLICY: "read-only" };
  setDedicatedGoalEnvironment(env);
  assert.deepEqual(env, { AGENTSH_PERMISSION_GATE_SOCKET: "/private/gate", PI_SESSION_ROUTING_FILE: "/private/route", USER_POLICY: "read-only" });
  setDedicatedGoalEnvironment(env, { entryId: "new-entry", attempt: 2 });
  assert.equal(env.PI_DEDICATED_GOAL_CHILD, "1");
  assert.deepEqual(JSON.parse(env.PI_DEDICATED_GOAL_BINDING), { entryId: "new-entry", attempt: 2 });
});
