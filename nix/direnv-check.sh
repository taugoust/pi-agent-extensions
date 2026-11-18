# Inputs: src is the extension source; fixtures contains the check fixtures.
set -euo pipefail

workdir="$TMPDIR/direnv-check"
srcdir="$workdir/src"
outdir="$workdir/out"
mkdir -p "$srcdir/direnv" "$srcdir/sandbox" "$srcdir/shared" "$outdir"
cp "$src"/direnv/index.ts "$srcdir/direnv/index.ts"
cp "$src"/sandbox/api.ts "$srcdir/sandbox/api.ts"
cp "$src"/shared/agentsh-mode.ts "$srcdir/shared/agentsh-mode.ts"

tsc \
  --noCheck \
  --skipLibCheck \
  --module nodenext \
  --moduleResolution nodenext \
  --target es2022 \
  --rootDir "$srcdir" \
  --outDir "$outdir" \
  "$srcdir/direnv/index.ts" \
  "$srcdir/sandbox/api.ts" \
  "$srcdir/shared/agentsh-mode.ts"

cp "$fixtures/check.test.mjs" "$workdir/test.mjs"

node "$workdir/test.mjs" "$outdir"
mkdir -p "$out"
touch "$out/passed"
