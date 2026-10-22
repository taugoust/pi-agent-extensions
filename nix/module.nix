{
  self,
  pi-mcp-adapter ? null,
  pi-openai-fast-mode ? null,
}:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.pi;
  registry = import ./extension-registry.nix { inherit self pi-mcp-adapter pi-openai-fast-mode; };
  json = pkgs.formats.json { };
  jsonObject = lib.types.attrsOf json.type;
  extensionNames = builtins.attrNames registry.extensions;
  selectedExtensions = registry.resolveExtensions (
    builtins.filter (
      name: cfg.extensions.${registry.extensions.${name}.optionName}.enable
    ) extensionNames
  );
  selectedSkills = builtins.filter (name: cfg.skills.${name}.enable) registry.localSkillNames;
  bundle =
    (import ./mk-extension-bundle.nix {
      inherit
        self
        pi-mcp-adapter
        pi-openai-fast-mode
        lib
        ;
    })
      {
        inherit pkgs;
        extensions = selectedExtensions;
        skills = selectedSkills;
      };
  needsSharedRuntime = lib.any (
    name: builtins.elem name registry.sharedRuntimeExtensionNames
  ) selectedExtensions;
  modelDefaults = {
    inherit (cfg.extensions.subagent) defaultProvider defaultModel defaultThinkingLevel;
  };
  namedSettings = {
    btw = { inherit (cfg.extensions.btw) model; };
    stamp = { inherit (cfg.extensions.stamp) visibleByDefault; };
    cache-hit-monitor = { inherit (cfg.extensions.cache-hit-monitor) visibleByDefault; };
    idle-context-warning = {
      inherit (cfg.extensions.idle-context-warning)
        idleMinutes
        contextPercent
        cheapCompactionModel
        guardedModels
        ;
    };
    slow-mode = { inherit (cfg.extensions.slow-mode) enabledByDefault; };
    subagent = modelDefaults;
  };
  extensionSettings =
    name:
    lib.recursiveUpdate (namedSettings.${name} or { })
      cfg.extensions.${registry.extensions.${name}.optionName}.settings;
  normalizePackage =
    value:
    if lib.isDerivation value then
      toString value
    else if builtins.isAttrs value then
      value // { source = toString value.source; }
    else
      value;
  nativeSettings =
    cfg.settings
    // lib.optionalAttrs (cfg.packages != [ ] || cfg.settings ? packages) {
      packages = lib.unique (map normalizePackage ((cfg.settings.packages or [ ]) ++ cfg.packages));
    };
  nativeDefaults = json.generate "pi-native-defaults.json" {
    settings = nativeSettings;
    models = cfg.models;
  };
  extensionFiles = lib.listToAttrs (
    map (
      name:
      let
        entry = registry.extensions.${name};
      in
      {
        name = "${cfg.agentDir}/extensions/${entry.installName}";
        value = {
          source =
            "${bundle}/${entry.manifestPath}"
            + lib.optionalString (entry ? installSubdir) "/${entry.installSubdir}";
          # Link source files, never the containing directory: upstream Fast Mode
          # persists config.json alongside its sources.
          recursive = true;
        };
      }
    ) selectedExtensions
  );
  defaultsFiles = lib.listToAttrs (
    map (name: {
      name = "${cfg.agentDir}/defaults/${name}.json";
      value.text = builtins.toJSON (extensionSettings name);
    }) selectedExtensions
  );
  skillFiles = lib.listToAttrs (
    map (name: {
      name = "${cfg.agentDir}/skills/${name}";
      value = {
        source = "${bundle}/${registry.skills.${name}.manifestPath}";
        recursive = true;
      };
    }) selectedSkills
  );
  subagentSettingsValid = lib.all (
    key:
    builtins.elem key [
      "defaultProvider"
      "defaultModel"
      "defaultThinkingLevel"
    ]
  ) (builtins.attrNames cfg.extensions.subagent.settings);
  thinkingType = lib.types.enum [
    "off"
    "minimal"
    "low"
    "medium"
    "high"
    "xhigh"
    "max"
  ];
  stringOption =
    default: description:
    lib.mkOption {
      type = lib.types.str;
      inherit default description;
    };
  boolOption =
    default: description:
    lib.mkOption {
      type = lib.types.bool;
      inherit default description;
    };
in
{
  options.programs.pi = {
    enable = lib.mkEnableOption "pi coding agent";
    package = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = null;
      description = "Pi executable to install; null leaves home.packages unchanged.";
    };
    agentDir = lib.mkOption {
      type = lib.types.strMatching "[^/].*";
      default = ".pi/agent";
      description = "Agent directory relative to home. Sets PI_CODING_AGENT_DIR; must not contain parent traversal.";
    };
    quietState.enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Enable quiet harness background-state delivery. PAE_QUIET_STATE_DISABLED remains a higher-priority runtime kill switch.";
    };
    nativeConfigMode = lib.mkOption {
      type = lib.types.enum [
        "managed"
        "mutable"
      ];
      default = "managed";
      description = "managed links native settings/models read-only (UI changes cannot persist); mutable merges defaults on activation beneath existing regular files. Existing symlinks are never migrated automatically.";
    };
    settings = lib.mkOption {
      type = jsonObject;
      default = { };
      description = "Native Pi settings. In managed mode these are read-only; mutable mode merges beneath existing settings.json on activation. No secrets.";
    };
    models = lib.mkOption {
      type = jsonObject;
      default = { };
      description = "Native models.json configuration, read-only in managed mode or merged beneath writable values on activation in mutable mode. Use environment references, never literal credentials.";
    };
    packages = lib.mkOption {
      type = lib.types.listOf (
        lib.types.oneOf [
          lib.types.str
          lib.types.package
          (lib.types.submodule {
            freeformType = jsonObject;
            options.source = lib.mkOption { type = lib.types.either lib.types.str lib.types.package; };
          })
        ]
      );
      default = [ ];
      description = "Additive native Pi package declarations: source strings, Nix package derivations, or source/filter objects. Store paths become strings, not serialized derivations.";
    };
    contextFiles = lib.mkOption {
      type = lib.types.attrsOf (
        lib.types.submodule {
          options = {
            source = lib.mkOption {
              type = lib.types.nullOr lib.types.path;
              default = null;
              description = "Source file; mutually exclusive with text.";
            };
            text = lib.mkOption {
              type = lib.types.nullOr lib.types.lines;
              default = null;
              description = "Literal context text; mutually exclusive with source.";
            };
          };
        }
      );
      default = { };
      description = "Read-only Markdown context files keyed by filename relative to agentDir, e.g. AGENTS.md and APPEND_SYSTEM.md. No secrets. Reserved defaults/extensions/skills paths are not allowed.";
    };
    extensions =
      lib.recursiveUpdate
        (lib.listToAttrs (
          map (name: {
            name = registry.extensions.${name}.optionName;
            value = {
              enable = lib.mkEnableOption "${name} extension";
              settings = lib.mkOption {
                type = jsonObject;
                default = { };
                description = "Direct JSON configuration defaults for ${name}. Recursively overrides named options; user preferences and runtime overrides take precedence. Never put secrets, capabilities, or runtime identities here. Subagent accepts only its three model defaults.";
              };
            };
          }) extensionNames
        ))
        {
          btw.model = stringOption "${cfg.extensions.subagent.defaultProvider}/${cfg.extensions.subagent.defaultModel}" "Separate physical BTW model; unavailable models fail without fallback.";
          stamp.visibleByDefault = boolOption false "Show native transcript stamps at session start.";
          cache-hit-monitor.visibleByDefault = boolOption false "Show the native cache widget at session start.";
          slow-mode.enabledByDefault = boolOption false "Start each session with slow-mode active.";
          idle-context-warning = {
            idleMinutes = lib.mkOption {
              type = lib.types.ints.between 1 1440;
              default = 30;
              description = "Idle duration in minutes before the warning/recovery threshold.";
            };
            contextPercent = lib.mkOption {
              type = lib.types.ints.between 1 100;
              default = 20;
              description = "Minimum used context percentage for an idle warning.";
            };
            guardedModels = lib.mkOption {
              type = lib.types.attrsOf lib.types.str;
              default = { };
              description = "Selectable idle-guard names mapped to exact physical provider/model IDs.";
            };
            cheapCompactionModel = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "Exact provider/model[:thinking] for idle recovery; null uses normal Pi compaction. No fallback.";
            };
          };
          subagent = {
            defaultProvider = stringOption "openai" "Default provider for new subagents.";
            defaultModel = stringOption "gpt-6-luna" "Default model ID for new subagents.";
            defaultThinkingLevel = lib.mkOption {
              type = thinkingType;
              default = "low";
              description = "Subagent thinking unless the explicit task model includes a thinking suffix.";
            };
          };
        };
    skills = lib.genAttrs registry.localSkillNames (name: {
      enable = lib.mkEnableOption "${name} skill";
    });
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = !(builtins.elem ".." (lib.splitString "/" cfg.agentDir));
        message = "programs.pi.agentDir must be relative to home without parent traversal.";
      }
      {
        assertion = subagentSettingsValid;
        message = "programs.pi.extensions.subagent.settings accepts only defaultProvider, defaultModel and defaultThinkingLevel; launcher policy cannot be overridden.";
      }
      {
        assertion = lib.all (
          name:
          lib.hasSuffix ".md" name
          && !(lib.hasPrefix "/" name)
          && !(builtins.elem ".." (lib.splitString "/" name))
          && !(builtins.elem (builtins.head (lib.splitString "/" name)) [
            "defaults"
            "extensions"
            "skills"
          ])
          && (
            let
              file = cfg.contextFiles.${name};
            in
            (file.source == null) != (file.text == null)
          )
        ) (builtins.attrNames cfg.contextFiles);
        message = "programs.pi.contextFiles requires safe relative names and exactly one of source or text.";
      }
    ];
    programs.pi.package = lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.pi;
    home.sessionVariables.PI_CODING_AGENT_DIR = "${config.home.homeDirectory}/${cfg.agentDir}";
    home.packages =
      lib.optional (cfg.package != null) cfg.package
      ++ lib.optionals cfg.extensions.background-job.enable [
        pkgs.nodejs
        pkgs.tmux
      ]
      ++ lib.optionals cfg.extensions.pdf.enable [
        pkgs.poppler-utils
        pkgs.imagemagick
      ];
    home.file =
      extensionFiles
      // defaultsFiles
      // skillFiles
      // lib.optionalAttrs (cfg.nativeConfigMode == "managed") {
        "${cfg.agentDir}/settings.json".text = builtins.toJSON nativeSettings;
        "${cfg.agentDir}/models.json".text = builtins.toJSON cfg.models;
      }
      // lib.optionalAttrs needsSharedRuntime {
        "${cfg.agentDir}/extensions/shared" = {
          source = "${bundle}/shared";
          recursive = true;
        };
      }
      // lib.mapAttrs' (
        name: file:
        lib.nameValuePair "${cfg.agentDir}/${name}" (lib.filterAttrs (_: value: value != null) file)
      ) cfg.contextFiles
      // {
        "${cfg.agentDir}/defaults/quiet-state.json".text = builtins.toJSON {
          enabled = cfg.quietState.enable;
        };
        "${cfg.agentDir}/defaults/settings.json".text = builtins.toJSON nativeSettings;
        "${cfg.agentDir}/defaults/models.json".text = builtins.toJSON cfg.models;
      };
    # Native Pi does not support an additional defaults file. Seed/merge native
    # defaults only at activation, leaving regular files writable and existing
    # values authoritative. Never move credentials, user state, or symlinks.
    home.activation.piNativeDefaults = lib.mkIf (cfg.nativeConfigMode == "mutable") (
      lib.hm.dag.entryAfter [ "writeBoundary" "linkGeneration" ] ''
        run ${pkgs.python3}/bin/python3 ${./merge-native-defaults.py} \
          ${lib.escapeShellArg "${config.home.homeDirectory}/${cfg.agentDir}"} ${nativeDefaults}
      ''
    );
  };
}
