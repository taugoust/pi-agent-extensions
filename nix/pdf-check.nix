{ self, pkgs }:

pkgs.runCommand "pdf-check"
  {
    nativeBuildInputs = [
      pkgs.bash
      pkgs.nodejs
      pkgs.typescript
    ];
  }
  ''
    set -euo pipefail

    workdir="$TMPDIR/pdf-check"
    srcdir="$workdir/src"
    outdir="$workdir/out"
    mkdir -p "$srcdir/pdf" "$srcdir/sandbox" "$outdir/node_modules/@sinclair/typebox"

    cp ${self}/pdf/index.ts ${self}/pdf/backend.ts ${self}/pdf/index.test.ts "$srcdir/pdf/"
    cp ${self}/sandbox/api.ts "$srcdir/sandbox/api.ts"
    printf '{"type":"module"}\n' > "$srcdir/package.json"
    printf '{"type":"module"}\n' > "$outdir/package.json"

    cat > "$outdir/node_modules/@sinclair/typebox/package.json" <<'EOF'
    {
      "name": "@sinclair/typebox",
      "type": "module",
      "main": "./index.js"
    }
    EOF
    cat > "$outdir/node_modules/@sinclair/typebox/index.js" <<'EOF'
    export const Type = {
      String(options = {}) { return { type: "string", ...options }; },
      Number(options = {}) { return { type: "number", ...options }; },
      Boolean(options = {}) { return { type: "boolean", ...options }; },
      Literal(value, options = {}) { return { const: value, ...options }; },
      Union(anyOf, options = {}) { return { anyOf, ...options }; },
      Object(properties, options = {}) { return { type: "object", properties, ...options }; },
      Optional(schema) { return { ...schema, optional: true }; },
    };
    EOF

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
      "$srcdir/sandbox/api.ts"

    node "$outdir/pdf/index.test.js"
    mkdir -p "$out"
    touch "$out/passed"
  ''
