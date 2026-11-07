{
  self,
  pkgs,
  piPackage,
}:
let
  bundle =
    (import ./mk-extension-bundle.nix {
      inherit self;
      inherit (pkgs) lib;
    })
      {
        inherit pkgs;
        name = "pi-forge-watch-runtime";
        extensions = [ "forge-watch" ];
      };
in
# The native release deliberately installs only bin/libexec, not a Node SDK.
# Exercise the real SDK in the upstream build tree, then the installed native
# process against an immutable bundle with its own public MCP dependency.
piPackage.overrideAttrs (old: {
  pname = "pi-forge-watch-check";
  nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ [
    pkgs.bun
    pkgs.git
  ];
  preBuild = (old.preBuild or "") + ''
    # Keep the build's test data private. Nix's UID namespace may still report
    # filesystem / as unmapped UID 65534: production OAuth ancestor ownership
    # checks intentionally reject that root. Their exact real-filesystem suite
    # is a SEPARATE mandatory host release check, never a skip/xfail here.
    chmod 0700 "$TMPDIR"
    node -e 'const s=require("node:fs").lstatSync("/");console.log("Nix gate scope: protocol/storage/SDK/native; root uid="+s.uid+" mode="+(s.mode&4095).toString(8)+". OAuth filesystem security/refresh requires the separate host release command documented in docs/forge-watch-validation.md.")'
    export HOME="$TMPDIR/forge-test-home"
    export PI_CODING_AGENT_DIR="$HOME/agent"
    export PI_OFFLINE=1
    export NODE_PATH=
    unset PI_DEDICATED_GOAL_CHILD PI_DEDICATED_GOAL_BINDING PI_CODING_AGENT_ENTRY
    mkdir -p "$PI_CODING_AGENT_DIR" forge-test-source
    cp -R ${self}/workflows ${self}/shared ${self}/progress ${self}/subagent ${self}/tests forge-test-source/
    cp -R ${bundle}/forge-watch forge-test-source/forge-watch
    chmod -R u+w forge-test-source
    ln -s "$PWD/node_modules" forge-test-source/node_modules
    bun test forge-test-source/forge-watch/engine.test.ts
    node --experimental-transform-types --test \
      forge-test-source/forge-watch/storage.test.ts \
      forge-test-source/forge-watch/detached-rejection.test.mjs \
      forge-test-source/forge-watch/adapters.test.mjs \
      forge-test-source/forge-watch/mcp.test.mjs
    timeout 60s node forge-test-source/tests/forge-goal-runtime.mjs "$PWD"
    # The fixture additionally needs progress/*, which is intentionally absent
    # from the narrow production bundle. Its watcher comes from that bundle;
    # its fixture-only dependencies are the immutable copied producer source.
    PI_FORGE_TEST_SOURCE="$PWD/forge-test-source" timeout 60s node forge-test-source/tests/forge-watch-runtime.mjs "$PWD"
  '';
  postInstall = (old.postInstall or "") + ''
    export HOME="$TMPDIR/forge-native-home"
    export PI_CODING_AGENT_DIR="$HOME/agent"
    export NODE_PATH=
    unset PI_DEDICATED_GOAL_CHILD PI_DEDICATED_GOAL_BINDING PI_CODING_AGENT_ENTRY
    mkdir -p "$PI_CODING_AGENT_DIR"
    test -f ${bundle}/forge-watch/node_modules/@earendil-works/pi-mcp/package.json
    timeout 30s node ${self}/tests/package-load.mjs "$out/bin/pi" \
      ${bundle}/forge-watch ${bundle}/workflows --expect forge-watch goal worktree
  '';
})
