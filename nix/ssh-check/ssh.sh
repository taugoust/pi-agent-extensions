# Usage: ssh target [command]; SSH_TEST_LOG receives the fixture's argument log.
set -euo pipefail

printf '%s\n' "$*" >>"$SSH_TEST_LOG"
if [ "${2:-}" = pwd ]; then
  printf '/remote/home\n'
fi
