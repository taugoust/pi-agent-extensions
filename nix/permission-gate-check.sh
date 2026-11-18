# Inputs: src is the extension source; fixtures contains the check fixtures.
set -euo pipefail

workdir="$TMPDIR/permission-gate-check"
mkdir -p "$workdir/src/permission-gate" "$workdir/src/shared" "$workdir/out"
cp "$src"/permission-gate/index.ts "$workdir/src/permission-gate/index.ts"
cp "$src"/permission-gate/settings.ts "$workdir/src/permission-gate/settings.ts"
cp "$src"/shared/extension-defaults.ts "$workdir/src/shared/extension-defaults.ts"
mkdir -p "$workdir/out/shared"
cp "$src"/shared/extension-config-manifest.json "$workdir/out/shared/extension-config-manifest.json"
cp "$src"/shared/agentsh-mode.ts "$workdir/src/shared/agentsh-mode.ts"
cp "$src"/shared/bash-command-transform.ts "$workdir/src/shared/bash-command-transform.ts"
cp "$src"/shared/subagent-permission.ts "$workdir/src/shared/subagent-permission.ts"
cp "$src"/shared/foreground-tasks.ts "$workdir/src/shared/foreground-tasks.ts"
printf '%s\n' '{"type":"module"}' > "$workdir/src/package.json"
sources=(
  "$workdir/src/permission-gate/index.ts"
  "$workdir/src/permission-gate/settings.ts"
  "$workdir/src/shared/extension-defaults.ts"
  "$workdir/src/shared/agentsh-mode.ts"
  "$workdir/src/shared/bash-command-transform.ts"
  "$workdir/src/shared/subagent-permission.ts"
  "$workdir/src/shared/foreground-tasks.ts"
)
tsc \
  --noCheck \
  --skipLibCheck \
  --module nodenext \
  --moduleResolution nodenext \
  --rewriteRelativeImportExtensions \
  --target es2022 \
  --rootDir "$workdir/src" \
  --outDir "$workdir/out" \
  "${sources[@]}"

cp "$fixtures/check.test.mjs" "$workdir/test.mjs"

cd "$workdir"
# Keep the production preference reader; only the SDK directory lookup
# and Node's JSON-module loading are fixture boundaries here.
cp "$fixtures/fixture-hooks.mjs" fixture-hooks.mjs
export PI_CODING_AGENT_DIR="$workdir/agent"
mkdir -p "$PI_CODING_AGENT_DIR"
export NODE_OPTIONS="--import=$workdir/fixture-hooks.mjs"
node test.mjs
touch "$out"
