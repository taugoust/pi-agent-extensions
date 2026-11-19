# Usage: bash pi-run-cancellation-check.sh TEST_SCRIPT original|patched
set -euo pipefail

test_script=$1
expectation=$2
if [ "$expectation" = original ]; then
  # Patched expectations must reject the original SDK AND builtin bundle.
  for target in node bundle; do
    timeout 30s node "$test_script" "$PWD" "$target" original
    if timeout 30s node "$test_script" "$PWD" "$target" patched; then
      echo "ERROR: cancellation regression did not reject original $target" >&2
      exit 1
    fi
  done
else
  for target in node bundle; do
    timeout 30s node "$test_script" "$PWD" "$target" patched
  done
fi
