{
  self,
  pkgs,
  piSource ? self.packages.${pkgs.stdenv.hostPlatform.system}.pi.src,
}:

pkgs.runCommand "pi-progress-settings-behavior-check"
  {
    SOURCE_ROOT = self;
    FIXTURES = ./progress-settings-check;
    PI_QUEUE_MODULE = "${piSource}/dist/core/tools/file-mutation-queue.js";
    nativeBuildInputs = [
      pkgs.bun
      pkgs.python3
      pkgs.gnugrep
    ];
  }
  ''
    source ${./progress-settings-check.sh}
  ''
