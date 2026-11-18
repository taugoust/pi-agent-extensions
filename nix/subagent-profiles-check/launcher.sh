# Usage: source launcher.sh PI FIXTURE [PI_ARGS...]
set -euo pipefail

pi=$1
fixture=$2
shift 2
# Tmux workers receive the caller's agent directory, not its arbitrary environment.
# Reconstruct only this fixture's disposable paths, not the server-global environment.
export HOME="$(dirname "${PI_CODING_AGENT_DIR:?}")"
fixture_root="$(dirname "$HOME")"
export TMPDIR="$fixture_root"
export XDG_CONFIG_HOME="$HOME/config"
export XDG_CACHE_HOME="$HOME/cache"
export PI_TUI_WORKER_STATE_ROOT="$fixture_root/worker-state"
export PROFILE_FIXTURE_LOG="$fixture_root/dispatch.jsonl"
# Explicitly add only the synthetic provider, including for managed Goal workers.
exec "$pi" "$@" --extension "$fixture" 2>> "$PROFILE_FIXTURE_LOG.stderr"
