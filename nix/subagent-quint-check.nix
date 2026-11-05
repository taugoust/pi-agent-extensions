{ self, pkgs }:

pkgs.runCommand "subagent-quint-check"
  {
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.quint
      pkgs.typescript
    ];
  }
  ''
    set -euo pipefail
    export HOME="$TMPDIR/home"
    mkdir -p "$HOME" "$TMPDIR/src/subagent" "$TMPDIR/src/tests/quint"
    cd "$TMPDIR/src"
    printf '%s\n' '{ "type": "module" }' > package.json
    cp ${self}/subagent/resume.ts ${self}/subagent/resume.test.ts subagent/
    cp ${self}/tests/quint/* tests/quint/

    # Retain the existing hand-written regression test alongside the new oracle.
    tsc --noCheck --module nodenext --moduleResolution nodenext --target es2022 \
      --outDir "$TMPDIR/compiled" subagent/resume.ts subagent/resume.test.ts
    cp package.json "$TMPDIR/compiled/"
    node "$TMPDIR/compiled/resume.test.js"

    quint typecheck tests/quint/native_task.qnt
    node tests/quint/run.mjs --out-dir "$TMPDIR/traces"
    mkdir -p "$out"
    cp "$TMPDIR/traces/report.json" "$TMPDIR/traces"/counterexample-*.itf.json "$out/"
  ''
