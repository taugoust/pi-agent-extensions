{ self, pkgs }:

let
  inherit (import ./module-test-harness.nix { inherit self pkgs; }) evaluate valid;
  moduleConfig = evaluate { extensions.background-job.enable = true; };
  moduleFiles =
    assert valid moduleConfig;
    moduleConfig.home.file;
  modulePackages = moduleConfig.home.packages;
  package = self.packages.${pkgs.stdenv.hostPlatform.system}.extensions;
in
pkgs.runCommand "background-job-extension-check"
  {
    SOURCE_ROOT = self;
    FIXTURES = ./background-job-check;
    EXTENSION_PACKAGE = package;
    MODULE_EXTENSION = moduleFiles.".pi/agent/extensions/background-job".source;
    MODULE_SHARED = moduleFiles.".pi/agent/extensions/shared".source;
    HAS_TMUX = toString (builtins.elem pkgs.tmux modulePackages);
    HAS_NODE = toString (builtins.elem pkgs.nodejs modulePackages);
    TEST_TMUX = "${pkgs.tmux}/bin/tmux";
    nativeBuildInputs = [
      pkgs.coreutils
      pkgs.findutils
      pkgs.jq
      pkgs.nodejs
      pkgs.tmux
      pkgs.procps
      pkgs.typescript
    ];
  }
  ''
    source ${./background-job-check.sh}
  ''
