# Usage: bash goal-fresh-prompt-check.sh SOURCE
set -euo pipefail

source_root=$1
mkdir goal-test-source
sources=(workflows shared progress subagent tests)
for i in "${!sources[@]}"; do
  sources[$i]="$source_root/${sources[$i]}"
done
cp -R "${sources[@]}" goal-test-source/
chmod -R u+w goal-test-source
ln -s "$PWD/node_modules" goal-test-source/node_modules
timeout 30s node "$source_root/tests/goal-fresh-prompt.mjs" "$PWD/goal-test-source" "$PWD"
timeout 30s node "$source_root/tests/goal-presentation.mjs" "$PWD/goal-test-source" "$PWD"
# These suites resolve production modules relative to their own URL.
timeout 30s node goal-test-source/tests/goal-progress-unification.mjs "$PWD"
timeout 30s node goal-test-source/tests/goal-progress-runtime.mjs "$PWD"
timeout 30s node goal-test-source/tests/saved-goal-checklist-runtime.mjs "$PWD"
timeout 30s node goal-test-source/tests/goal-wait-runtime.mjs "$PWD"
timeout 30s node goal-test-source/tests/goal-prs.mjs "$PWD"
# Restoring the original stale guard must fail at the fresh-input assertion.
node "$source_root/nix/goal-fresh-prompt-check/stale-guard.mjs" \
  "$source_root/tests/goal-fresh-prompt.mjs" "$PWD"
