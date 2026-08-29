import assert from "node:assert/strict";
import test from "node:test";
import { selectSupervisorCwd } from "./execution-cwd.ts";

test("fixed remote cwd overrides host execution target and Pi context", () => {
  assert.equal(
    selectSupervisorCwd("/workspace", "/host/project", "/host/project", "/host/project"),
    "/workspace",
  );
});

test("execution target remains the fallback without a fixed remote cwd", () => {
  assert.equal(selectSupervisorCwd("", "/target", "/context", "/process"), "/target");
});
