# Configuration coverage

[Overview](../README.md) · [Nix API](../nix/README.md) · [Installation](installation.md)

The Home Manager module generates `defaults/<canonical-name>.json` only for
selected extensions. `extensions.<name>.settings` is the direct JSON object for
that extension's existing public settings; it does not invent new runtime knobs.
Use named typed options where available. Normalizers still validate their own
fields, and the normalizers themselves do not read configuration files.

## Ownership and precedence

Extension configuration is resolved as **built-ins → declarative defaults →
mutable preferences → session overrides**. Objects merge recursively; arrays,
scalars and null replace. Supported environment overrides retain their existing
higher priority. Changing a default does not erase an explicit user preference.
Commands continue writing their existing mutable preference files, not the
Nix-managed defaults. Credentials and worker/control identities are never part
of these defaults or copied into isolated workers.

Native Pi configuration has a different ownership choice: managed files or
seed-once mutable files. See [the explicit mode contract](../nix/README.md#native-pi-configuration-and-ownership).

## Extension settings

Preference paths below are relative to Pi's canonical agent directory (normally
`~/.pi/agent`, or `PI_CODING_AGENT_DIR`). Legacy read-only fallbacks are retained
where earlier releases used hardcoded paths; no user state is moved implicitly.
The source settings modules are the authoritative accepted-value reference.

| Nix configuration | Existing mutable preference | Public fields / reference |
| --- | --- | --- |
| `extensions.stamp.settings` | `pi-stamp.json` | `hourCycle`, `showSeconds`, `dateContext`, `locale`, `timeZone`, `responseTiming`, `showOutputThroughput`, `assistantMetadata`, `showExactTimeline`, `showThinkingLevel`, `showCompactAbnormalOutcome`, `showCostSinceUser`, `showTimeSinceUser`, `toolStamps`; [schema](../stamp/settings.ts) |
| `extensions.stamp.visibleByDefault` | `stamp-display.json` | Native display default; `/stamp show` and `/stamp hide` override the session, without disabling collection |
| `extensions.progress.settings` | `pi-progress.json` | `enabled`, `displayMode`, `showCompleted`, `maxVisibleItems`, `showProgress`; [schema](../progress/settings.ts) |
| `extensions.workflows.settings.goal` | `pi-goal.json` | `rpc.enabled`, `continuationLimits.automaticTurns`, `continuationLimits.noProgressTurns`; [schema](../workflows/goal/settings.ts) |
| `extensions.workflows.settings.worktree` | `pi-worktree.json` | `worktreeRoot`; [schema](../workflows/worktree/settings.ts) |
| `extensions.btw.settings.terminal` | `pi-btw.json` | `model`, `thinkingLevel`, `rememberThinkingLevelChanges`, `fullscreenCopyOnSelect`, `layout`, `sidePaneRatio`, `keybindings`; [schema](../btw/candidate/settings.ts) |
| `extensions.btw.model` / `extensions.btw.settings.paseo` | `btw.json` | Paseo side-chat `model` only. It never changes the terminal side-chat's default model |
| `extensions.idle-context-warning` named options / `.settings` | `idle-context-warning.json` | `idleMinutes`, `contextPercent`, `cheapCompactionModel`, `guardedModels`; [reader](../idle-context-warning/index.ts) |
| `extensions.subagent` model options / `.settings` | `subagent.json` | `defaultProvider`, `defaultModel`, `defaultThinkingLevel` only; [reader](../subagent/config.ts) |
| `extensions.slow-mode.enabledByDefault` / `.settings` | `slow-mode.json` | Startup review visibility; `/slow-mode` controls the session; [reader](../slow-mode/index.ts) |
| `extensions.cache-hit-monitor.visibleByDefault` | `cache-hit-monitor-display.json` | Startup widget visibility; `/cache-hit-monitor` controls the session; collection is independent |
| `extensions.permission-gate.settings` | `permission-gate.json` | `timeoutMs` only; socket ownership and authorization are not preferences |
| `extensions.sandbox.settings` | `sandbox.json` | Existing operator timeout/reconnect/approval/diagnostic tunables; [mapping and validation](../sandbox/settings.ts) |
| `extensions.openai-fast-mode.settings` | `extensions/pi-openai-fast-mode/config.json` | `enabled`; [package-owned loader](../nix/pi-openai-fast-mode/managed-defaults.patch), `/fast` remains writable |
| `quietState.enable` | environment override | Quiet-state publication default; existing environment kill switches retain priority |

All extension options require their `.enable = true` (or selection through a
dependency such as sandbox → subagent). `accounts` and `usage` are the module's
compatibility names for canonical `openai-accounts` and `openai-usage`.

Enable-only extensions such as fetch, SSH and questionnaire have no deployment
preference schema to configure. HTTP request arguments, SSH invocation targets,
questionnaire content and task specifications are tool inputs, not persistent
plugin options. `/usage` is an explicit action, not an automatic quota widget.

## Integration, not preference

The native worker launch executable, supervision mode, policy and launcher
provenance belong to the trusted host/package integration. They are not editable
JSON preferences. The same applies to account credential stores, operator
capabilities, assigned sockets, runtime epochs and parent/child identities.

The bridge owns its own endpoint, title, attachment and launcher API; use
[paseo-bridge-pi's Nix module](https://github.com/taugoust/paseo-bridge-pi/blob/main/nix/README.md)
rather than copying environment-variable assembly into host configuration.
Native Paseo listener, relay, providers, service identity and secrets provisioning
remain native Paseo/host configuration.

## Reloads and state

Nix activation installs sources and defaults. Existing Pi processes keep the
code and settings they loaded until a deliberate resource reload or new session;
Pi executable changes require a new process. Extension display commands change
session presentation only.

Isolated host launchers can snapshot supported public configuration with:

```sh
node <bundle>/shared/snapshot-extension-settings.mjs SOURCE_AGENT_DIR DEST_AGENT_DIR
```

The [shared manifest](../shared/extension-config-manifest.json) is the allowlist
for declarative defaults and public preference files. The Node-only helper
validates bounded JSON objects and writes private atomic snapshots. Empty source
means no configured root; identical canonical directories are left alone.
Missing source files remove only their approved snapshot paths. It never walks
or copies credential stores, accounts, sessions, sockets or control identities.
Snapshots are per-runtime configuration; changes in an isolated snapshot are
not merged back into the parent profile.

Activation does not switch accounts, create a second credential store, resume
goals or relaunch workers.
