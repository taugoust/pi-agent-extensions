{
  pkgs,
  self,
  piPackage,
  extensionBundle,
}:
let
  bundle = import ./mk-extension-bundle.nix {
    inherit self;
    inherit (pkgs) lib;
  };
  workflowsOnly = bundle {
    inherit pkgs;
    name = "pi-workflows-only-runtime";
    extensions = [ "workflows" ];
  };
  subagentOnly = bundle {
    inherit pkgs;
    name = "pi-subagent-only-runtime";
    extensions = [ "subagent" ];
  };
in
pkgs.runCommand "workflows-immutable-runtime-check"
  {
    nativeBuildInputs = [
      pkgs.coreutils
      pkgs.nodejs_24
      pkgs.git
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
    # All Git mutations and removals in these tests are confined to disposable
    # repositories; fixture hooks prohibit use of the live ownership registry.
    node --experimental-transform-types --test \
      ${self}/shared/worktree-completion.test.ts \
      ${self}/shared/worktree-completion.integration.test.mjs \
      ${self}/shared/subagent-worktrees-metadata.test.mjs \
      ${self}/workflows/worktree-completion-service.test.mjs \
      ${self}/workflows/delegated-service.test.mjs \
      ${self}/workflows/delegated-goals.test.ts \
      ${self}/workflows/goal-story.test.ts \
      ${self}/workflows/goal-planning.test.ts \
      ${self}/workflows/goal-review.test.ts \
      ${self}/workflows/goal-review-worker.test.ts \
      ${self}/questionnaire/goal-attachments.test.mjs \
      ${self}/workflows/delegated-child.test.mjs \
      ${self}/subagent/goal-policy.test.ts \
      ${self}/subagent/coordinator-role.test.ts \
      ${self}/subagent/goal-executor.test.ts \
      ${self}/subagent/goal-reload.test.ts \
      ${self}/subagent/goal-pause-race.test.ts \
      ${self}/subagent/goal-completion.test.ts
    timeout 30s node ${../tests/package-load.mjs} ${piPackage}/bin/pi \
      ${extensionBundle}/workflows ${extensionBundle}/subagent --expect goal worktree background
    test -f ${workflowsOnly}/subagent/tui-names.ts
    test ! -f ${workflowsOnly}/subagent/index.ts
    test -f ${workflowsOnly}/progress/progress-state.ts
    test ! -f ${workflowsOnly}/progress/index.ts
    timeout 30s node ${../tests/package-load.mjs} ${piPackage}/bin/pi \
      ${workflowsOnly}/workflows --expect goal worktree
    timeout 30s node ${../tests/package-load.mjs} ${piPackage}/bin/pi \
      ${subagentOnly}/subagent --expect background
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
