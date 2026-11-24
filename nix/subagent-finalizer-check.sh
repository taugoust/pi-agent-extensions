# Inputs: SOURCE_ROOT (source tree), FIXTURES (JavaScript fixtures).
set -euo pipefail

workdir="$TMPDIR/subagent-finalizer-check"
srcdir="$workdir/src"
outdir="$workdir/out"
mkdir -p "$srcdir" "$outdir"

cp -r "$SOURCE_ROOT/subagent-finalizer" "$srcdir/"
printf '%s\n' '{"type":"module"}' >"$srcdir/package.json"

tsc \
  --noCheck \
  --skipLibCheck \
  --module nodenext \
  --moduleResolution nodenext \
  --target es2022 \
  --rootDir "$srcdir" \
  --outDir "$outdir" \
  "$srcdir/subagent-finalizer/index.ts"

cp "$FIXTURES/test.mjs" "$workdir/test.mjs"

node "$workdir/test.mjs" "$outdir"
touch "$out"
