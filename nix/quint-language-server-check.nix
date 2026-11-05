{ self, pkgs }:

pkgs.runCommand "quint-language-server-check"
  {
    nativeBuildInputs = [
      self.packages.${pkgs.stdenv.hostPlatform.system}.quint-language-server
      pkgs.python3
    ];
  }
  ''
    export HOME="$TMPDIR"
    python3 ${self}/tests/quint/lsp-smoke.py ${self}/tests/quint/native_task.qnt
    touch "$out"
  ''
