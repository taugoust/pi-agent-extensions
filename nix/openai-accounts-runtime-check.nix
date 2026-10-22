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
      ${extensionBundle}/openai-accounts ${extensionBundle}/openai-usage --expect accounts usage
    printf 'Account and usage commands registered in the actual immutable Pi runtime.\n' > "$out"
  ''
