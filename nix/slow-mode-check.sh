# Inputs: src is the extension source; fixtures contains the check fixtures.
set -euo pipefail

workdir="$TMPDIR/slow-mode-check"
srcdir="$workdir/src"
outdir="$workdir/out"
mkdir -p "$srcdir" "$outdir"

cp -r "$src"/slow-mode "$srcdir/"
# Slow mode reads its defaults through the shared settings helper.
mkdir -p "$srcdir/shared"
cp "$src"/shared/extension-defaults.ts "$src"/shared/extension-config-manifest.json \
  "$srcdir/shared/"
substituteInPlace "$srcdir/shared/extension-defaults.ts" \
  --replace-fail 'from "./extension-config-manifest.json";' \
  'from "./extension-config-manifest.json" with { type: "json" };'
printf '%s\n' '{ "type": "module" }' >"$srcdir/package.json"
cp "$srcdir/package.json" "$outdir/package.json"

mkdir -p "$outdir/node_modules/@earendil-works/pi-coding-agent"
cat >"$outdir/node_modules/@earendil-works/pi-coding-agent/package.json" <<'EOF'
{ "name": "@earendil-works/pi-coding-agent", "type": "module", "main": "./index.js" }
EOF
cp "$fixtures/earendil-works-pi-coding-agent.mjs" \
  "$outdir/node_modules/@earendil-works/pi-coding-agent/index.js"

mkdir -p "$outdir/node_modules/@mariozechner/pi-tui"
cat >"$outdir/node_modules/@mariozechner/pi-tui/package.json" <<'EOF'
{
  "name": "@mariozechner/pi-tui",
  "type": "module",
  "main": "./index.js"
}
EOF

cp "$fixtures/mariozechner-pi-tui.mjs" "$outdir/node_modules/@mariozechner/pi-tui/index.js"

tsc \
  --noCheck \
  --skipLibCheck \
  --module nodenext \
  --moduleResolution nodenext \
  --target es2022 \
  --resolveJsonModule \
  --rootDir "$srcdir" \
  --outDir "$outdir" \
  "$srcdir/slow-mode/index.ts"

cp "$fixtures/check.test.mjs" "$workdir/test.mjs"

node "$workdir/test.mjs" "$outdir"

mkdir -p "$out"
touch "$out/passed"
