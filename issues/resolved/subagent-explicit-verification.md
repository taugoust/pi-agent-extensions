# Explicit subagent verification and guarded reaping

## Status

Resolved.

## Problem

Configured verification was launched when a worker settled, even when the worker was only returning control for parent guidance. Reaping had no explicit acceptance gate or exceptional, audited verification bypass.

## Required behavior

- Ordinary idle turns and partial, blocked or checkpointed outcomes do not launch verification.
- Standalone verification and delivered outcomes run configured gates; delivered completion cannot be accepted before checks pass.
- Normal reap requires current passing verification when gates are configured, running checks when necessary and retaining workers on failure.
- `reap` with `force: true` and a reason bypasses only verification, records the bypass, and does not accept the work or bypass activity, ownership or recursive job cleanup.
- Merge and worktree cleanup remain assignment/coordinator concerns rather than universal verification requirements.

## Validation

- Full `checks.x86_64-linux.subagent`: 162 tests passed, including actual Pi native/headless lifecycle, explicit parent verification, delivered verification and cleanup checks.
- Focused acceptance, protocol, worker-tool and headless tests: 61 passed.
- Worktree metadata controls: 3 passed.
- Nix formatting and Git whitespace checks passed.

## Resolution

Implemented in `1a2459d`: explicit parent/worker verification, delivered-triggered gates, current-verification requirements on normal reap, audited force flag, and regression/documentation updates. `ed0f295` retains the existing ownership-lease release on both normal and forced reap without deleting the Git worktree; merge and worktree removal remain coordinator concerns. Interim idle turns do not dispatch checks or fabricate a failed final acceptance. Verification does not grant new command permissions.
