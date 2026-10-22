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
  '';
  # This is a Goal lifecycle/SDK behavioral check. The separate core check builds
  # and executes the shipped native artifact's extracted cancellation functions.
  preInstall = "";
  installPhase = ''
    mkdir -p "$out"
    echo 'Real GoalRuntime + lifecycle + SDK Agent fresh-prompt regressions passed.' > "$out/passed"
  '';
  postInstall = "";
})
