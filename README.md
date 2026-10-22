# pi-agent-extensions

Composable tools, terminal workflows, and supervised execution for the [Pi coding agent](https://github.com/mariozechner/pi).

Choose the extensions you need with Nix; keep credentials and mutable session preferences outside the store. This repository also supports Pi package loading and manual source installation.

## Start with Nix

Add `github:taugoust/pi-agent-extensions` as a flake input, then import its Home Manager module:

```nix
# In your Home Manager configuration, with pi-agent-extensions in scope:
{
  imports = [ pi-agent-extensions.homeManagerModules.default ];
  programs.pi = {
    enable = true;
    extensions = {
      fetch.enable = true;
      questionnaire.enable = true;
      progress.enable = true;
    };
  };
}
```

`programs.pi.enable` installs this flake's Pi by default; extensions are **opt-in**. The default extension package is a different, broad catalogue bundle—not the module's default selection.

→ [Installation, selective bundles, dependencies, and configuration](docs/installation.md) · [Detailed extension reference](docs/reference.md)

## Choose by purpose

Commands below are entry points, not a complete CLI reference. Most extensions support macOS and Linux; UI, external tools, and supervision impose additional requirements.

| Purpose | Extensions | Entry points / boundaries |
| --- | --- | --- |
| Parallel work | `subagent`, `subagent-finalizer`, `background-job` | `subagent`, `background_job` tools; `/background`, `/background-jobs`; native TUI workers require Linux/tmux |
| Goals and worktrees | [`workflows`](workflows/README.md), `auto` | Goal/progress tools; `/auto`; automatic continuation is explicitly authorized and bounded |
| Side conversations | [`btw`](btw/README.md) | `/btw`; native terminal and Paseo have distinct settings |
| Network and documents | `fetch`, `pdf`, `ssh` | `fetch`, PDF tools; SSH uses `--ssh` and `/retarget`; local binaries or active supervisor required |
| Supervision and review | `sandbox`, `permission-gate`, `fence`, `slow-mode` | `/sandbox`, `/sandbox-allow`, `/permission-gate`, `/fence`, `/slow-mode` |
| Interaction | `questionnaire`, `modal-editor`, `pager` | Questionnaire tool, modal input, `/pager`, `/pager-full`; interactive terminal where applicable |
| Environment and appearance | `direnv`, `mac-system-theme` | Automatic environment refresh; system appearance sync is macOS-only |
| Context and diagnostics | `idle-context-warning`, `stamp`, `progress`, `cache-hit-monitor` | `/idle-guard-retry`; [observability commands and privacy](OBSERVABILITY.md) |
| OpenAI accounts and status | [`openai-accounts`](openai-accounts/README.md), [`openai-usage`](openai-usage/README.md) | `/accounts` (native TUI), `/usage`; safe labels/status, not quota queries |
| Pinned integrations | `openai-fast-mode`, `mcp-adapter` | `/fast`; upstream MCP adapter configuration; separate upstream sources |

Bundled skills: GitHub repository search, Apple Reminders (`remindctl`, macOS), draw.io diagrams, and TikZ figure recreation. See [reference](docs/reference.md#skills) and the [registry](nix/extension-registry.nix) for exact names.

## Compose, don't copy everything

Use `lib.mkExtensionBundle` for an explicit Pi package manifest:

```nix
pi-agent-extensions.lib.mkExtensionBundle {
  inherit pkgs;
  name = "pi-research-tools";
  extensions = [ "fetch" "questionnaire" "progress" ];
  skills = [ "github-repo-search" ];
}
```

The resulting derivation is a package directory to load through Pi's `packages` setting; it is not a Pi executable. Selecting `sandbox` also selects `subagent`; selecting either adds `subagent-finalizer`. Shared runtime files are included where needed. Bundles copy source rather than installing dependency closures—read the [composition guide](docs/installation.md) before selecting dependency-heavy extensions.

## Safety and runtime boundaries

Native execution uses the current user's authority. `fence` and review prompts are not an OS sandbox. Full AgentSH mode requires a working supervisor and fails closed instead of falling back to native execution; approval-only sockets are not full supervision. See [mode selection](docs/reference.md#agentsh-mode-selection).

Pi terminal UI, headless/RPC use, Linux native workers, AgentSH workers, and the companion Paseo UI are distinct surfaces. A terminal feature does not imply a native mobile control. [Observability](OBSERVABILITY.md), [workflow](workflows/README.md), and [side-chat](btw/README.md) documentation describe those boundaries; native iOS verification remains pending deployment where noted. The optional [read-only harness service](docs/reference.md#read-only-harness-api) exposes bounded session-owned snapshots, never control capabilities or credentials.

Configuration evolves separately from deployment: the proposed `programs.pi.settings/models/packages/agentDir` and `extensions.*.settings` API is **not part of the module documented at this revision**. Its intended preference precedence is defaults < mutable preferences < session overrides. See [current versus proposed configuration](docs/installation.md#configuration-current-and-proposed).

## Repository map

- Extension directories: TypeScript entry points and extension-specific assets.
- `shared/`: runtime classification and cross-extension contracts.
- `nix/`: registry, bundle builder, Home Manager module, and Pi patches.
- `skills/`: optional agent skills.
- `docs/`: installation and preserved detailed reference.
- `issues/`: tracked work; `tests/`: validation sources.

## License and attribution

[MIT](LICENSE). Adapted upstream material retains its notices; see [THIRD_PARTY.md](THIRD_PARTY.md) and extension READMEs. Pinned upstream integrations retain their own licenses. The [reference acknowledgements](docs/reference.md#-acknowledgements) preserve earlier credits.
