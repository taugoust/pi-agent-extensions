import assert from "node:assert/strict";
import { selectSupervisorCwd } from "./execution-cwd.js";
import * as workspacePaths from "./workspace-paths.js";
import {
  absoluteToVirtual,
  cleanPosix,
  isUnderPath,
  normalizeWorkspaceRoots,
  restFileRequest,
  supervisorAbsolutePath,
  toSlashPath,
  type WorkspacePathMetadata,
} from "./workspace-paths.js";

assert.deepEqual(Object.keys(workspacePaths).sort(), [
  "absoluteToVirtual",
  "cleanPosix",
  "isUnderPath",
  "normalizeWorkspaceRoots",
  "restFileRequest",
  "supervisorAbsolutePath",
  "toSlashPath",
]);

assert.equal(toSlashPath("repo\\src\\index.ts"), "repo/src/index.ts");
assert.equal(cleanPosix("repo\\src/../test.ts"), "repo/test.ts");
assert.equal(cleanPosix("."), "");

assert.equal(isUnderPath("/real/project/src/index.ts", "/real/project"), true);
assert.equal(isUnderPath("/real/project", "/real/project"), true);
assert.equal(isUnderPath("/real/project-copy/src/index.ts", "/real/project"), false);
assert.equal(isUnderPath("/workspace-copy/index.ts", "/workspace"), false);

assert.deepEqual(normalizeWorkspaceRoots([
  null,
  "not-an-object",
  {},
  { name: "" },
  { name: "frontend", real: "/real/frontend", work: "/shadow/frontend" },
]), [{ name: "frontend", real: "/real/frontend", work: "/shadow/frontend" }]);

const multiRootMetadata: WorkspacePathMetadata = {
  real_workspace: "/real/session",
  worktree: "/shadow/session",
  virtual_root: "/workspace",
  workspace_roots: [
    { name: "backend", real: "/real/backend", work: "/shadow/backend" },
    { name: "frontend", real: "/real/frontend", work: "/shadow/frontend" },
  ],
};

assert.equal(absoluteToVirtual(multiRootMetadata, "/real/backend/src/api.ts"), "/workspace/backend/src/api.ts");
assert.equal(absoluteToVirtual(multiRootMetadata, "/shadow/frontend/src/app.ts"), "/workspace/frontend/src/app.ts");
assert.equal(absoluteToVirtual(multiRootMetadata, "/workspace/frontend/src/app.ts"), "/workspace/frontend/src/app.ts");
assert.equal(absoluteToVirtual(multiRootMetadata, "/real/backend-copy/src/api.ts"), undefined);
assert.equal(absoluteToVirtual(multiRootMetadata, "/shadow/frontend-copy/src/app.ts"), undefined);
assert.equal(absoluteToVirtual(multiRootMetadata, "/workspace-copy/src/app.ts"), undefined);

assert.deepEqual(
  restFileRequest(multiRootMetadata, "/real/frontend/src/app.ts", "/outside"),
  { path: "/workspace/frontend/src/app.ts" },
);
assert.deepEqual(
  restFileRequest(multiRootMetadata, "src/app.ts", "/shadow/frontend/packages/ui"),
  { path: "src/app.ts", cwd: "/workspace/frontend/packages/ui" },
);
assert.deepEqual(
  restFileRequest(multiRootMetadata, "frontend/src/app.ts", "/outside"),
  { path: "frontend/src/app.ts", cwd: "/workspace" },
);
assert.deepEqual(
  restFileRequest(multiRootMetadata, "frontend-copy/src/app.ts", "/outside"),
  { path: "frontend-copy/src/app.ts" },
);

// With no per-request cwd, index.ts supplies effectiveSupervisorCwd(). Keep the
// fixed remote cwd ahead of stale host target/context paths before translating
// that default into the matching virtual multi-root location.
const remoteDefaultCwd = selectSupervisorCwd(
  "/shadow/backend/services/api",
  "/real/frontend",
  "/host/context",
  "/host/process",
);
assert.equal(remoteDefaultCwd, "/shadow/backend/services/api");
assert.deepEqual(
  restFileRequest(multiRootMetadata, "src/router.ts", remoteDefaultCwd),
  { path: "src/router.ts", cwd: "/workspace/backend/services/api" },
);
assert.equal(
  supervisorAbsolutePath(multiRootMetadata, "src/router.ts", remoteDefaultCwd),
  "/workspace/backend/services/api/src/router.ts",
);
assert.equal(
  supervisorAbsolutePath(multiRootMetadata, "frontend/src/app.ts", "/outside"),
  "/workspace/frontend/src/app.ts",
);

const singleFlatRootMetadata: WorkspacePathMetadata = {
  real_workspace: "/real/project",
  worktree: "/shadow/project",
  virtual_root: "/workspace",
  workspace_roots: [{ name: "project", real: "/real/project", work: "/shadow/project" }],
};
assert.equal(absoluteToVirtual(singleFlatRootMetadata, "/real/project/src/index.ts"), "/workspace/src/index.ts");
assert.equal(absoluteToVirtual(singleFlatRootMetadata, "/shadow/project/src/index.ts"), "/workspace/src/index.ts");
assert.equal(absoluteToVirtual(singleFlatRootMetadata, "/real/project-other/src/index.ts"), undefined);

console.log("sandbox workspace path checks passed");
