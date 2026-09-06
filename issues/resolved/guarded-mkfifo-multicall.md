# Guarded native launches lost mkfifo multicall dispatch

## Status
Resolved.

## Problem
The in-session UX probe failed before worker startup: `coreutils: invalid option -- 'm'`. Guarded executable validation canonicalized Nix's `mkfifo` symlink to the shared `coreutils` binary, losing the invocation name required for multicall dispatch.

## Resolution
Commit `4b8922ecf5d2e541c480f4876d66a23e4c1a3c7b` sets `argv0: "mkfifo"` while retaining the validated immutable executable path. The existing sequential process-group regression now canonicalizes its FIFO executable, matching guarded launches. A direct spawn of the deployed Nix coreutils binary confirmed successful FIFO creation with mode 0600. Full in-session worker validation requires deployment and reload.
