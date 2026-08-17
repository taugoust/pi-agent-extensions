import assert from "node:assert/strict";
import { AGENTSH_DETACHED_CONTROL_TOKEN_HEADER, detachedOperatorHeaders } from "./operator-auth.js";

assert.deepEqual(detachedOperatorHeaders("/api/v1/approvals", " token "), {
  [AGENTSH_DETACHED_CONTROL_TOKEN_HEADER]: "token",
});
assert.deepEqual(detachedOperatorHeaders("/api/v1/approvals/id", "token"), {
  [AGENTSH_DETACHED_CONTROL_TOKEN_HEADER]: "token",
});
assert.deepEqual(detachedOperatorHeaders("/api/v1/sessions/id", "token"), {});
assert.deepEqual(detachedOperatorHeaders("/api/v1/approvals", ""), {});
