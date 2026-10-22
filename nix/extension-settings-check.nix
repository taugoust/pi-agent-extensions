{ self, pkgs }:

assert import ./extension-settings-module-tests.nix { inherit self pkgs; };
pkgs.runCommand "pi-extension-settings-behavior-check"
  {
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.typescript
      pkgs.python3
      pkgs.coreutils
    ];
  }
  ''
    set -euo pipefail
    export HOME="$TMPDIR/home"
    mkdir -p "$HOME" src/shared src/tests src/nix compiled/node_modules/@earendil-works/pi-coding-agent
    cp ${self}/shared/extension-defaults.ts ${self}/shared/extension-config-manifest.json \
      ${self}/shared/snapshot-extension-settings.mjs src/shared/
    cp ${self}/tests/extension-settings.mjs ${self}/tests/native-defaults.py \
      ${self}/tests/extension-settings-mutations.py src/tests/
    cp ${self}/nix/merge-native-defaults.py src/nix/
    # The sole SDK dependency is the root locator, not a settings implementation.
    # Compile production code without typechecking unrelated SDK dependencies.
    printf '%s\n' 'exports.getAgentDir = () => process.env.PI_TEST_AGENT_DIR;' \
      > compiled/node_modules/@earendil-works/pi-coding-agent/index.js
    tsc --noCheck --skipLibCheck --module commonjs --moduleResolution node \
      --esModuleInterop --resolveJsonModule --target es2022 \
      --outDir compiled src/shared/extension-defaults.ts
    export DEFAULTS_MODULE="$PWD/compiled/extension-defaults.js"
    node --test --test-timeout=30000 src/tests/extension-settings.mjs
    python3 src/tests/native-defaults.py
    python3 src/tests/extension-settings-mutations.py
    touch "$out"
  ''
