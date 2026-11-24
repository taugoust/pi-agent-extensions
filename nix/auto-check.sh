# Inputs: SOURCE_ROOT (source tree), FIXTURES (JavaScript fixtures).
set -euo pipefail
workdir="$TMPDIR/auto-extension-check"
srcdir="$workdir/src"
outdir="$workdir/out"
mkdir -p "$srcdir/auto" "$srcdir/sandbox" "$outdir/node_modules/@mariozechner/pi-coding-agent"
cp "$SOURCE_ROOT/auto/index.ts" "$srcdir/auto/index.ts"
cp "$SOURCE_ROOT/auto/request.ts" "$srcdir/auto/request.ts"
cp "$SOURCE_ROOT/sandbox/api.ts" "$srcdir/sandbox/api.ts"
cat >"$outdir/node_modules/@mariozechner/pi-coding-agent/package.json" <<'EOF'
{ "name": "@mariozechner/pi-coding-agent", "type": "module", "main": "./index.js" }
EOF
cp "$FIXTURES/coding-agent.mjs" "$outdir/node_modules/@mariozechner/pi-coding-agent/index.js"
tsc --noCheck --skipLibCheck --module nodenext --moduleResolution nodenext --target es2022 \
  --rootDir "$srcdir" --outDir "$outdir" \
  "$srcdir/auto/index.ts" "$srcdir/auto/request.ts" "$srcdir/sandbox/api.ts"
cp "$FIXTURES/test.mjs" "$workdir/test.mjs"
node "$workdir/test.mjs" "$outdir"
touch "$out"
