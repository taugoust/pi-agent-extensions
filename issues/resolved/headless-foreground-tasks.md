# Headless foreground tasks with an interactive parent panel

## Status

Resolved in `0fc2261`. Companion panel: `paseo-bridge-pi` commit `9a67610`. Existing workers and DOS deployments were not migrated.

## User-approved behavior

Foreground helpers must not create tmux panes, windows, or staging sessions. Their owning visible Pi agent exposes a temporary Paseo task view for conversation, direct user instructions, questionnaires, individual permission decisions, and stopping work. Closing the view only hides it.

Background workers retain their existing TUI/tmux behavior and may launch foreground helpers. Foreground helpers do not delegate further. Existing Jobs/Subagents dashboards remain read-only. Promotion must never silently restart or replay a task; unsupported promotion is explicit.

## Runtime requirements

- Use the verified native/guard-only launcher and preserve mandatory AgentSH authorization.
- Keep process ownership, task/attempt identity, replay-safe commands, retained history and explicit reap independent of UI connection lifetime.
- Distinguish authenticated direct user instructions from parent guidance.
- Pending questionnaire/permission requests remain pending when the panel closes. Stale, invalid, expired, cancelled or disconnected requests never approve execution.
- Preserve background-worker lifecycle behavior and measured-context compaction policy.
- Validate the real worker, bridge and compiled plugin together, including guarded interaction paths and negative lifecycle cases.

## Validation

Nix subagent, background-job, permission-gate and questionnaire checks passed, including 58 native/TUI tests. A strict core typecheck against Pi 0.85 declarations passed. Isolated real Pi tests on Matebook passed in native and guarded modes, including real questionnaire and permission-gate tool flows, startup Stop ordering, queued-work cancellation, retained history, actual Pi PID verification, and no foreground tmux placement. The compiled Paseo backend/private socket also passed against real foreground workers with a deterministic no-network provider.

The initial release is Linux native/guard-only. Promotion is explicitly unsupported. Parent ownership/lifecycle still applies; closing a panel is not cancellation. Mobile visual confirmation was not performed. The coordinated UI lives in `paseo-bridge-pi`; existing workers and DOS deployments were left unchanged.
