# Usage: source driver.sh SOURCE PI BUNDLE
# PROFILE_TEST_LOG, PROFILE_TEST_RESULT and PROFILE_TMUX_SOCKET identify the private fixture.
set -euo pipefail

source_root=$1
pi=$2
bundle=$3
result=0
node "$source_root/tests/subagent-profiles-native.mjs" \
  "$pi" "$bundle/subagent/index.ts" \
  "$source_root/tests/subagent-profiles-native-fixture.ts" > "$PROFILE_TEST_LOG" 2>&1 || result=$?
printf '%s\n' "$result" > "$PROFILE_TEST_RESULT"
tmux -S "$PROFILE_TMUX_SOCKET" wait-for -S profiles-done
# Keep the real calling pane alive until the outer fixture reads the result
# and destroys only its own server, including on test failure or timeout.
exec tail -f /dev/null
