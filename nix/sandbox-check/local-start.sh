# Usage: source local-start.sh; LOCAL_START_SOCKET names the fixture supervisor socket.
set -euo pipefail

printf '{"session_id":"sess-local-start","supervisor_sock":"unix://%s"}\n' "$LOCAL_START_SOCKET"
