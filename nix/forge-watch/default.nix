{
  lib,
  runCommand,
  importNpmLock,
  nodejs_24,
  src,
}:
let
  dependencies = importNpmLock.buildNodeModules {
    npmRoot = src;
    nodejs = nodejs_24;
    derivationArgs.npmFlags = [ "--ignore-scripts" ];
  };
in
runCommand "pi-forge-watch" { } ''
  mkdir -p "$out"
  # Never copy an ignored developer node_modules symlink into the bundle.
  cp ${lib.escapeShellArg src}/*.ts ${lib.escapeShellArg src}/*.mjs \
    ${lib.escapeShellArg src}/README.md ${lib.escapeShellArg src}/package*.json "$out/"
  chmod -R u+w "$out"
  cp -R ${dependencies}/node_modules "$out/node_modules"
''
