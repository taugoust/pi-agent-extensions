{
  self,
  pkgs,
  piPackage,
  extensionBundle,
}:
let
  # A test-owned immutable launcher, deliberately without host AgentSH/Paseo
  # environment or real credentials. Each fixture gets its own HOME/state root.
  launcher = pkgs.writeShellScriptBin "pi-profiles-test-worker" ''
    exec ${pkgs.lib.getExe piPackage} "$@"
  '';
in
pkgs.runCommand "pi-subagent-profiles-native-check"
  {
    nativeBuildInputs = [
      pkgs.nodejs_24
      pkgs.coreutils
      pkgs.git
    ];
  }
  ''
    set -euo pipefail
    export HOME="$TMPDIR/home"
    mkdir -p "$HOME"
    export PI_OFFLINE=1
    export PI_TUI_WORKER_LAUNCHER=${pkgs.lib.getExe launcher}
    export PI_TUI_WORKER_LAUNCH_MODE=none
    for role in scout worker reviewer oracle; do
      test -f ${extensionBundle}/subagent/agents/$role.md
    done
    test -f ${extensionBundle}/subagent/agents/LICENSE
    timeout 240s node ${self}/tests/subagent-profiles-native.mjs \
      ${pkgs.lib.getExe piPackage} ${extensionBundle}/subagent/index.ts \
      ${self}/tests/subagent-profiles-native-fixture.ts
    printf 'Actual offline native profile selection and retained contract checks passed.\n' > "$out"
  ''
