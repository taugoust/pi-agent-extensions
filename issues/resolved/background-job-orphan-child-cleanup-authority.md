# Parent cleanup of jobs whose child TUI was reaped

## Status

Resolved for live-child pre-reap cleanup. Existing orphan recovery remains explicitly scoped below.

## Resolution

Implemented in `b072f71` (Clean child-owned jobs before reaping native subagents).

## Implemented behavior

Native parent reap delegates terminal-job cleanup through the live child's authenticated `prepare_reap` endpoint and its session-bound `LocalJobController`. The parent never reads or mutates another session's job store. The child temporarily reserves input and background-job operations before asynchronous inventory/cleanup, then durably seals and exits only after cleanup has succeeded and live idle state is rechecked.

Cleanup inventories all session jobs (not a paginated list), refuses active/starting jobs and adopted/observation records with their IDs, and never cancels work. In-flight job operations, active watches, missing/incompatible controllers, changed ownership, failed preservation/deletion, corrupt inventory, or incomplete verification refuse reap and retain the child/controller for repair and retry. Failed cleanup does not cache a successful reap receipt or permanently seal the input boundary. Terminal jobs already deleted before a later failure remain deleted; their snapshots are retained, and retry inventories the remaining jobs.

Before deletion, bounded terminal status/output snapshots are written using private immutable `job-cleanup-*.json` artifacts in the retained worker directory. Output retains its tail (including final errors) with UTF-8-safe truncation and explicit truncation flags. Successful worker state records the artifact and exact worker epoch; the launcher verifies these before deleting the dead owned pane. Artifact capacity/write failures occur before deletion.

The launcher propagates the child failure message so blocking job IDs reach the parent. Parent control is serialized; direct input during the temporary reservation is handled without shutting down the controller. A turn that starts through another route interrupts the cleanup reservation rather than becoming eligible for reap.

## Recovery and limitations

Old workers must reload to acquire the new controller API; workers without a background-job controller cannot prove an empty managed-job inventory and fail closed. There is no production assumption that a missing extension implies no retained jobs.

A child already dead without an epoch-bound successful cleanup seal cannot delegate. Reap refuses with explicit recovery/adoption guidance, even if its inventory might be empty. Recover the child controller or explicitly inspect/adopt retained jobs with user authorization; this change adds no parent cross-session fallback, implicit adoption, or force reap. Existing verified pane-deletion tombstones remain idempotent.

Reservations are in-process and cover the child extension's ordinary job tool, delegated broker calls, and watch recovery. They do not grant authority over unrelated sessions or coordinate arbitrary separate Pi processes deliberately using the same session identity. Inventory scanning intentionally fails closed on unreadable/corrupt metadata, including an unrelated entry whose ownership cannot be established. Users must explicitly resolve adopted records/watches rather than having reap infer cleanup permission.

## Validation

Focused tests cover terminal/no-job cleanup, preservation failures, active/adopted refusal and bounded ID propagation, failed-cleanup retry, temporary input reservation/human-start races, job-operation reservation, complete inventory, cross-session authentication, dead-before-prepare refusal, and original tmux exit-race revalidation.

Passed `nix build --no-link 'path:.#checks.x86_64-linux.subagent' 'path:.#checks.x86_64-linux.background-job'`. The native TUI test suite passed 35/35 with no skips, including the real root Pi integration asserting active-job refusal, retained child controller, parent-triggered terminal job pane deletion, and preserved output. Background-job checks include reservation/inventory tests, live pane adoption, persistent watch and completion regressions. The subsequently added oversized-error regression passed in the standalone 7/7 cleanup test suite. `git diff --check` passed. Test jobs and delegated helper panes were explicitly reaped after consuming results.
