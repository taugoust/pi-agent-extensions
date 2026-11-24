# Usage: source recovery-success.sh jq-store-path
set -euo pipefail
jq=$1/bin/jq

test "$PI_AGENTSH_RECOVERY_CONTRACT_VERSION" = 1
test "$("$jq" -r .schema_version "$PI_AGENTSH_LIFECYCLE_STATE")" = 1
test "$("$jq" -r .session_id "$PI_AGENTSH_LIFECYCLE_STATE")" \
  = "$PI_AGENTSH_RECOVERY_EXPECTED_SESSION"
test -z "${AGENTSH_SESSION_EVENT_TOKEN-}${OPENAI_API_KEY-}${AUTHORIZATION-}"
