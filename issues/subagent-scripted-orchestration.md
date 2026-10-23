# Subagent scripted workflows and dynamic orchestration

## Status

Open. Requested as planned work alongside runtime-verified acceptance; implementation is not started. This backlog entry does not activate Goal mode.

## Outcome

Adapt scripted orchestration directly from `candidates/pi-subagents`: reusable programs can launch children dynamically, collect results, branch on outcomes, and coordinate implement/review/fix loops through our existing subagent runtime.

## Upstream reference

- Repository: https://github.com/nicobailon/pi-subagents, reviewed snapshot `3ce6185a`.
- Start from `src/workflows/scripted-workflow.ts`, the workflow documentation, and associated workflow validation/execution tests. Copy/adapt applicable implementation and tests rather than recreating the feature from its description.
- Preserve upstream license notices and attribution; document copied/adapted code provenance in `THIRD_PARTY.md`.
- Related task: [runtime-verified acceptance](subagent-runtime-verified-acceptance.md).

## Requirements

- Support reusable scripted sequential/parallel coordination, dynamic fan-out from earlier results, fan-in, conditional steps, and review/fix loops with explicit stopping conditions.
- Adapt the upstream orchestration layer to our existing launch, prompt, wait, result and resume primitives. Preserve separate Pi RPC/TUI workers, tmux placement, retained conversations, explicit worktrees, AgentSH authority and fail-closed backend selection. Do not adopt the upstream execution backend or replace the worker lifecycle.
- Track and observe every launched child and control operation, including losing branches of races and error paths. A script returning must not silently orphan active work or claim all children completed.
- Distinguish accepted launch/control requests, execution settlement, task delivery, verification and review results. Integrate the verified-acceptance task rather than treating worker prose as a successful gate.
- Define honest cancellation, parent disconnect, reload/restart and retained-work recovery semantics. Do not imply that an arbitrary JavaScript continuation survives a process restart, replay completed mutations, or relaunch work after ambiguous dispatch.
- Preserve existing concurrency controls and notification deduplication. Cost/token budgets remain owned by goals/accounts or another higher-level policy; do not import upstream delegation budgets.
- Workflow scripts and resource provenance must have explicit authorization boundaries. Do not copy direct host-command execution or allow scripts/child outputs to expand permissions, bypass AgentSH, or authorize new scope. Do not represent ordinary JavaScript execution as a security sandbox.
- Keep this task focused on orchestration; do not also import missions, schedules, watchdogs, agent catalogs, or a new project-management layer.

## Paseo outcome

Present an orchestration as a structured group in the existing Work surface with named steps, dependencies, dynamically created children, current review/fix iteration, and explicit blocked/failed/checking states. Preserve direct access to each real worker conversation and terminal. Keep literal results/logs available on demand rather than flooding parent chat. Retain existing Work pill count/priority meanings; an orchestration group is not an additional running worker.

## Acceptance evidence required

- Offline deterministic tests cover dynamic fan-out/fan-in, conditional failures, review/fix stopping, result ordering, rejected/unobserved launches, cancellation, partial results, recovery and permission failures without live providers or real credentials.
- Verify compatibility with single/parallel/chain calls, retained resume, worktree ownership and explicit recursive cleanup; do not silently change those existing contracts.
- Composed native-worker and Paseo tests show actual structured progress, worker controls, verification/review outcomes and non-duplicated completion. Record native-device validation separately from desktop tests.
