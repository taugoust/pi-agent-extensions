# AgentSH approval terminal bell

## Status

Open.

## Problem

When Pi runs inside a remote tmux session nested in a local tmux session, an AgentSH approval prompt can remain unnoticed. The macOS AgentSH notifier does not cover every remote interactive session.

## Desired behavior

Allow the AgentSH approval UI to emit one terminal bell when it starts waiting for a decision, so nested tmux layers can relay the bell to the local terminal.
