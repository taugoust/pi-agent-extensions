{
  self,
  pkgs,
  piPackage ? null,
  tuiWorkerLauncher ? null,
}:

let
  mkExtensionBundle = import ./mk-extension-bundle.nix {
    inherit self;
    lib = pkgs.lib;
  };
  sandboxOnlyBundle = mkExtensionBundle {
    inherit pkgs;
    name = "sandbox-only-subagent-check-bundle";
    extensions = [ "sandbox" ];
  };
  subagentOnlyBundle = mkExtensionBundle {
    inherit pkgs;
    name = "subagent-only-finalizer-check-bundle";
    extensions = [ "subagent" ];
  };
in
pkgs.runCommand "subagent-check"
  {
    nativeBuildInputs = [
      pkgs.gnugrep
      pkgs.git
      pkgs.jq
      pkgs.nodejs
      pkgs.python3
      pkgs.typescript
      pkgs.tmux
    ];
    srcRoot = self;
    fixtureRoot = ./subagent-check;
    inherit sandboxOnlyBundle subagentOnlyBundle;
    mkfifoBin = "${pkgs.coreutils}/bin/mkfifo";
    piBin = pkgs.lib.optionalString (piPackage != null) (pkgs.lib.getExe piPackage);
    tuiRootLauncher = pkgs.lib.optionalString (piPackage != null) (
      pkgs.lib.getExe (if tuiWorkerLauncher != null then tuiWorkerLauncher else piPackage)
    );
    tuiRootMode = if tuiWorkerLauncher != null then "guard-only" else "none";
  }
  ''
    source ${./subagent-check.sh}
  ''
