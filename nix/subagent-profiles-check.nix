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
    # Tmux workers receive the caller's agent directory, not its arbitrary
    # environment. Reconstruct ONLY this fixture's disposable per-scenario
    # paths rather than mutating the server-global environment between cases.
    export HOME="$(dirname "''${PI_CODING_AGENT_DIR:?}")"
    fixture_root="$(dirname "$HOME")"
    export TMPDIR="$fixture_root"
    export XDG_CONFIG_HOME="$HOME/config"
    export XDG_CACHE_HOME="$HOME/cache"
    export PI_TUI_WORKER_STATE_ROOT="$fixture_root/worker-state"
    export PROFILE_FIXTURE_LOG="$fixture_root/dispatch.jsonl"
    # Explicitly add ONLY the synthetic provider, including for managed Goal
    # workers that correctly disable automatic extension discovery.
    exec ${pkgs.lib.getExe piPackage} "$@" --extension ${self}/tests/subagent-profiles-native-fixture.ts 2>> "$PROFILE_FIXTURE_LOG.stderr"
  '';
  driver = pkgs.writeShellScript "pi-profiles-tmux-driver" ''
    set +e
    node ${self}/tests/subagent-profiles-native.mjs \
      ${pkgs.lib.getExe piPackage} ${extensionBundle}/subagent/index.ts \
      ${self}/tests/subagent-profiles-native-fixture.ts > "$PROFILE_TEST_LOG" 2>&1
    result=$?
    printf '%s\n' "$result" > "$PROFILE_TEST_RESULT"
    tmux -S "$PROFILE_TMUX_SOCKET" wait-for -S profiles-done
    # Keep the real calling pane alive until the outer fixture reads the result
    # and destroys ONLY its own server, including on test failure or timeout.
    exec tail -f /dev/null
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
    set -euo pipefail
    export HOME="$TMPDIR/home"
    mkdir -p "$HOME"
    export PI_OFFLINE=1
    export PI_TUI_WORKER_LAUNCHER=${pkgs.lib.getExe launcher}
    export PI_TUI_WORKER_LAUNCH_MODE=none
    for role in scout worker reviewer oracle coordinator; do
      test -f ${extensionBundle}/subagent/agents/$role.md
    done
    test -f ${extensionBundle}/subagent/agents/LICENSE
    export PROFILE_TMUX_SOCKET="$TMPDIR/profiles.sock"
    export PROFILE_TEST_LOG="$TMPDIR/profiles.log"
    export PROFILE_TEST_RESULT="$TMPDIR/profiles.exit"
    trap 'tmux -S "$PROFILE_TMUX_SOCKET" kill-server 2>/dev/null || true' EXIT
    # The Node driver and all RPC parents really descend from this private
    # calling pane; no fake pane IDs, host server or production bypass is used.
    tmux -S "$PROFILE_TMUX_SOCKET" -f /dev/null new-session -d -s profiles ${driver}
    wait_status=0
    timeout 240s tmux -S "$PROFILE_TMUX_SOCKET" wait-for profiles-done || wait_status=$?
    if [ -f "$PROFILE_TEST_LOG" ]; then cat "$PROFILE_TEST_LOG"; fi
    test "$wait_status" = 0
    test -f "$PROFILE_TEST_RESULT"
    test "$(< "$PROFILE_TEST_RESULT")" = 0
    printf 'Actual offline native profile selection and retained contract checks passed.\n' > "$out"
  ''
