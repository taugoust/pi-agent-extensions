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
    # The legacy typed model selects only the separate Paseo conversation.
    # Terminal BTW retains its main-model default unless explicitly configured.
    btw = {
      paseo = { inherit (cfg.extensions.btw) model; };
      terminal = { };
    };
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
  nativeSettingsBase = if cfg.settings == null then { } else cfg.settings;
  nativeSettings =
    if cfg.settings == null && cfg.packages == [ ] then
      null
    else
      nativeSettingsBase
      // lib.optionalAttrs (cfg.packages != [ ] || nativeSettingsBase ? packages) {
        packages = lib.unique (map normalizePackage ((nativeSettingsBase.packages or [ ]) ++ cfg.packages));
      };
  nativeDocuments = lib.filterAttrs (_: value: value != null) {
    settings = nativeSettings;
    models = cfg.models;
    keybindings = cfg.keybindings;
    mcp = cfg.mcp;
  };
  nativeDefaults = json.generate "pi-native-defaults.json" nativeDocuments;
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
  subagentSettings = extensionSettings "subagent";
  subagentKeys = [
    "defaultProvider"
    "defaultModel"
    "defaultThinkingLevel"
  ];
  subagentSettingsValid =
    lib.all (key: builtins.elem key subagentKeys) (builtins.attrNames cfg.extensions.subagent.settings)
    && lib.all (
      key:
      builtins.isString subagentSettings.${key}
      && builtins.match "[^[:space:]]+" subagentSettings.${key} != null
    ) subagentKeys
    && builtins.elem subagentSettings.defaultThinkingLevel thinkingLevels;
  fastModeSettings = cfg.extensions.openai-fast-mode.settings;
  fastModeSettingsValid =
    lib.all (key: key == "enabled") (builtins.attrNames fastModeSettings)
    && (!(fastModeSettings ? enabled) || builtins.isBool fastModeSettings.enabled);
  thinkingLevels = [
    "off"
    "minimal"
    "low"
    "medium"
    "high"
    "xhigh"
    "max"
  ];
  thinkingType = lib.types.enum thinkingLevels;
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
      description = "managed links native settings/models read-only (UI changes cannot persist); mutable only seeds missing files once on activation, with no reconciliation of existing files. Symlinks are never migrated automatically.";
    };
    settings = lib.mkOption {
      type = lib.types.nullOr jsonObject;
      default = null;
      description = "Native Pi settings; null leaves existing configuration unmanaged unless packages are added. In managed mode these are read-only; mutable mode only seeds a missing settings.json, never updating an existing file. No secrets.";
    };
    models = lib.mkOption {
      type = lib.types.nullOr jsonObject;
      default = null;
      description = "Native models.json configuration; null leaves it unmanaged. Otherwise read-only in managed mode or used to seed a missing writable file once in mutable mode. Use environment references, never literal credentials.";
    };
    keybindings = lib.mkOption {
      type = lib.types.nullOr jsonObject;
      default = null;
      description = "Native keybindings.json object; null leaves it unmanaged. Otherwise read-only in managed mode or used to seed a missing writable file once in mutable mode.";
    };
    mcp = lib.mkOption {
      type = lib.types.nullOr jsonObject;
      default = null;
      description = "Native mcp.json object; null leaves it unmanaged. Otherwise read-only in managed mode or used to seed a missing writable file once in mutable mode. Never include literal credentials; use supported environment references.";
    };
    extraSkills = lib.mkOption {
      type = lib.types.attrsOf lib.types.path;
      default = { };
      description = "Additional skill source directories keyed by safe skill name, recursively linked under agentDir/skills. Names must not collide with enabled registry skills.";
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
          btw.model = stringOption cfg.extensions.subagent.defaultModel "BTW role model ID; provider and account follow the owning session. Legacy qualified preferences cannot override the session provider. Unavailable models fail without fallback.";
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
              description = "Role model[:thinking] for idle recovery; provider/account follow the owning session. Legacy qualified selectors remain readable. Null uses normal Pi compaction; no provider fallback.";
            };
          };
          subagent = {
            defaultProvider = stringOption "openai" "Legacy standalone compatibility fallback; active subagents always use their owning session's provider/account.";
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
        message = "programs.pi.extensions.subagent.settings accepts only defaultProvider/defaultModel/defaultThinkingLevel; effective model defaults must be nonempty strings without whitespace and thinking must be off|minimal|low|medium|high|xhigh|max. Launcher policy cannot be overridden.";
      }
      {
        assertion = fastModeSettingsValid;
        message = "programs.pi.extensions.openai-fast-mode.settings supports only enabled, which must be a boolean; supported targets remain package-owned.";
      }
      {
        assertion = lib.all (
          name:
          builtins.match "[A-Za-z0-9][A-Za-z0-9._-]*" name != null && !(builtins.elem name selectedSkills)
        ) (builtins.attrNames cfg.extraSkills);
        message = "programs.pi.extraSkills requires safe skill names without collisions with enabled registry skills.";
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
      ++
        lib.optionals (cfg.extensions.background-job.enable || builtins.elem "subagent" selectedExtensions)
          [
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
      // lib.optionalAttrs (cfg.nativeConfigMode == "managed") (
        lib.mapAttrs' (
          name: value:
          lib.nameValuePair "${cfg.agentDir}/${name}.json" {
            text = builtins.toJSON value;
          }
        ) nativeDocuments
      )
      // lib.optionalAttrs needsSharedRuntime {
        "${cfg.agentDir}/extensions/shared" = {
          source = "${bundle}/shared";
          recursive = true;
        };
      }
      // lib.mapAttrs' (
        name: source:
        lib.nameValuePair "${cfg.agentDir}/skills/${name}" {
          inherit source;
          recursive = true;
        }
      ) cfg.extraSkills
      // lib.mapAttrs' (
        name: file:
        lib.nameValuePair "${cfg.agentDir}/${name}" (lib.filterAttrs (_: value: value != null) file)
      ) cfg.contextFiles
      // {
        "${cfg.agentDir}/defaults/quiet-state.json".text = builtins.toJSON {
          enabled = cfg.quietState.enable;
        };
      }
      // lib.mapAttrs' (
        name: value:
        lib.nameValuePair "${cfg.agentDir}/defaults/${name}.json" {
          text = builtins.toJSON value;
        }
      ) nativeDocuments;
    # HM's per-file collision check cannot recognize an old whole-directory
    # ancestor link. Archive only links proven by the old generation/history;
    # unknown/custom paths are left to the ordinary collision check (no force).
    home.activation.piMigrateExtensionLinks = lib.hm.dag.entryBefore [ "checkLinkTargets" ] ''
      piMigrationDryRun=()
      if [[ -v DRY_RUN || -n "''${DRY_RUN_CMD:-}" ]]; then
        piMigrationDryRun=(--dry-run)
      fi
      ${pkgs.python3}/bin/python3 ${./migrate-extension-links.py} \
        --home ${lib.escapeShellArg config.home.homeDirectory} \
        --old-generation "''${oldGenPath:-}" \
        --profile "''${genProfilePath:-}" \
        "''${piMigrationDryRun[@]}" \
        ${
          lib.escapeShellArgs (
            lib.filter
              (
                path:
                let
                  file = config.home.file.${path};
                in
                (file.enable or true) && file.recursive && (file.target or path) == path
              )
              (
                builtins.attrNames extensionFiles
                ++ lib.optional needsSharedRuntime "${cfg.agentDir}/extensions/shared"
              )
          )
        } || exit 1
    '';
    # Native Pi does not support an additional defaults file. Seed absent native
    # files only; never read/merge/overwrite preferences or race native saves.
    # Existing files, credentials, user state, and symlinks are left untouched.
    home.activation.piNativeDefaults = lib.mkIf (cfg.nativeConfigMode == "mutable") (
      lib.hm.dag.entryAfter [ "writeBoundary" "linkGeneration" ] ''
        run ${pkgs.python3}/bin/python3 ${./merge-native-defaults.py} \
          ${lib.escapeShellArg "${config.home.homeDirectory}/${cfg.agentDir}"} ${nativeDefaults}
      ''
    );
  };
}
