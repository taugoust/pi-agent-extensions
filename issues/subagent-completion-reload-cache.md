# Subagent completion wake-up code remains stale after reload

## Status

Fix implemented and validated; publication pending.

## Evidence

Two live completion probes finished successfully but did not wake their idle parent. Their receipts were `recorded`, not `queued`/`delivered`, despite `completion: true`. The second probe followed an explicit `/reload`. The installed quiet-state implementation queues completions, so this was not a failure to observe child termination.

`subagent/index.ts` imported `shared/quiet-state.js`. Pi/Jiti retained the older transitive module across replacement of Nix-style links and reload. The background-job entrypoint already used an explicit `.ts` import and its completion notifications continued working.

## Change

Use the explicit `.ts` quiet-state import from the subagent entrypoint, matching the previously established hot-reload convention.

A no-model real-Pi regression loads the entrypoint's actual imported binding against a prior routine-only notification fixture, replaces links with the current implementation, and reloads the same process. Before the fix the wake request never arrived; after the fix the public extension API receives the completion message with `triggerTurn: true`.

Historical `recorded` receipts are deliberately not replayed: waking for old completed tasks would create a notification storm. Verify activation with a newly launched child.

## Validation

The real-Pi reload regression failed before the import change and passed after it. The full `checks.x86_64-linux.subagent` check passed, including the new reload regression, 40 native tests, and real TUI/root-control tests. No live user panes were closed by the tests.
