# Usage: source workflows-runtime-check.sh SOURCE PI_PACKAGE BUNDLE WORKFLOWS_ONLY SUBAGENT_ONLY
set -euo pipefail

source_root=$1
pi_package=$2
bundle=$3
workflows_only=$4
subagent_only=$5

test -f "$bundle/workflows/index.ts"
test -f "$bundle/workflows/goal/LICENSE"
test -f "$bundle/workflows/worktree/LICENSE"
export HOME="$TMPDIR/home"
export PI_CODING_AGENT_DIR="$HOME/agent"
export PI_OFFLINE=1
export NODE_PATH=
mkdir -p "$PI_CODING_AGENT_DIR"
# All Git mutations and removals are confined to disposable repositories.
# Fixture hooks prohibit use of the live ownership registry.
tests=(
  shared/worktree-completion.test.ts
  shared/worktree-completion.integration.test.mjs
  shared/worktree-reap.integration.test.mjs
  shared/automatic-worktrees.integration.test.mjs
  shared/subagent-worktrees-metadata.test.mjs
  workflows/worktree-completion-service.test.mjs
  workflows/worktree-goal-provenance.test.ts
  workflows/delegated-service.test.mjs
  workflows/worktree/repositories.test.ts
  workflows/delegated-goals.test.ts
  workflows/saved-goal-tasks.test.ts
  workflows/goal-story.test.ts
  workflows/goal-planning.test.ts
  workflows/goal-review.test.ts
  workflows/goal-review-worker.test.ts
  questionnaire/goal-attachments.test.mjs
  workflows/delegated-child.test.mjs
  workflows/delegated-restore.test.mjs
  subagent/goal-policy.test.ts
  subagent/coordinator-role.test.ts
  subagent/goal-executor.test.ts
  subagent/goal-reload.test.ts
  subagent/goal-pause-race.test.ts
  subagent/goal-completion.test.ts
)
for i in "${!tests[@]}"; do
  tests[$i]="$source_root/${tests[$i]}"
done
node --experimental-transform-types --test "${tests[@]}"
probe="$source_root/tests/package-load.mjs"
timeout 30s node "$probe" "$pi_package/bin/pi" \
  "$bundle/workflows" "$bundle/subagent" --expect goal worktree background
test -f "$workflows_only/subagent/tui-names.ts"
test ! -f "$workflows_only/subagent/index.ts"
test -f "$workflows_only/progress/progress-state.ts"
test ! -f "$workflows_only/progress/index.ts"
timeout 30s node "$probe" "$pi_package/bin/pi" \
  "$workflows_only/workflows" --expect goal worktree
timeout 30s node "$probe" "$pi_package/bin/pi" \
  "$subagent_only/subagent" --expect background
# A normal CLI exit is insufficient: missing registration must fail for the intended reason.
node "$source_root/nix/workflows-runtime-check/missing-registration.mjs" \
  "$probe" "$pi_package/bin/pi" "$bundle/workflows"
printf 'Worktree and Goal commands registered in the actual immutable Pi runtime.\n' >"$out"
