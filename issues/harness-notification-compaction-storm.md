# Harness notification replay and compaction storm

## Status
Source remediation validated for publication; Rose deployment and live observation remain pending. Do not resume the affected Rose session to investigate.

## Incident
User-supplied incident report (2026-09-06/07 UTC), session `01a038e9-bca5-73ce-a796-69ebabb48ad9`, describes 5,229 hidden harness-state messages, 901 successful empty model turns, 4,330 context-window failures and two compactions during the overnight interval. JSONL reportedly reached 252 MiB. Usage and cost are session-recorded provider fields, not independently verified billing. PID 2384437 was terminated by the user; builds were left untouched. Evidence file: `/home/theo/.pi/agent/sessions/2026-08-25T12-33-57-413Z_01a038e9-bca5-73ce-a796-69ebabb48ad9.jsonl`. Preserve it without rewriting or compacting.

## Source findings
`shared/quiet-state.ts` trims delivered-state memory to 512 keys. Job and subagent polling each revisit up to 1,000 records and depend on that memory for notification deduplication. This permits already-delivered terminal states to replay after eviction. Every batch uses triggerTurn=true even for routine terminal updates. The existing 32-item/6,000-character batch budget bounds individual messages, not aggregate replay or model cost. Restore repeatedly scans the active branch at agent_settled. Compaction cannot stop the incoming stream.

This source mechanism does not require Paseo to reinject messages. The previous bridge-only foreground visibility fix addressed stale UI notifications, not model request scheduling or transcript growth.

## Required behavior
Persist bounded routine deltas outside conversation/model context. Deduplicate durably without a smaller-than-poll history eviction loop, including reload and compaction. Only explicit actionable guidance may request a model turn, with coalescing, byte/rate limits and backpressure. Expose counters and an operator delivery kill switch without cancelling workers or builds. Keep notification routing separate from explicit result observation/retention acknowledgement. Regression coverage must exercise thousands of terminal records and repeated polling, reload, compaction and guidance.

## Implementation and validation
Routine state is persisted as private `harness-state-receipt` custom entries, not model messages. Durable receipts replace the evicting 512-key memory. Guidance-only wakeups use bounded UTF-8 batches, a 30-second interval, a conservative quota, and at-most-once reservation before scheduling. `/harness-state disable|enable|status|show` provides operator controls; `PAE_QUIET_STATE_DISABLED=1` is the environment kill switch. Compaction leaves guidance disabled until explicit operator re-enablement. Watch cursors restore from private receipts without acknowledging job results for retention.

Final focused quiet-state regressions and the extension package build passed. Broader subagent/background-job checks encountered failures in native-RPC and tmux-adoption tests; a full green suite is not claimed. Deployment must preserve the incident JSONL and use a fresh parent session, not resume the incident session.
