# Native OpenAI accounts and local usage status

## Status

Phase 2 implemented and published/deployed for testing. The native Accounts header control's visibility on the user's device remains unresolved and is not device-verified.

## Scope

Provide named native OpenAI OAuth/API-key credentials with per-session selection and explicit restoration of Pi's built-in default. Keep the account store private, atomic, cross-process safe, preserve unrelated provider sections, and fail closed on activation errors. The native `/accounts` workflow is TUI-only; the versioned Paseo service exposes safe labels/status and idle-only switching, never credential material or login/key-entry actions.

`/usage` reports local effective credential binding and official settings links only. It does not call companion quota endpoints, report numeric allowances, or register `/fast`. Real OpenAI dispatch, physical Astra reached through `idle-guard`, and direct Luna compaction must use the selected account and reject stale auth immediately before payload dispatch. Account switching does not compact or alter conversation context.

## Verification

- `node --test tests/openai-accounts-runtime.mjs tests/openai-accounts-storage.mjs` covers installed Pi 1.0.0 registry auth, ordinary Astra dispatch, guarded Astra dispatch, direct Luna compaction, fail-closed missing account, serialized concurrent/stale service requests, busy-after-await and in-flight dispatch guards, exact request-ID replay/conflict, provider config/provider-section preservation, local usage/no companion fetch, private permissions, and cross-process lock serialization.
- Strict TypeScript check passed against the installed Pi 1.0.0 declarations.
- `nix build .#checks.x86_64-linux.openai-accounts-runtime --no-link` loads the immutable extension layout through Pi with no repository node_modules or network.
- Parent reran 18 runtime/storage/snapshot tests and the module/immutable-layout checks; the full-service bridge test uses the real Pi SDK and private socket with fake accounts and zero network calls.
- A read-only installed-code smoke against the normal local model configuration selected `idle-guard/astra` and reported a configured ChatGPT grant with zero network/model requests; named-account storage was isolated.
- No real named-account switches or OAuth logins were performed. Native Usage behavior is unchanged. Accounts controls are native header controls (not Activity); their visibility on the user's device remains unresolved and is not device-verified.
