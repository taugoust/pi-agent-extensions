# Usage: source openai-fast-mode-check.sh
# Inputs: fastModePackage, bundle, defaultBundle, pi, hmEnabledByDefault,
# hmFileCount, hmFilesManifest (JSON entries: name, source, recursive), rpcTest.
set -euo pipefail

test "$(jq -r .version "$fastModePackage/package.json")" = 0.3.0
test "$(jq -r '.pi.extensions | length' "$fastModePackage/package.json")" = 1
test "$(jq -r '.pi.extensions[0]' "$fastModePackage/package.json")" = ./src/index.ts
extension_count='[.pi.extensions[] | select(. == "node_modules/pi-openai-fast-mode/src/index.ts")]'
test "$(jq "$extension_count | length" "$bundle/package.json")" = 1
test "$(jq "$extension_count | length" "$defaultBundle/package.json")" = 1
test "$hmEnabledByDefault" = 0
# The extension directory plus its defaults and the quiet-state default.
test "$hmFileCount" = 3

work="$TMPDIR/fast-mode"
agent="$work/agent"
mkdir -p "$agent"
python3 "$rpcTest" "$pi/bin/pi" "$bundle/node_modules/pi-openai-fast-mode/src/index.ts" "$agent"

hm_home="$work/hm-home"
hm_agent="$hm_home/.pi/agent"
while IFS= read -r entry; do
  name=$(jq -r .name <<<"$entry")
  source_path=$(jq -r .source <<<"$entry")
  # Like Home Manager, recursive entries link each file into a writable directory.
  if [ "$(jq -r .recursive <<<"$entry")" = true ]; then
    mkdir -p "$hm_home/$name"
    cp -rs "$source_path/." "$hm_home/$name"
    chmod -R u+w "$hm_home/$name"
  else
    mkdir -p "$hm_home/$(dirname "$name")"
    ln -s "$source_path" "$hm_home/$name"
  fi
done < <(jq -c '.[]' "$hmFilesManifest")
python3 "$rpcTest" "$pi/bin/pi" "$hm_agent/extensions/pi-openai-fast-mode/index.ts" "$hm_agent"

mkdir -p "$out"
touch "$out/passed"
