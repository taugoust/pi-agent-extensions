# Coordinator worktree cleanup on reap

## Status

Resolved.

## Scope

Trusted coordinator profile metadata opts the worker into guarded task-worktree cleanup at idle reap. Ordinary worker/scout profiles remain unchanged. Cleanup is a required callback for opted-in workers and runs after job/descendant cleanup but before sealing; failure keeps the coordinator unsealed and repairable.

Force reap forwards the explicit reason, bypasses configured verification, and permits coordinator destruction even when worktree cleanup cannot complete; it does not remove dirty or otherwise protected worktrees. Durable leftover registry audits record worktrees left behind. Legacy RPC coordinators without authenticated ancestry fail closed on normal opted-in reap; forced reap audits discoverable leftovers and inventory uncertainty without removing worktrees. It does not fabricate verification acceptance, remove branches, merge changes, mark work complete, or change task completion automatically. Only managed task worktrees registered in the cleanup inventory are covered; external/unregistered worktrees are outside scope.

## Resolution

Implemented in `5546473760e5f94432eef7f5ebea6aca20403f65`: trusted retained profile policy, guarded branch-preserving root/nested cleanup, durable partial recovery and forced leftover audits, plus fail-closed legacy handling. Native task regression (176 tests), workflows regression (110 tests), offline profile/coordinator runtime checks and local guarded-service/completion fixtures (40 tests) pass. See [retained validation evidence](../../docs/coordinator-worktree-reap-validation.md), including independently reproduced baseline full-flake failures. The task branch/worktree remains retained for parent review; nothing was published or deployed.

## Validation

`subagent/tui-worker-reap.test.ts` covers cleanup ordering, same-request retry after failure, forwarded force options, policy-off behavior, mandatory callback, and the asynchronous activity race. `subagent/worktree-reap-manager.test.ts` checks policy attribution, reserved target projection, and failure retention; `subagent/tui-worker-tmux-reap-policy.test.ts` checks the destructive pane-removal boundary. These tests run in `nix/subagent-check.nix`. `shared/worktree-reap.integration.test.mjs` covers registered inventory, ancestry, force audits, dirty/active protection, and recovery; it runs in `nix/workflows-runtime-check.nix`.
