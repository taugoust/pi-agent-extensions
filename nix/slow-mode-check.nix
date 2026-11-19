{ self, pkgs }:
pkgs.runCommand "slow-mode-check"
  {
    src = self;
    fixtures = ./slow-mode-check;
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.typescript
    ];
  }
  ''
    source ${./slow-mode-check.sh}
  ''
