# AgentSH approval terminal bell

## Status

Resolved.

## Problem

When Pi runs inside a remote tmux session nested in a local tmux session, an AgentSH approval prompt can remain unnoticed. The macOS AgentSH notifier does not cover every remote interactive session.

## Desired behavior

Allow the AgentSH approval UI to emit one terminal bell when it starts waiting for a decision, so nested tmux layers can relay the bell to the local terminal.

## Resolution

Commit `8a05ba5` added an opt-in `PI_AGENTSH_APPROVAL_BELL` notification and regression coverage that verifies exactly one BEL is emitted when an approval prompt opens.
