# Legacy OpenAI usage selection

`/usage` is retired. Use `/accounts` → choose provider → **Credential status and usage link**. This reports only local session-bound credential status and the official usage settings URL, never quota/billing metrics or remote entitlement.

The `openai-usage` entrypoint is retained as an inert compatibility resource. Nix `programs.pi.extensions.usage.enable` and package selections pull in `openai-accounts` through the shared dependency closure. Prefer `programs.pi.extensions.accounts.enable = true;` and remove `usage.enable`. Non-Nix package filters must select `openai-accounts` explicitly. The account-controls service and its bridge `usage` data remain supported.
