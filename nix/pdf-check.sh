# Inputs: SOURCE_ROOT (source tree), FIXTURES (JavaScript fixtures).
set -euo pipefail

workdir="$TMPDIR/pdf-check"
srcdir="$workdir/src"
outdir="$workdir/out"
mkdir -p "$srcdir/pdf" "$srcdir/sandbox" "$srcdir/shared" "$outdir/node_modules/@sinclair/typebox"

pdf_sources=(index.ts backend.ts index.test.ts)
for file in "${pdf_sources[@]}"; do
  cp "$SOURCE_ROOT/pdf/$file" "$srcdir/pdf/"
done
cp "$SOURCE_ROOT/sandbox/api.ts" "$srcdir/sandbox/api.ts"
cp "$SOURCE_ROOT/shared/agentsh-mode.ts" "$srcdir/shared/agentsh-mode.ts"
printf '{"type":"module"}\n' >"$srcdir/package.json"
printf '{"type":"module"}\n' >"$outdir/package.json"

cat >"$outdir/node_modules/@sinclair/typebox/package.json" <<'EOF'
{
  "name": "@sinclair/typebox",
  "type": "module",
  "main": "./index.js"
}
EOF
cp "$FIXTURES/typebox.mjs" "$outdir/node_modules/@sinclair/typebox/index.js"

tsc \
  --noCheck \
  --skipLibCheck \
  --module nodenext \
  --moduleResolution nodenext \
  --target es2022 \
  --rootDir "$srcdir" \
  --outDir "$outdir" \
  "$srcdir/pdf/index.ts" \
  "$srcdir/pdf/backend.ts" \
  "$srcdir/pdf/index.test.ts" \
  "$srcdir/sandbox/api.ts" \
  "$srcdir/shared/agentsh-mode.ts"

node "$outdir/pdf/index.test.js"
mkdir -p "$out"
touch "$out/passed"
