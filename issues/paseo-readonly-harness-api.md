# Session-scoped read-only harness API for Paseo

## Status

Implemented; final integration validation and deployment pending.

## Contract

`shared/harness-readonly.ts` defines version-1 lifetime-owned jobs and native-subagent services. Every operation checks the actual Pi session, active generation, and registered service identity. Shutdown removes only its own service. Reads must not initialize storage, reconcile terminal results, migrate records, acknowledge notifications, or perform job/task control.

Job metadata is owner-filtered before process/pane observation. Root-session views exclude delegated child and infrastructure jobs. Output uses bounded sanitized reads without consuming completion notifications. Native task views use retained snapshots and answer-only report artifacts, with unknown timestamps left null and retained state marked stale. Control tokens, private paths, environment, and diagnostic artifacts are not DTO fields.

The first version lists up to 50 direct session-owned items. Unsupported non-native subagent backends are explicit. A child's local jobs are read through that child's own Pi session, not by bypassing ownership from the parent.

## Tests

Regression coverage includes foreign-owner filtering, no initialization, no result/notification writes, stale service calls, retained task/report filtering, private artifact fields, and UTF-8 boundaries. The bridge/plugin consumer is maintained in `paseo-bridge-pi`; deployment remains a separate operation.
