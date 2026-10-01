# Failed child compaction leaves an idle worker marked active

## Status

Resolved. Diagnosed read-only on eliza.dos on 2026-10-01; no remote changes made.

## Evidence

The Carbonara parent received the snapshot worker's completion notification and read its milestone report at 10:20:12 UTC. The report explicitly left further implementation unfinished and its outcome was checkpointed.

At 10:20:28 UTC, the parent attempted `subagent operation=resume`. The automatic checkpoint compaction returned `Resume compaction failed: ambiguous`. The child terminal displayed `Compaction failed: Nothing to compact (session too small)`.

The retained worker state then had `active: true`, `phase: settled`, sequence 15, and its previous terminal report. The last mutation receipt had a digest but no response. No subsequent model turn appeared in the child's session. The parent continued unrelated paper work rather than recovering the failed resume.

This was not a missing completion notification and is distinct from the serialized refresh backlog and stale queued completion wakeups.

## Cause

In `subagent/tui-worker-server.ts`, the `compact` mutation sets and persists `active = true` before awaiting `adapter.compact()`. The restoration from `adapter.isIdle()` is only on the success path. Rejection skips restoration and the confirmed mutation receipt, leaving a known compaction failure represented as an ambiguous mutation and an indefinitely active worker.

## Resolution

Implemented in `a314af3` (`Recover worker state after failed or unnecessary compaction`).

Compaction failures reconcile the activity reservation with the live adapter and intervening activity events, then persist a bounded `compact_failed` receipt. Replaying a request ID returns that receipt without retrying compaction. Human input that has reserved activity before streaming starts remains protected from reap. Parent resume errors include the underlying cause instead of only a generic code.

The user explicitly authorized treating Pi's exact `Nothing to compact (session too small)` error as a successful no-op. The Pi bridge returns `{ compaction: "not-needed", reason: "nothing-to-compact" }`, preserving the existing context and permitting checkpoint continuation. Other errors, including lookalike messages, remain failures.

A real-Pi regression also exposed previous-turn report/outcome metadata surviving parent-origin custom-message continuations. Parent prompt dispatch now clears that metadata after authority/interrupt checks and before sending the new instruction; these messages do not pass through Pi's ordinary `before_agent_start` hook.

Regression tests cover synchronous/asynchronous rejection, durable failure/no-op replay, bounded Unicode errors, human-input races, status/reap recovery, subsequent explicit retry, parent error propagation, and real Pi checkpoint continuation with retained history.

Validation passed: Nix `subagent` and `permission-gate` checks (47 native tests), plus the isolated guard-only real-Pi/tmux fixture on Matebook against the candidate source. The real Pi compactor returned the explicit too-small no-op, mandatory checkpoint resume continued in the same process, the old outcome was cleared, and existing history was retained with no compaction entry. No Eliza deployment, reload, or recovery was performed.
