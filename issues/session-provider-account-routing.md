# Session provider and account routing

## Status

Implementation in progress. User approved implementation and Matebook deployment, with both account UIs unchanged. Do not commit or push until the user confirms satisfaction; publication is the final task.

## Required behavior

- The owning Pi session's effective physical provider and selected account govern all subsequent model-using helper requests: new/resumed subagents, idle compaction, and existing/new BTW threads.
- Keep role-specific model and thinking defaults. Never fall back silently to another provider or account; unavailable models/authentication fail explicitly.
- Either existing account UI changes both the selected account and, when necessary, the session's physical provider. Preserve independent per-provider credential stores/defaults and unrelated sessions.
- Requests already dispatched retain their captured provider/account. Changes affect subsequent requests; no terminating retained Pi/tmux sessions to apply a switch.
- Virtual idle-guard selection must resolve to the chosen physical provider and invalidate stale recovery authorization after routing changes.
- Account names/routing metadata may cross process boundaries; credentials must not be serialized into routing descriptors or tool arguments.
- Use isolated synthetic credentials/providers for tests; no live provider requests or modification of real credentials/settings during validation.
- Deploy validated local sources without publishing first. Report any reload/restart limitations honestly. Keep exact upstream publication pins deferred until final approval.

## Investigation

Subagent resolution uses static provider/model defaults without parent context. Idle compaction and Paseo BTW use full static provider/model selectors. Account selection changes per-provider authentication but does not select that provider for the main conversation. Child sessions restore their own selections/defaults rather than the parent's session-selected account. Existing helper records also pin their original selectors.
