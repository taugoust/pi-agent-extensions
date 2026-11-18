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
    bash ${./goal-fresh-prompt-check.sh} ${self}
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
