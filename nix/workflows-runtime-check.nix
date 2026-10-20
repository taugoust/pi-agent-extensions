{
  pkgs,
  piPackage,
  extensionBundle,
}:
pkgs.runCommand "workflows-immutable-runtime-check"
  {
    nativeBuildInputs = [
      pkgs.coreutils
      pkgs.gnugrep
    ];
  }
  ''
    set -euo pipefail
    test -f ${extensionBundle}/workflows/index.ts
    test -f ${extensionBundle}/workflows/goal/LICENSE
    test -f ${extensionBundle}/workflows/worktree/LICENSE
    export HOME="$TMPDIR/home"
    export PI_CODING_AGENT_DIR="$HOME/agent"
    export PI_OFFLINE=1
    export NODE_PATH=
    mkdir -p "$PI_CODING_AGENT_DIR"
    ${piPackage}/bin/pi --no-extensions --no-skills --extension ${extensionBundle}/workflows --list-models 2>&1 | tee "$TMPDIR/load.log"
    if grep -Ei 'failed to load extension|error loading extension|cannot find module' "$TMPDIR/load.log"; then exit 1; fi
    printf 'Worktree and Goal loaded from the immutable bundle without the candidate toolkit.\n' > "$out"
  ''
