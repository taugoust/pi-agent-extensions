{ pkgs, piPackage }:
# Test the very same upstream release source/dependencies and compilation recipe as
# the shipped package, not an independently reimplemented cancellation loop.
piPackage.overrideAttrs (old: {
  pname = "pi-run-cancellation-check";
  preBuild = ''
    # The patched expectations must reject the original SDK AND builtin bundle.
    for target in node bundle; do
      timeout 30s node ${./pi-run-cancellation.test.mjs} "$PWD" "$target" original
      if timeout 30s node ${./pi-run-cancellation.test.mjs} "$PWD" "$target" patched; then
        echo "ERROR: cancellation regression did not reject original $target" >&2
        exit 1
      fi
    done
    ${old.preBuild or ""}
    for target in node bundle; do
      timeout 30s node ${./pi-run-cancellation.test.mjs} "$PWD" "$target" patched
    done
  '';
  postInstall = (old.postInstall or "") + ''
    # Pi 1.4 compiles its Bun entry from unbundled modules. Verify behavior
    # through RPC rather than extracting assumed byte layouts from the binary.
    # Exercise the actual standalone Bun process through public RPC and a
    # disposable offline extension, not merely extracted code under Node.
    timeout 45s node ${./pi-run-cancellation-native.test.mjs} "$out/bin/pi" ${./pi-run-cancellation-native-fixture.ts}
  '';
})
