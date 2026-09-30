# Empty Bash input poisons guard authority and misreports native workers

## Status

Fix implemented and validated; publication pending.

## Evidence

Two native workers during a nix-config refactoring task issued `bash` with `{ "command": "" }`. Their installed extension source was `zxv7jwqmnqdhcaqljrcf297mqspxsvhz-source` (the pinned bundle at the time).

1. The identity `ssh-target` transform returned the empty string unchanged. `applyBashCommandTransforms` rejected the result.
2. Permission Gate treated this as an authority failure, rather than invalid tool input, and revoked the session's command authority.
3. The next tool was blocked with `terminate: true` and the generic message `Worker sealed or local authority unavailable`. The workers were not durably sealed (`state.sealed` was false).
4. `agent_settled` retained an assistant message with `stopReason: toolUse`, not a final answer. Native observation treated everything except `error` and `aborted` as completed.
5. Follow-up prompt handling persisted `active: true` before discovering that dispatch was unavailable. The caller received `ambiguous`, and status claimed the worker was running even though no instruction was delivered.

Worker identities: `94e9502ef4f6910ba8a29066` and `d85d6e30fd4abf1924884065`; native group `subagent-job-3cf59c3393f6d09300f10621`. The parent cancelled the stalled group and paused the uncommitted refactor. No deployment occurred.

## Required behavior

- Reject malformed/empty command inputs without executing them or revoking otherwise valid guard authority. A subsequent valid request must still receive normal authoritative authorization.
- Preserve fail-closed authority handling for genuine transform, transport, and protocol failures.
- Retain and surface execution failure when a worker stops on authority loss; do not call that successful completion or return a misleading empty answer.
- Reject known unavailable prompt dispatch before reserving running state. Preserve ambiguity for genuinely uncertain side effects; do not automatically replay them.
- Cover these cases with behavioral tests, including successful continuation after rejected input and prompt refusal without phantom activity.

## Validation

The new permission-gate and native-observation tests failed against the original code: invalid input closed the gate client; observation returned `completed` instead of `failed`; refusal returned `ambiguous` instead of `unavailable`.

After the fix, both Nix checks pass (`checks.x86_64-linux.permission-gate` and `checks.x86_64-linux.subagent`). The subagent suite includes 40 passing native tests, real Pi TUI/root control tests, and the same-process reload test. Regressions also cover authority loss during interrupt, definitive refusal replay, preservation of ambiguous dispatch, genuine broken transforms failing closed, and successful terminating-tool compatibility.

No deployment or reload of existing user sessions was performed.
