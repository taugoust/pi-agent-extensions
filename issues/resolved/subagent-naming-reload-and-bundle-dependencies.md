# Subagent naming reload and narrow-bundle dependencies

## Status

Resolved in source; deployment verification is tracked with the harness regression release.

## Problem

After activation and same-process reload, the subagent entrypoint could retain an older `tui-names.js` import lacking `validateSubagentDisplayName`. Launches failed before creating a worker. Separately, fresh supervised Pi sessions failed to load narrow subagent bundles because `shared/subagent-worktrees.ts` imported workflow implementation files omitted from those bundles.

## Resolution

Import the naming helper through its actual `.ts` path, consistent with the other native worker imports. Extend the real same-process reload fixture to introduce the display-name validator across an activation and verify valid and invalid names after reload without changing PID.

Include only the two worktree implementation modules required by the subagent runtime in narrow bundles. Do not enable the workflows extension or change security-extension selection. Assert those files exist in both subagent-only and sandbox-only bundles while workflows remains absent from their extension manifests.

## Validation

`nix build .#checks.x86_64-linux.subagent --no-link --max-jobs 1 --cores 2 -L` passed, including 140 runtime tests, real Pi reload fixtures and narrow-bundle assertions. The replacement `gpt-6-astra` worker was launched using the complete installed extension bundle through the normal supervised wrapper; its session records confirm the requested provider/model. No protected parent process was restarted.
