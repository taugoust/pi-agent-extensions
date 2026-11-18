# Compiles and runs the session and subagent routing tests.
# Usage: session-routing-check.sh SOURCE_TREE
set -euo pipefail
src_root=$1
export HOME="$TMPDIR/home"
mkdir -p "$HOME" src/shared src/openai-accounts src/subagent out

copy() {
  local dir=$1
  shift
  for file in "$@"; do
    cp "$src_root/$dir/$file" "src/$dir/"
  done
}

copy shared session-routing.ts session-routing.test.ts \
  subagent-routing.ts subagent-routing.test.ts account-controls.ts \
  model-tiers.ts extension-defaults.ts extension-config-manifest.json
copy subagent config.ts config.test.ts coordinator-role.ts
copy openai-accounts session-follower.ts session-follower.test.ts

# Node needs an import attribute to load JSON.
manifest='"./extension-config-manifest.json"'
substituteInPlace src/shared/extension-defaults.ts \
  --replace-fail "from $manifest;" "from $manifest with { type: \"json\" };"

tests=(
  shared/session-routing.test
  shared/subagent-routing.test
  subagent/config.test
  openai-accounts/session-follower.test
)
sources=()
compiled=()
for test in "${tests[@]}"; do
  sources+=("src/$test.ts")
  compiled+=("out/$test.js")
done

echo '{"type":"module"}' > src/package.json
tsc --noCheck --skipLibCheck --resolveJsonModule --rewriteRelativeImportExtensions \
  --module nodenext --moduleResolution nodenext --target es2022 \
  --rootDir src --outDir out "${sources[@]}"
cp src/package.json out/package.json

# config.ts only needs getAgentDir from Pi.
pi=out/node_modules/@earendil-works/pi-coding-agent
mkdir -p "$pi"
echo '{"type":"module","main":"./index.js"}' > "$pi/package.json"
echo 'export const getAgentDir = () => process.env.HOME;' > "$pi/index.js"

node --test "${compiled[@]}"
