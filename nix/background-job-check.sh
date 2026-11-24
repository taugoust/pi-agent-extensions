# Inputs: SOURCE_ROOT (source tree), FIXTURES (JavaScript fixtures).
# EXTENSION_PACKAGE, MODULE_EXTENSION, MODULE_SHARED: installed trees.
# HAS_TMUX, HAS_NODE: module package membership; TEST_TMUX: tmux executable.
set -euo pipefail

workdir="$TMPDIR/background-job-check"
srcdir="$workdir/src"
outdir="$workdir/out"
mkdir -p "$srcdir/background-job" "$srcdir/shared" "$srcdir/subagent" \
  "$outdir/background-job" "$workdir/home" "$workdir/tmp"

copy_sources() {
  local dir=$1
  shift
  local file
  for file in "$@"; do
    cp "$SOURCE_ROOT/$dir/$file" "$srcdir/$dir/"
  done
}
subagent_sources=(
  readonly-job-ancestry.test.ts tui-worker-store.ts acceptance.ts managed-goal.ts goal-policy.ts
)
shared_sources=(
  tui-worker-protocol.ts readonly-job-ancestry.ts verification-worker.ts verification-worker.test.ts
  agentsh-mode.ts background-job.ts harness-readonly.ts task-presentation.ts watch-menu.ts
  quiet-state.ts idle-admission.ts extension-defaults.ts extension-config-manifest.json
  quiet-state.test.ts
)
background_sources=(
  index.ts manager.ts retention.ts retention.test.mjs retention-races.test.mjs store.ts tmux.ts
  types.ts
  test.mjs streams.test.mjs runner.mjs watch.ts watch-runner.mjs watch.test.mjs watch-job.test.mjs
  external-pane.ts pane.test.mjs runtime-path.ts startup.test.mjs completion.test.mjs
  readonly-descendants.test.mjs yield.test.mjs identity-race.test.mjs output-hints.ts
  output-hints.test.mjs
)
copy_sources subagent "${subagent_sources[@]}"
copy_sources shared "${shared_sources[@]}"
copy_sources background-job "${background_sources[@]}"
printf '%s\n' '{"type":"module"}' >"$srcdir/package.json"

tsc \
  --rewriteRelativeImportExtensions \
  --noCheck \
  --skipLibCheck \
  --module nodenext \
  --moduleResolution nodenext \
  --target es2022 \
  --rootDir "$srcdir" \
  --outDir "$outdir" \
  "$srcdir/background-job/index.ts" \
  "$srcdir/background-job/manager.ts" \
  "$srcdir/background-job/retention.ts" \
  "$srcdir/background-job/store.ts" \
  "$srcdir/background-job/tmux.ts" \
  "$srcdir/background-job/types.ts" \
  "$srcdir/shared/agentsh-mode.ts" \
  "$srcdir/shared/quiet-state.test.ts" \
  "$srcdir/shared/verification-worker.test.ts" \
  "$srcdir/subagent/readonly-job-ancestry.test.ts"
node --test "$outdir/subagent/readonly-job-ancestry.test.js"
node --test "$outdir/shared/verification-worker.test.js"
background_tests=(
  test.mjs streams.test.mjs retention.test.mjs retention-races.test.mjs runner.mjs watch-runner.mjs
  watch.test.mjs watch-job.test.mjs pane.test.mjs startup.test.mjs completion.test.mjs
  readonly-descendants.test.mjs yield.test.mjs
)
for file in "${background_tests[@]}"; do
  cp "$srcdir/background-job/$file" "$outdir/background-job/"
done
cp "$srcdir/background-job/identity-race.test.mjs" "$outdir/background-job/"
node "$outdir/background-job/identity-race.test.mjs"
cp "$srcdir/background-job/output-hints.test.mjs" "$outdir/background-job/"
node "$outdir/background-job/output-hints.test.mjs"
cp "$srcdir/shared/extension-config-manifest.json" "$outdir/shared/"
substituteInPlace "$outdir/shared/extension-defaults.js" \
  --replace-fail 'from "./extension-config-manifest.json"' \
  'from "./extension-config-manifest.json" with { type: "json" }'

export HOME="$workdir/home"
export PI_CODING_AGENT_DIR="$workdir/agent"
export TMPDIR="$workdir/tmp"
export TEST_TMUX
export TEST_RUNNER="$EXTENSION_PACKAGE/background-job/runner.mjs"
substituteInPlace "$outdir/background-job/streams.test.mjs" \
  --replace-fail "./store.ts" "./store.js" \
  --replace-fail "./manager.ts" "./manager.js"
node "$outdir/background-job/streams.test.mjs"
node "$outdir/background-job/startup.test.mjs"
node "$outdir/background-job/test.mjs"
node "$outdir/background-job/watch.test.mjs"
node "$outdir/background-job/watch-job.test.mjs"
node "$outdir/background-job/pane.test.mjs"

earendil="$outdir/node_modules/@earendil-works/pi-coding-agent"
mkdir -p "$earendil"
printf '%s\n' '{"type":"module","main":"index.js"}' >"$earendil/package.json"
cp "$FIXTURES/earendil-coding-agent.mjs" "$earendil/index.js"
mkdir -p "$outdir/node_modules/@sinclair/typebox" \
  "$outdir/node_modules/@mariozechner/pi-coding-agent" \
  "$outdir/node_modules/@mariozechner/pi-tui"
for packageName in @sinclair/typebox @mariozechner/pi-coding-agent @mariozechner/pi-tui; do
  cat >"$outdir/node_modules/$packageName/package.json" <<EOF
{ "name": "$packageName", "type": "module", "main": "./index.js" }
EOF
done
cp "$FIXTURES/typebox.mjs" "$outdir/node_modules/@sinclair/typebox/index.js"
cp "$FIXTURES/coding-agent.mjs" "$outdir/node_modules/@mariozechner/pi-coding-agent/index.js"
cp "$FIXTURES/tui.mjs" "$outdir/node_modules/@mariozechner/pi-tui/index.js"
node "$outdir/background-job/readonly-descendants.test.mjs"
substituteInPlace "$outdir/background-job/yield.test.mjs" \
  --replace-fail '../shared/background-job.ts' '../shared/background-job.js'
node "$outdir/background-job/yield.test.mjs"
node "$outdir/shared/quiet-state.test.js"
PI_CODING_AGENT_DIR="$workdir/completion-agent" node "$outdir/background-job/completion.test.mjs"
PI_CODING_AGENT_DIR="$workdir/retention-agent" node "$outdir/background-job/retention.test.mjs"
PI_CODING_AGENT_DIR="$workdir/retention-races-agent" \
  node "$outdir/background-job/retention-races.test.mjs"
cp "$FIXTURES/contract.mjs" "$workdir/contract.mjs"
contractSocket="$workdir/contract.sock"
caller=$(tmux -S "$contractSocket" -f /dev/null new-session -d -P -F '#{pane_id}' \
  -x 240 -y 200 -s caller 'sleep 120')
trap 'tmux -S "$contractSocket" kill-server 2>/dev/null || true' EXIT
TMUX="$contractSocket,0,0" TMUX_PANE="$caller" PI_CODING_AGENT_DIR="$workdir/agent" \
  node "$workdir/contract.mjs"

test -d "$MODULE_EXTENSION"
test -f "$MODULE_EXTENSION/index.ts"
test -f "$MODULE_SHARED/agentsh-mode.ts"
test "$HAS_TMUX" = 1
test "$HAS_NODE" = 1

test -f "$EXTENSION_PACKAGE/background-job/index.ts"
test -f "$EXTENSION_PACKAGE/background-job/runner.mjs"
test -f "$EXTENSION_PACKAGE/shared/agentsh-mode.ts"
filter='[.pi.extensions[] | select(. == "background-job")] | length'
test "$(jq "$filter" "$SOURCE_ROOT/package.json")" = 1
test "$(jq "$filter" "$EXTENSION_PACKAGE/package.json")" = 1

mkdir -p "$out"
touch "$out/passed"
