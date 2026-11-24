# Usage: source recovery-automatic.sh jq-store-path coreutils-store-path
set -euo pipefail
jq=$1/bin/jq
coreutils=$2/bin

test "$PI_AGENTSH_RECOVERY_CONTRACT_VERSION" = 1
test "$("$jq" -r .session_id "$PI_AGENTSH_LIFECYCLE_STATE")" \
  = "$PI_AGENTSH_RECOVERY_EXPECTED_SESSION"
test -z "${AGENTSH_SESSION_EVENT_TOKEN-}${RECOVERY_CUSTOM_ENV-}${RECOVERY_UNRELATED_SECRET-}"
printf '%s\n' "$PI_AGENTSH_RECOVERY_EXPECTED_SESSION" \
  >>"$("$coreutils/dirname" "$PI_AGENTSH_LIFECYCLE_STATE")/automatic-recovery.requested"
