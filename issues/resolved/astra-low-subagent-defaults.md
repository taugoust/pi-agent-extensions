# GPT-6 Astra / Low subagent defaults

## Status
Resolved.

## Resolution
Commit `ec309ba7915e313645ec84538ed4eba8ea75dbdf` applies `openai-codex/gpt-6-astra:low` before native/AgentSH routing for single, parallel, and chain launches. Explicit model choices remain supported; a recognized `:thinking` suffix overrides Low. Lifecycle operations and Draft dispositions are not rewritten. The shared Nix parent configuration separately sets Astra / Medium for managed systems.
