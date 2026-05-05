{
  description = "A collection of pi coding agent extensions";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-25.11-darwin";

    bun2nix = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

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
      bun2nix,
      llm-agents-nix,
      pi-mcp-adapter,
      ...
    }:
    let
      systems = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs {
            inherit system;
            overlays = [ llm-agents-nix.overlays.default ];
          };
        in
        {
          default = import ./nix/package.nix { inherit self bun2nix pkgs pi-mcp-adapter; };
          pi = pkgs.llm-agents.pi;
          pi-mcp-adapter-src = pi-mcp-adapter;
        }
      );

      checks = forAllSystems (system:
        let
          pkgs = import nixpkgs {
            inherit system;
            overlays = [ llm-agents-nix.overlays.default ];
          };
        in
        import ./nix/checks.nix { inherit self bun2nix pkgs pi-mcp-adapter; }
      );

      homeManagerModules.default = import ./nix/module.nix { inherit self bun2nix pi-mcp-adapter; };
    };
}
