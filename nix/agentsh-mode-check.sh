# Inputs: SOURCE_ROOT (source tree), FIXTURES (JavaScript fixtures).
# BUNDLE_ROOTS and MODULE_SHARED_ROOTS: space-separated store paths to check.
set -euo pipefail

workdir="$TMPDIR/agentsh-mode-check"
mkdir -p "$workdir/src/shared" "$workdir/out"
cp "$SOURCE_ROOT/shared/agentsh-mode.ts" "$workdir/src/shared/agentsh-mode.ts"
printf '{"type":"module"}\n' >"$workdir/src/package.json"

tsc \
  --noCheck \
  --skipLibCheck \
  --module nodenext \
  --moduleResolution nodenext \
  --target es2022 \
  --rootDir "$workdir/src" \
  --outDir "$workdir/out" \
  "$workdir/src/shared/agentsh-mode.ts"

cp "$FIXTURES/test.mjs" "$workdir/test.mjs"

node "$workdir/test.mjs" "$workdir/out"

for bundle in $BUNDLE_ROOTS; do
  test -f "$bundle/shared/agentsh-mode.ts"
done
for shared in $MODULE_SHARED_ROOTS; do
  test -f "$shared/agentsh-mode.ts"
done

touch "$out"
