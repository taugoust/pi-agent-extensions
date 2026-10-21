# Native terminal BTW

## Status

Implemented for the unpublished review batch.

## Implementation

- Adapted the candidate pi-btw 0.61.2 sources at `012c08dc9c17f7ef4adaf92c6a5fe1d036653c7c` into `btw/candidate/`.
- A single `/btw` dispatcher lazily loads the candidate manager/chat in native TUI mode. Existing Paseo service lifecycle and RPC command behavior remain separate and intact.
- Preserved candidate context picking, settings, resume, layouts, search, steering and explicit draft transfer. Native defaults/settings remain the candidate's, separate from Paseo's cheap model.
- Added UI/concurrency gates, session-lifecycle cancellation and stale asynchronous-operation guards. Session changes clear retained terminal threads and detach old subscriptions.
- Bundled the toolkit and Markdown dependencies with hash-pinned Nix fetches, leaving Pi SDK imports external. The highlighter's opaque createRequire lookup is adapted into a static bundle import. Dependency licenses are retained.

## Review evidence

Production terminal bundle built successfully with Nix/esbuild. Source inspection found no concrete incompatibility with the installed Pi 1.0 public declarations. No tests, typechecks, smoke scripts, paid side-question probes or other extra validation runs were performed. Production build and switch succeeded to `/nix/store/g8bxajlfmzqiasq0002lsjypb2xdbvrk-nixos-system-matebook-26.05.20260916.4c78701`. Temporary Nix check/smoke omissions were restored afterward. Actual terminal interaction remains for user review after reload.
