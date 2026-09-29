# Modal editor cursor ownership

## Status

Fix implemented and regression-tested; pending affected-terminal visual confirmation.

## Problem

With hardware cursors enabled, INSERT removes Pi's software inverse-video cursor, but NORMAL retains it while also selecting a hardware block at the same position. Overlapping blocks can lose visible contrast depending on terminal rendering. The reported disappearance occurs both directly and through tmux after a Pi update; the specific upstream trigger is unconfirmed. Installed Pi 0.85.0 still emits the expected software cursor sequence.

With hardware cursors disabled, the old INSERT rendering also removed the only visible cursor.

## Changes

The editor now removes only the marker-anchored software cursor when hardware cursors are enabled, in every mode. It preserves the cursor marker, unrelated inverse-video content, and the software fallback when hardware cursors are disabled. The modal-editor Nix check covers ownership, mode transitions, empty/EOL cursor cells, Unicode graphemes, focus, and visual selection preservation.

Published with the accompanying cursor-ownership fix. The Nix modal-editor check, Nix formatting, and whitespace validation passed. Keep this issue open until the reported terminal behavior is verified after deployment.
