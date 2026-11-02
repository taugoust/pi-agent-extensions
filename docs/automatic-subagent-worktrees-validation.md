# Automatic subagent worktree validation

Candidate is implemented in isolated branch `goal/subagent-auto-worktrees`, based on published `464117b`. Publication, the coordinated Nix pin and Adelaide deployment are parent-controlled, not implied by these local checks.

## Passing gates

```sh
nix build .#checks.x86_64-linux.subagent .#checks.x86_64-linux.workflows-runtime \
  --no-link --keep-going -L
```

Passed (exit 0). Native/runtime subagent suite: **199/199**. Workflows-runtime: **151/151**, plus its immutable-package registration checks. The subagent gate also runs its existing legacy/config/profile/routing/control suites. Git is now an explicit Nix test dependency for the disposable repository canary; no package is installed globally.

Additional focused run:

```sh
node --experimental-transform-types --test shared/automatic-worktrees.integration.test.mjs subagent/profiles.test.ts
```

Passed **28/28**. Existing shared completion/reap/metadata regression run passed **48/48** before the new automation cases; the final workflows gate includes both existing lifecycle and new automation coverage.

All runtime models/providers in these tests are deterministic offline fixtures. No paid inference, user workers, accounts, production repositories or live deployment are exercised.

## Requirement evidence

| Requirement | Evidence |
| --- | --- |
| Spawning coordinator defaults on, ordinary parent unchanged, per-item overrides, no Goal dependency | `automatic-worktrees.integration.test.mjs`: trusted-parent policy test; actual root canary launches non-Goal coordinator and ordinary worker, verifies coordinator root is not automatically isolated |
| New repository isolation; dirty include/exclude remains explicit; non-Git fails actionably or explicit false opts out | Automatic integration provisioning/snapshot tests; real native root canary verifies primary branch/working tree unchanged |
| Exact parent-owned cwd reuse without copying dirty partial work | Integration replacement/resume test preserves staged and untracked files in the same physical path; nested supervisor/foreign tests; real native canary verifies one registry record and released borrower rather than a second snapshot |
| Exclusive/active/foreign/physical/branch fences | Integration active borrower/managed activity, unavailable inventory, changed branch/admin identity, stale attempt release and foreign-owner tests; existing native/headless managed-activity tests remain green |
| Parent cleanup option and durable blocked retry | Real root optional ordinary-worker cleanup; `worktree-reap-manager.test.ts` sticky optional cleanup; headless optional cleanup after verified sealing test |
| Mandatory normal coordinator cleanup across nested/multiple repositories | Real root coordinator canary removes its owned root/nested tree before closure; shared nested/multi-repository cleanup tests; existing root-last/partial-failure/retry tests |
| Borrowed nested coordinator retains ancestor root without deadlock or ownership transfer | Integration borrowed-coordinator test blocks on dirty own descendant before detach, removes its two owned repository trees, preserves parent root, retries after durable detach, and verifies eventual original-owner removal |
| Explicit cleanup of a still-shared borrowed root refuses | Integration shared-root test returns creator/supervisor blocker; force audits the original/borrower identities and leaves files in place |
| Audited force escape hatch does not weaken permission/activity/job/descendant/pane/verification safeguards | Existing reap/server/launcher/acceptance suites; new shared-root force audit case; preserved branch refs and original cleanup service |
| Startup/reload recovery | Deterministic empty/partial/published/malformed/oversized session-header tests; strict cleanup still refuses incomplete identity; actual nested startup canary passes; existing parent crash/rehydration tests pass |
| No planning/review/merge machinery added | Changes use existing manifest, registry, launch and reap paths; no new goal prerequisite, merge operation, approval channel or review runner |

Native root canary sequence (inside the automated real-Pi/Tmux fixture):

1. Ordinary parent launches a coordinator from a disposable clean repository without a root worktree request. The coordinator's authenticated profile causes its ordinary child to provision isolation; child normal reap retains the tree; coordinator normal reap removes it while preserving source/branch.
2. Parent explicitly isolates a coordinator with `worktree: {}`. Its ordinary nested child automatically reuses that exact root, then normally reaps/releases its borrower. Parent normally reaps the coordinator and verifies physical removal with branch preservation.
3. Ordinary worker explicitly gets a new tree and the parent reaps it with `cleanup_worktree: true`; path is removed and the primary checkout remains clean.

## Baseline gate failure (not reported as green)

`subagent-profiles` still fails in the old dedicated RPC fixture after the published ordinary-managed Goal refactor. Reproduced separately on **untouched `464117b67b0ac20755c42e23e6cdbc6872e18a0f`**:

```sh
nix build "git+file://$PWD?rev=464117b67b0ac20755c42e23e6cdbc6872e18a0f#checks.x86_64-linux.subagent-profiles" \
  --no-link -L
```

Both base and candidate fail with:

```text
dedicated proof absent ... TUI workers require a calling tmux pane
at tests/subagent-profiles-native.mjs:153
```

Base derivation: `/nix/store/23h2jz16h10mf5p4gqziyy8ab44cscvq-pi-subagent-profiles-native-check.drv`.
The new ordinary-managed Goal/real root tests and profile unit tests pass in the subagent gate. This baseline comparison is not a passing profiles gate, waiver, full-flake result or deployment proof; no unrelated production workaround is included.

## Recovery and retained evidence

Original task edits from shared main at `269f085` were copied to the isolated task worktree and independently archived byte-for-byte before restoring only hash-matching task paths on shared main. `.dev/recovery/manifest.json` records SHA256 hashes, original files and the binary patch; preexisting unrelated main `.dev` was left untouched. The worktree and private validation logs are retained for coordinated integration and recovery, not deleted to manufacture a clean directory. No task implementation edits were made in shared main after recovery.
