# Wake supervising parents on background child completion

## Status

Resolved.

## Problem

The quiet-state remediation classified native settlement and legacy background completion as routine metadata. An idle parent therefore never resumed to consume results or decide when to reap. Native launch failures and lost worker processes could also terminate without a settlement event.

## Changes

Explicit background execution completion now has a bounded, deduplicated wake path separate from guidance. Accepted sends get delivered receipts; failed sends remain queued. Completion has no guidance quota or 30-second throttle, pauses for UI/compaction, respects explicit disable, and never interrupts in-flight tools. Native current-terminal snapshots cover settlement and failures, suppress foreground duplicates and stale historical events, and retain retry cursors. Routine progress and task outcomes remain quiet. Result reads consume only the selected native child's queued wake.

## Validation

Focused quiet-state and native observer/completion tests cover idle triggerTurn delivery, active turn-safe steering, routine silence, duplicate/reload suppression, send retry, guidance quota independence, compaction, foreground/background distinctions, and terminal failure snapshots. Quiet-state tests and six native tests passed. No deployment performed.

## Resolution

Fixed by `4b563e5` (Wake supervising parents on background child completion).
