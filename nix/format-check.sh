# Fails when any JavaScript or TypeScript file isn't formatted with oxfmt.
# Usage: format-check.sh SOURCE_TREE
set -euo pipefail
cd "$1"
find . -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \) \
  -not -path '*/node_modules/*' -print0 \
  | xargs -0 oxfmt --check --config .oxfmtrc.json
