# Centralize SSH target routing and support retargeting

## Status

Resolved.

## Problem

SSH target ownership is split between the SSH extension, the sandbox extension, and trusted wrappers. The SSH extension contains both legacy raw-SSH behavior and partial supervised behavior, while supervised tools are backed by AgentSH. An active conversation cannot switch from one supervised machine to another or back to its sandboxed local project.

## Desired behavior

- The SSH extension owns local/SSH target selection in legacy and supervised sessions.
- The sandbox extension remains an optional AgentSH execution backend and does not own SSH presentation.
- `/retarget` with no argument selects the original sandboxed local project.
- `/retarget host[:path]` selects a fresh sandboxed session on that host; an omitted path uses the target login directory.
- Legacy `pi-unsafe` retargeting remains available through raw SSH.
- Supervised retargeting preserves the Pi conversation and never falls back to raw SSH after a sandbox failure.

## Resolution

Implemented by `ba93071`, with immediate pre-conversation retargeting fixed by `c17dea2`. The SSH extension now owns target selection and uses either legacy raw SSH or the published AgentSH backend. It writes a private wrapper handoff for supervised retargeting, while the sandbox API accepts the selected execution target and remains responsible for AgentSH operations and approvals. When Pi has reserved but not yet created a session file, the handoff explicitly requests a fresh empty replacement session.
