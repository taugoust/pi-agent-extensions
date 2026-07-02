{ self, pi-mcp-adapter ? null }:

let
  localExtensionNames = [
    "agent-events"
    "direnv"
    "fence"
    "fetch"
    "mac-system-theme"
    "modal-editor"
    "pager"
    "pdf"
    "permission-gate"
    "questionnaire"
    "sandbox"
    "slow-mode"
    "ssh"
    "subagent"
  ];

  localExtensions = builtins.listToAttrs (map (name: {
    inherit name;
    value = {
      source = "${self}/${name}";
      manifestPath = name;
    };
  }) localExtensionNames);

  optionalExtensions = {
    mcp-adapter = {
      source = pi-mcp-adapter;
      manifestPath = "node_modules/pi-mcp-adapter";
      requiresInput = "pi-mcp-adapter";
    };
  };

  localSkillNames = [
    "drawio"
    "github-repo-search"
    "remindctl"
    "tikz-figure-recreation"
  ];

  skills = builtins.listToAttrs (map (name: {
    inherit name;
    value = {
      source = "${self}/skills/${name}";
      manifestPath = "skills/${name}";
    };
  }) localSkillNames);
in
{
  extensions = localExtensions // optionalExtensions;
  inherit skills localExtensionNames localSkillNames;
}
