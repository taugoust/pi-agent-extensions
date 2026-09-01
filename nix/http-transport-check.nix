{ self, pkgs }:

pkgs.runCommand "http-transport-check"
  {
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.typescript
    ];
  }
  ''
    set -euo pipefail
    workdir="$TMPDIR/http-transport-check"
    mkdir -p "$workdir/src/shared" "$workdir/out"
    cp ${self}/shared/http-transport.ts "$workdir/src/shared/http-transport.ts"
    printf '%s\n' '{"type":"module"}' > "$workdir/src/package.json"
    tsc --noCheck --skipLibCheck --module nodenext --moduleResolution nodenext --target es2022 \
      --rootDir "$workdir/src" --outDir "$workdir/out" "$workdir/src/shared/http-transport.ts"
    cat > "$workdir/test.mjs" <<'EOF'
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import http from "node:http";
    import os from "node:os";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const transport = await import(pathToFileURL(path.join(process.argv[2], "shared/http-transport.js")).href);
    const socket = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "http-transport-")), "server.sock");
    const server = http.createServer((request, response) => {
      if (request.url === "/closed") { response.writeHead(200); response.flushHeaders(); response.write("partial"); setTimeout(() => response.socket.destroy(), 10); return; }
      if (request.url === "/hang") return;
      if (request.url === "/large") { response.writeHead(200); response.end("x".repeat(100)); return; }
      response.writeHead(200, { "content-type": "application/json" }); response.end('{"ok":true}');
    });
    await new Promise((resolve) => server.listen(socket, resolve));
    const request = (url, options = {}) => transport.bufferedHttpRequest({
      request: { socketPath: socket, path: url }, method: "GET", timeoutMs: 500, ...options,
    });
    const ok = await request("/ok"); assert.equal(ok.statusCode, 200); assert.equal(ok.body.toString(), '{"ok":true}');
    await assert.rejects(request("/closed"), (error) => error.responseStarted === true);
    await assert.rejects(request("/hang", { timeoutMs: 30 }), (error) => error.kind === "timeout");
    await assert.rejects(request("/large", { maxResponseBytes: 10 }), (error) => error.kind === "response-too-large");
    const controller = new AbortController(); controller.abort();
    await assert.rejects(request("/ok", { signal: controller.signal }), (error) => error.kind === "abort");
    await new Promise((resolve) => server.close(resolve));
    EOF
    node "$workdir/test.mjs" "$workdir/out"
    touch "$out"
  ''
