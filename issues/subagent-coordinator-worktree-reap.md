# Coordinator worktree cleanup on reap

## Status

Implemented; awaiting validation and review.

## Scope

Trusted coordinator profile metadata opts the worker into guarded task-worktree cleanup at idle reap. Ordinary worker/scout profiles remain unchanged. Cleanup is a required callback for opted-in workers and runs after job/descendant cleanup but before sealing; failure keeps the coordinator unsealed and repairable.

Force reap forwards the explicit reason, bypasses configured verification, and permits coordinator destruction even when worktree cleanup cannot complete; it does not remove dirty or otherwise protected worktrees. Durable leftover registry audits record worktrees left behind. Legacy RPC coordinators without authenticated ancestry fail closed on normal opted-in reap; forced reap audits discoverable leftovers and inventory uncertainty without removing worktrees. It does not fabricate verification acceptance, remove branches, merge changes, mark work complete, or change task completion automatically. Only managed task worktrees registered in the cleanup inventory are covered; external/unregistered worktrees are outside scope.

## Validation

`subagent/tui-worker-reap.test.ts` covers cleanup ordering, same-request retry after failure, forwarded force options, policy-off behavior, mandatory callback, and the asynchronous activity race. `subagent/worktree-reap-manager.test.ts` checks policy attribution, reserved target projection, and failure retention; `subagent/tui-worker-tmux-reap-policy.test.ts` checks the destructive pane-removal boundary. These tests run in `nix/subagent-check.nix`. `shared/worktree-reap.integration.test.mjs` covers registered inventory, ancestry, force audits, dirty/active protection, and recovery; it runs in `nix/workflows-runtime-check.nix`.
