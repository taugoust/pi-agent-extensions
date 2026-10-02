# Intermittent headless cleanup refusal in root integration test

## Status

Resolved.

## Evidence

During background-launch fixes, the full subagent check (`9kw05x3liqn27lfggv589jpj50jq1w5i-subagent-check.drv`) passed 57/58 tests. `subagent/tui-root.test.ts:62` failed with `Headless worker reap refused: cleanup_failed: Worker reap refused: Background job operations are still in flight (1); retry cleanup after they finish`.

The worker's exact-derivation rebuild and an independent parent rebuild initially passed all 58 tests, but retries alone did not fix the race.

## Resolution

`8c24ebe` fixes synchronization in `ReapReservation`. The periodic background-job poll enters this reservation around asynchronous `WatchManager.recover()`. An idle worker can overlap that operation when reaping, even with no jobs or watches. Previously, prepare reserved cleanup then immediately rejected any existing operation.

Preparation now reserves exclusively, prevents new operations, and drains existing operations within a bounded deadline before running the unchanged inventory/cleanup checks. Timeout releases the reservation without running cleanup; a late operation completion cannot resurrect timed-out cleanup or release a subsequent reservation. Idle waiters and timers are cleared on all paths. Active/starting/adopted jobs and active watches remain blockers.

A deterministic before/after probe reproduced the exact old in-flight refusal and verified the new drain ordering. Regression coverage includes multiple entered operations, idempotent release, blocked new entrants, timeout, late completion, and a subsequent reservation. Background-job and subagent Nix checks passed, including all 58 subagent/TUI tests; strict core typecheck passed. No host deployment or worker restart was performed.
