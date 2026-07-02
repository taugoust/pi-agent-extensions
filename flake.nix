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
  };

  outputs =
    {
      self,
      nixpkgs,
      llm-agents-nix,
      pi-mcp-adapter,
      ...
    }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      registry = import ./nix/extension-registry.nix { inherit self pi-mcp-adapter; };
    in
    {
      lib = {
        availableExtensions = builtins.attrNames registry.extensions;
        availableSkills = builtins.attrNames registry.skills;
        mkExtensionBundle = import ./nix/mk-extension-bundle.nix {
          inherit self pi-mcp-adapter;
          lib = nixpkgs.lib;
        };
      };

      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          extensionBundle = self.lib.mkExtensionBundle;
          extensionsPackage = import ./nix/package.nix { inherit self pkgs pi-mcp-adapter; };
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
              "agent-events"
              "questionnaire"
              "pager"
              "fetch"
              "modal-editor"
              "pdf"
              "slow-mode"
              "ssh"
              "sandbox"
            ];
          };
        }
      );

      checks = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        import ./nix/checks.nix { inherit self pkgs pi-mcp-adapter; }
      );

      homeManagerModules.default = import ./nix/module.nix { inherit self pi-mcp-adapter; };
    };
}
