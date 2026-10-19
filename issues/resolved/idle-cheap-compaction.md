# Use a cheap compaction model after the idle warning threshold

## Status

Resolved.

## Problem

The idle-context warning identifies sessions whose prompt cache may have expired, but manual and automatic compaction still use the selected conversation model. A cold large-model compaction can therefore be unnecessarily expensive. The warning's context-percentage gate must not govern compaction-model selection.

## Required behavior

Below the existing idle threshold, retain normal Pi compaction. At or above it, use an explicitly configured `cheapCompactionModel`, independently of context percentage, without changing the conversation model or thinking level. Reuse the active branch's persisted model-response timestamp across restored sessions. A failed or aborted cheap compaction must cancel rather than silently falling back to the conversation model.

## Implementation

`idle-context-warning` registers `session_before_compact` for manual, threshold, and overflow attempts. It uses the public native `compact()` algorithm with Pi's model-registry stream/authentication path and returns its summary, retained boundary, usage, and details. Native preparation/custom instructions and split-turn behavior remain intact. Each generated response must finish successfully with nonempty text and no tool calls; exceptions and aborts return `{ cancel: true }`, even if diagnostic UI reporting fails.

Pi marks extension results `fromHook`, which normally excludes their file lists from later preparation. Tagged native-format details are restored from the latest compaction into the next preparation on both cheap and normal routes. Unknown extension detail formats are left alone.

The nullable Home Manager option is `programs.pi.extensions.idle-context-warning.cheapCompactionModel`. It generates the JSON key of the same name and installs both helper modules. Exact `provider/model[:thinking]` selectors support subagent thinking suffixes, defaulting to `low`; null/missing configuration leaves ordinary compaction enabled. Existing `idleMinutes` and warning-only `contextPercent` remain compatible. Malformed/unreadable configuration cancels compaction conservatively; a missing file retains defaults.

## Validation

- 57 Bun tests passed (160 assertions): manual/automatic routing, exact thresholds, warning independence, restored timestamps, configuration and selectors, native summary preparation, instructions, split turns, usage, cumulative file tracking, errors, aborts, and failing UI notifications.
- Strict production TypeScript check passed against the existing Pi 1.0.0 SDK (`tsc --noEmit --skipLibCheck --strict --module esnext --moduleResolution bundler --target es2023 --allowImportingTsExtensions idle-context-warning/index.ts`).
- `nix build 'path:.#checks.x86_64-linux.idle-context-warning' --no-link` passed: selector/null JSON, disabled extension behavior, and installed helper files.
- Installed Pi 1.0.0 loaded the extension and native `compact` import in an isolated RPC session. No model calls were made.
- `git diff --check` passed. No deployment performed.

## Resolution

Implemented and published in `b62d974`. Shared Nix configuration wires the selector to the subagent default; activation remains separate.
