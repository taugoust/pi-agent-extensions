# Intermittent headless cleanup refusal in root integration test

## Status

Open; not reproduced on two subsequent rebuilds.

## Evidence

During background-launch fixes, the full subagent check (`9kw05x3liqn27lfggv589jpj50jq1w5i-subagent-check.drv`) passed 57/58 tests. `subagent/tui-root.test.ts:62` failed with `Headless worker reap refused: cleanup_failed: Worker reap refused: Background job operations are still in flight (1); retry cleanup after they finish`.

The worker's exact-derivation rebuild and an independent parent rebuild subsequently passed all 58 tests. Cleanup guards were not weakened or changed. This may be a test synchronization or transient runtime cleanup race; the cause is not established. Retain as an open reliability issue rather than claiming the successful retries fixed it.
