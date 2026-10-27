# Native TUI worker startup can block on project trust

## Status

Resolved.

## Diagnosis and evidence

A fresh/untrusted worker project can trigger Pi's interactive project-trust prompt before `session_start` and before the worker control socket is created. The worker's readiness wait then times out; a missing socket/pane alone does not prove that the worker exited or is safe to reap.

The observed real-Pi reproduction used an untrusted `.agents/skills` directory and no saved trust: interactive startup blocked before `session_start`/socket creation; pressing Escape allowed startup to continue. With the worker trust hook enabled, the real-Pi regression test reaches readiness without the prompt and verifies that project extension code did not execute, no trust decision was saved, and normal reap still passes. A separate startup-timeout test preserves only the bounded `project-trust-prompt` classification, not captured terminal contents.

A later isolated reproduction exercised the historical guard-only launch path (permission-gate extension plus local mock provider, isolated config and tmux): the exact historical wrapper was `/nix/store/v6jmlf9rdhjsv098fclvcxlpwrga9m0c-pi-tui-worker/bin/pi-tui-worker`, running `agentsh permission-gate run -- rawPi`, the same wrapper command as `pi-unsafe`. With only the new `project_trust` hook disabled it timed out with `project-trust-prompt`; captured live output showed the actual trust dialog, and Escape allowed READY and reap. With the hook active, it reached READY without a prompt and reap passed. This establishes that the same launch path supports the failure mechanism. It does **not** establish that a historical terminal capture exists; the historical attribution is inference from the reproduced launch configuration, not a retained historical pane transcript.

## Policy

For worker processes only, saved project decisions and global settings/CLI policy retain their meaning. The hook returns a session-only negative answer solely for unresolved `ask`; it does not write a trust decision or load untrusted project settings as policy. The fix does not grant project trust or enable project extensions. Startup diagnostics are bounded/private and do not retain raw terminal text. Observation failures are reported separately from the original launch/task failure, and existing reap safeguards are unchanged.

## Resolution

Worker startup now declines only unresolved project-trust asks without persisting policy. Original lifecycle errors survive observation failures, and startup timeouts retain a private reason classification. Cleanup authority remains unchanged.

## Validation

- Final Nix subagent check passed: `/nix/store/7dhacc4vrshwil75f4hixl8g17v3qkak-subagent-check`.

- Real-Pi fixture: unknown trust skipped; no trust persistence or untrusted project extension execution; worker ready and reap succeeds.
- Isolated historical-wrapper reproduction: hook-disabled trust prompt blocks readiness until Escape; hook-enabled readiness and reap pass.
- Nix subagent check initially reproduced a harness-only failure: the minimal `@earendil-works/pi-coding-agent` stub exported `getAgentDir` only, while the worker now imports `ProjectTrustStore` and `SettingsManager`. The Nix unit harness now uses an explicitly labeled, narrow test double for those exports; its tests exercise the policy branches but do not claim equivalence to SDK implementation. Actual SDK unit tests separately passed saved `true`/`false`, global `always`/`never`, and project settings not self-authorizing; the real-Pi integration exercises the startup path through the actual runtime.
- A prior Nix run passed 139/141 tests; the two failing test modules both failed during ESM import because of the missing stub exports, not because trust was granted or persisted.
