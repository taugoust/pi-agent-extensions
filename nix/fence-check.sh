# Inputs: src is the extension source; fixtures contains the check fixtures.
set -euo pipefail

workdir="$TMPDIR/fence-check"
srcdir="$workdir/src"
outdir="$workdir/out"
mkdir -p "$srcdir" "$outdir"

cp -r "$src"/fence "$srcdir/"

tsc \
  --noCheck \
  --skipLibCheck \
  --module nodenext \
  --moduleResolution nodenext \
  --target es2022 \
  --rootDir "$srcdir" \
  --outDir "$outdir" \
  "$srcdir/fence/index.ts"

cp "$fixtures/check.test.mjs" "$workdir/test.mjs"

node "$workdir/test.mjs" "$outdir"

mkdir -p "$out"
touch "$out/passed"
