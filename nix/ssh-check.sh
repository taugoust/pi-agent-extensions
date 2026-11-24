# Inputs: src is the extension source; fixtures contains the check fixtures.
# runtimeShell is the interpreter for the SSH executable fixture.
set -euo pipefail

workdir="$TMPDIR/ssh-extension-check"
srcdir="$workdir/src"
outdir="$workdir/out"
directories=(
  "$srcdir/ssh"
  "$srcdir/sandbox"
  "$srcdir/shared"
  "$outdir/node_modules/@mariozechner/pi-coding-agent"
  "$workdir/bin"
)
mkdir -p "${directories[@]}"
cp "$src"/ssh/index.ts "$srcdir/ssh/index.ts"
cp "$src"/sandbox/api.ts "$srcdir/sandbox/api.ts"
cp "$src"/shared/agentsh-mode.ts "$srcdir/shared/agentsh-mode.ts"
cp "$src"/shared/bash-command-transform.ts "$srcdir/shared/bash-command-transform.ts"

cat >"$outdir/node_modules/@mariozechner/pi-coding-agent/package.json" <<'EOF'
{ "name": "@mariozechner/pi-coding-agent", "type": "module", "main": "./index.js" }
EOF
cp "$fixtures/mariozechner-pi-coding-agent.mjs" \
  "$outdir/node_modules/@mariozechner/pi-coding-agent/index.js"

printf '#!%s\n' "$runtimeShell" >"$workdir/bin/ssh"
cat "$fixtures/ssh.sh" >>"$workdir/bin/ssh"
chmod +x "$workdir/bin/ssh"

sources=(
  "$srcdir/ssh/index.ts"
  "$srcdir/sandbox/api.ts"
  "$srcdir/shared/agentsh-mode.ts"
  "$srcdir/shared/bash-command-transform.ts"
)
tsc \
  --noCheck \
  --skipLibCheck \
  --module nodenext \
  --moduleResolution nodenext \
  --target es2022 \
  --rootDir "$srcdir" \
  --outDir "$outdir" \
  "${sources[@]}"

cp "$fixtures/check.test.mjs" "$workdir/test.mjs"

export SSH_TEST_LOG="$workdir/ssh.log"
export PATH="$workdir/bin:$PATH"
cd "$workdir"
node "$workdir/test.mjs" "$outdir"
touch "$out"
