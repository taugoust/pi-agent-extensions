# OpenAI Codex accounts

`/accounts` manages named OpenAI Codex (`openai-codex`) ChatGPT sign-ins: add, switch, remove, and restore Pi's built-in Codex login. Codex is the only provider this extension manages.

Pi's other ChatGPT provider, `openai`, is a plain built-in provider here. This extension does not wrap its requests, select accounts for it, report its usage or change its configuration. Its built-in login in `auth.json` keeps working as before.

Enable with `programs.pi.extensions.accounts.enable = true;`.

## Session selection

- The selected Codex account belongs to the current Pi session branch and is saved in the session history. New sessions start with the stored default account, or Pi's built-in Codex login when there is none.
- Child sessions such as subagents follow the account of their nearest ancestor through private, owner-only routing files under the agent directory. A child can choose its own account, including **default Pi login**, or **Follow parent account** to drop its own choice. Parents and siblings are not affected. Broken, unsafe, cyclic or regressed routing files block requests.
- Choosing a Codex account moves the session to the same model ID under `openai-codex`. If Codex has no model with that ID, the choice is refused and nothing changes.
- A Codex child whose parent session uses a non-Codex provider fails closed.
- Requests already sent keep their credentials. Switching is refused while a request is in flight. Switching makes no model call and does not change the conversation.

## Request gate

The extension wraps the `openai-codex` provider's `streamSimple`. Each request syncs the session's selection, requires the official ChatGPT origin, binds the selected OAuth access token to the `Authorization` header, and checks the session, selection revision, credential and headers again just before dispatch. A deleted or replaced account blocks the request; it never falls back to the default login or an environment key. A separately registered native Codex provider is refused and left untouched. Restoring the default login restores the complete previous Codex provider configuration.

## Storage

Accounts are stored in `<agentDir>/pi-accounts.json` with mode `0600`, atomic writes, path checks and cross-process locking (vendored `proper-lockfile` 4.1.2). Only the `openai-codex` section is read or written. Every other section, including a `providers.openai` section from older versions, is kept on disk unchanged. Older Codex account files are not migrated or deleted.

## Account controls

Paseo uses the service at `globalThis.__paeAccountControlsV1` (protocol 1). It sees account labels and status, never credentials.

- Every request must set `providerId: "openai-codex"`. A request for `openai`, or without `providerId`, is rejected with `unsupported-provider` and changes nothing.
- Snapshots contain `providerId`, `accounts`, `currentAccountId`, `defaultSelected`, `selectionRevision`, `activationStatus`, `busy`, `canSwitch`, `usage`, `pendingAccountNames` while a sign-in runs, and `inheritance` for child sessions.
- `switchAccount` works only while the session is idle. Selection revisions and service/session epochs reject stale clients. Retrying a request ID with the same intent returns the first result; reusing it with a different intent is rejected.
- `manageAccount` supports `add`, `cancel-login`, `rename`, `remove` and `default` for Codex accounts.
- `usage.accountKey` is a hash of the provider, ChatGPT account ID and user ID, not of a credential. It is published for a verified named sign-in, and for the default login only when the stored OAuth login is in effect with the official origin and no authentication override.

Adding and signing in to accounts from `/accounts` requires the native Pi TUI.

## Default login files

The default-login account key reads `<agentDir>/auth.json` without refreshing or resolving credentials. It accepts a private file owned by the user, or a managed link chain such as Home Manager's root-owned `/nix/store` links to a user-owned private file. The agent directory must be an absolute, real user-owned directory. Links are followed at most 32 times, the file may be at most 1 MiB, and directory and file identities are checked before and after reading. Unsafe ownership or permissions, replacement during the read, malformed JSON, loops and dangling links all withhold the key.

## Validation

- `checks.<system>.openai-accounts-runtime` runs real Pi processes with synthetic accounts and no HTTP: Codex routing to children, own choices and follow-parent, history restore, cold resume, rejection of `openai` and missing-provider requests, preservation of a legacy `providers.openai` section, and the fail-closed non-Codex parent case. It also runs `tests/account-managed-auth.test.mjs`.
- `checks.<system>.openai-accounts-module` and `checks.<system>.session-routing` cover the module wiring and routing files.
- `tests/openai-accounts-*.mjs` and `tests/session-routing-sdk.mjs` use the Pi SDK and need `@earendil-works/pi-coding-agent` to be resolvable; run them with `node --test`.

## Legacy usage option

`/usage` has been retired. In `/accounts`, **Credential status and usage link** shows the local credential status of the session's Codex account. It does not query quota, billing or remote entitlement. The `programs.pi.extensions.usage.enable` option and the `openai-usage` package still work: they install `openai-accounts` and register no command. Prefer `accounts.enable = true`.
