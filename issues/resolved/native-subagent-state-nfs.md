# Native subagent state NFS issues

## Status

Resolved.

## Problem

Native TUI subagent state defaults to `~/.local/state/pi-tui` instead of honoring `XDG_STATE_HOME`. Periodic observation also synchronously rewrites every owned group once per second, including unchanged records, causing needless fsync/atomic-rename pressure on network filesystems.

## Resolution

Fixed by commit `4aa5d7f`.
