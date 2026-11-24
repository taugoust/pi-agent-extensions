# Usage: source recovery-swap.sh coreutils-store-path
set -euo pipefail
coreutils=$1/bin

"$coreutils/mv" "$PI_AGENTSH_LIFECYCLE_STATE" "$PI_AGENTSH_LIFECYCLE_STATE.old"
"$coreutils/ln" -s "$PI_AGENTSH_LIFECYCLE_STATE.old" "$PI_AGENTSH_LIFECYCLE_STATE"
