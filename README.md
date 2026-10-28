# 🧩 Pi Agent Extensions

[![Pi](https://img.shields.io/badge/Pi-1.x-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Tools, side chats, parallel agents and terminal workflows for [Pi](https://pi.dev).
**Choose what you need. Configure it with Nix.**

[Installation](docs/installation.md) · [Configuration](nix/README.md) · [Full reference](docs/reference.md)

## 🚀 Quick start

Add `github:taugoust/pi-agent-extensions` as a flake input, then select extensions in Home Manager:

```nix
{ pi-agent-extensions, ... }: {
  imports = [ pi-agent-extensions.homeManagerModules.default ];
  programs.pi = {
    enable = true;
    extensions = {
      btw.enable = true;
      progress.enable = true;
      fetch.enable = true;
    };
  };
}
```

Extensions are **opt-in**. [Build a selective bundle or install without Nix →](docs/installation.md)

## 📦 Choose your extensions

### Workflows and delegation

| Extension | Use it for |
| --- | --- |
| [BTW](btw/README.md) | Ask a side question without cluttering the main conversation. |
| [Workflows](workflows/README.md) | Manage Git worktrees and explicitly authorized Goals. |
| [Subagent](docs/subagent-profiles.md) | Delegate single, parallel or chained work with named profiles and optional [supervised runtime verification](docs/subagent-verification.md). |
| [Background jobs](background-job) | Run, monitor and clean up durable shell jobs. |
| [Progress](OBSERVABILITY.md) | Keep multi-step work visible. |
| [Auto](auto) | Opt into automatic continuation with `/auto`. |

### Tools and terminal

| Extension | Use it for |
| --- | --- |
| [Fetch](fetch) | Read web pages and call HTTP APIs. |
| [PDF](pdf) | Work with PDF documents. |
| [SSH](ssh) | Retarget work to a remote machine. |
| [Questionnaire](questionnaire) | Ask structured questions instead of guessing. |
| [Modal editor](modal-editor) | Edit longer input in a terminal dialog. |
| [Pager](pager) | Browse long output without flooding the transcript. |
| [direnv](direnv) | Refresh the project's environment. |
| [System theme](mac-system-theme) | Follow macOS appearance. |

### Accounts, visibility and control

| Extension | Use it for |
| --- | --- |
| [OpenAI accounts](openai-accounts/README.md) | Manage named accounts with `/accounts`. |
| [OpenAI usage](openai-usage/README.md) | Open credential status and the official usage link. |
| [Stamp](OBSERVABILITY.md) | Record timestamps, response timing and usage metadata. |
| [Cache monitor](OBSERVABILITY.md) | Inspect prompt-cache reuse. |
| [Idle context admission](idle-context-warning) | User/parent-owned cold-context decisions, notification admission, and native cheap compaction; independent of provider routing. |
| [Sandbox](sandbox) | Route tools through AgentSH supervision. |
| [Permission Gate](permission-gate) | Require approvals for guarded operations. |
| [Slow mode](slow-mode) | Review edits before applying them. |
| [Fence](fence) | Add lightweight path restrictions—not an OS sandbox. |

[Fast Mode and optional MCP integration →](nix/README.md#source-composition)

## 🛠️ Skills and composition

Bundled skills: [GitHub search](skills/github-repo-search), [Apple Reminders](skills/remindctl), [draw.io](skills/drawio) and [TikZ figures](skills/tikz-figure-recreation).

| Want to… | Guide |
| --- | --- |
| Configure Pi, models and extension defaults | [Nix API](nix/README.md) |
| Package only selected extensions and skills | [Composition](docs/installation.md#build-a-package-manifest) |
| Connect terminal sessions to Paseo | [paseo-bridge-pi](https://github.com/taugoust/paseo-bridge-pi) |
| Understand dependencies and supported surfaces | [Installation guide](docs/installation.md) |

> [!IMPORTANT]
> Extensions run with your user permissions. Full AgentSH supervision requires a working supervisor; review prompts alone are not isolation. Keep credentials out of Nix values.

## 📄 License

[MIT](LICENSE) · [Third-party notices](THIRD_PARTY.md) · [Acknowledgements](docs/reference.md#-acknowledgements)
