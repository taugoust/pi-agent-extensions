{ self, pi-mcp-adapter ? null }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.pi;
  extDir = ".pi/agent/extensions";
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
      agent-events.enable = lib.mkEnableOption "agent-events extension — publish AgentSH session events for external notifications";
      direnv.enable = lib.mkEnableOption "direnv extension — refreshes environment via direnv export";
      fence.enable = lib.mkEnableOption "fence extension — blocks write/edit outside cwd";
      questionnaire.enable = lib.mkEnableOption "questionnaire extension — LLM-driven multi-question UI tool";
      modal-editor.enable = lib.mkEnableOption "modal-editor extension — vim-style modal input";
      mac-system-theme.enable = lib.mkEnableOption "mac-system-theme extension — syncs pi theme to macOS system appearance";
      pager.enable = lib.mkEnableOption "pager extension — open conversation in an external pager (bat/less)";
      pdf.enable = lib.mkEnableOption "pdf extension — inspect local PDFs via Poppler and ImageMagick tools";
      permission-gate.enable = lib.mkEnableOption "permission-gate extension — legacy regex gate for dangerous bash commands";
      ssh.enable = lib.mkEnableOption "ssh extension — run read/write/edit/bash tools on a remote host via --ssh";

      slow-mode = {
        enable = lib.mkEnableOption "slow-mode extension — review gate for write/edit tool calls";
        enabledByDefault = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Start every session with slow-mode already active.";
        };
      };

      sandbox.enable = lib.mkEnableOption "sandbox extension — AgentSH approval relay UI";
      subagent.enable = lib.mkEnableOption "subagent extension — same-session dynamic child Pi processes under AgentSH inheritance";
      subagent-finalizer.enable = lib.mkEnableOption "subagent-finalizer extension — steer subagents to finish before context compaction";
      mcp-adapter.enable = lib.mkEnableOption "pi-mcp-adapter extension — MCP proxy/direct-tools integration";
    };

    skills = {
      github-repo-search.enable = lib.mkEnableOption "github-repo-search skill — search GitHub repos via gh CLI without cloning";
      remindctl.enable = lib.mkEnableOption "remindctl skill — manage Apple Reminders via the remindctl CLI";
      drawio.enable = lib.mkEnableOption "drawio skill — generate native draw.io diagrams and optional exports";
      tikz-figure-recreation.enable = lib.mkEnableOption "tikz-figure-recreation skill — recreate paper/PDF/image/draw.io figures as TikZ";
    };
  };

  config = lib.mkIf cfg.enable {
    programs.pi.package = lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.pi;

    home.packages = lib.mkMerge [
      (lib.mkIf (cfg.package != null) [ cfg.package ])
      (lib.mkIf cfg.extensions.pdf.enable [ pkgs.poppler-utils pkgs.imagemagick ])
    ];

      home.file = lib.mkMerge [
      (lib.mkIf cfg.skills.github-repo-search.enable {
        ".pi/agent/skills/github-repo-search/SKILL.md".source = "${self}/skills/github-repo-search/SKILL.md";
      })
      (lib.mkIf cfg.skills.remindctl.enable {
        ".pi/agent/skills/remindctl/SKILL.md".source = "${self}/skills/remindctl/SKILL.md";
      })
      (lib.mkIf cfg.skills.drawio.enable {
        ".pi/agent/skills/drawio".source = "${self}/skills/drawio";
      })
      (lib.mkIf cfg.skills.tikz-figure-recreation.enable {
        ".pi/agent/skills/tikz-figure-recreation/SKILL.md".source = "${self}/skills/tikz-figure-recreation/SKILL.md";
      })
      (lib.mkIf cfg.extensions.agent-events.enable {
        "${extDir}/agent-events/index.ts".source = "${self}/agent-events/index.ts";
      })
      (lib.mkIf cfg.extensions.direnv.enable {
        "${extDir}/direnv/index.ts".source = "${self}/direnv/index.ts";
      })

      (lib.mkIf cfg.extensions.fence.enable {
        "${extDir}/fence/index.ts".source = "${self}/fence/index.ts";
      })

      (lib.mkIf cfg.extensions.questionnaire.enable {
        "${extDir}/questionnaire/index.ts".source = "${self}/questionnaire/index.ts";
      })

      (lib.mkIf cfg.extensions.modal-editor.enable {
        "${extDir}/modal-editor/index.ts".source = "${self}/modal-editor/index.ts";
      })

      (lib.mkIf cfg.extensions.mac-system-theme.enable {
        "${extDir}/mac-system-theme/index.ts".source = "${self}/mac-system-theme/index.ts";
      })

      (lib.mkIf cfg.extensions.pager.enable {
        "${extDir}/pager/index.ts".source = "${self}/pager/index.ts";
      })

      (lib.mkIf cfg.extensions.pdf.enable {
        "${extDir}/pdf/index.ts".source = "${self}/pdf/index.ts";
      })

      (lib.mkIf cfg.extensions.permission-gate.enable {
        "${extDir}/permission-gate/index.ts".source = "${self}/permission-gate/index.ts";
      })

      (lib.mkIf cfg.extensions.ssh.enable {
        "${extDir}/ssh/index.ts".source = "${self}/ssh/index.ts";
      })

      (lib.mkIf cfg.extensions.slow-mode.enable {
        "${extDir}/slow-mode/index.ts".text =
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
            (builtins.readFile "${self}/slow-mode/index.ts");
      })

        (lib.mkIf cfg.extensions.sandbox.enable {
          "${extDir}/sandbox".source = "${self}/sandbox";
        })

        (lib.mkIf cfg.extensions.subagent.enable {
          "${extDir}/subagent/index.ts".source = "${self}/subagent/index.ts";
        })

        (lib.mkIf (cfg.extensions.subagent.enable || cfg.extensions.subagent-finalizer.enable) {
          "${extDir}/subagent-finalizer/index.ts".source = "${self}/subagent-finalizer/index.ts";
        })

        (lib.mkIf cfg.extensions.mcp-adapter.enable {
          "${extDir}/pi-mcp-adapter".source =
            if pi-mcp-adapter != null then
              pi-mcp-adapter
            else
              throw "programs.pi.extensions.mcp-adapter.enable requires pi-mcp-adapter input";
        })
      ];
  };
}
