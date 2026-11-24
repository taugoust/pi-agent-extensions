# Inputs: SOURCE_ROOT (source tree), FIXTURES (JavaScript fixtures).
set -euo pipefail
workdir="$TMPDIR/http-transport-check"
mkdir -p "$workdir/src/shared" "$workdir/out"
cp "$SOURCE_ROOT/shared/http-transport.ts" "$workdir/src/shared/http-transport.ts"
printf '%s\n' '{"type":"module"}' >"$workdir/src/package.json"
tsc --noCheck --skipLibCheck --module nodenext --moduleResolution nodenext --target es2022 \
  --rootDir "$workdir/src" --outDir "$workdir/out" "$workdir/src/shared/http-transport.ts"
cp "$FIXTURES/test.mjs" "$workdir/test.mjs"
node "$workdir/test.mjs" "$workdir/out"
touch "$out"
