{ pkgs, piPackage }:
# Exercise the modified standalone native runtime with an offline public-RPC fixture.
piPackage.overrideAttrs (old: {
  pname = "pi-command-feedback-check";
  postInstall = (old.postInstall or "") + ''
    timeout 45s node ${./pi-command-feedback-native.test.mjs} "$out/bin/pi" ${./pi-command-feedback-native-fixture.ts}
    timeout 45s node ${./pi-command-feedback-native.test.mjs} "node-sdk:$PWD" ${./pi-command-feedback-native-fixture.ts}
  '';
})
