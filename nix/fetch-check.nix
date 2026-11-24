{ self, pkgs }:
let
  inherit (import ./module-test-harness.nix { inherit self pkgs; }) evaluate;
  # The module installs the fetch extension when it is enabled.
  moduleFiles = (evaluate { extensions.fetch.enable = true; }).home.file;
  installed = moduleFiles ? ".pi/agent/extensions/fetch";
in
assert installed;
pkgs.runCommand "fetch-extension-check"
  {
    SOURCE_ROOT = self;
    FIXTURES = ./fetch-check;
    nativeBuildInputs = [
      pkgs.bash
      pkgs.coreutils
      pkgs.curl
      pkgs.gnused
      pkgs.nodejs
      pkgs.typescript
    ];
  }
  ''
    source ${./fetch-check.sh}
  ''
