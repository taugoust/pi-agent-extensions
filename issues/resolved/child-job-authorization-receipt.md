# Brokered child background jobs lacked local Permission Gate receipts

## Status
Resolved.

## Problem
When a native parent had the local Permission Gate but no inherited AgentSH child authority, a child's brokered background_job start bypassed parent tool_call hooks. It therefore had no command receipt and failed with `background_job start lacks an exact Permission Gate authorization receipt`. This was reproduced in a fresh Pi process with the actual gate and job extensions.

## Resolution
Commit `34e970fbdb1969b042fe9570e89fc9d6328155be` exposes delegated authorization through the same gate handler used for parent calls. Only internal broker calls use this path. Receipts remain exact, one-use command/cwd checks, with call IDs namespaced by delegated task/child identity. Session changes, cancellation, inactive or older authorities fail closed. The existing inherited AgentSH authorizer remains in place. Direct calls without receipts remain rejected.

Live checks: `RECEIPT_BUG_REPRODUCED` before the fix; afterwards `COMPILE_AUTH_OK`, `REAL_WORKER_COMPILE_PI_PASS`, and `CHILD_JOB_AUTHORIZATION_PI_PASS`. An actual native worker started a parent-owned background job, compiled and ran a C program, and read the output. A harmless quoted command triggering the dangerous-command policy was declined and rejected. No full test suite was run. Logs are under ignored plans/job-authorization-*.log. Rose's project and builds were not modified during reproduction.
