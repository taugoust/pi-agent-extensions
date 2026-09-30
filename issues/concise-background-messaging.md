# Simplify background-job and subagent messaging

## Status

Implementation and validation complete; publication pending.

## Scope

Apply the user-approved current/proposed wording review: concise completion/guidance notifications, tool descriptions and guidelines, lifecycle replies, parent/worker messages, and default cleanup guidance. Keep identifiers, structured event data, control semantics, and runtime safeguards unchanged.

Completed agent-created jobs and workers should be inspected and reaped by default once follow-up is finished, without waiting for the user to inspect them. Unrelated/adopted user panes remain protected. Detailed recovery guidance stays in the relevant errors rather than every ordinary response.

## Changes

- Short completion notifications retain output/result inspection and cleanup reminders. Mixed batches use one instruction instead of two repeated paragraphs.
- Shorten tool descriptions/guidelines and start/adoption/reap replies; remove the repeated native status footer.
- Use a concise parent-message label while preserving human precedence and the non-slash-command delivery boundary.
- Remove unused completion/running-reminder helpers and their test-only delivery helper, plus tests for those dead paths. Keep real completion producer, wake-up, ownership, and cleanup tests.
- Update wording assertions to cover routing/action cues without pinning complete paragraphs.
- Matching default-cleanup/output guidance is updated downstream in nix-config.

## Validation

Both `checks.x86_64-linux.background-job` and `checks.x86_64-linux.subagent` pass, including completion producers, notification delivery/deduplication, real pane adoption, reload regressions, and all 40 native tests. No execution/cleanup guards or notification payload fields changed.

Completion preambles fell from 63/64 words to 13 each. The job description fell from 195 to 63 words; the subagent description/guidelines fell from 553 to 270 words.
