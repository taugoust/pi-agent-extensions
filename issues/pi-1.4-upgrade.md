# Upgrade native Pi to 1.4.0

## Status

In progress. User requested the newest Pi release; npm and the current upstream Nix derivation both identify 1.4.0. Existing Matebook installation is 1.0.0.

## Requirements

- Preserve the native shell-renderer preference and live settings toggle.
- Preserve cancellation boundaries and queued user input in both Node SDK and native Bun execution paths; reject unsupported source drift.
- Verify native extension loading, account-provider isolation, worker lifecycle and Paseo compatibility offline with synthetic fixtures.
- Publish coordinated source/input pins and deploy only after validation; do not alter real credentials or interrupt the live session for tests.

## Evidence

The shell-timing patch was ported to the 1.4 schema and shared timer renderer with clean zero-fuzz application. Cancellation now covers the `_startRun` scheduler and independently validates unbundled SDK and minified bundle source anchors.

Combined checks passed against Pi 1.4.0: account runtime/storage/snapshots 21/3/3 tests, BTW/workflow SDK suites 11 tests, native Accounts/Usage/BTW/Workflow registration checks, and eight native Paseo bridge/RPC/reload tests. Cancellation negative controls reproduce the original extra dispatches and lost input; patched Node, bundle and actual native Bun RPC tests preserve both queued inputs, stop canceled dispatch, and use a clean controller for the next explicit run. All use offline synthetic fixtures. Native BTW validation now checks actual command registration rather than relying on `--list-models` exit status.

Publication and Matebook activation remain pending consumer host-parity checks.
