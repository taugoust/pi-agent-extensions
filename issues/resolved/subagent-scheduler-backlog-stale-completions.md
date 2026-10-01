# Native subagent scheduler backlog and stale completion wakeups

## Status

Resolved.

## Problem

The native TUI scheduler started unconditional one-second refreshes. Each refresh serialized a full scan of all children, so slow worker RPCs accumulated queued refreshes. A selected `result` operation also waited for that global scan before reading its report. Quiet-state could retain multiple terminal revisions for one child and inject old queued completion messages before newer reports; a result read could also consume a notification for a report it had not retrieved.

## Resolution

Implemented in `5b0f152` (`Bound subagent polling and coalesce stale completion wakes`).

Coalesce concurrent native refreshes into one in-flight pass. Selected result reads bypass global polling with a bounded, abortable status RPC and a private snapshot of the selected worker. Active turns never return an old report; unreachable workers' retained results are explicitly marked potentially stale.

Completion wakeups remain inside the harness while the parent is busy, rather than accumulating obsolete steering messages inside Pi. Only the latest pending terminal report per child wakes the idle parent. Report sequence numbers, not receipt timestamps, determine ordering across reloads. Reading a result persists its exact completion identity and sequence even before polling discovers it; this suppresses older wakes without hiding a newer unread result. Explicit guidance keeps its existing delivery behavior, and read-only dashboards remain non-consuming.

Regression coverage: `subagent/tui-native-observe.test.ts`, `shared/quiet-state.test.ts`, and `background-job/completion.test.mjs`. Standalone Nix `subagent`, `background-job`, and `permission-gate` checks pass, including 42 native tests and same-process reload checks. Installed Matebook live validation is a separate rollout step; no DOS activation is part of this fix.
