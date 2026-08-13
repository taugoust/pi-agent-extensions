{
  self,
  pkgs,
  pi-mcp-adapter ? null,
  pi-openai-fast-mode ? null,
}:

let
  registry = import ./extension-registry.nix { inherit self pi-mcp-adapter pi-openai-fast-mode; };
  mkExtensionBundle = import ./mk-extension-bundle.nix {
    inherit self pi-mcp-adapter pi-openai-fast-mode;
    lib = pkgs.lib;
  };
in
mkExtensionBundle {
  inherit pkgs;
  name = "pi-agent-extensions";
  packageName = "pi-agent-extensions";
  extensions =
    registry.localExtensionNames
    ++ registry.pinnedExtensionNames
    ++ pkgs.lib.optional (pi-mcp-adapter != null) "mcp-adapter";
  skills = registry.localSkillNames;
}
