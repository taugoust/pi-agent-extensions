# Home Manager composition API

Import `inputs.pi-agent-extensions.homeManagerModules.default`. The module owns
extension source assembly; consumers should not enumerate internal TypeScript
files. `programs.pi.enable` enables the module, not every extension.

```nix
programs.pi = {
  enable = true;
  # package = pkgs.pi-supervised; # null installs no executable
  agentDir = ".pi/agent"; # relative to home; also sets PI_CODING_AGENT_DIR
  settings = {
    defaultProvider = "idle-guard";
    defaultModel = "astra";
    defaultThinkingLevel = "low";
    theme = "light/dark";
  };
  models.providers.openai.modelOverrides."gpt-6-astra".contextWindow = 1000000;
  packages = [
    bridgePackage
    { source = otherPackage; extensions = [ "extensions/*.ts" ]; skills = [ ]; }
  ];
  contextFiles = {
    "AGENTS.md".source = ./AGENTS.md;
    "APPEND_SYSTEM.md".text = "Keep changes focused.";
  };
  extensions = {
    auto.enable = true;
    sandbox.enable = true; # includes subagent and its finalizer
    subagent.defaultModel = "gpt-6-luna";
    idle-context-warning = {
      enable = true;
      idleMinutes = 30;
      contextPercent = 20;
      guardedModels.astra = "openai/gpt-6-astra";
    };
    openai-fast-mode = {
      enable = true;
      settings.enabled = false;
    };
  };
  skills.github-repo-search.enable = true;
};
```

## Native Pi configuration and ownership

| Option | Default | Meaning |
| --- | --- | --- |
| `enable` | `false` | Enable installation and configuration. |
| `package` | flake's Pi package when enabled | Executable added to `home.packages`; `null` disables this. |
| `agentDir` | `.pi/agent` | Home-relative global agent directory; no `..`. The launcher must respect `PI_CODING_AGENT_DIR`. |
| `nativeConfigMode` | `"managed"` | `managed` links native files read-only; `mutable` merges defaults on activation. |
| `settings` | `{}` | Native `settings.json` object, including arbitrary supported native settings. |
| `models` | `{}` | Native `models.json` object, including provider/model declarations. |
| `packages` | `[]` | Additive native package declarations: source strings, derivations, or `{ source = ...; ...filters }`. |
| `contextFiles` | `{}` | Markdown filenames relative to `agentDir`; exactly one of `source` or `text`. |

`settings.packages` and `packages` concatenate and deduplicate. Derivations are
converted to absolute store paths, including a filter object's `source`.
Relative source strings retain Pi's semantics: relative to the containing
settings file, **not** the Nix source file. Use a derivation or absolute source
for reusable packages. Context files cannot occupy reserved extension, skill,
or defaults directories.

**Managed mode is intentionally immutable.** Pi can apply an in-memory settings
change but cannot persist it into a Nix-store-backed `settings.json`; UI save
operations may fail with `EROFS`. This mode preserves declarative native
configuration, not writable native preferences. Do not promise persistence.

Opt into `nativeConfigMode = "mutable"` for writable native settings/models.
Activation recursively merges declared defaults beneath existing JSON objects;
existing scalars/arrays win, except native package declarations are additive.
Files are written atomically, only when changed, as ordinary user-owned files.
Changed defaults do not override values already present. Removing a declaration
does not remove previously seeded values/packages. This is default seeding, not
continuous reconciliation or a runtime defaults loader.

Existing symlinks (including a previous managed-mode generation), invalid JSON,
and non-object JSON are left untouched with a warning. No automatic migration,
move, or backup of user settings/state/credentials occurs. Review the existing
configuration and remove the old declarative owner before a deliberate migration
to mutable mode. Both modes expose `defaults/settings.json` and
`defaults/models.json` for inspection; native Pi does **not** load these files by
itself. Switching `agentDir` does not move existing files or state.

When adopting this API, remove equivalent consumer `home.file` declarations for
`settings.json`, `models.json`, context files, extension sources and managed
extension defaults. Keep unrelated bridge/package declarations. No launcher
arguments, supervisor policy, or credential files are rewritten by this module.

## Extension settings

Every registry extension has `extensions.<option>.enable` (default `false`) and
`extensions.<option>.settings` (default `{}`), a direct JSON object. All existing
option names remain available. The only aliases are:

| Existing option name | Canonical extension / defaults file |
| --- | --- |
| `accounts` | `openai-accounts` / `defaults/openai-accounts.json` |
| `usage` | `openai-usage` / `defaults/openai-usage.json` |

All others use their option name as the canonical name, including
`openai-fast-mode` (installed source directory `pi-openai-fast-mode`). The full
registry list is in `extension-registry.nix`; `auto` is included.

Named typed options remain compatible:

| Option under `extensions` | Default |
| --- | --- |
| `btw.model` | `${subagent.defaultProvider}/${subagent.defaultModel}` |
| `stamp.visibleByDefault` | `false` |
| `cache-hit-monitor.visibleByDefault` | `false` |
| `slow-mode.enabledByDefault` | `false` |
| `idle-context-warning.idleMinutes` | `30` (1–1440) |
| `idle-context-warning.contextPercent` | `20` (1–100) |
| `idle-context-warning.guardedModels` | `{}` |
| `idle-context-warning.cheapCompactionModel` | `null` |
| `subagent.defaultProvider` | `"openai"` |
| `subagent.defaultModel` | `"gpt-6-luna"` |
| `subagent.defaultThinkingLevel` | `"low"` |

Generated defaults recursively merge **named options, then `.settings`**; explicit
raw settings win. The file contains the resulting object directly, without a
`settings` wrapper. Runtime loaders merge managed defaults, the user's existing
preference file, then runtime overrides. Arrays/scalars replace rather than
concatenate. Existing extension preference files remain writable and are never
created, linked, or migrated by the module. Extensions without a configuration
loader ignore their empty/default settings file; raw JSON does not create new
runtime features or replace schema validation.

Subagent raw settings accept only `defaultProvider`, `defaultModel`, and
`defaultThinkingLevel`. This API cannot override its immutable launcher/safety
contract. Never place secrets, auth material, capabilities, runtime/session IDs,
or transient state in any Nix option: all declared values enter the public Nix
store. For native models use supported environment/command references instead
of literal API credentials. Auth/account storage stays runtime-owned.

## Source composition

`extension-registry.nix` is the single source of installation names and extension
dependencies. Both Home Manager and `lib.mkExtensionBundle` use its closure:
`sandbox -> subagent -> subagent-finalizer`. The shared runtime is included when
required. Home Manager consumes the generated bundle via recursive file links,
keeping containing directories writable. Fast Mode's package-owned `src` tree is
installed this way, so its runtime `config.json` is not a store symlink; consumers
must not assemble six internal source files.

Skills retain `skills.<name>.enable`. Bundle resource paths are relative to the
bundle root; external Fast Mode explicitly names `src/index.ts` as its extension
entrypoint. Optional upstream inputs must be supplied. The MCP adapter's upstream
source requires non-host npm dependencies; this API does not install npm packages
or turn that source checkout into a dependency-complete package.

`lib.mkExtensionBundle` remains usable independently with `pkgs`, `extensions`,
`skills`, `prompts`, `themes`, `name`, `version`, and `packageName`. `prompts` and
`themes` are manifest-relative resource declarations, not an import/copy API for
arbitrary outside files.
