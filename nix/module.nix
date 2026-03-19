{ self, bun2nix }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.pi;
  extDir = ".pi/agent/extensions";
  pkg = import ./package.nix { inherit self bun2nix pkgs; };
in
{
  options.programs.pi = {
    enable = lib.mkEnableOption "pi coding agent";

    package = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = null;
      description = "The pi package to install. If null, pi is not added to home.packages.";
    };

    extensions = {
      fence.enable = lib.mkEnableOption "fence extension — blocks write/edit outside cwd";
      questionnaire.enable = lib.mkEnableOption "questionnaire extension — LLM-driven multi-question UI tool";
      modal-editor.enable = lib.mkEnableOption "modal-editor extension — vim-style modal input";
      mac-system-theme.enable = lib.mkEnableOption "mac-system-theme extension — syncs pi theme to macOS system appearance";
      permission-gate.enable = lib.mkEnableOption "permission-gate extension — confirms dangerous bash commands";

      slow-mode = {
        enable = lib.mkEnableOption "slow-mode extension — review gate for write/edit tool calls";
        enabledByDefault = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Start every session with slow-mode already active.";
        };
      };

      sandbox.enable = lib.mkEnableOption "sandbox extension — OS-level sandboxing for bash commands";
    };

    skills = {
      github-repo-search.enable = lib.mkEnableOption "github-repo-search skill — search GitHub repos via gh CLI without cloning";
      remindctl.enable = lib.mkEnableOption "remindctl skill — manage Apple Reminders via the remindctl CLI";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = lib.mkIf (cfg.package != null) [ cfg.package ];

    home.file = lib.mkMerge [
      (lib.mkIf cfg.skills.github-repo-search.enable {
        ".pi/agent/skills/github-repo-search/SKILL.md".source = "${pkg}/skills/github-repo-search/SKILL.md";
      })
      (lib.mkIf cfg.skills.remindctl.enable {
        ".pi/agent/skills/remindctl/SKILL.md".source = "${pkg}/skills/remindctl/SKILL.md";
      })
      (lib.mkIf cfg.extensions.fence.enable {
        "${extDir}/fence/index.ts".source = "${pkg}/fence/index.ts";
      })

      (lib.mkIf cfg.extensions.questionnaire.enable {
        "${extDir}/questionnaire/index.ts".source = "${pkg}/questionnaire/index.ts";
      })

      (lib.mkIf cfg.extensions.modal-editor.enable {
        "${extDir}/modal-editor/index.ts".source = "${pkg}/modal-editor/index.ts";
      })

      (lib.mkIf cfg.extensions.mac-system-theme.enable {
        "${extDir}/mac-system-theme/index.ts".source = "${pkg}/mac-system-theme/index.ts";
      })

      (lib.mkIf cfg.extensions.permission-gate.enable {
        "${extDir}/permission-gate/index.ts".source = "${pkg}/permission-gate/index.ts";
      })

      (lib.mkIf cfg.extensions.slow-mode.enable {
        "${extDir}/slow-mode/index.ts".source = pkgs.writeText "index.ts" (
          builtins.replaceStrings
            [ "rmdirSync" "let enabled = false;" ]
            [
              "rmSync"
              (
                if cfg.extensions.slow-mode.enabledByDefault then
                  ''
                    let enabled = true;

                      pi.on("session_start", async (_event, ctx) => {
                        if (ctx.hasUI) ctx.ui.setStatus("slow-mode", ctx.ui.theme.fg("warning", "slow ■"));
                      });''
                else
                  "let enabled = false;"
              )
            ]
            (builtins.readFile "${pkg}/slow-mode/index.ts")
        );
      })

      (lib.mkIf cfg.extensions.sandbox.enable {
        "${extDir}/sandbox".source = "${pkg}/sandbox";
      })
    ];
  };
}
