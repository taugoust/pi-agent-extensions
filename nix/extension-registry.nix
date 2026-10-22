{
  self,
  pi-mcp-adapter ? null,
  pi-openai-fast-mode ? null,
}:

let
  localExtensionNames = [
    "auto"
    "btw"
    "workflows"
    "background-job"
    "direnv"
    "fence"
    "fetch"
    "idle-context-warning"
    "openai-accounts"
    "openai-usage"
    "stamp"
    "progress"
    "cache-hit-monitor"
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
        installName = name;
        optionName =
          if name == "openai-accounts" then
            "accounts"
          else if name == "openai-usage" then
            "usage"
          else
            name;
        dependencies =
          if name == "sandbox" then
            [ "subagent" ]
          else if name == "subagent" then
            [ "subagent-finalizer" ]
          else
            [ ];
      };
    }) localExtensionNames
  );

  pinnedExtensionNames = [ "openai-fast-mode" ];

  # Local extensions may import the classifier, defaults loader, or other
  # package-level helpers. Include the small shared tree for every local
  # selection so adding a helper import never creates a missing-file install.
  sharedRuntimeExtensionNames = localExtensionNames;

  upstreamExtensions = {
    openai-fast-mode = {
      source = pi-openai-fast-mode;
      package = ./pi-openai-fast-mode;
      manifestPath = "node_modules/pi-openai-fast-mode";
      # The package lives at manifestPath, but Pi's extension resource is its
      # TypeScript entrypoint (not a nested package declaration).
      entrypoint = "src/index.ts";
      requiresInput = "pi-openai-fast-mode";
      installName = "pi-openai-fast-mode";
      installSubdir = "src";
      optionName = "openai-fast-mode";
      dependencies = [ ];
    };
  };

  optionalExtensions = {
    mcp-adapter = {
      source = pi-mcp-adapter;
      manifestPath = "node_modules/pi-mcp-adapter";
      requiresInput = "pi-mcp-adapter";
      installName = "pi-mcp-adapter";
      optionName = "mcp-adapter";
      dependencies = [ ];
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
  extensions = localExtensions // upstreamExtensions // optionalExtensions;
  # One dependency graph serves package composition and Home Manager installation.
  resolveExtensions =
    names:
    map (entry: entry.key) (
      builtins.genericClosure {
        startSet = map (key: { inherit key; }) names;
        operator = entry: map (key: { inherit key; }) (extensions.${entry.key}.dependencies or [ ]);
      }
    );
in
{
  inherit extensions resolveExtensions;
  inherit
    skills
    localExtensionNames
    pinnedExtensionNames
    sharedRuntimeExtensionNames
    localSkillNames
    ;
}
