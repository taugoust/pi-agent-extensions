# Translate supervised subagent working directories into the AgentSH workspace

## Status

Resolved.

## Problem

A directly supervised Pi can retain the real project directory as `ctx.cwd` while AgentSH executes the session from a shadow workspace. The sandbox extension forwarded that absolute real-project path to `spawn_subagent`. AgentSH correctly rejected it because it was outside the effective session workspace, producing:

```text
subagent cwd must be inside the session workspace
```

This affected omitted `cwd` as well as explicit absolute paths under the real project. Relative cwd handling alone did not solve the mismatch.

## Resolution

Commit `5b224dd` maps the parent Pi cwd and explicit real or shadow paths through AgentSH supervisor metadata into the virtual workspace before spawning a child. Relative single, parallel, and chained cwd values are then resolved from that virtual parent directory.

The sandbox Nix check covers omitted cwd, real-project absolute paths, shadow absolute paths, and nested relative parallel/chain requests.
