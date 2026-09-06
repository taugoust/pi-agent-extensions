# Guarded native launches lost mkfifo multicall dispatch

## Status
Resolved.

## Problem
The in-session UX probe failed before worker startup: `coreutils: invalid option -- 'm'`. Guarded executable validation canonicalized Nix's `mkfifo` symlink to the shared `coreutils` binary, losing the invocation name required for multicall dispatch.

## Resolution
The initial `argv0` fix (`4b8922ecf5d2e541c480f4876d66a23e4c1a3c7b`) passed isolated checks but the existing reloaded session still failed. Fresh Pi 0.85.0 probes, both direct and under AgentSH, honored argv0, so a general Bun argv0 defect was not established.

Commit `f3e50f1f5d6b0df6106fde055634f39a6d1a206f` preserves the immutable Nix-store `mkfifo` alias after verifying that it resolves to the already-validated executable. This also works with retained older launch helpers. The launcher additionally uses `--coreutils-prog=mkfifo` when explicitly given a canonical coreutils binary. The sequential process-group regression canonicalizes its FIFO executable. A fresh Pi probe verified successful process-group startup, readiness, and exit with canonical coreutils, directly and under AgentSH. In-session verification remains pending deployment/reload.
