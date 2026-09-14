# Retained legacy native subagent groups cannot be explicitly reaped

## Status

Implemented locally; pending review and commit.

## Problem

A resumed pi-unsafe session on Rose lists retained native subprocess groups under
“Retained AgentSH/legacy groups”, but `subagent operation=reap` rejects them with
“requires an owned native TUI group”. These records are native, not AgentSH.

## Implemented behavior

- Route legacy native reap to session-ownership-checked, terminal-only storage
  cleanup. Remove the record, notification marker, and retained `result-N.md`
  reports only. No child process or pane identity exists in this record schema;
  cleanup must never infer authority over a PID or tmux pane.
- Refuse active executions, pending persistence, concurrent result migration,
  unsafe/unexpected storage entries, disk identity/ownership changes, and live
  foreign executors. Linux process start tokens distinguish PID reuse without
  signalling the unrelated process. Unknown liveness fails closed.
- Native records no longer undergo automatic age/count pruning, which previously
  bypassed explicit cleanup ownership/liveness checks. AgentSH behavior is unchanged.
- List legacy native and AgentSH groups separately; unsupported AgentSH reap gives
  backend-specific guidance. `pi-unsafe` does not imply AgentSH.
- A hot-reloaded old V4 manager lacking safe reap remains intact and requests a Pi
  restart. Do not replace its live runner closures merely to gain the new method.

## Validation

`subagent/legacy-reap.test.ts` covers terminal statuses, foreign ownership,
AgentSH refusal, running/cancelling and reload/shutdown safety, concurrent reap
and result migration, stale-manager resurrection, changed disk records, native
retention, executor death/PID reuse, and unsafe storage entries. Included in
`nix/subagent-check.nix`.

No commit/deployment is part of this task. Move to `issues/resolved/` and record
the fixing commit after review/commit.
