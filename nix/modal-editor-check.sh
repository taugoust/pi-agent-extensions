# Inputs: SOURCE_ROOT (source tree), FIXTURES (JavaScript fixtures).
set -euo pipefail

workdir="$TMPDIR/modal-editor-check"
srcdir="$workdir/src"
outdir="$workdir/out"
mkdir -p "$srcdir" "$outdir"

cp -r "$SOURCE_ROOT/modal-editor" "$srcdir/"

mkdir -p \
  "$outdir/node_modules/@mariozechner/pi-coding-agent" \
  "$outdir/node_modules/@mariozechner/pi-tui"

cat > "$outdir/node_modules/@mariozechner/pi-coding-agent/package.json" <<'EOF'
{
  "name": "@mariozechner/pi-coding-agent",
  "type": "module",
  "main": "./index.js"
}
EOF

cp "$FIXTURES/coding-agent.mjs" "$outdir/node_modules/@mariozechner/pi-coding-agent/index.js"

cat > "$outdir/node_modules/@mariozechner/pi-tui/package.json" <<'EOF'
{
  "name": "@mariozechner/pi-tui",
  "type": "module",
  "main": "./index.js"
}
EOF

cp "$FIXTURES/tui.mjs" "$outdir/node_modules/@mariozechner/pi-tui/index.js"

tsc \
  --noCheck \
  --skipLibCheck \
  --module nodenext \
  --moduleResolution nodenext \
  --target es2022 \
  --rootDir "$srcdir" \
  --outDir "$outdir" \
  "$srcdir/modal-editor/index.ts"

cp "$FIXTURES/test.mjs" "$workdir/test.mjs"

node "$workdir/test.mjs" "$outdir"
touch "$out"
