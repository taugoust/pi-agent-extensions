{ self, pkgs }:
pkgs.runCommand "fence-check"
  {
    src = self;
    fixtures = ./fence-check;
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.typescript
    ];
  }
  ''
    source ${./fence-check.sh}
  ''
