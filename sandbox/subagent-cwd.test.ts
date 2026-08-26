import assert from "node:assert/strict";
import { normalizeSupervisorSubagentCwds } from "./subagent-cwd.js";

const real = "/home/user/project";
const work = "/var/lib/agentsh/workspaces/session-test/work";
const toVirtual = (value: string) => {
  for (const root of [real, work]) {
    if (value === root) return "/workspace";
    if (value.startsWith(`${root}/`)) return `/workspace/${value.slice(root.length + 1)}`;
  }
  return undefined;
};

{
  const result = normalizeSupervisorSubagentCwds({ task: "review" }, real, toVirtual);
  assert.equal(result.parentCwd, "/workspace");
  assert.deepEqual(result.params, { task: "review" });
}

{
  const result = normalizeSupervisorSubagentCwds({ task: "review", cwd: `${real}/src` }, real, toVirtual);
  assert.equal(result.parentCwd, "/workspace/src");
  assert.equal(result.params.cwd, "/workspace/src");
}

{
  const result = normalizeSupervisorSubagentCwds({
    tasks: [{ task: "one", cwd: "src" }, { task: "two", cwd: `${work}/tests` }],
  }, real, toVirtual);
  assert.equal(result.parentCwd, "/workspace");
  assert.deepEqual(result.params.tasks, [
    { task: "one", cwd: "/workspace/src" },
    { task: "two", cwd: "/workspace/tests" },
  ]);
}

{
  const result = normalizeSupervisorSubagentCwds({
    cwd: "packages/app",
    chain: [{ task: "one", cwd: "src" }, { task: "two" }],
  }, real, toVirtual);
  assert.equal(result.parentCwd, "/workspace/packages/app");
  assert.deepEqual(result.params.chain, [
    { task: "one", cwd: "/workspace/packages/app/src" },
    { task: "two" },
  ]);
}

console.log("sandbox subagent cwd checks passed");
