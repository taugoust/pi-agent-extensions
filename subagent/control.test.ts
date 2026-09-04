import assert from "node:assert/strict";
import {
  SUBAGENT_CHILD_ID_PATTERN,
  bindNativeSubagentControl,
  completeSubagentChildren,
  controlSubagentChild,
  createSubagentChildId,
  removeSubagentControlSession,
  reserveSubagentChildren,
  subagentChildControlState,
  type SubagentChildIdentity,
} from "./control.js";

const sessionId = `control-session-${process.pid}`;
const nativeChild: SubagentChildIdentity = {
  childId: createSubagentChildId(),
  child: 1,
  label: "subagent",
  task: "keep working",
};
const agentSHChild: SubagentChildIdentity = {
  childId: createSubagentChildId(),
  child: 2,
  label: "task 2",
  task: "remote work",
};
assert.match(nativeChild.childId, SUBAGENT_CHILD_ID_PATTERN);
assert.match(agentSHChild.childId, SUBAGENT_CHILD_ID_PATTERN);
assert.notEqual(nativeChild.childId, agentSHChild.childId);

reserveSubagentChildren(sessionId, "native", [nativeChild]);
reserveSubagentChildren(sessionId, "agentsh", [agentSHChild]);
assert.deepEqual(subagentChildControlState(sessionId, nativeChild.childId), { backend: "native", state: "pending" });
await assert.rejects(
  controlSubagentChild(sessionId, agentSHChild.childId, "steer", "hello"),
  (error: any) => error?.code === "capability" && /agentsh backend/.test(error.message),
);

let active = true;
const calls: unknown[][] = [];
const handle = {
  isActive: () => active,
  async control(mode: string, message: string, _signal?: AbortSignal, onUpdate?: (text: string) => void) {
    calls.push([mode, message]);
    onUpdate?.("streamed response");
    return { text: "complete response" };
  },
};
bindNativeSubagentControl(sessionId, nativeChild.childId, handle);
assert.deepEqual(subagentChildControlState(sessionId, nativeChild.childId), { backend: "native", state: "active" });
const updates: string[] = [];
assert.deepEqual(
  await controlSubagentChild(sessionId, nativeChild.childId, "follow_up", "more detail", undefined, (text) => updates.push(text)),
  { text: "complete response" },
);
assert.deepEqual(calls, [["follow_up", "more detail"]]);
assert.deepEqual(updates, ["streamed response"]);

await assert.rejects(
  controlSubagentChild(`${sessionId}-foreign`, nativeChild.childId, "steer", "probe"),
  (error: any) => error?.code === "ownership" && /different Pi session/.test(error.message),
);
assert.deepEqual(calls, [["follow_up", "more detail"]], "foreign-session request reached the child handle");

// A replacement extension module must discover the exact same process-owned handle.
const reloaded = await import(`./control.js?reload=${Date.now()}`);
assert.deepEqual(
  await reloaded.controlSubagentChild(sessionId, nativeChild.childId, "steer", "after reload"),
  { text: "complete response" },
);
assert.deepEqual(calls.at(-1), ["steer", "after reload"]);

active = false;
await assert.rejects(
  controlSubagentChild(sessionId, nativeChild.childId, "steer", "too late"),
  (error: any) => error?.code === "inactive",
);
completeSubagentChildren(sessionId, [nativeChild, agentSHChild]);
assert.deepEqual(subagentChildControlState(sessionId, nativeChild.childId), { backend: "native", state: "terminal" });
assert.throws(
  () => bindNativeSubagentControl(sessionId, nativeChild.childId, handle),
  /cannot bind terminal native subagent child/,
);
await assert.rejects(
  controlSubagentChild(sessionId, nativeChild.childId, "interrupt", "restart completed child"),
  (error: any) => error?.code === "inactive" && /terminal/.test(error.message),
);
const rollbackChild: SubagentChildIdentity = {
  childId: createSubagentChildId(), child: 1, label: "rollback",
};
assert.throws(
  () => reserveSubagentChildren(sessionId, "native", [rollbackChild, nativeChild]),
  /identity collision/,
);
assert.equal(subagentChildControlState(sessionId, rollbackChild.childId), undefined, "failed reservation leaked an earlier child identity");
removeSubagentControlSession(sessionId);
assert.equal(subagentChildControlState(sessionId, nativeChild.childId), undefined);

console.log("subagent child control registry checks passed");
