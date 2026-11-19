{ pkgs, piPackage }:
# Test the very same upstream release source/dependencies and compilation recipe as
# the shipped package, not an independently reimplemented cancellation loop.
piPackage.overrideAttrs (old: {
  pname = "pi-run-cancellation-check";
  preBuild = ''
    bash ${./pi-run-cancellation-check.sh} ${./pi-run-cancellation.test.mjs} original
    ${old.preBuild or ""}
    bash ${./pi-run-cancellation-check.sh} ${./pi-run-cancellation.test.mjs} patched
  '';
  postInstall = (old.postInstall or "") + ''
    # Pi 1.4 compiles its Bun entry from unbundled modules. Verify behavior
    # through RPC rather than extracting assumed byte layouts from the binary.
    # Exercise the actual standalone Bun process through public RPC and a
    # disposable offline extension, not merely extracted code under Node.
    timeout 45s node ${./pi-run-cancellation-native.test.mjs} \
      "$out/bin/pi" ${./pi-run-cancellation-native-fixture.ts}
  '';
})
