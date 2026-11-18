{ self, pkgs }:
pkgs.runCommand "pi-extensions-format-check" { nativeBuildInputs = [ pkgs.oxfmt ]; } ''
  source ${./format-check.sh} ${self}
  touch $out
''
