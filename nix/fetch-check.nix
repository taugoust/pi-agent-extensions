{ self, pkgs }:

pkgs.runCommand "fetch-extension-check"
  {
    nativeBuildInputs = [
      pkgs.bash
      pkgs.coreutils
      pkgs.curl
      pkgs.gnused
      pkgs.nodejs
      pkgs.typescript
    ];
  }
  ''
    set -euo pipefail
    workdir="$TMPDIR/fetch-check"
    mkdir -p "$workdir/src/fetch" "$workdir/src/sandbox" "$workdir/src/shared" "$workdir/out"
    cp ${self}/fetch/backend.ts "$workdir/src/fetch/backend.ts"
    cp ${self}/fetch/native.ts "$workdir/src/fetch/native.ts"
    cp ${self}/sandbox/api.ts "$workdir/src/sandbox/api.ts"
    cp ${self}/shared/agentsh-mode.ts "$workdir/src/shared/agentsh-mode.ts"
    printf '%s\n' '{"type":"module"}' > "$workdir/src/package.json"
    tsc --noCheck --skipLibCheck --module nodenext --moduleResolution nodenext --target es2022 \
      --rootDir "$workdir/src" --outDir "$workdir/out" "$workdir/src/fetch/backend.ts" "$workdir/src/fetch/native.ts" "$workdir/src/sandbox/api.ts" "$workdir/src/shared/agentsh-mode.ts"

    cat > "$workdir/test.mjs" <<'EOF'
    import assert from "node:assert/strict";
    import { spawn } from "node:child_process";
    import fs from "node:fs";
    import http from "node:http";
    import os from "node:os";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const backend = await import(pathToFileURL(path.join(process.argv[2], "fetch/backend.js")).href);
    const native = await import(pathToFileURL(path.join(process.argv[2], "fetch/native.js")).href);
    const mode = await import(pathToFileURL(path.join(process.argv[2], "shared/agentsh-mode.js")).href);
    const nativeStartup = mode.classifyAgentSHStartup({});
    const fullStartup = mode.classifyAgentSHStartup({ PI_SUPERVISED: "1" });
    assert.equal(backend.selectFetchBackend(undefined, nativeStartup).kind, "native");
    assert.equal(backend.selectFetchBackend(undefined, fullStartup).kind, "unavailable");
    assert.equal(backend.selectFetchBackend({ getSupervisorState: () => ({ configured: true, active: false, protocol: "rest", status: "error" }) }, nativeStartup).kind, "unavailable");
    assert.equal(backend.selectFetchBackend(undefined, mode.classifyAgentSHStartup({ AGENTSH_PERMISSION_GATE_SOCKET: "/guard" })).kind, "native");
    assert.equal(backend.selectFetchBackend({ exec() {}, toSupervisorPath(value) { return value; } }, nativeStartup).kind, "unavailable");

    const server = http.createServer((request, response) => {
      if (request.url === "/large") {
        response.writeHead(200, { "content-type": "text/plain", "x-test": "large" });
        response.end("x".repeat(4096));
      } else if (request.url === "/redirect") {
        response.writeHead(302, { location: "/small" }); response.end();
      } else if (request.url === "/notfound") {
        response.writeHead(404, { "content-type": "text/plain" }); response.end("missing");
      } else if (request.url === "/slow") {
        setTimeout(() => { response.writeHead(200); response.end("late"); }, 500);
      } else if (request.url === "/echo") {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => { response.writeHead(200, { "content-type": "text/plain" }); response.end(Buffer.concat(chunks)); });
      } else {
        response.writeHead(200, { "content-type": "text/plain", "x-test": "small" });
        response.end(request.method === "HEAD" ? undefined : "hello");
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:''${server.address().port}`;
    const calls = [];
    const api = {
      getSupervisorState: () => ({ configured: true, active: true, status: "connected" }),
      toSupervisorPath(value) { return value; },
      exec(request, options) {
        calls.push({ request, options });
        return new Promise((resolve, reject) => {
          const child = spawn("bash", ["-c", request.command], { cwd: request.cwd, env: process.env });
          const stdout = [], stderr = [];
          child.stdout.on("data", (chunk) => stdout.push(chunk));
          child.stderr.on("data", (chunk) => stderr.push(chunk));
          child.on("error", reject);
          child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }));
          options?.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
        });
      },
    };
    assert.equal(backend.selectFetchBackend(api, fullStartup).kind, "agentsh");
    assert.equal(backend.selectFetchBackend({ ...api, getSupervisorState: () => ({ configured: true, active: true, protocol: "mock-ndjson", status: "connected", source: "mock" }) }, fullStartup).kind, "unavailable");
    const common = { method: "GET", timeoutMs: 5000, cwd: os.tmpdir(), toolCallId: "fetch-check" };
    const small = await backend.executeAgentSHFetch(api, { ...common, url: base + "/small", maxBodyBytes: 1024 });
    assert.equal(small.status, 200);
    assert.equal(small.headers["x-test"], "small");
    assert.equal(small.body.toString(), "hello");
    assert.equal(small.truncated, false);
    const redirected = await backend.executeAgentSHFetch(api, { ...common, url: base + "/redirect", maxBodyBytes: 1024 });
    assert.equal(redirected.status, 200);
    assert.equal(redirected.effectiveUrl, base + "/small");
    const head = await backend.executeAgentSHFetch(api, { ...common, url: base + "/small", method: "HEAD", maxBodyBytes: 1024 });
    assert.equal(head.bodyLength, 0);
    assert.equal(head.body.length, 0);
    const literalAt = await backend.executeAgentSHFetch(api, { ...common, url: base + "/echo", method: "POST", body: "@/etc/passwd", maxBodyBytes: 1024 });
    assert.equal(literalAt.body.toString(), "@/etc/passwd", "curl interpreted a string body as a file reference");
    const notFound = await backend.executeAgentSHFetch(api, { ...common, url: base + "/notfound", maxBodyBytes: 1024 });
    assert.equal(notFound.status, 404);
    assert.match(calls[0].request.command, /curl --disable/);
    assert.match(calls[0].request.command, /--proto '=http,https'/);
    assert.equal(calls[0].request.actor.tool_call_id, "fetch-check");

    const large = await backend.executeAgentSHFetch(api, { ...common, url: base + "/large", maxBodyBytes: 100 });
    assert.equal(large.truncated, true);
    assert.equal(large.body.length, 100);

    const outputPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fetch-output-")), "body.bin");
    fs.writeFileSync(outputPath, "old");
    const failedDownload = await backend.executeAgentSHFetch(api, { ...common, url: base + "/notfound", maxBodyBytes: 1024, outputPath });
    assert.equal(failedDownload.status, 404);
    assert.equal(fs.readFileSync(outputPath, "utf8"), "old", "HTTP error download replaced its destination");
    await assert.rejects(
      backend.executeAgentSHFetch(api, { ...common, url: base + "/large", maxBodyBytes: 100, outputPath }),
      /exceeded maxBodyBytes/,
    );
    assert.equal(fs.readFileSync(outputPath, "utf8"), "old", "oversized download replaced its destination");
    const saved = await backend.executeAgentSHFetch(api, { ...common, url: base + "/small", maxBodyBytes: 1024, outputPath });
    assert.equal(saved.outputPath, outputPath);
    assert.equal(fs.readFileSync(outputPath, "utf8"), "hello");

    const nativeCommon = { method: "GET", timeoutMs: 5000, maxBodyBytes: 1024, cwd: os.tmpdir() };
    const nativeSmall = await native.executeNativeFetch({ ...nativeCommon, url: base + "/small" });
    assert.equal(nativeSmall.backend, "native");
    assert.equal(nativeSmall.body.toString(), "hello");
    const nativeLarge = await native.executeNativeFetch({ ...nativeCommon, url: base + "/large", maxBodyBytes: 100 });
    assert.equal(nativeLarge.truncated, true);
    assert.equal(nativeLarge.body.length, 100);
    const nativeOutput = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "native-fetch-output-")), "body");
    await native.executeNativeFetch({ ...nativeCommon, url: base + "/small", outputPath: nativeOutput });
    assert.equal(fs.readFileSync(nativeOutput, "utf8"), "hello");
    fs.writeFileSync(nativeOutput, "old");
    await assert.rejects(native.executeNativeFetch({ ...nativeCommon, url: base + "/large", maxBodyBytes: 100, outputPath: nativeOutput }), /exceeded maxBodyBytes/);
    assert.equal(fs.readFileSync(nativeOutput, "utf8"), "old");
    const outsideParent = path.join("/var/empty", "must-not-create", "nested");
    await assert.rejects(native.executeNativeFetch({ ...nativeCommon, url: base + "/small", outputPath: path.join(outsideParent, "body") }), /restricted/);
    assert.equal(fs.existsSync(outsideParent), false, "rejected native outputPath created outside directories");
    const preAborted = new AbortController(); preAborted.abort();
    await assert.rejects(native.executeNativeFetch({ ...nativeCommon, url: base + "/small", signal: preAborted.signal }), /abort/i);
    await assert.rejects(native.executeNativeFetch({ ...nativeCommon, url: base + "/slow", timeoutMs: 50 }), /Timed out/);

    await new Promise((resolve) => server.close(resolve));
    EOF
    node "$workdir/test.mjs" "$workdir/out"

    grep -F 'selectFetchBackend(agentSHAPI(), agentSHStartup)' ${self}/fetch/index.ts >/dev/null
    grep -F '"''${extDir}/fetch".source = "''${self}/fetch";' ${self}/nix/module.nix >/dev/null
    touch "$out"
  ''
