{ self, pkgs }:

pkgs.runCommand "subagent-quint-check"
  {
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.quint
      pkgs.typescript
    ];
  }
  ''
    source ${./subagent-quint-check.sh} ${self}
  ''
