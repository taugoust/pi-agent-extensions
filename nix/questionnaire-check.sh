# Inputs: src is the extension source; fixtures contains the check fixtures.
# questionnaireBundle is the bundled extension; moduleFileCount is the module output count.
# moduleShared and moduleQuestionnaire are the module-generated extension directories.
set -euo pipefail

workdir="$TMPDIR/questionnaire-check"
srcdir="$workdir/src"
outdir="$workdir/out"
mkdir -p "$srcdir/questionnaire" "$outdir"
cp "$src"/questionnaire/paseo.ts "$srcdir/questionnaire/paseo.ts"
cp "$src"/questionnaire/index.ts "$srcdir/questionnaire/index.ts"
cp "$src"/questionnaire/timeout.ts "$srcdir/questionnaire/timeout.ts"
mkdir -p "$srcdir/shared"
cp "$src"/shared/foreground-tasks.ts "$srcdir/shared/foreground-tasks.ts"
cp "$src"/shared/tool-presentation.ts "$srcdir/shared/tool-presentation.ts"
cp "$src"/shared/goal-question-recorder.ts "$srcdir/shared/goal-question-recorder.ts"

test "$moduleFileCount" = 4
test -f "$moduleShared"/foreground-tasks.ts
test -f "$questionnaireBundle"/shared/foreground-tasks.ts
test -f "$moduleQuestionnaire"/index.ts
test -f "$moduleQuestionnaire"/paseo.ts
test -f "$questionnaireBundle"/questionnaire/index.ts
test -f "$questionnaireBundle"/questionnaire/paseo.ts

# Keep the existing strict helper check. The entrypoint has host-only
# SDK/UI imports; transpile it separately and exercise its real execute
# path with explicit UI stubs below, rather than weakening that check.
# This isolated compile has no @types/node package, so declare only the
# process.env surface used by foreground-tasks.
printf '%s\n' 'declare const process: { env: Record<string, string | undefined> };' \
  >"$srcdir/node-globals.d.ts"
sources=(
  "$srcdir/questionnaire/paseo.ts"
  "$srcdir/questionnaire/timeout.ts"
  "$srcdir/shared/foreground-tasks.ts"
  "$srcdir/node-globals.d.ts"
)
tsc \
  --strict \
  --skipLibCheck \
  --module nodenext \
  --moduleResolution nodenext \
  --target es2022 \
  --rootDir "$srcdir" \
  --outDir "$outdir" \
  "${sources[@]}"
tsc --noCheck --skipLibCheck --module nodenext --moduleResolution nodenext \
  --rewriteRelativeImportExtensions \
  --target es2022 --rootDir "$srcdir" --outDir "$outdir" "$srcdir/questionnaire/index.ts"
mkdir -p "$outdir/node_modules/@mariozechner/pi-tui" "$outdir/node_modules/@sinclair/typebox"
printf '%s\n' '{"type":"module","main":"index.js"}' \
  >"$outdir/node_modules/@mariozechner/pi-tui/package.json"
cp "$fixtures/mariozechner-pi-tui.mjs" "$outdir/node_modules/@mariozechner/pi-tui/index.js"
printf '%s\n' '{"type":"module","main":"index.js"}' \
  >"$outdir/node_modules/@sinclair/typebox/package.json"
cp "$fixtures/sinclair-typebox.mjs" "$outdir/node_modules/@sinclair/typebox/index.js"
node "$src"/questionnaire/headless.test.mjs "$outdir"
tests=(
  "$src/questionnaire/paseo.test.mjs"
  "$src/questionnaire/timeout.test.mjs"
)
node --experimental-strip-types --test "${tests[@]}"

# Compile and load the actual selected package bundle, not a hand-picked
# source subset. This catches runtime imports whose implementations are
# absent from the package closure (notably workflows/goal-questions.ts).
bundledir="$workdir/bundle"
bundleout="$workdir/bundle-out"
cp -R "$questionnaireBundle" "$bundledir"
test ! -e "$bundledir/workflows/goal-questions.ts"
tsc --noCheck --skipLibCheck --module nodenext --moduleResolution nodenext \
  --rewriteRelativeImportExtensions --target es2022 --rootDir "$bundledir" \
  --outDir "$bundleout" "$bundledir/questionnaire/index.ts"
cp "$bundledir/package.json" "$bundleout/package.json"
mkdir -p "$bundleout/node_modules"
cp -R "$outdir/node_modules/@mariozechner" "$bundleout/node_modules/"
cp -R "$outdir/node_modules/@sinclair" "$bundleout/node_modules/"
node "$src"/questionnaire/headless.test.mjs "$bundleout"

cp "$fixtures/check.test.mjs" "$workdir/test.mjs"

node "$workdir/test.mjs" "$outdir"
mkdir -p "$out"
touch "$out/passed"
