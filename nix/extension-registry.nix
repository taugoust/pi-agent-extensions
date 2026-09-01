{
  self,
  pi-mcp-adapter ? null,
  pi-openai-fast-mode ? null,
}:

let
  localExtensionNames = [
    "auto"
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
    "subagent-finalizer"
  ];

  localExtensions = builtins.listToAttrs (
    map (name: {
      inherit name;
      value = {
        source = "${self}/${name}";
        manifestPath = name;
      };
    }) localExtensionNames
  );

  pinnedExtensionNames = [ "openai-fast-mode" ];

  # These extensions import the canonical AgentSH startup/runtime classifier
  # from the package-level shared directory.
  sharedRuntimeExtensionNames = [
    "direnv"
    "fetch"
    "pdf"
    "permission-gate"
    "sandbox"
    "ssh"
    "subagent"
  ];

  upstreamExtensions = {
    openai-fast-mode = {
      source = pi-openai-fast-mode;
      manifestPath = "node_modules/pi-openai-fast-mode";
      requiresInput = "pi-openai-fast-mode";
    };
  };

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

  skills = builtins.listToAttrs (
    map (name: {
      inherit name;
      value = {
        source = "${self}/skills/${name}";
        manifestPath = "skills/${name}";
      };
    }) localSkillNames
  );
in
{
  extensions = localExtensions // upstreamExtensions // optionalExtensions;
  inherit
    skills
    localExtensionNames
    pinnedExtensionNames
    sharedRuntimeExtensionNames
    localSkillNames
    ;
}
