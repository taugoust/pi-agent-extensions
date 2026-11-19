# Usage: source extension-settings-check.sh SOURCE
set -euo pipefail

source_root=$1
export HOME="$TMPDIR/home"
mkdir -p "$HOME" src/shared src/tests src/nix compiled/node_modules/@earendil-works/pi-coding-agent
cp "$source_root/shared/extension-defaults.ts" \
  "$source_root/shared/extension-config-manifest.json" \
  "$source_root/shared/snapshot-extension-settings.mjs" src/shared/
cp "$source_root/tests/extension-settings.mjs" "$source_root/tests/native-defaults.py" \
  "$source_root/tests/extension-settings-mutations.py" src/tests/
cp "$source_root/nix/merge-native-defaults.py" src/nix/
# The sole SDK dependency is the root locator, not a settings implementation.
# Compile production code without typechecking unrelated SDK dependencies.
cp "$source_root/nix/extension-settings-check/sdk-root.js" \
  compiled/node_modules/@earendil-works/pi-coding-agent/index.js
tsc --noCheck --skipLibCheck --module commonjs --moduleResolution node \
  --esModuleInterop --resolveJsonModule --target es2022 \
  --outDir compiled src/shared/extension-defaults.ts
export DEFAULTS_MODULE="$PWD/compiled/extension-defaults.js"
node --test --test-timeout=30000 src/tests/extension-settings.mjs
python3 src/tests/native-defaults.py
python3 src/tests/extension-settings-mutations.py
touch "$out"
