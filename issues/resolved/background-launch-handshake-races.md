# Background launch identity, readiness and pane geometry failures

## Status

Resolved.

## Problem

Rose's later read-only diagnostics reported no space for a new pane, a vanished `/proc/<pid>/stat`, and the background runner's ten-second launch-gate timeout. The timeout occurred before command execution, independently of the earlier completed Vivado work. The exact source of the incident's controller delay was not retained.

## Resolution

`bb94d8b` publishes an atomic runner startup identity, verifies its live process token, batches pane ownership setup, and waits for the controller with cancellation/terminal-result/liveness checks and a bounded 120-second ceiling. A nonce-validated pipe holds the command shell until its process identity is recorded; EOF cannot execute the command. Failed launch cleanup is restricted to the matching owned pane. A definitive no-space error permits one same-window tiled-layout recovery and retry; genuinely full windows still refuse without closing unrelated panes or creating hidden placements.

Validation: background-job Nix check, strict core typecheck, and all 58 subagent/TUI tests passed on an independent final rebuild. Coverage includes fast exits, >10-second delayed setup, controller loss, cancellation, bounded timeout, pipe EOF, cramped/full geometry, and exactly-once command execution. No Rose deployment or worker restart was performed.
