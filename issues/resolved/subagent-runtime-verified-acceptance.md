# Subagent runtime-verified acceptance

## Status

Resolved.

## Resolution

Implemented in `b0dfe9e2938963698b21a8919ce4f31f8d494542`. Explicit optional verification gates now use worker-owned supervised jobs and live command permissions, retain literal bounded evidence, distinguish typed/business verdicts from real exits, invalidate stale/current acceptance, recover ambiguous dispatches without replay, and preserve unresolved evidence through cleanup. Runtime verification, worker reports, execution settlement and independent review remain separate. Upstream snapshot `3ce6185a` and MIT provenance are recorded in [THIRD_PARTY.md](../../THIRD_PARTY.md); the implemented contract and limits are documented in [Runtime verification](../../docs/subagent-verification.md).

Validation passed sequentially with `nice -n 19`, `--max-jobs 1` and `--cores 1`:

- `nix build .#checks.x86_64-linux.background-job --no-link -L`: 10 named Node tests plus real supervised command/permission/evidence/ambiguous-dispatch controls and stream/retention/watch/ownership fixtures.
- `nix build .#checks.x86_64-linux.subagent --no-link -L`: 177 named Node tests (123 native runtime/tool tests plus 54 legacy/config/profile/routing tests), no failures or skips, plus background-only schema reload and actual Pi reload/control/outcome/RPC fixtures.
- Additional offline real guard-only Pi controls verified exit-zero acceptance, exit-seven rejection, read-only denial, literal output, reload invalidation and cleanup without provider credentials. Independent review cleared the implementation and adversarial regressions.

Unsupported headless/full-AgentSH verification remains explicitly unavailable, not bypassed. Disk-only/reloaded/reaped evidence never restores current acceptance; native same-UID execution is not an OS isolation boundary. Conservative byte-tree identity and the supported JSON Schema subset are explicit limits. No Paseo UI changes, deployment or protected-runtime restart are included.

## Outcome

Adapt runtime-verified acceptance directly from `candidates/pi-subagents`, so explicit verification commands—not worker claims—determine whether configured checks passed. Preserve our separate Pi RPC/TUI workers, tmux lifecycle, retained conversations, and Paseo integration.

Related planned work: [scripted workflows and dynamic orchestration](../subagent-scripted-orchestration.md) and [reusable profiles](subagent-agent-profiles.md). No Paseo changes in the current scope.

## Upstream reference

- Repository: https://github.com/nicobailon/pi-subagents
- Reviewed snapshot: `3ce6185a`.
- Reuse/adapt relevant code in `src/runs/shared/acceptance.ts` and focused tests, including `test/unit/typed-gate-output.test.ts`, rather than independently recreating the feature from its description.
- Reference contract: `docs/tool-reference.md`, acceptance gates section.
- Preserve upstream license notices and attribution for copied/adapted code; document provenance in `THIRD_PARTY.md`.

## Requirements

- Distinguish worker execution settlement, worker-reported acceptance evidence, runtime verification, and independent review. A process finishing is not proof of delivery; passed checks are not proof that all task requirements are correct.
- Support explicitly configured verification commands in the worker's actual cwd/worktree, with bounded output, timeouts, cancellation, and durable results. Explicit failed gates must prevent accepted delivery; unconfigured checks must never appear passed.
- Adapt upstream typed JSON gates and relevant failure tests where applicable. Invalid/truncated/schema-invalid output cannot silently become successful verification. A business verdict in valid JSON is distinct from command execution success.
- Execute commands through our existing supervised job/permission boundaries, not upstream's direct host-shell spawning. Verification must not expand a read-only task's authority or bypass AgentSH, approval, or worker ownership controls.
- Retain literal stdout/stderr and real exit/timeout/cancellation outcomes with the command, cwd, time, and workspace identity. Do not substitute a model summary for evidence.
- Bind evidence to the checked workspace state. Relevant changes invalidate current passed status; avoid claiming that command/workspace fingerprints prove full environmental reproducibility. Do not blindly copy caching assumptions.
- Preserve existing notification deduplication, parent wakeup behavior, explicit reap, and descendant/job cleanup. No duplicate terminal success before required verification settles; no invisible/orphaned verification work.
- No delegation budgets, agent-profile system, scheduling, or execution-backend replacement in this task.

## Deferred Paseo presentation

Future reference only; Paseo implementation and UI validation are explicitly out of the current scope.

Use the existing Work child row/detail surface, not a new dashboard. Keep execution state and check state separate:

- `Working` while the worker is active.
- `Worker finished · Checking 1/3` while runtime verification is active.
- `Checks passed 3/3` only after all required configured gates pass.
- `Checks failed 1/3` with the failed command readily accessible.
- Explicit `Not configured`, `Interrupted`, `Unavailable`, or `Stale` states where appropriate; never render these as green success.

An expandable Checks section lists each command, outcome, duration, checked workspace/revision and timestamp, with literal stdout/stderr available on demand. Keep the compact row quiet; do not dump logs into chat or change existing Work pill count/priority semantics. Display independent review separately from command checks. These labels are a UI proposal, not an implemented contract.

## Acceptance evidence required

- Offline deterministic positive and negative controls demonstrate that fabricated worker success cannot bypass a failing command, while a passing configured command records real evidence.
- Cover nonzero exit, timeout, cancellation, missing permission/backend, invalid typed output, workspace changes, reload/restart recovery, and cleanup without live providers or real credentials.
- Native worker/tool tests verify the structured state, no premature accepted completion, and access to unmodified command output. Paseo integration and device validation are deferred.
