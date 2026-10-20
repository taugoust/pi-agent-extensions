# Idle warning choices and parent-owned worker decisions

## Status

Implemented and validated locally for main sessions and native TUI-pane workers. Deployed on Matebook; publication approved on 2026-10-20 alongside BTW/Workflows. RPC-headless, legacy RPC and AgentSH parent-decision transport is not implemented: those workers fail closed without UI when a warning would require it. Guarded aliases retain their separate automatic recovery policy, and extension-originated automatic continuations retain their existing bypass.

## Request

Offer Ignore / Compact / Cancel. Compact uses the configured cheap physical model without changing the conversation's selected model or thinking, and resumes the pending request only after successful persisted compaction. Cancel discards the submitted prompt, not restoring it to the composer. Worker warnings must never open a worker questionnaire: the parent agent makes the three-way decision.

## Implementation and validation

- Cancel is the default and discards the submitted input; Ignore authorizes only the submission.
- Explicit Compact forces the configured cheap physical model. A unique attempt token in the persisted summary proves success before the pending prompt (including images) is replayed. Model/thinking selections remain unchanged; session/model/thinking/tree/fork/reload invalidation prevents stale replay. Native terminal input is deferred until its hook has returned, avoiding compaction aborting the active input operation.
- Mirrored selectors honor both local-race and session cancellation. Late callbacks cannot settle another attempt, and an already-aborted preflight cannot dispatch even if the optional warning extension is absent.
- Native TUI workers publish a parent-only decision channel. Parent `idle_decision` requests bind child ID, worker epoch and request ID. Notifications include the full invocation, are owner-only and emitted once per accepted notification. Private parent status clears resolved requests; cancellation clears pending waiters; pending decisions block reaping.
- Paseo receives a recognized abort diagnostic rather than a failed-turn diagnostic for intentional cancellation. Its internal compaction-busy flag is also cleared on failure without inventing an unsupported wire event or claiming successful compaction.
- Passed: focused warning tests, 23 real-SDK deterministic integration tests, native worker/control tests, extension and bridge TypeScript checks, bridge suite (136 passed / 9 skipped), compiled plugin suite (35 passed / 1 skipped), and Nix `idle-context-warning` + `subagent` checks. These automated checks used no paid inference. Subsequent deployment and live attempts are described below. The final native tests cover owner-only/deduplicated guidance, required epoch forwarding, and removal of resolved status.

## Deployed delivery correction

The initial deployed bridge cancelled ordinary Paseo prompts because `connectSession` called `stopServer`, which aborted the preflight controller, without creating a fresh controller in `startServer`. The corrected startup creates a new controller for the new transport. Deployed as `/nix/store/p5zah4ydx4mm2kigkq3hgg4ml0dbmx96-nixos-system-matebook-26.05.20260916.4c78701`; typecheck and five preflight tests passed. The user subsequently sent “Sent from Paseo”, which reached this conversation, confirming delivery.

Full live Ignore/Compact/parent-decision validation remains incomplete. An isolated guarded-alias SDK attempt produced a real cheap summary but timed out before follow-up dispatch; it does not validate explicit Compact. Test resources were cleaned. Do not infer full live coverage from service health or the successful delivery check.

## Incident evidence

The user no longer has the two UI error messages. Current-session journal records contain two `handleStreamEvent: turn_failed` events for agent `f8c615d5-4caa-4923-81f7-3293e34e10b1`, both `Prompt cancelled; draft restored.`:

- 2026-10-20T06:35:17.062Z (08:35 local)
- 2026-10-20T07:10:12.007Z (09:10 local)

The session file records successful hook-provided native compaction `5b7a73d0` at 2026-10-20T07:11:48.611Z: 533330 tokens before, 181141 summary input tokens, 4070 output tokens, reported cost $0.0201491; `idleContextNativeCompaction: 1`. The user had selected `openai/gpt-6-luna` at 06:35:25Z and later switched back to Astra at 07:18:29Z. There is no persisted summary-generation error in the available session/daemon evidence. The observed cancellation failures likely explain the report but cannot be conclusively matched to unavailable UI messages.

The installed Paseo provider's `isPiRequestAbortError` recognizes `AbortError` or messages matching `request was aborted` / `abort(ed)`. The bridge's old cancellation text matches neither, so a deliberate Cancel becomes `turn_failed`. A standard abort diagnostic allows Paseo to emit `turn_canceled` without patching its core.

Separate daemon errors refer to the already-deleted disposable Workflows live-test agent, not this compaction; they must not be conflated with the two current-session cancellation failures.
