{
  self,
  pkgs,
  piPackage,
  extensionBundle,
}:
let
  # Test-owned immutable launchers, without host AgentSH/Paseo or real credentials.
  launcher = pkgs.writeShellScriptBin "pi-profiles-test-worker" ''
    source ${./subagent-profiles-check/launcher.sh} \
      ${pkgs.lib.getExe piPackage} ${self}/tests/subagent-profiles-native-fixture.ts "$@"
  '';
  driver = pkgs.writeShellScript "pi-profiles-tmux-driver" ''
    source ${./subagent-profiles-check/driver.sh} \
      ${self} ${pkgs.lib.getExe piPackage} ${extensionBundle}
  '';
in
pkgs.runCommand "pi-subagent-profiles-native-check"
  {
    nativeBuildInputs = [
      pkgs.nodejs_24
      pkgs.coreutils
      pkgs.git
      pkgs.tmux
    ];
  }
  ''
    source ${./subagent-profiles-check.sh} ${pkgs.lib.getExe launcher} ${extensionBundle} ${driver}
  ''
