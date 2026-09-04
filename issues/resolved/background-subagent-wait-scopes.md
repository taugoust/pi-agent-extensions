# Add child, group, and global background-subagent waits

## Status
Resolved by `a036aa2` (`Add scoped background subagent waits`).

## Problem
The background `subagent` lifecycle can wait for one aggregate job, but it cannot wait for the next child completion across groups or for every currently active group. Supervisors otherwise need to poll each group manually.

## Desired behavior
- `wait_any` waits for one currently unfinished child across all groups owned by the current Pi session; simultaneous completions remain observable through group status/results rather than forming a queue.
- `wait_group` waits for one complete aggregate and keeps `wait` as a compatibility alias.
- `wait_all` waits for every group that is active when the operation begins.
- Every wait is bounded by `wait_ms`; cancelling a wait never cancels execution.
- Child progress survives same-process extension reload and works for native and AgentSH single, parallel, and chain groups.
- Groups launched after `wait_any` or `wait_all` starts do not extend that wait.

## Resolution
- Added process-owned child progress with stable request-order identities and same-process reload adoption.
- Added bounded `wait_any`, `wait_group`, and snapshot-based `wait_all`; retained `wait` as the group alias.
- Kept wait cancellation observational: only explicit `cancel` terminates execution.
- Preserved completion notifications for waits that report status without exposing retained output.
- Fixed queued native child states, chain boundary updates, pending-launch visibility, and foreground-handoff ownership races discovered during review.

## Validation
- `nix build .#checks.x86_64-linux.subagent .#checks.x86_64-linux.sandbox .#packages.x86_64-linux.default --no-link -L`
- `nix flake check --no-build`
- `git diff --check`
- Two focused reviews plus a post-fix review; the final review reported `No blocker.`
