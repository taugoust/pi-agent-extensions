# Idle-context admission

This extension separates cold-context **decisions** from model routing. It never registers a provider, wraps a provider stream, or intercepts private Pi internals.

## Policy

By default a warning is needed when the last successful model response on the active branch is at least **30 minutes** old and context usage is at least **20%**. Tools, user input, failed/aborted responses, summaries and cache-refresh usage do not reset that clock. The warning is a cache-expiry heuristic, not a measured provider cache state or billing guarantee.

- A root user chooses **Cancel / Ignore / Compact**.
- A worker's **owning parent** chooses; the worker never opens its own questionnaire. Native TUI and native RPC-headless controllers use the same parent decision service.
- Without a usable user/parent channel, the request **stays pending**. Missing or disconnected UI is never approval, nor an automatic Cancel.
- `/idle-context` shows/resolves a pending root decision. `/idle-context ignore|compact|cancel [request-id]` is explicit user control. Worker commands cannot approve themselves.
- The existing remote preflight capability (`__piIdleContextPreflightV1`) exposes `ready`, `check(signal)`, read-only `pending`, and request-bound `decide(id, choice)`. A transport can signal `idle-context:decision-channel-ready` after attaching a decision channel; reconnect is not consent.

An accepted raw submission is consumed before asynchronous decision/compaction. Ignore replays its exact text/images once without command/template expansion. Cancel discards it. One pending submission is retained; a second is explicitly refused rather than overwriting the first. Pending payloads are session custom entries and survive extension reload, but approvals do not: a fresh decision is required. A durable `released` reservation precedes replay to avoid duplicate sends after a crash. A crash between reservation and send may require explicit resubmission; it never silently replays an uncertain request.

Model, thinking, routing/account, branch/fork/session changes cancel stale admission. Extension shutdown on reload preserves the pending payload; other invalidations revoke it. External cancellation revokes remote preflight. Old IDs/late callbacks cannot release a different request.

## Notification wakeups

`shared/quiet-state.ts` retains its existing completion/guidance queue, receipts, deduplication and generation checks. It now requests admission **before** sending its existing model wake message. It does not create a second wake queue or a second notification message. Ordinary completion/guidance waits for busy work and queued messages to drain. Result reads, explicit Cancel and newer activity can consume/supersede the exact pending revision. Reload restores queued notifications, never their approval.

Producer-confirmed terminal completions, identity-bound child idle-decision controls, and validated job/subagent guidance use **automatic compaction** when cold-context admission is needed. These autonomous wakes do not ask the root user to choose Compact. Classification uses structured producer metadata, never message text; every item in a batch must qualify. User submissions retain their explicit choice. Notification admission waits for an existing submission decision to settle; invalidation or failed compaction preserves the durable wake for retry rather than consuming it as an explicit Cancel.

`notify_parent` model parameters cannot set idle-control metadata. The `subagent idle_decision` operation continues to require owning parent, child ID, request ID and worker epoch. Automatic admission does not grant permission approvals or bypass worker ownership checks.

## Compaction is separate

`session_before_compact` retains Pi's public native `compact()` algorithm with current account routing and a configured cheap physical model. Warning context percentage does not govern cheap summary selection: after the idle threshold, a configured cheap model handles native compaction. Warm native compaction remains Pi-owned. Explicit Compact forces the cheap model regardless of current idle threshold.

Replay requires a newly persisted matching compaction receipt, not only a callback. Failed, empty, partial, tool-calling or aborted summaries cancel; they never silently fall back to the expensive conversation model. Conversation model/thinking, instructions, retained boundary, usage and cumulative file tracking are preserved. Branch summarization is a different operation, not owned by this extension.

## Legacy alias migration

`guardedModels` is now a **migration mapping**, not a dispatch policy. Known `idle-guard/<name>` (and old proxy) selections resolve through the existing session account/provider routing and public `setModel`/thinking APIs at session start. Explicit physical selections are not changed; startup defaults are not rewritten by the extension. `/idle-context-migrate` retries a failed migration after credentials/configuration are corrected.

Temporary **closed virtual placeholders** preserve old selections during startup and prevent stock Pi from silently falling back to the last answering physical/proxy model. They never route a request. Removed/unknown remembered aliases remain closed until an explicit mapping is supplied. The extension reads old alias tombstones but creates no new ones. Keep these compatibility placeholders until existing/default/imported selections have been inventoried and migrated.

`planSettingsMigration(settings, aliases)` is a pure migration planner for supplied settings: defaults, exact model scopes, per-model thinking and compaction overrides. It rejects ambiguous patterns, unknown aliases and conflicting mapped values, never edits files/accounts or live sessions. Deployment review must apply reviewed configuration changes separately and retain mappings for old sessions. Historical summaries/usage/proofs remain audit records; old guard proofs no longer authorize anything. `/idle-guard-retry` and automatic guard-error/summary/resume behavior are removed.

## Supported stock Pi boundary

Target: **unmodified stock Pi 1.4.0 / Node 24.21.0**.

This provides owned-submission and owned-notification admission, **not universal zero-paid-request enforcement**. Stock `input` handles submissions; it is not a gate before each internal tool follow-up/retry/direct call. Provider request hooks transform payloads and catch errors; they are not fail-closed vetoes. Queued decisions may become stale before internal dispatch. Other extensions' direct/nested calls and independently configured cache warming remain outside this admission boundary. Cancellation cannot undo a request already sent.

Extension-origin inputs remain owned by their originating integration: the remote bridge must invoke explicit preflight, while the one-shot replay does not re-enter its own decision. Worker continuation, stream-stall notifications, deadline/context finalization and background `yield` semantics remain separate and unchanged.

See [TESTING.md](TESTING.md) for deterministic offline checks and their limits.
