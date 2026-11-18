{ self, pkgs }:

let
  consumerNames = [
    "background-job"
    "direnv"
    "fetch"
    "pdf"
    "permission-gate"
    "sandbox"
    "ssh"
    "subagent"
  ];
  mkExtensionBundle = import ./mk-extension-bundle.nix {
    inherit self;
    lib = pkgs.lib;
  };
  bundles = map (
    name:
    mkExtensionBundle {
      inherit pkgs;
      name = "agentsh-mode-${name}-bundle-check";
      extensions = [ name ];
    }
  ) consumerNames;
  inherit (import ./module-test-harness.nix { inherit self pkgs; }) evaluate valid;
  # Evaluate through the shared module harness, so options the module relies
  # on (such as `assertions` for removed options) are declared consistently.
  homeFilesFor =
    name:
    let
      config = evaluate { extensions.${name}.enable = true; };
    in
    assert valid config;
    config.home.file;
in
pkgs.runCommand "agentsh-mode-check"
  {
    SOURCE_ROOT = self;
    FIXTURES = ./agentsh-mode-check;
    BUNDLE_ROOTS = bundles;
    MODULE_SHARED_ROOTS = map (
      name: (homeFilesFor name).".pi/agent/extensions/shared".source
    ) consumerNames;
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.typescript
    ];
  }
  ''
    source ${./agentsh-mode-check.sh}
  ''
