{ self, pkgs }:

pkgs.runCommand "http-transport-check"
  {
    SOURCE_ROOT = self;
    FIXTURES = ./http-transport-check;
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.typescript
    ];
  }
  ''
    source ${./http-transport-check.sh}
  ''
