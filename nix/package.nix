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
  # Source-only optional integrations must be selected deliberately: a pinned
  # repository is not an installed npm runtime dependency closure.
  extensions = registry.localExtensionNames ++ registry.pinnedExtensionNames;
  skills = registry.localSkillNames;
}
