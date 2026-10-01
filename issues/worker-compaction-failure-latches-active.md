# Failed child compaction leaves an idle worker marked active

## Status

Open. Diagnosed read-only on eliza.dos on 2026-10-01; no remote changes made.

## Evidence

The Carbonara parent received the snapshot worker's completion notification and read its milestone report at 10:20:12 UTC. The report explicitly left further implementation unfinished and its outcome was checkpointed.

At 10:20:28 UTC, the parent attempted `subagent operation=resume`. The automatic checkpoint compaction returned `Resume compaction failed: ambiguous`. The child terminal displayed `Compaction failed: Nothing to compact (session too small)`.

The retained worker state then had `active: true`, `phase: settled`, sequence 15, and its previous terminal report. The last mutation receipt had a digest but no response. No subsequent model turn appeared in the child's session. The parent continued unrelated paper work rather than recovering the failed resume.

This was not a missing completion notification and is distinct from the serialized refresh backlog and stale queued completion wakeups.

## Cause

In `subagent/tui-worker-server.ts`, the `compact` mutation sets and persists `active = true` before awaiting `adapter.compact()`. The restoration from `adapter.isIdle()` is only on the success path. Rejection skips restoration and the confirmed mutation receipt, leaving a known compaction failure represented as an ambiguous mutation and an indefinitely active worker.

## Required follow-up

Restore actual activity after compaction failure, retain an explicit failure receipt without automatically retrying the mutation, and test both synchronous and asynchronous failures plus subsequent safe resume/reap behavior. Preserve the checkpoint's session and fail-closed ownership checks. Decide separately how to handle a checkpoint whose session is too small to compact; do not silently discard context or bypass checkpoint policy.
