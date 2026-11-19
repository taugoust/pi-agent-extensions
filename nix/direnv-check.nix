{ self, pkgs }:
pkgs.runCommand "direnv-check"
  {
    src = self;
    fixtures = ./direnv-check;
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.typescript
    ];
  }
  ''
    source ${./direnv-check.sh}
  ''
