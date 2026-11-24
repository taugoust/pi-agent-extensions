{ self, pkgs }:
pkgs.runCommand "ssh-extension-check"
  {
    src = self;
    fixtures = ./ssh-check;
    runtimeShell = pkgs.runtimeShell;
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.typescript
    ];
  }
  ''
    source ${./ssh-check.sh}
  ''
