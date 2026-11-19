{ self, pkgs }:

pkgs.runCommand "pdf-check"
  {
    SOURCE_ROOT = self;
    FIXTURES = ./pdf-check;
    nativeBuildInputs = [
      pkgs.bash
      pkgs.nodejs
      pkgs.typescript
    ];
  }
  ''
    source ${./pdf-check.sh}
  ''
