# Installation and composition

[Catalogue](../README.md) · [Detailed reference](reference.md)

## Home Manager: selected extensions

In your flake inputs:

```nix
pi-agent-extensions.url = "github:taugoust/pi-agent-extensions";
```

Pass that input into your Home Manager configuration (for example through `extraSpecialArgs`), import `pi-agent-extensions.homeManagerModules.default`, and select extensions:

```nix
{ pi-agent-extensions, ... }:
{
  imports = [ pi-agent-extensions.homeManagerModules.default ];
  programs.pi = {
    enable = true;
    extensions = {
      background-job.enable = true;
      subagent.enable = true;
      slow-mode = { enable = true; enabledByDefault = false; };
      stamp = { enable = true; visibleByDefault = false; };
    };
    skills.github-repo-search.enable = true;
  };
}
```

The module installs its pinned Pi unless `programs.pi.package = null` (use an independently installed compatible Pi), or you select another package. Enabling Pi alone does not enable every extension. Account/status options are named `extensions.accounts` and `extensions.usage`, whereas the bundle registry uses `openai-accounts` and `openai-usage`.

The flake declares `aarch64-darwin`, `x86_64-darwin`, `aarch64-linux`, and `x86_64-linux` outputs. That does not make platform-specific features portable: native TUI workers require Linux; appearance sync and Apple Reminders require macOS. Headless execution cannot display terminal-only dialogs. Runtime and SDK compatibility must be checked when substituting a different Pi package.

## Build a package manifest

```nix
let
  tools = pi-agent-extensions.lib.mkExtensionBundle {
    inherit pkgs;
    name = "pi-local-tools";
    extensions = [ "fetch" "pdf" "questionnaire" ];
    skills = [ "github-repo-search" ];
  };
in tools
```

`tools` is a store directory with a `package.json` Pi manifest. Add its resulting absolute path to the `packages` array in Pi's mutable `~/.pi/agent/settings.json`. The current module does not expose a `programs.pi.packages` option. Do not load the same extension both from that package and the module's discovery directory.

`lib.availableExtensions` and `lib.availableSkills` enumerate registry names. Unknown names are rejected. `sandbox` adds `subagent`; either adds `subagent-finalizer`. Shared runtime files are copied automatically. Optional upstream entries require their corresponding flake inputs. `prompts` and `themes` are manifest paths supplied by the caller, not an automatic external-resource installer.

`packages.<system>.default` (also `.extensions`) selects the broad registered catalogue and skills. `packages.<system>.pi` is the Pi executable package; the two are not interchangeable.

### Source packages are not dependency closures

The bundle builder copies extension sources, selected skill directories, and shared runtime files. It does not run npm/Bun, resolve imports, or add executable dependencies to Pi's PATH. A manifest entry is not proof that all runtime dependencies are packaged.

The current Home Manager module explicitly supplies Node/tmux for `background-job` and Poppler/ImageMagick for `pdf`, and has extension-specific packaging for integrations. Read [the module](../nix/module.nix) before assuming a custom bundle has the same closure. Runtime packages or generated assets already present in a source tree are not a reproducible dependency-installation strategy.

In particular, source-only bundles must account for dependency-heavy extensions such as `slow-mode` (`diff`), account locking dependencies, BTW's bundled artifact, and upstream MCP/fast-mode dependencies. Fetch can degrade without optional Readability dependencies, but that does not imply arbitrary missing imports are safe. External utilities such as `direnv`, SSH, pagers, GitHub's `gh`, and skill-specific tools must be available where execution occurs. AgentSH supervision does not implicitly supply native binaries.

## Non-Nix installation

Pi's package workflow can load the repository:

```sh
pi install git:github/taugoust/pi-agent-extensions
```

This follows the repository's Pi manifest rather than Home Manager's opt-in options. Review that manifest and dependency requirements before use. Manual source installation is also described in the [reference](reference.md#installation); preserve sibling `shared/` imports and extension-specific assets rather than copying a single entry point indiscriminately. Avoid installing another copy into a discovery directory when a package already provides it.

## Configuration: current and proposed

**Current module:** use the typed extension-specific options actually declared in [`nix/module.nix`](../nix/module.nix), such as `slow-mode.enabledByDefault`, `stamp.visibleByDefault`, subagent model defaults, and idle-context-warning selectors. Some generate extension-specific JSON files. Pi's own settings/models files remain separate from this module's option surface.

**Upcoming API proposal, not a runnable example for this revision:**

- `programs.pi.settings`: declarative Pi settings.
- `programs.pi.models`: declarative model configuration.
- `programs.pi.packages`: package selection/composition.
- `programs.pi.agentDir`: configurable agent directory.
- `programs.pi.extensions.<name>.settings`: generated extension defaults files.

The intended preference order is **declarative defaults < mutable user preferences < session overrides**. Defaults must seed behavior without replacing user-owned preference files or persisting temporary session overrides. File names, merge behavior, migration, and individual extension support must be synchronized with the eventual implementation; these proposed names do not imply they already exist.

Never put OAuth tokens, API keys, or private account state in Nix expressions or store-generated defaults: store paths are not a secret store. Keep mutable credentials in Pi's supported private runtime storage. Supervisor policy and approvals remain owned by AgentSH, not by preference files.
