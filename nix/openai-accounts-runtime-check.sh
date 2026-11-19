# Usage: source openai-accounts-runtime-check.sh SOURCE PI_PACKAGE BUNDLE
set -euo pipefail

source_root=$1
pi_package=$2
bundle=$3
test -f "$bundle/openai-accounts/index.ts"
test -f "$bundle/openai-accounts/node_modules/proper-lockfile/package.json"
test -f "$bundle/openai-accounts/node_modules/proper-lockfile/LICENSE"
test -f "$bundle/openai-accounts/node_modules/graceful-fs/LICENSE"
test -f "$bundle/openai-accounts/node_modules/signal-exit/LICENSE.txt"
test ! -e "$bundle/node_modules/proper-lockfile"

export HOME="$TMPDIR/home"
export PI_CODING_AGENT_DIR="$HOME/agent"
export PI_OFFLINE=1
export NODE_PATH=
mkdir -p "$HOME" "$PI_CODING_AGENT_DIR"
node --test "$source_root/tests/account-managed-auth.test.mjs"
timeout 30s node "$source_root/tests/package-load.mjs" "$pi_package/bin/pi" \
  "$bundle/openai-accounts" "$bundle/openai-usage" --expect accounts '!usage'
# Exercise Codex-only routing and legacy-provider preservation against the immutable bundle,
# never a checkout or user accounts.
mkdir -p fixture/tests
cp "$source_root/tests/session-routing-native.mjs" fixture/tests/session-routing-native.mjs
cp "$source_root/tests/session-routing-native-fixture.ts" \
  fixture/tests/session-routing-native-fixture.ts
ln -s "$bundle/openai-accounts" fixture/openai-accounts
ln -s "$bundle/idle-context-warning" fixture/idle-context-warning
ln -s "$bundle/shared" fixture/shared
unset PI_SESSION_ROUTING_FILE PI_SESSION_ROUTING_OWNER_SESSION
unset AGENTSH_SUBAGENT_ID AGENTSH_SUBAGENT_REQUEST_ID
mkdir -p "$out"
timeout 90s node fixture/tests/session-routing-native.mjs "$pi_package/bin/pi" \
  "$PWD/fixture/tests/session-routing-native-fixture.ts" > "$out/native-routing.log" 2>&1 || {
  cat "$out/native-routing.log"
  exit 1
}
cat "$out/native-routing.log"
printf 'Account commands and native routing verified in the immutable Pi runtime.\n' > "$out/result"
