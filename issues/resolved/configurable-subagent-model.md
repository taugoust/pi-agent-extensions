# Configurable subagent model defaults

## Status

Resolved.

## Resolution

Added agent-directory `subagent.json` with `defaultProvider`, `defaultModel`, and
`defaultThinkingLevel`, exposed through Home Manager's subagent options. The
router resolves these before native/AgentSH dispatch for single, parallel, and
chain tasks; explicit task model/thinking overrides win. Tool descriptions show
the configured default. Native child directories carry the config to descendants;
legacy resumes no longer receive an unrelated hardcoded TUI fallback.

Validation: configuration unit tests, native tmux unit tests, and the Nix
subagent check (without live Pi TUI integration) passed.
