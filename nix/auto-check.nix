{ self, pkgs }:

pkgs.runCommand "auto-extension-check"
  {
    SOURCE_ROOT = self;
    FIXTURES = ./auto-check;
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.typescript
    ];
  }
  ''
    source ${./auto-check.sh}
  ''
