{
  description = "A collection of pi coding agent extensions";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";

    llm-agents-nix = {
      url = "github:numtide/llm-agents.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    pi-mcp-adapter = {
      url = "github:nicobailon/pi-mcp-adapter";
      flake = false;
    };

    pi-openai-fast-mode = {
      url = "github:johncmunson/pi-openai-fast-mode/v0.3.0";
      flake = false;
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      llm-agents-nix,
      pi-mcp-adapter,
      pi-openai-fast-mode,
      ...
    }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      registry = import ./nix/extension-registry.nix { inherit self pi-mcp-adapter pi-openai-fast-mode; };
    in
    {
      lib = {
        availableExtensions = builtins.attrNames registry.extensions;
        availableSkills = builtins.attrNames registry.skills;
        mkExtensionBundle = import ./nix/mk-extension-bundle.nix {
          inherit self pi-mcp-adapter pi-openai-fast-mode;
          lib = nixpkgs.lib;
        };
      };

      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          extensionBundle = self.lib.mkExtensionBundle;
          extensionsPackage = import ./nix/package.nix {
            inherit
              self
              pkgs
              pi-mcp-adapter
              pi-openai-fast-mode
              ;
          };
        in
        {
          default = extensionsPackage;
          extensions = extensionsPackage;
          pi = llm-agents-nix.packages.${system}.pi;
          pi-mcp-adapter-src = pkgs.runCommand "pi-mcp-adapter-src" { } ''
            cp -R ${pi-mcp-adapter} "$out"
            chmod -R u+rwX "$out"
          '';

          example-auto-extensions = extensionBundle {
            inherit pkgs;
            name = "pi-auto-extensions";
            packageName = "pi-auto-extensions";
            extensions = [
              "questionnaire"
              "pager"
              "fetch"
              "modal-editor"
              "pdf"
              "slow-mode"
              "ssh"
              "sandbox"
              "auto"
              "subagent-finalizer"
            ];
          };
        }
      );

      checks = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        (import ./nix/checks.nix {
          inherit
            self
            pkgs
            pi-mcp-adapter
            pi-openai-fast-mode
            ;
        })
        // {
          openai-fast-mode = import ./nix/openai-fast-mode-check.nix {
            inherit self pkgs pi-openai-fast-mode;
          };
          auto = import ./nix/auto-check.nix { inherit self pkgs; };
          modal-editor = import ./nix/modal-editor-check.nix { inherit self pkgs; };
          subagent = import ./nix/subagent-check.nix { inherit self pkgs; };
          subagent-finalizer = import ./nix/subagent-finalizer-check.nix { inherit self pkgs; };
        }
      );

      homeManagerModules.default = import ./nix/module.nix {
        inherit self pi-mcp-adapter pi-openai-fast-mode;
      };
    };
}
