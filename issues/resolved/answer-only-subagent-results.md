# Answer-only subagent result retrieval

## Status
Resolved.

## Resolution
Commit `9759d7211c937037a14dea213e492843cdb2fb29` makes `operation=result` return the worker answer without the generated task-outcome/RPC metadata envelope. `diagnostics=true` retrieves the original retained report. Existing artifacts remain unchanged and checksum-verified; pagination offsets and response checksums apply to the selected view. Compatible retained managers refresh their reader on reload without replacing live runners.

A direct Pi 0.85.0 probe verified default and diagnostic views, UTF-8 pagination, ordinary diagnostic-like answer text, and retained-reader refresh. The existing in-session worker artifact shrank from 2,976 bytes to its exact 22-byte answer in the default view. A regression was added to the existing subagent check.
