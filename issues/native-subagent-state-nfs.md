# Native subagent state NFS issues

## Status

Resolved.

## Problem

Native TUI subagent state defaults to `~/.local/state/pi-tui` instead of honoring `XDG_STATE_HOME`. Periodic observation also synchronously rewrites every owned group once per second, including unchanged records, causing needless fsync/atomic-rename pressure on network filesystems.

## Resolution

Implemented in the native state-root and persistence changes; verified by the focused Linux subagent Nix check.
