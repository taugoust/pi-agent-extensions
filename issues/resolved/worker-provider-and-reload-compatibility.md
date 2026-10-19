# Worker provider defaults and reload compatibility

## Status
Resolved for defaults, reload compatibility, and cleanup diagnostics.
Automatic legacy-controller replacement remains outside this fix.

## Evidence

October 19 workers started with openai/gpt-6-luna, completed one tool request,
and then failed after selection changed to openai/gpt-5.5. Native model
resolution preserves explicit references; the import/attachment problem is
being fixed separately in nix-config's packaged Paseo. A Codex fallback failed
with refresh_token_invalidated; Codex is deprecated for this installation and
must not be a missing-config default. No credential contents were inspected.

Earlier sessions reported `requireAcceptance is not a function` after harness
updates. The entrypoint imported outcome through a .js-to-TypeScript alias,
matching the previously reproduced transitive reload cache failure. Extend
the real Pi, same-process symlink-update regression to cover the missing export
and ensure the new acceptance validation works after reload.

Legacy workers lacking recursive cleanup support must remain protected against
unverified pane deletion. The existing error incorrectly prescribed reload
without explaining that an explicit immutable --extension entrypoint can stay
pinned. Distinguish failed capability queries from legacy capability absence,
and explain the pinned-controller limitation without weakening cleanup proof.
Legacy controller replacement/recovery itself is not automated by this change.

## Validation
`nix build .#checks.x86_64-linux.subagent --no-link -L` passed, including
same-process Pi activation/reload checks for acceptance exports and model
defaults, and 85 native TUI/descendant tests. Legacy cleanup refusal still leaves
the worker unsealed and never issues a tmux mutation.

## Resolution

Implementation: `ba14dab`. No live worker was restarted, upgraded, or killed.
The packaged Paseo import fix is tracked in nix-config separately.
