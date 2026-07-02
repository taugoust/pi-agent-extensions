{ self, pkgs, pi-mcp-adapter ? null }:

let
  registry = import ./extension-registry.nix { inherit self pi-mcp-adapter; };
  mkExtensionBundle = import ./mk-extension-bundle.nix {
    inherit self pi-mcp-adapter;
    lib = pkgs.lib;
  };
in
mkExtensionBundle {
  inherit pkgs;
  name = "pi-agent-extensions";
  packageName = "pi-agent-extensions";
  extensions = registry.localExtensionNames ++ pkgs.lib.optional (pi-mcp-adapter != null) "mcp-adapter";
  skills = registry.localSkillNames;
}
