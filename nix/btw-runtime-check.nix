{
  pkgs,
  piPackage,
  extensionBundle,
}:
pkgs.runCommand "btw-immutable-runtime-check" { nativeBuildInputs = [ pkgs.coreutils ]; } ''
  set -euo pipefail
  test -f ${extensionBundle}/btw/index.ts
  test -f ${extensionBundle}/btw/LICENSE
  export HOME="$TMPDIR/home"
  export PI_CODING_AGENT_DIR="$HOME/agent"
  export PI_OFFLINE=1
  export NODE_PATH=
  mkdir -p "$PI_CODING_AGENT_DIR"
  ${piPackage}/bin/pi --no-extensions --no-skills --extension ${extensionBundle}/btw --list-models
  printf 'BTW loaded in immutable Pi layout without repository dependencies.\n' > "$out"
''
