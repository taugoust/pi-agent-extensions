{
  pkgs,
  piPackage,
  extensionBundle,
}:
pkgs.runCommand "openai-accounts-immutable-runtime-check"
  {
    nativeBuildInputs = [
      pkgs.coreutils
      pkgs.nodejs
    ];
  }
  ''
    set -euo pipefail
    test -f ${extensionBundle}/openai-accounts/index.ts
    test -f ${extensionBundle}/openai-accounts/node_modules/proper-lockfile/package.json
    test -f ${extensionBundle}/openai-accounts/node_modules/proper-lockfile/LICENSE
    test -f ${extensionBundle}/openai-accounts/node_modules/graceful-fs/LICENSE
    test -f ${extensionBundle}/openai-accounts/node_modules/signal-exit/LICENSE.txt
    test ! -e ${extensionBundle}/node_modules/proper-lockfile

    export HOME="$TMPDIR/home"
    export PI_CODING_AGENT_DIR="$HOME/agent"
    export PI_OFFLINE=1
    export NODE_PATH=
    mkdir -p "$HOME" "$PI_CODING_AGENT_DIR"
    timeout 30s node ${../tests/package-load.mjs} ${piPackage}/bin/pi \
      ${extensionBundle}/openai-accounts ${extensionBundle}/openai-usage --expect accounts '!usage'
    # Exercise native identity, isolated subtree overrides, history restoration and
    # cold resume against the immutable bundle, never a checkout or user accounts.
    mkdir -p fixture/tests
    cp ${../tests/session-routing-native.mjs} fixture/tests/session-routing-native.mjs
    cp ${../tests/session-routing-native-fixture.ts} fixture/tests/session-routing-native-fixture.ts
    ln -s ${extensionBundle}/openai-accounts fixture/openai-accounts
    ln -s ${extensionBundle}/idle-context-warning fixture/idle-context-warning
    ln -s ${extensionBundle}/shared fixture/shared
    unset PI_SESSION_ROUTING_FILE PI_SESSION_ROUTING_OWNER_SESSION AGENTSH_SUBAGENT_ID AGENTSH_SUBAGENT_REQUEST_ID
    mkdir -p "$out"
    timeout 90s node fixture/tests/session-routing-native.mjs ${piPackage}/bin/pi \
      "$PWD/fixture/tests/session-routing-native-fixture.ts" > "$out/native-routing.log" 2>&1 || {
      cat "$out/native-routing.log"
      exit 1
    }
    cat "$out/native-routing.log"
    printf 'Account commands and native routing verified in the immutable Pi runtime.\n' > "$out/result"
  ''
