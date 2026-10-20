# BTW side conversations

Paseo side conversations adapted from `narumiruna/pi-extensions`' MIT-licensed `pi-btw` at `012c08dc9c17f7ef4adaf92c6a5fe1d036653c7c`. `side-thread.ts` and `conversation-context.ts` are copied from the candidate; `LICENSE` retains its notice. The new service exposes that engine to the native Paseo bridge without importing the upstream terminal toolkit.

Open **BTW** beside the Paseo composer. Choose a model and either recent main-conversation context or no main context, then ask a question. Follow-ups use the original snapshot and a separate provider routing ID. The open panel polls selected streaming text every second and idle status every five seconds; closing the panel does not cancel the request. Stop cancels the side response only. Completed exchanges remain available until deletion, Pi reload, session switch, or process exit.

The Nix `programs.pi.extensions.btw.model` default derives from the subagent provider/model; standalone default is `openai/gpt-6-luna`. Thinking is low, output is limited to 4096 tokens, and requests have a three-minute cancellation deadline. Unavailable models fail without fallback. The guarded main-model alias is excluded. Pi's request-time model registry handles authentication, including the selected session's OpenAI account; no credential is exposed in snapshots.

## Boundaries

- Side conversations never write main messages, change the main model/thinking, compact the main session, or run tools.
- Main context is a snapshot of the active branch's latest 40,000 formatted characters, with explicit truncation. The first Paseo version offers active-branch/no-context selection rather than the candidate's terminal branch-tree picker.
- History is in memory: at most eight threads, sixteen completed exchanges each. Visible answers are bounded to 16,000 characters with a truncation marker. Snapshots return detailed turns only for the selected thread.
- **Copy answer** uses the client clipboard. Paseo 0.11.4's public plugin API cannot edit the main draft directly, so paste is explicit and existing draft text is never overwritten. Full-thread/range transfer and terminal-specific layout/search/steering are not ported in this Paseo-focused adaptation.
- Mutations bind the Pi session, bridge epoch, service epoch and unique request ID. Duplicate intent is idempotent; uncertain delivery is never automatically retried. Reload invalidates old controls and aborts owned requests.
- `/btw <question>` starts a default-model thread with recent context; `/btw` directs users to the Paseo panel. The terminal fullscreen UI is not installed.

## Verification

Run `node --test tests/btw-runtime.mjs tests/btw-sdk.mjs tests/openai-accounts-runtime.mjs` from the extension repository. The SDK smoke binds the actual extension and verifies runtime-owned shutdown and unchanged main state. The bridge includes socket/identity and compiled native-client tests. Tests use deterministic model streams, never live credentials or paid inference. Native iOS interaction remains a user-review step.
