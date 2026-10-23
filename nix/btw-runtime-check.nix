{
  pkgs,
  piPackage,
  extensionBundle,
}:
pkgs.runCommand "btw-immutable-runtime-check"
  {
    nativeBuildInputs = [
      pkgs.coreutils
      pkgs.nodejs
    ];
  }
  ''
    set -euo pipefail
    test -f ${extensionBundle}/btw/index.ts
    test -f ${extensionBundle}/btw/LICENSE
    export HOME="$TMPDIR/home"
    export PI_CODING_AGENT_DIR="$HOME/agent"
    export PI_OFFLINE=1
    export NODE_PATH=
    mkdir -p "$PI_CODING_AGENT_DIR"
    timeout 30s node ${../tests/package-load.mjs} ${piPackage}/bin/pi \
      ${extensionBundle}/btw --expect btw
    printf 'BTW command registration verified offline in immutable Pi layout.\n' > "$out"
  ''
