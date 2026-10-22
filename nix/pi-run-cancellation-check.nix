{ pkgs, piPackage }:
# Test the very same upstream release source/dependencies and compilation recipe as
# the shipped package, not an independently reimplemented cancellation loop.
piPackage.overrideAttrs (old: {
  pname = "pi-run-cancellation-check";
  nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ [ pkgs.python3 ];
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
    # Bun's standalone build embeds this prebuilt chunk. Check the actual shipped
    # executable, including its controller/queue and session scheduler boundaries.
    python3 ${./pi-run-cancellation-verify.py} "$out/libexec/pi/pi" "$PWD" ${./pi-run-cancellation.test.mjs}
    # Exercise the actual standalone Bun process through public RPC and a
    # disposable offline extension, not merely extracted code under Node.
    timeout 45s node ${./pi-run-cancellation-native.test.mjs} "$out/bin/pi" ${./pi-run-cancellation-native-fixture.ts}
  '';
})
