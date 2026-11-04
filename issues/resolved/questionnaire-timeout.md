# Bound unanswered questionnaires to five minutes

## Status
Resolved.

## Request
Questionnaires must not wait indefinitely. The agreed default is five minutes
for the entire questionnaire. On expiry, return only `Questionnaire timed out.`
without choosing an answer or directing the agent to stop.

## Implementation
A shared deadline covers terminal, Paseo, headless-worker and Goal question
routes, including transport setup and terminal handoff. Expiry returns a distinct
`timedOut` result, aborts pending transport/recorder operations, and closes the
terminal UI without calling `ctx.abort()`. Partial answers are discarded. Existing
human-cancellation provenance remains distinct, and late replies cannot select an
answer or open another native input step.

## Verification
Deterministic fake-clock tests exercise the exact five-minute boundary, terminal
and remote expiry, partial answers, handoff, actual Goal recorder cleanup, late
replies, parent abort, explicit human cancellation and timer cleanup. The Nix
questionnaire check includes these regressions and the standalone package-bundle
headless adapter checks.

Passed: 34 targeted questionnaire/attachment tests, 15 real-SDK guidance
integration tests, and the Nix `questionnaire`, `workflows-runtime` (154 tests)
and `subagent` (199 tests) checks. The guidance fixture now supplies the current
session-history API and asserts the current ordinary-worker launch contract;
its initial stale-fixture failures were corrected before the final 15/15 run.

## Resolution
Implemented in `c8665704661ef874c8bb7893f99f2bc1f612e31f`.
Expiry returns only the timed-out message, with distinct metadata and no answer
or automatic agent stop. Publication includes the shared Nix input update;
host activation and running-session reloads are separate deployment actions.
