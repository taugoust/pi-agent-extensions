# Guidance notification delivery

Guidance notifications are wakeups, not answers or permissions. An ordinary request still requires `guidance list` and a reply to its exact authenticated target. Human preferences still use the existing questionnaire; Permission Gate consent stays on its separate channel. Routine findings remain silent. The separate completion lane keeps its ownership, sequence ordering and result-consumption behavior.

## Identity, pacing and recovery

There is no lifetime delivery allowance. Deduplication uses the owner session/runtime, task, child, attempt, worker epoch/runtime, stable request ID and optional goal identity—not prompt text or display name. Changes to presentation cannot make an already delivered request new.

Pending requests are reconciled against the actual owner broker's connected waiters before dispatch. Answered, cancelled, disconnected, superseded, unavailable and foreign requests do not become new wakeups. Broker startup/reconnect without a ready snapshot is not an empty snapshot or permission to replay retained messages. A parent process restart cannot reconstruct a dead socket promise: its retained pending record becomes unavailable, not an automatically replayed request. A new authenticated launch/attempt must establish a new waiter.

Guidance uses a 30-second minimum interval between batches, at most 16 items and 6,000 UTF-8 bytes across message content and details. Each update is bounded to 3,000 bytes and each receipt to 4,096 bytes. Concise prompt previews retain routing identities; the full request remains in `guidance list`. Round-robin child selection prevents one child's backlog monopolizing batches. The bounded local queue holds 512 items; overflow remains in the broker and is admitted as capacity returns. Busy tools, queued input, modal UI and compaction defer delivery rather than interrupting them.

The broker allows 64 connected waiters and a hot journal of at most 1,024 records (rollover starts at 8 MiB). Older terminal records are preserved as hidden `coordinator-guidance-history-v1` entries in the owning conversation before removal from the hot journal. They remain historical evidence, never live waiters. Archived request IDs remain protected against replay. This uses the conversation's normal durable history, like notification receipts; it does not impose another lifetime request/byte allowance. Pending waiters are never evicted. If archival/persistence or actual disk capacity is unavailable, the producer receives an explicit capacity error, not a fabricated successful enqueue.

## Failure guarantees

Queued receipts precede dispatch. A `dispatching` receipt precedes calling Pi's void `sendMessage`; return from that API is **not** an acknowledgement. The persisted custom message acknowledges delivery, including across reload. If acknowledgement has not appeared within ten seconds, status reports an uncertain dispatch. A restored dispatch intent without message evidence is likewise uncertain. It is not blindly replayed: exactly-once dispatch cannot be guaranteed across the send/persistence crash boundary.

Pre-dispatch persistence failures and explicitly certified pre-acceptance transport rejection retry with exponential backoff from one second to five minutes. An arbitrary transport exception is not a certificate of non-delivery. Failures and recovery diagnostics are persisted where possible, with bounded cause, affected routing identities, pending counts and next retry. If diagnostic persistence itself fails, the local UI still reports that limitation. No failure counter permanently mutes guidance.

## Operator controls and migration

- `/harness-state status`: diagnostics, affected identities, uncertain keys, pending broker/local counts and next retry.
- `guidance list`: retrieve and answer the actual current requests, regardless of notification state.
- `/harness-state dismiss-guidance <child_id|all>`: explicitly consume selected notification wakeups; this does not answer a broker waiter.
- `/harness-state retry-guidance <exact-key>`: explicitly retry one uncertain dispatch after inspecting message history. This may duplicate a wake; it cannot fabricate an answer.
- `/harness-state disable` / `enable`: deliberate session opt-out/resumption. Enable does not erase uncertain dispatches or historical receipts.
- `PAE_QUIET_STATE_DISABLED=1` (legacy alias `PI_QUIET_STATE_DISABLED`) remains an overriding environment opt-out; declarative defaults and independent retained pauses are preserved.

Old `guidance-quota` controls no longer suppress delivery. Historical delivered/consumed receipts are migrated without replay, including sessions already beyond twenty deliveries. A stranded legacy queued request is moved to its authenticated identity before consuming the old key, so migration cannot mistake it for an already delivered request. There is no need to periodically reset or replace a conversation.

Deterministic tests use controlled clocks for 128 distinct deliveries, a 600-item fair backlog, 38-receipt migration plus a stranded waiter, duplicate IDs/presentation, admission delays, disables, retry/backoff, real custom-message acknowledgement and uncertain recovery. Broker tests additionally exercise terminal-history rollover and replay rejection with actual socket waiters.
