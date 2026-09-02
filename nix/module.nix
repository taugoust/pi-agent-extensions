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
  extDir = ".pi/agent/extensions";
  registry = import ./extension-registry.nix { inherit self pi-mcp-adapter pi-openai-fast-mode; };
  needsSharedRuntime = lib.any (name: cfg.extensions.${name}.enable) registry.sharedRuntimeExtensionNames;
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
      background-job.enable = lib.mkEnableOption "background-job extension — durable native shell jobs in an isolated tmux server";
      direnv.enable = lib.mkEnableOption "direnv extension — refreshes environment via direnv export";
      fence.enable = lib.mkEnableOption "fence extension — blocks write/edit outside cwd";
      fetch.enable = lib.mkEnableOption "adaptive fetch extension — native HTTP outside AgentSH and supervised curl when AgentSH is active";
      questionnaire.enable = lib.mkEnableOption "questionnaire extension — LLM-driven multi-question UI tool";
      modal-editor.enable = lib.mkEnableOption "modal-editor extension — vim-style modal input";
      mac-system-theme.enable = lib.mkEnableOption "mac-system-theme extension — syncs pi theme to macOS system appearance";
      pager.enable = lib.mkEnableOption "pager extension — open conversation in an external pager (bat/less)";
      pdf.enable = lib.mkEnableOption "pdf extension — inspect PDFs locally or through an active AgentSH supervisor";
      permission-gate.enable = lib.mkEnableOption "permission-gate extension — AgentSH rendezvous or legacy dangerous Bash authorization";
      ssh.enable = lib.mkEnableOption "ssh extension — run read/write/edit/bash tools on a remote host via --ssh";
      openai-fast-mode.enable = lib.mkEnableOption "pi-openai-fast-mode extension — toggle OpenAI priority inference with /fast";

      slow-mode = {
        enable = lib.mkEnableOption "slow-mode extension — review gate for write/edit tool calls";
        enabledByDefault = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Start every session with slow-mode already active.";
        };
      };

      sandbox.enable = lib.mkEnableOption "sandbox extension — AgentSH supervisor backend; also installs the adaptive subagent and its child finalizer";
      subagent.enable = lib.mkEnableOption "adaptive subagent extension — native child Pi or AgentSH backend; also installs its child finalizer";
      subagent-finalizer.enable = lib.mkEnableOption "standalone subagent-finalizer extension — automatically included with sandbox or subagent";
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
      (lib.mkIf cfg.extensions.background-job.enable [
        pkgs.nodejs
        pkgs.tmux
      ])
      (lib.mkIf cfg.extensions.pdf.enable [
        pkgs.poppler-utils
        pkgs.imagemagick
      ])
    ];

    home.file = lib.mkMerge [
      (lib.mkIf cfg.skills.github-repo-search.enable {
        ".pi/agent/skills/github-repo-search/SKILL.md".source =
          "${self}/skills/github-repo-search/SKILL.md";
      })
      (lib.mkIf cfg.skills.remindctl.enable {
        ".pi/agent/skills/remindctl/SKILL.md".source = "${self}/skills/remindctl/SKILL.md";
      })
      (lib.mkIf cfg.skills.drawio.enable {
        ".pi/agent/skills/drawio".source = "${self}/skills/drawio";
      })
      (lib.mkIf cfg.skills.tikz-figure-recreation.enable {
        ".pi/agent/skills/tikz-figure-recreation/SKILL.md".source =
          "${self}/skills/tikz-figure-recreation/SKILL.md";
      })
      (lib.mkIf needsSharedRuntime {
        "${extDir}/shared".source = "${self}/shared";
      })
      (lib.mkIf cfg.extensions.background-job.enable {
        "${extDir}/background-job".source = "${self}/background-job";
      })

      (lib.mkIf cfg.extensions.direnv.enable {
        "${extDir}/direnv/index.ts".source = "${self}/direnv/index.ts";
      })

      (lib.mkIf cfg.extensions.fence.enable {
        "${extDir}/fence/index.ts".source = "${self}/fence/index.ts";
      })

      (lib.mkIf cfg.extensions.fetch.enable {
        "${extDir}/fetch".source = "${self}/fetch";
      })

      (lib.mkIf cfg.extensions.questionnaire.enable {
        "${extDir}/questionnaire/index.ts".source = "${self}/questionnaire/index.ts";
        "${extDir}/questionnaire/paseo.ts".source = "${self}/questionnaire/paseo.ts";
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
        "${extDir}/pdf/backend.ts".source = "${self}/pdf/backend.ts";
      })

      (lib.mkIf cfg.extensions.permission-gate.enable {
        "${extDir}/permission-gate/index.ts".source = "${self}/permission-gate/index.ts";
      })

      (lib.mkIf cfg.extensions.ssh.enable {
        "${extDir}/ssh/index.ts".source = "${self}/ssh/index.ts";
      })

      (lib.mkIf cfg.extensions.openai-fast-mode.enable (
        builtins.listToAttrs (
          map
            (file: {
              name = "${extDir}/pi-openai-fast-mode/${file}";
              value.source = "${pi-openai-fast-mode}/src/${file}";
            })
            [
              "commands.ts"
              "config.ts"
              "index.ts"
              "payload.ts"
              "status.ts"
              "types.ts"
            ]
        )
      ))

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

      (lib.mkIf (cfg.extensions.sandbox.enable || cfg.extensions.subagent.enable) {
        "${extDir}/subagent/index.ts".source = "${self}/subagent/index.ts";
        "${extDir}/subagent/backend.ts".source = "${self}/subagent/backend.ts";
        "${extDir}/subagent/background.ts".source = "${self}/subagent/background.ts";
        "${extDir}/subagent/foreground-handoff.ts".source = "${self}/subagent/foreground-handoff.ts";
        "${extDir}/subagent/parallel-result.ts".source = "${self}/subagent/parallel-result.ts";
      })

      (lib.mkIf
        (
          cfg.extensions.sandbox.enable
          || cfg.extensions.subagent.enable
          || cfg.extensions.subagent-finalizer.enable
        )
        {
          "${extDir}/subagent-finalizer/index.ts".source = "${self}/subagent-finalizer/index.ts";
        }
      )

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
