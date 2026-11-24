# Usage: source recovery-slow.sh coreutils-store-path
set -euo pipefail
coreutils=$1/bin

# The leader exits promptly on TERM, while this same-process-group
# descendant ignores TERM and closes inherited stdio. Node can therefore
# emit child close even though the descendant still requires group KILL.
(
  trap "" TERM
  exec "$coreutils/sleep" 30
) </dev/null >/dev/null 2>&1 &
child=$!
printf '%s\n' "$child" >"$("$coreutils/dirname" "$PI_AGENTSH_LIFECYCLE_STATE")/descendant.pid"
trap 'exit 0' TERM
wait "$child"
