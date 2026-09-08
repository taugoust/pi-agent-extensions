# Dynamic AgentSH guard-only permission prompts

## Status
Resolved.

## Requirement
The operator must be able to turn approval prompts off/on without restarting the Pi parent or its children. Scope is the current parent session and its delegated children. Preserve the selection across /reload; new independent sessions remain protected by default.

## Design constraints
Use the existing AgentSH authorize/resolve protocol and retain exact execution receipts. Off means explicit operator-authorized automatic approval of guard-only prompt decisions, not skipping transport, authorization validation, or error handling. Broken or missing authority still fails closed. Full AgentSH filesystem/network/sandbox policy is outside this toggle. Children cannot change parent approval mode. Copied session records must not implicitly disable protection in a fork.

The source of the current restriction is the inheritedGateClaim branch of /permission-gate in permission-gate/index.ts, which reports that the launcher-owned gate cannot be disabled. This incident is independent of the notification replay storm and the Paseo fork resolver error.

## Resolution
Implemented `/permission-gate off|on|status` for guard-only sessions. Explicit off mode auto-resolves pending and future parent/child prompts while retaining authoritative AgentSH receipt validation. Mode lives in session-bound runtime authority, survives /reload, and resets on session/process replacement; it is not restored from model-writable or forked history. Full sandbox policy remains unchanged. `nix build .#checks.x86_64-linux.permission-gate --no-link` passed, including dynamic pending prompts, on/off, child authorization, reload, independent-session protection, and existing protocol failure checks.
