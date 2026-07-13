{ self, pkgs }:

pkgs.runCommand "modal-editor-check"
  {
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.typescript
    ];
  }
  ''
    set -euo pipefail

    workdir="$TMPDIR/modal-editor-check"
    srcdir="$workdir/src"
    outdir="$workdir/out"
    mkdir -p "$srcdir" "$outdir"

    cp -r ${self}/modal-editor "$srcdir/"

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

    cat > "$outdir/node_modules/@mariozechner/pi-coding-agent/index.js" <<'EOF'
    export class CustomEditor {}
    export function copyToClipboard() {}
    EOF

    cat > "$outdir/node_modules/@mariozechner/pi-tui/package.json" <<'EOF'
    {
      "name": "@mariozechner/pi-tui",
      "type": "module",
      "main": "./index.js"
    }
    EOF

    cat > "$outdir/node_modules/@mariozechner/pi-tui/index.js" <<'EOF'
    export function matchesKey() { return false; }
    export function truncateToWidth(value) { return String(value); }
    export function visibleWidth(value) { return [...String(value)].length; }
    EOF

    tsc \
      --noCheck \
      --skipLibCheck \
      --module nodenext \
      --moduleResolution nodenext \
      --target es2022 \
      --rootDir "$srcdir" \
      --outDir "$outdir" \
      "$srcdir/modal-editor/index.ts"

    cat > "$workdir/test.mjs" <<'EOF'
    import assert from "node:assert/strict";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const compiledRoot = process.argv[2];
    const moduleUrl = pathToFileURL(path.join(compiledRoot, "modal-editor/index.js")).href;
    const imported = await import(moduleUrl);
    const modalEditor = imported.default?.default ?? imported.default ?? imported;
    assert.equal(typeof modalEditor, "function", "modal-editor did not export an extension function");

    const handlers = new Map();
    const pi = {
      on(event, handler) {
        const current = handlers.get(event) ?? [];
        current.push(handler);
        handlers.set(event, current);
      },
      events: { emit() {} },
    };
    modalEditor(pi);

    const sessionHandlers = handlers.get("session_start") ?? [];
    assert.equal(sessionHandlers.length, 1, "expected one session_start handler");

    let editorCalls = 0;
    const writes = [];
    const originalWrite = process.stdout.write;
    const listenerCounts = new Map(
      ["exit", "SIGINT", "SIGTERM"].map((event) => [event, process.listenerCount(event)]),
    );

    process.stdout.write = function (chunk) {
      writes.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      return true;
    };
    try {
      await sessionHandlers[0](
        { type: "session_start", reason: "startup" },
        {
          hasUI: false,
          ui: {
            setEditorComponent() {
              editorCalls += 1;
            },
          },
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      process.stdout.write = originalWrite;
    }

    assert.equal(editorCalls, 0, "non-interactive session configured an editor component");
    assert.deepEqual(writes, [], "non-interactive session wrote terminal control bytes to stdout");
    for (const [event, count] of listenerCounts) {
      assert.equal(process.listenerCount(event), count, `non-interactive session registered a ''${event} listener`);
    }
    EOF

    node "$workdir/test.mjs" "$outdir"
    touch "$out"
  ''
