# Inputs: src is the extension source; fixtures contains the check fixtures.
set -euo pipefail

workdir="$TMPDIR/sandbox-check"
srcdir="$workdir/src"
outdir="$workdir/out"
mkdir -p "$srcdir" "$outdir" "$TMPDIR/home"
export HOME="$TMPDIR/home"

cp -r "$src"/sandbox "$srcdir/"
cp -r "$src"/subagent "$srcdir/"
cp -r "$src"/shared "$srcdir/"
cp -r "$src"/workflows "$srcdir/"
substituteInPlace "$srcdir/shared/extension-defaults.ts" \
  --replace-fail 'from "./extension-config-manifest.json";' \
  'from "./extension-config-manifest.json" with { type: "json" };'
mkdir -p "$outdir/node_modules/@earendil-works"
ln -s ../@mariozechner/pi-coding-agent "$outdir/node_modules/@earendil-works/pi-coding-agent"
printf '%s\n' '{"type":"module"}' >"$srcdir/package.json"

mkdir -p "$outdir/node_modules/@sinclair/typebox"
cat >"$outdir/node_modules/@sinclair/typebox/package.json" <<'EOF'
{
  "name": "@sinclair/typebox",
  "type": "module",
  "main": "./index.js"
}
EOF

cp "$fixtures/sinclair-typebox.mjs" "$outdir/node_modules/@sinclair/typebox/index.js"

# pi-ai re-exports typebox's Type; guidance tools import it from there.
mkdir -p "$outdir/node_modules/@earendil-works/pi-ai"
printf '%s\n' '{"name":"@earendil-works/pi-ai","type":"module","main":"./index.js"}' \
  >"$outdir/node_modules/@earendil-works/pi-ai/package.json"
cp "$fixtures/earendil-works-pi-ai.mjs" "$outdir/node_modules/@earendil-works/pi-ai/index.js"

mkdir -p "$outdir/node_modules/@mariozechner/pi-coding-agent"
cat >"$outdir/node_modules/@mariozechner/pi-coding-agent/package.json" <<'EOF'
{
  "name": "@mariozechner/pi-coding-agent",
  "type": "module",
  "main": "./index.js"
}
EOF
cp "$fixtures/mariozechner-pi-coding-agent.mjs" \
  "$outdir/node_modules/@mariozechner/pi-coding-agent/index.js"

mkdir -p "$outdir/node_modules/@mariozechner/pi-tui"
cat >"$outdir/node_modules/@mariozechner/pi-tui/package.json" <<'EOF'
{
  "name": "@mariozechner/pi-tui",
  "type": "module",
  "main": "./index.js"
}
EOF
cp "$fixtures/mariozechner-pi-tui.mjs" "$outdir/node_modules/@mariozechner/pi-tui/index.js"

sources=(
  "$srcdir/sandbox/index.ts"
  "$srcdir/subagent/index.ts"
  "$srcdir/subagent/backend.ts"
  "$srcdir/subagent/parallel-result.ts"
  "$srcdir/subagent/background-wait.test.ts"
  "$srcdir/subagent/job-proxy.ts"
  "$srcdir/subagent/outcome-proxy.ts"
  "$srcdir/sandbox/approval-model.test.ts"
  "$srcdir/sandbox/auto-approval.test.ts"
  "$srcdir/sandbox/command-output.test.ts"
  "$srcdir/sandbox/exec-result.test.ts"
  "$srcdir/sandbox/tool-result-presentation.test.ts"
  "$srcdir/sandbox/command-timeout.test.ts"
  "$srcdir/sandbox/operator-auth.test.ts"
  "$srcdir/sandbox/subagent-cwd.test.ts"
  "$srcdir/sandbox/subagent-model.test.ts"
  "$srcdir/sandbox/subagent-parent-result.test.ts"
  "$srcdir/sandbox/subagent-protocol.test.ts"
  "$srcdir/sandbox/subagent-render.test.ts"
  "$srcdir/sandbox/subagent-result.test.ts"
  "$srcdir/sandbox/subagent-stream.test.ts"
  "$srcdir/sandbox/subagent-terminal.test.ts"
  "$srcdir/sandbox/workspace-paths.test.ts"
)
tsc \
  --noCheck \
  --skipLibCheck \
  --module nodenext \
  --moduleResolution nodenext \
  --target es2022 \
  --rootDir "$srcdir" \
  --outDir "$outdir" \
  --rewriteRelativeImportExtensions \
  --resolveJsonModule \
  "${sources[@]}"

# subagent/index.ts keeps a runtime import of tui-native.ts; retain the
# source tree for that local TypeScript dependency in this JS harness.
cp -r "$srcdir/subagent" "$outdir/"
cp -r "$srcdir/shared" "$outdir/"

node "$outdir/sandbox/approval-model.test.js"
node "$outdir/sandbox/auto-approval.test.js"
node "$outdir/sandbox/command-output.test.js"
node "$outdir/sandbox/exec-result.test.js"
node "$outdir/sandbox/tool-result-presentation.test.js"
node "$outdir/sandbox/command-timeout.test.js"
node "$outdir/sandbox/operator-auth.test.js"
node "$outdir/sandbox/subagent-cwd.test.js"
node "$outdir/sandbox/subagent-model.test.js"
node "$outdir/sandbox/subagent-parent-result.test.js"
node "$outdir/sandbox/subagent-protocol.test.js"
node "$outdir/sandbox/subagent-render.test.js"
node "$outdir/sandbox/subagent-result.test.js"
node "$outdir/sandbox/subagent-stream.test.js"
node "$outdir/sandbox/subagent-terminal.test.js"
node "$outdir/sandbox/workspace-paths.test.js"
# The background wait fixture runs on its own provider, so give it a cheap tier.
export PI_TEST_AGENT_DIR="$TMPDIR/background-wait-agent"
mkdir -p "$PI_TEST_AGENT_DIR"
printf '%s\n' '{"fixture-provider":{"cheap":"gpt-6-luna"}}' >"$PI_TEST_AGENT_DIR/model-tiers.json"
node "$outdir/subagent/background-wait.test.js"
unset PI_TEST_AGENT_DIR

cp "$fixtures/check.test.mjs" "$workdir/test.mjs"

node "$workdir/test.mjs" "$outdir"
PI_AGENTSH_BUN_ABORT_REGRESSION=1 bun "$workdir/test.mjs" "$outdir"

mkdir -p "$out"
touch "$out/passed"
