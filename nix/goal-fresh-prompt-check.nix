{
  self,
  pkgs,
  piPackage,
}:
# Use the release's real installed SDK dependencies and the patched core, not
# copied lifecycle predicates or a replacement GoalRuntime implementation.
piPackage.overrideAttrs (old: {
  pname = "pi-goal-fresh-prompt-check";
  preBuild = (old.preBuild or "") + ''
    mkdir goal-test-source
    cp -R ${self}/workflows ${self}/shared ${self}/progress goal-test-source/
    chmod -R u+w goal-test-source
    ln -s "$PWD/node_modules" goal-test-source/node_modules
    timeout 30s node ${../tests/goal-fresh-prompt.mjs} "$PWD/goal-test-source" "$PWD"
    timeout 30s node ${../tests/goal-presentation.mjs} "$PWD/goal-test-source" "$PWD"
    # Restore the original stale-guard behavior in the disposable fixture.
    # The identical real-runtime test must fail at its fresh-input assertion.
    node --input-type=module - ${../tests/goal-fresh-prompt.mjs} "$PWD" <<'JS'
    import assert from 'node:assert/strict';
    import { readFileSync, writeFileSync } from 'node:fs';
    import { spawnSync } from 'node:child_process';
    const file = 'goal-test-source/workflows/goal/lifecycle.ts';
    const source = readFileSync(file, 'utf8');
    const marker = '    // Unlike a busy steer, this hook admits a fresh user-prompt run.';
    assert.equal(source.split(marker).length, 2, 'Mutant target must be unique');
    const start = source.indexOf(marker);
    const end = source.indexOf('    if (!ownedPromptGoalId && !ownedPromptBoundary)', start);
    assert.ok(end > start);
    writeFileSync(file, source.slice(0, start) + source.slice(end));
    const result = spawnSync(process.execPath, [process.argv[2], process.argv[3] + '/goal-test-source', process.argv[3]], {
      encoding: 'utf8', timeout: 30000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Fresh unowned idle human tool must not be aborted/);
    assert.match(result.stderr, /Operation aborted/);
    console.log('KILLED: original Goal stale-tool guard rejects fresh idle input');
    JS
  '';
  # This is a Goal lifecycle/SDK behavioral check. The separate core check builds
  # and executes the actual native process as well as its extracted functions.
  preInstall = "";
  installPhase = ''
    mkdir -p "$out"
    echo 'Real GoalRuntime + lifecycle + SDK Agent fresh-prompt regressions passed.' > "$out/passed"
  '';
  postInstall = "";
})
