# Inputs: SOURCE_ROOT (source tree), FIXTURES (JavaScript fixtures).
set -euo pipefail
workdir="$TMPDIR/fetch-check"
mkdir -p "$workdir/src/fetch" "$workdir/src/sandbox" "$workdir/src/shared" "$workdir/out"
cp "$SOURCE_ROOT/fetch/backend.ts" "$workdir/src/fetch/backend.ts"
cp "$SOURCE_ROOT/fetch/native.ts" "$workdir/src/fetch/native.ts"
cp "$SOURCE_ROOT/fetch/response.ts" "$workdir/src/fetch/response.ts"
cp "$SOURCE_ROOT/sandbox/api.ts" "$workdir/src/sandbox/api.ts"
cp "$SOURCE_ROOT/shared/agentsh-mode.ts" "$workdir/src/shared/agentsh-mode.ts"
printf '%s\n' '{"type":"module"}' > "$workdir/src/package.json"
tsc --noCheck --skipLibCheck --module nodenext --moduleResolution nodenext --target es2022 \
  --rootDir "$workdir/src" --outDir "$workdir/out" \
  "$workdir/src/fetch/backend.ts" \
  "$workdir/src/fetch/native.ts" \
  "$workdir/src/fetch/response.ts" \
  "$workdir/src/sandbox/api.ts" \
  "$workdir/src/shared/agentsh-mode.ts"

cp "$FIXTURES/test.mjs" "$workdir/test.mjs"
node "$workdir/test.mjs" "$workdir/out"

touch "$out"
