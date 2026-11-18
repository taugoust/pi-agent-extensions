{ self, pkgs }:
pkgs.runCommand "permission-gate-check"
  {
    src = self;
    fixtures = ./permission-gate-check;
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.typescript
    ];
  }
  ''
    source ${./permission-gate-check.sh}
  ''
