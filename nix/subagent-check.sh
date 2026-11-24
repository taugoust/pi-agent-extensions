# Usage: source subagent-check.sh
# Inputs (environment): srcRoot, fixtureRoot, sandboxOnlyBundle, subagentOnlyBundle,
# mkfifoBin, piBin (empty to skip real-Pi tests), tuiRootLauncher, tuiRootMode.
set -euo pipefail

workdir="$TMPDIR/subagent-check"
mkdir -p "$workdir/src/subagent" "$workdir/src/shared" "$workdir/out"
cp -R "$srcRoot/workflows" "$workdir/src/"
sources=(
  subagent/pi-invocation.ts
  subagent/pi-invocation.test.ts
  subagent/config.ts
  subagent/config.test.ts
  subagent/profiles.ts
  subagent/profiles.test.ts
  shared/session-routing.ts
  shared/subagent-routing.ts
  shared/account-controls.ts
  shared/session-routing.test.ts
  shared/extension-defaults.ts
  shared/model-tiers.ts
  shared/model-tiers.test.ts
  shared/extension-config-manifest.json
  subagent/backend.ts
  subagent/background.ts
  subagent/legacy-reap.test.ts
  subagent/control.ts
  subagent/outcome.ts
  subagent/outcome.test.ts
  subagent/resume.ts
  subagent/resume.test.ts
  subagent/dashboard.ts
  subagent/dashboard.test.ts
  shared/task-presentation.ts
  shared/watch-menu.ts
  shared/quiet-state.ts
  shared/idle-admission.ts
  shared/quiet-state.test.ts
  shared/guidance-notifications.test.ts
  subagent/control.test.ts
  subagent/foreground-handoff.ts
  subagent/native-rpc.ts
  subagent/native-rpc.test.ts
  subagent/parallel-result.ts
  subagent/permission-proxy.ts
  subagent/permission-relay.ts
  subagent/result-artifact.ts
  shared/agentsh-mode.ts
  shared/subagent-permission.ts
)
for file in "${sources[@]}"; do
  cp "$srcRoot/$file" "$workdir/src/$file"
done
manifest='"./extension-config-manifest.json"'
substituteInPlace "$workdir/src/shared/extension-defaults.ts" \
  --replace-fail "from $manifest;" "from $manifest with { type: \"json\" };"
printf '%s\n' '{ "type": "module" }' >"$workdir/src/package.json"

compileSources=(
  subagent/backend.ts
  subagent/background.ts
  subagent/legacy-reap.test.ts
  subagent/control.ts
  subagent/outcome.ts
  subagent/config.test.ts
  subagent/pi-invocation.test.ts
  subagent/profiles.test.ts
  shared/session-routing.test.ts
  shared/model-tiers.test.ts
  subagent/outcome.test.ts
  subagent/resume.ts
  subagent/resume.test.ts
  subagent/dashboard.ts
  subagent/dashboard.test.ts
  shared/quiet-state.test.ts
  shared/guidance-notifications.test.ts
  subagent/control.test.ts
  subagent/foreground-handoff.ts
  subagent/native-rpc.ts
  subagent/native-rpc.test.ts
  subagent/parallel-result.ts
  subagent/permission-proxy.ts
  subagent/permission-relay.ts
  subagent/result-artifact.ts
  shared/agentsh-mode.ts
  shared/subagent-permission.ts
)
compilePaths=()
for file in "${compileSources[@]}"; do
  compilePaths+=("$workdir/src/$file")
done
tsc \
  --rewriteRelativeImportExtensions \
  --resolveJsonModule \
  --noCheck \
  --skipLibCheck \
  --module nodenext \
  --moduleResolution nodenext \
  --target es2022 \
  --rootDir "$workdir/src" \
  --outDir "$workdir/out" \
  "${compilePaths[@]}"

legacyPi="$workdir/out/node_modules/@mariozechner/pi-coding-agent"
mkdir -p "$legacyPi"
printf '%s\n' \
  '{ "name": "@mariozechner/pi-coding-agent", "type": "module", "main": "./index.js" }' \
  >"$legacyPi/package.json"
cp "$fixtureRoot/legacy-pi-stub.mjs" "$legacyPi/index.js"

pi="$workdir/out/node_modules/@earendil-works/pi-coding-agent"
mkdir -p "$pi"
printf '%s\n' \
  '{ "name": "@earendil-works/pi-coding-agent", "type": "module", "main": "./index.js" }' \
  >"$pi/package.json"
# Guidance registration needs schema helpers; real-Pi fixtures use the actual SDK.
piAi="$workdir/out/node_modules/@earendil-works/pi-ai"
mkdir -p "$piAi"
printf '%s\n' \
  '{ "name": "@earendil-works/pi-ai", "type": "module", "main": "./index.js" }' \
  >"$piAi/package.json"
cp "$fixtureRoot/pi-ai-stub.mjs" "$piAi/index.js"
export PI_SUBAGENT_TEST_AGENT_DIR="$workdir/isolated-agent"
mkdir -p "$PI_SUBAGENT_TEST_AGENT_DIR"
# Deliberately narrow double; real-Pi integration below exercises the actual SDK/runtime.
cp "$fixtureRoot/pi-coding-agent-stub.mjs" "$pi/index.js"

node --test "$workdir/out/subagent/legacy-reap.test.js"
node "$workdir/out/subagent/control.test.js"
node --test "$workdir/out/subagent/config.test.js"
cp -R "$srcRoot/subagent/agents" "$workdir/out/subagent/agents"
node --test "$workdir/out/subagent/profiles.test.js"
node --test "$workdir/out/shared/session-routing.test.js"
node --test "$workdir/out/shared/model-tiers.test.js"
node "$workdir/out/subagent/outcome.test.js"
node "$workdir/out/subagent/resume.test.js"
node "$workdir/out/subagent/dashboard.test.js"
node "$workdir/out/subagent/pi-invocation.test.js"
node "$workdir/out/shared/quiet-state.test.js"
node --test "$workdir/out/shared/guidance-notifications.test.js"
TEST_MKFIFO="$mkfifoBin" node "$workdir/out/subagent/native-rpc.test.js"

# Native TUI tests need TS transformation, including constructor parameter properties.
# The real Pi, when supplied, uses a local provider: no model/API requests.
mkdir -p "$workdir/tui-runtime"
runtimeSources=(subagent shared workflows progress permission-gate background-job questionnaire)
for dir in "${runtimeSources[@]}"; do
  cp -R "$srcRoot/$dir" "$workdir/tui-runtime/"
done
chmod -R u+rwX "$workdir/tui-runtime"
ln -s "$workdir/out/node_modules" "$workdir/tui-runtime/node_modules"
# Raw Node TS fixtures need source-relative TS imports, unlike compiled output.
python3 "$fixtureRoot/rewrite-ts-imports.py" "$workdir/tui-runtime"
substituteInPlace "$workdir/tui-runtime/shared/extension-defaults.ts" \
  --replace-fail "from $manifest;" "from $manifest with { type: \"json\" };"
if [[ -n "$piBin" ]]; then
  PI_BIN="$piBin" python3 "$srcRoot/background-job/reload.test.py"
  PI_BIN="$piBin" python3 "$srcRoot/subagent/quiet-state-reload.test.py"
  PI_BIN="$piBin" python3 "$srcRoot/subagent/foreground-tasks-reload.test.py"
  export PI_TUI_TEST_PI="$piBin"
  export PI_TUI_ROOT_LAUNCHER="$tuiRootLauncher"
  export PI_TUI_ROOT_MODE="$tuiRootMode"
fi
# Child processes also load TS; CLI flags alone are not inherited. Serialize to
# avoid timer-test starvation from source transformation and native subprocesses.
export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--experimental-transform-types"
runtimeTests=(
  shared/tool-result-text.test.ts
  subagent/guidance.test.ts
  subagent/guidance-handle.test.ts
  subagent/acceptance.test.ts
  subagent/acceptance-adversarial.test.ts
  subagent/acceptance-manager.test.ts
  subagent/state-root.test.ts
  subagent/tui-names.test.ts
  subagent/canonical-names.test.ts
  subagent/task-name-store.test.ts
  subagent/task-name-contention.test.ts
  subagent/canonical-runtime.test.ts
  subagent/worker-alias-projection.test.ts
  subagent/group-wait.test.ts
  subagent/tui-native-observe.test.ts
  subagent/tui-descendants.test.ts
  subagent/operator-mode.test.ts
  subagent/task-inventory.test.ts
  subagent/prompt-group.test.ts
  subagent/completion.test.ts
  subagent/tui-worker-jobs.test.ts
  subagent/tui-worker-protocol.test.ts
  subagent/managed-goal.test.ts
  subagent/tui-worker-server.test.ts
  subagent/live-conversation.test.ts
  subagent/retained-conversation.test.ts
  subagent/tui-worker-reap.test.ts
  subagent/worktree-reap-manager.test.ts
  subagent/tui-worker-tmux-reap-policy.test.ts
  subagent/tui-worker-extension.test.ts
  subagent/model-inactivity.test.ts
  subagent/headless-foreground.test.ts
  subagent/session-source.test.ts
  subagent/tui-worker-seal.test.ts
  subagent/tui-worker-tmux.test.ts
  subagent/tui-root.test.ts
)
runtimePaths=()
for file in "${runtimeTests[@]}"; do
  runtimePaths+=("$workdir/tui-runtime/$file")
done
node --experimental-transform-types --test --test-concurrency=1 "${runtimePaths[@]}"

node "$fixtureRoot/assertions.mjs" \
  "$workdir/out/subagent/parallel-result.js" \
  "$workdir/out/subagent/backend.js" \
  "$workdir/out/shared/agentsh-mode.js" \
  "$workdir/out/subagent/background.js" \
  "$workdir/out/subagent/foreground-handoff.js" \
  "$workdir/out/subagent/result-artifact.js" \
  "$workdir/out/subagent/permission-relay.js" \
  "$workdir/out/shared/subagent-permission.js" \
  "$workdir/out/subagent/permission-proxy.js"
for bundle in "$sandboxOnlyBundle" "$subagentOnlyBundle"; do
  test "$(jq '[.pi.extensions[] | select(. == "subagent")] | length' "$bundle/package.json")" -eq 1
  test "$(jq '[.pi.extensions[] | select(. == "subagent-finalizer")] | length' \
    "$bundle/package.json")" -eq 1
  test -f "$bundle/subagent/index.ts"
  test -f "$bundle/subagent/background.ts"
  test -f "$bundle/subagent/control.ts"
  test -f "$bundle/subagent/foreground-handoff.ts"
  test -f "$bundle/subagent/model-inactivity.ts"
  test -f "$bundle/subagent/native-rpc.ts"
  test -f "$bundle/subagent/permission-proxy.ts"
  test -f "$bundle/subagent/permission-relay.ts"
  test -f "$bundle/subagent/result-artifact.ts"
  test -f "$bundle/subagent-finalizer/index.ts"
  test -f "$bundle/shared/agentsh-mode.ts"
  # Narrow bundles include implementation-only worktree dependencies, not workflows.
  test -f "$bundle/workflows/worktree/git.ts"
  test -f "$bundle/workflows/worktree/settings.ts"
  test "$(jq '[.pi.extensions[] | select(. == "workflows")] | length' "$bundle/package.json")" -eq 0
done
test "$(jq '[.pi.extensions[] | select(. == "sandbox")] | length' \
  "$sandboxOnlyBundle/package.json")" -eq 1
test "$(jq '[.pi.extensions[] | select(. == "sandbox")] | length' \
  "$subagentOnlyBundle/package.json")" -eq 0
touch "$out"
