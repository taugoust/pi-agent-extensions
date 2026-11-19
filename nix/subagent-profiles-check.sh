# Usage: source subagent-profiles-check.sh LAUNCHER BUNDLE DRIVER
set -euo pipefail

launcher=$1
bundle=$2
driver=$3
export HOME="$TMPDIR/home"
mkdir -p "$HOME"
export PI_OFFLINE=1
export PI_TUI_WORKER_LAUNCHER="$launcher"
export PI_TUI_WORKER_LAUNCH_MODE=none
for role in scout worker reviewer oracle coordinator; do
  test -f "$bundle/subagent/agents/$role.md"
done
test -f "$bundle/subagent/agents/LICENSE"
export PROFILE_TMUX_SOCKET="$TMPDIR/profiles.sock"
export PROFILE_TEST_LOG="$TMPDIR/profiles.log"
export PROFILE_TEST_RESULT="$TMPDIR/profiles.exit"
trap 'tmux -S "$PROFILE_TMUX_SOCKET" kill-server 2>/dev/null || true' EXIT
# The Node driver and RPC parents really descend from this private calling pane;
# no fake pane IDs, host server or production bypass is used.
tmux -S "$PROFILE_TMUX_SOCKET" -f /dev/null new-session -d -s profiles "$driver"
wait_status=0
timeout 240s tmux -S "$PROFILE_TMUX_SOCKET" wait-for profiles-done || wait_status=$?
if [ -f "$PROFILE_TEST_LOG" ]; then
  cat "$PROFILE_TEST_LOG"
fi
test "$wait_status" = 0
test -f "$PROFILE_TEST_RESULT"
test "$(< "$PROFILE_TEST_RESULT")" = 0
printf 'Actual offline native profile selection and retained contract checks passed.\n' > "$out"
