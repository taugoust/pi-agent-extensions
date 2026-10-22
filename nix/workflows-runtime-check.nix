{
  pkgs,
  piPackage,
  extensionBundle,
}:
pkgs.runCommand "workflows-immutable-runtime-check"
  {
    nativeBuildInputs = [
      pkgs.coreutils
      pkgs.nodejs
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
    timeout 30s node ${../tests/package-load.mjs} ${piPackage}/bin/pi \
      ${extensionBundle}/workflows --expect goal worktree
    # A normal CLI exit is not sufficient: demonstrate that missing expected
    # registration fails this probe for the intended reason, not import/setup.
    node --input-type=module - ${../tests/package-load.mjs} ${piPackage}/bin/pi ${extensionBundle}/workflows <<'JS'
    import assert from 'node:assert/strict';
    import { spawnSync } from 'node:child_process';
    const result = spawnSync(process.execPath, [...process.argv.slice(2), '--expect', 'deliberately-unregistered-command'], {
      encoding: 'utf8', timeout: 30000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing registered command deliberately-unregistered-command/);
    console.log('PASS missing-registration negative control');
    JS
    printf 'Worktree and Goal commands registered in the actual immutable Pi runtime.\n' > "$out"
  ''
