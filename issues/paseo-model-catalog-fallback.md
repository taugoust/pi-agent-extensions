# Paseo model label falls back when its catalog lacks the live model

## Status
Investigated read-only on Rose; upstream client fix remains open. No daemon restart or configuration edit performed.

## Evidence
On 2026-09-14, Rose's live Pi session, Paseo's persisted config/runtimeInfo/persistence metadata, and live `paseo --json inspect ef96f2bd-3ef7-4ad5-9aa1-b4705463e0b4` all reported `openai-codex/gpt-6-astra`. Latest assistant messages used Astra. Host-specific `~/.config-rose/pi/settings.json` specifies Astra. A fresh `pi-unsafe --mode rpc --no-session --no-extensions --offline` process in `/scratch/theo/qshell-project` returned Astra, medium thinking and 1,000,000 context in `get_state`; no prompt or model request was sent. This isolates launcher/settings behavior, not interactive extension behavior.

Initially `paseo --json provider models pi` returned seven models ending at GPT-5.6, without Astra. After `provider diagnostic pi`, diagnostics reported eight models and a repeated model-list query included Astra. This is consistent with provider catalog refresh during diagnostics; no client display verification was available. The session briefly selected GPT-5.5 at 18:03:58 UTC and returned to Astra at 18:04:07 UTC; that does not prove the cause of the reported default.

Pinned Paseo v0.8.0 client source, `packages/app/src/composer/agent-controls/utils.ts`, resolves a known configured/runtime model absent from the catalog to `fallbackModel` in `pickSelectedModel`. `resolveModelDisplay` then prefers that fallback's label and ID over the known preferred ID. Thus an incomplete catalog can mislabel the current model and selected control value. It is not safe to conclude the actual session is running the displayed fallback model.

## Follow-up
Fix the client to preserve the explicit runtime/configured model ID when absent from the catalog, rather than substitute another model. Add a missing-current-model regression. Catalog freshness should be investigated separately from label correctness. Client changes need publication through the actual Paseo client distribution; editing the server Nix package alone does not update an installed mobile/desktop client. No changes to defaults are justified by the fresh-process evidence.
