{ self, pkgs }:

pkgs.runCommand "auto-extension-check" {
  nativeBuildInputs = [
    pkgs.nodejs
    pkgs.typescript
  ];
} ''
  set -euo pipefail
  workdir="$TMPDIR/auto-extension-check"
  srcdir="$workdir/src"
  outdir="$workdir/out"
  mkdir -p "$srcdir/auto" "$srcdir/sandbox" "$outdir/node_modules/@mariozechner/pi-coding-agent"
  cp ${self}/auto/index.ts "$srcdir/auto/index.ts"
  cp ${self}/auto/request.ts "$srcdir/auto/request.ts"
  cp ${self}/sandbox/api.ts "$srcdir/sandbox/api.ts"
  cat > "$outdir/node_modules/@mariozechner/pi-coding-agent/package.json" <<'EOF'
  { "name": "@mariozechner/pi-coding-agent", "type": "module", "main": "./index.js" }
  EOF
  cat > "$outdir/node_modules/@mariozechner/pi-coding-agent/index.js" <<'EOF'
  export {};
  EOF
  tsc --noCheck --skipLibCheck --module nodenext --moduleResolution nodenext --target es2022 \
    --rootDir "$srcdir" --outDir "$outdir" \
    "$srcdir/auto/index.ts" "$srcdir/auto/request.ts" "$srcdir/sandbox/api.ts"
  cat > "$workdir/test.mjs" <<'EOF'
  import fs from "node:fs";
  import os from "node:os";
  import path from "node:path";
  import { pathToFileURL } from "node:url";
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const imported = await import(pathToFileURL(path.join(process.argv[2], "auto/index.js")).href);
  const extension = imported.default?.default ?? imported.default ?? imported;
  const sessionId = "session-11111111-1111-4111-8111-111111111111";

  function createPi() {
    const handlers = new Map(); const commands = new Map(); const tools = new Map();
    return {
      handlers, commands, tools,
      registerCommand(name, value) { commands.set(name, value); },
      registerTool(value) { tools.set(value.name, value); },
      on(name, handler) { const list = handlers.get(name) || []; list.push(handler); handlers.set(name, list); },
    };
  }
  function context(selection, confirmation = true) {
    const statuses = new Map(); const notices = []; const calls = [];
    let shutdown = false;
    return {
      mode: "tui", hasUI: true, statuses, notices, calls,
      get shutdownCalled() { return shutdown; },
      ui: {
        theme: { fg: (_color, text) => text },
        setStatus(key, value) { statuses.set(key, value); },
        notify(message, level) { notices.push({ message, level }); },
        async select() { calls.push("select"); return selection; },
        async confirm() { calls.push("confirm"); return confirmation; },
      },
      async waitForIdle() { calls.push("wait"); },
      isIdle() { return true; }, hasPendingMessages() { return false; },
      shutdown() { calls.push("shutdown"); shutdown = true; },
    };
  }
  async function event(pi, name, ctx) { for (const handler of pi.handlers.get(name) || []) await handler({}, ctx); }

  delete process.env.PI_AUTO;
  const inactive = createPi(); extension(inactive);
  assert(inactive.commands.size === 0 && inactive.tools.size === 0, "auto registered outside pi-auto");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-auto-extension-"));
  fs.chmodSync(root, 0o700);
  const request = path.join(root, "request.json");
  process.env.PI_AUTO = "1";
  process.env.PI_AGENTSH_WORKSPACE_MODE = "shadow";
  process.env.AGENTSH_SESSION_ID = sessionId;
  process.env.PI_AUTO_ACTION_REQUEST = request;
  globalThis.__AGENTSH_PI__ = {
    getSupervisorState() { return { configured: true, active: true, status: "connected", source: "agentsh-env", socketPath: "/tmp/s", sessionId, metadata: { session_id: sessionId, workspace_mode: "shadow", real_workspace: "/project" } }; },
    getSupervisorMetadata() { return { session_id: sessionId, workspace_mode: "shadow", real_workspace: "/project" }; },
  };

  const choices = [
    ["Review", "review"], ["Apply and exit", "apply"], ["Discard and exit", "discard"], ["Pause and exit", "pause"],
  ];
  for (const [selection, action] of choices) {
    fs.rmSync(request, { force: true });
    const pi = createPi(); extension(pi);
    assert(pi.commands.size === 1 && pi.tools.size === 0, "auto must register one command and no tools");
    const ctx = context(selection);
    await event(pi, "session_start", ctx);
    assert(String(ctx.statuses.get("auto")).includes("Draft ready"), "auto status missing");
    await pi.commands.get("auto").handler("", ctx);
    assert(ctx.shutdownCalled, `''${action} did not request shutdown`);
    const body = JSON.parse(fs.readFileSync(request, "utf8"));
    assert(body.schema_version === 1 && body.session_id === sessionId && body.action === action, `invalid ''${action} request`);
    assert((fs.statSync(request).mode & 0o777) === 0o600, "request mode is not 0600");
    assert(ctx.calls.at(-1) === "shutdown" && ctx.calls.filter((x) => x === "wait").length === 2, "request was not quiesced before shutdown");
    await event(pi, "session_shutdown", ctx);
    assert(ctx.statuses.get("auto") === undefined, "auto status was not cleared");
  }

  fs.rmSync(request, { force: true });
  const cancelledPi = createPi(); extension(cancelledPi); const cancelledCtx = context(undefined);
  await cancelledPi.commands.get("auto").handler("", cancelledCtx);
  assert(!fs.existsSync(request) && !cancelledCtx.shutdownCalled, "cancelled selection committed an action");

  const deniedPi = createPi(); extension(deniedPi); const deniedCtx = context("Discard and exit", false);
  await deniedPi.commands.get("auto").handler("", deniedCtx);
  assert(!fs.existsSync(request) && !deniedCtx.shutdownCalled, "denied confirmation committed an action");

  fs.chmodSync(root, 0o755);
  const unsafePi = createPi(); extension(unsafePi); const unsafeCtx = context("Pause and exit");
  await unsafePi.commands.get("auto").handler("", unsafeCtx);
  assert(!unsafeCtx.shutdownCalled && unsafeCtx.notices.some((n) => n.level === "error"), "unsafe request directory was accepted");
  fs.chmodSync(root, 0o700);

  process.env.AGENTSH_SUBAGENT_ID = "subagent-test";
  const childPi = createPi(); extension(childPi); const childCtx = context("Pause and exit");
  await childPi.commands.get("auto").handler("", childCtx);
  assert(!childCtx.shutdownCalled && !fs.existsSync(request), "subagent committed a Draft action");
  delete process.env.AGENTSH_SUBAGENT_ID;
  console.log("auto extension checks passed");
  EOF
  node "$workdir/test.mjs" "$outdir"
  touch "$out"
''
