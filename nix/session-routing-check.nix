{ self, pkgs }:
pkgs.runCommand "pi-session-routing-check"
  {
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.typescript
    ];
  }
  ''
    source ${./session-routing-check.sh} ${self}
    touch $out
  ''
