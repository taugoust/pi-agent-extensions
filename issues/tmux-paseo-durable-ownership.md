# Durable tmux/Paseo ownership and explicit reaping

## Status
Implemented for Linux; publication and Matebook live validation in progress. Rose deployment remains user-owned.

## User-approved requirements
- Linux only for this refactor; macOS is out of scope.
- Assume a clean start; no migration/rearrangement of old active work is required.
- Background single subagents occupy new tmux windows in the launching agent's tmux session. Group children occupy panes in one shared new window.
- Foreground subagents do not acquire visible tmux placement until dynamically promoted to background.
- Background jobs occupy panes in the calling agent/subagent's tmux window.
- Background subagents survive parent exit/crash, with retained task/owner relationships and direct human messaging.
- Completion is NOT reaping. Completed worker/job panes and reports stay inspectable.
- Explicit owner reaping through jobs/subagents APIs closes corresponding panes and releases runtime resources; normal parents are expected to reap.
- Paseo projects map to tmux sessions; Paseo windows map to tmux windows; Paseo tabs map to tmux panes. Existing tmux sessions are automatically discovered. Forks created in Paseo materialize in tmux.
- Changes may span harness, bridge, server, and Nix packaging. No Paseo UI changes (App Store deployment). Do not modify doctor-cluster-config.
- Automatically publish shared Nix lock updates for harness/bridge fixes; host activation remains separate.

## Safety and consistency
One worker process/session per agent, not concurrent Pi processes opening the same JSONL. Parent steering and direct messages need ordered delivery and explicit acknowledgement. Parent disconnect must not imply worker cancellation or tool authorization bypass. Runtime control metadata and pane identity must survive reattachment. Pane cleanup must verify ownership and distinguish terminal/reaped/cancelled states. New topology must not reintroduce model-triggering routine notifications.
