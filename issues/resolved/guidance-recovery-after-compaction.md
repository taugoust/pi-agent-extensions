# Recover guidance delivery after compaction

## Status

Resolved. Host recovery is an explicit operator rollout.

## Problem

The Amy qshell parent retained 18 queued historical guidance requests. A durable `compaction-pause` control entry disabled guidance until explicit re-enabling, but the footer displayed only the queue length. Completion wakeups worked while requests for decisions could remain silent. Carbonara also retained an obsolete guidance request.

Enabling guidance without first acknowledging the obsolete requests would replay old instructions into the model. Direct edits to live session state are unsafe.

## Resolution

Implemented in `8c70879`, with historical quota restoration corrected in `9d8d4ca`. Nix subagent, background-job and permission-gate checks passed, including 47 native tests.

Live recovery exposed a second legacy issue: old custom-message delivery evidence was assigned the current time on every restore, incorrectly exhausting even an explicitly reset quota. Restore now preserves explicit receipts and uses the message's original timestamp for legacy delivery evidence. Operator reset therefore survives subsequent turns and reloads.

Add an operator-only `/harness-state dismiss-guidance all|<exact child_id>` command. It durably consumes only pending guidance, retains history, preserves completion notifications and unrelated children, and requires explicit scope. Footer/status output exposes paused guidance, compaction and quota state.

Future compactions pause delivery only while active, resuming previously enabled guidance on success or failure without resetting quotas or operator disables. Existing durable pauses remain intact until explicitly enabled, so upgrading cannot automatically replay old requests.

During Carbonara recovery, the worker's last session leaf was already a successful compaction. Pi's exact `Already compacted` preflight error is now an explicit no-op with `reason: "already-compacted"`, reusing that saved context. Lookalike and unrelated errors still fail. Existing `Nothing to compact (session too small)` handling remains unchanged.

## Recovery scope

The user authorized recovering Carbonara on Eliza and fixing Amy's guidance delivery. Preserve drafts and retained sessions; acknowledge reviewed historical requests before enabling guidance. No board actions, unrelated worker cancellation, or manual mutation of live task/session files is authorized by this recovery.
