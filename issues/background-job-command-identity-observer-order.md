# Background-job runner observes children after fallible identity lookup

## Status

Open; separate follow-up investigation. Not the cause of the confirmed Rose startup failures.

## Finding

`background-job/runner.mjs` calls `publishProcess(child.pid)` before registering stdout/stderr, error, and close listeners. If the identity read throws, the catch path signals the child process group without a saved identity, writes failure 125, and exits before draining child output or observing its actual status. Missing shell executables also bypass the asynchronous child error/close path because `child.pid` is absent.

A deterministic local fault injection making `/proc/<child>/stat` throw ENOENT produced exit 125 and lost both streams for a command that printed stdout/stderr and exited 0. This is injected evidence, not a natural timing reproduction under the deployed runtime, and it must not be confused with the missing runner-module launch failure.

## Scope concerns

Simply continuing without process identity can make cancellation impossible or unsafe. A separate fix needs to preserve identity ownership, command output/status, and cancellation of descendants, with tests for natural fast exits, asynchronous spawn failure, identity-read failure, and cancellation. No runner or signaling changes are included in the discovery-path fix.
