{ self, pkgs }:

pkgs.runCommand "subagent-finalizer-check"
  {
    SOURCE_ROOT = self;
    FIXTURES = ./subagent-finalizer-check;
    nativeBuildInputs = [
      pkgs.gnugrep
      pkgs.nodejs
      pkgs.typescript
    ];
  }
  ''
    source ${./subagent-finalizer-check.sh}
  ''
