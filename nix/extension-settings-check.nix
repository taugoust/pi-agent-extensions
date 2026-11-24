{ self, pkgs }:

assert import ./extension-settings-module-tests.nix { inherit self pkgs; };
pkgs.runCommand "pi-extension-settings-behavior-check"
  {
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.typescript
      pkgs.python3
      pkgs.coreutils
    ];
  }
  ''
    source ${./extension-settings-check.sh} ${self}
  ''
