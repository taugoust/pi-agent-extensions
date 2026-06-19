{ self, pkgs, pi-mcp-adapter ? null }:
let
  package = import ./package.nix { inherit self pkgs pi-mcp-adapter; };
in
{
  package = package;

  slow-mode = pkgs.runCommand "slow-mode-check" {
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.typescript
    ];
  } ''
    set -euo pipefail

    workdir="$TMPDIR/slow-mode-check"
    srcdir="$workdir/src"
    outdir="$workdir/out"
    mkdir -p "$srcdir" "$outdir"

    cp -r ${self}/slow-mode "$srcdir/"

    mkdir -p "$outdir/node_modules/@mariozechner/pi-tui"
    cat > "$outdir/node_modules/@mariozechner/pi-tui/package.json" <<'EOF'
    {
      "name": "@mariozechner/pi-tui",
      "type": "module",
      "main": "./index.js"
    }
    EOF

    cat > "$outdir/node_modules/@mariozechner/pi-tui/index.js" <<'EOF'
    export function truncateToWidth(text) {
      return String(text);
    }

    export const Key = {
      enter: "<enter>",
      escape: "<escape>",
      up: "<up>",
      down: "<down>",
      pageUp: "<page-up>",
      pageDown: "<page-down>",
      ctrl: (key) => `<ctrl-''${key}>`,
    };

    export function matchesKey(data, key) {
      return data === key;
    }
    EOF

    tsc \
      --noCheck \
      --skipLibCheck \
      --module nodenext \
      --moduleResolution nodenext \
      --target es2022 \
      --rootDir "$srcdir" \
      --outDir "$outdir" \
      "$srcdir/slow-mode/index.ts"

    cat > "$workdir/test.mjs" <<'EOF'
    import fs from "node:fs";
    import os from "node:os";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    function assert(condition, message) {
      if (!condition) {
        throw new Error(message);
      }
    }

    function createPi() {
      const handlers = new Map();
      const commands = new Map();

      return {
        handlers,
        commands,
        registerCommand(name, definition) {
          commands.set(name, definition);
        },
        on(event, handler) {
          const list = handlers.get(event) ?? [];
          list.push(handler);
          handlers.set(event, list);
        },
        events: {
          emit() {},
        },
      };
    }

    function createCustomUI(actionBatches) {
      let calls = 0;

      return {
        get calls() {
          return calls;
        },
        async custom(factory) {
          const actions = actionBatches[calls] ?? ["<enter>"];
          calls += 1;

          let resolveResult;
          const result = new Promise((resolve) => {
            resolveResult = resolve;
          });

          const component = factory(
            {
              terminal: { rows: 40 },
              requestRender() {},
            },
            {
              fg: (_color, text) => text,
            },
            {},
            (value) => resolveResult(value),
          );

          for (const action of actions) {
            component.handleInput(action);
          }

          return await result;
        },
      };
    }

    function createContext(cwd, customUI) {
      return {
        cwd,
        hasUI: true,
        ui: {
          theme: {
            fg: (_color, text) => text,
          },
          setStatus() {},
          notify() {},
          custom: customUI.custom.bind(customUI),
        },
      };
    }

    async function enableSlowMode(pi, ctx) {
      const command = pi.commands.get("slow-mode");
      assert(command, "slow-mode command was not registered");
      await command.handler("", ctx);
    }

    function getToolCallHandler(pi) {
      const handlers = pi.handlers.get("tool_call") ?? [];
      assert(handlers.length === 1, `expected exactly one tool_call handler, got ''${handlers.length}`);
      return handlers[0];
    }

    async function main() {
      const compiledRoot = process.argv[2];
      const moduleUrl = pathToFileURL(path.join(compiledRoot, "slow-mode/index.js")).href;
      const importedModule = await import(moduleUrl);
      const slowMode = importedModule.default?.default ?? importedModule.default ?? importedModule;
      assert(typeof slowMode === "function", "slow-mode module did not export a function");

      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "slow-mode-check-"));
      const editorLog = path.join(tempRoot, "editor.log");
      const editorScript = path.join(tempRoot, "editor.sh");

      fs.writeFileSync(
        editorScript,
        [
          "#!/bin/sh",
          "printf '%s\\n' \"$1\" >> \"$EDITOR_LOG\"",
          "if [ -n \"$EDITOR_REPLACEMENT\" ]; then",
          "  printf '%s' \"$EDITOR_REPLACEMENT\" > \"$1\"",
          "fi",
        ].join("\n"),
        { mode: 0o755 },
      );

      process.env.EDITOR = editorScript;
      process.env.EDITOR_LOG = editorLog;

      // Test: write review stages outside-cwd writes inside the tmp staging dir.
      {
        const pi = createPi();
        slowMode(pi);

        const cwd = path.join(tempRoot, "write-cwd");
        fs.mkdirSync(cwd, { recursive: true });

        const customUI = createCustomUI([["<ctrl-o>", "<enter>"]]);
        const ctx = createContext(cwd, customUI);
        await enableSlowMode(pi, ctx);

        const targetPath = path.join(tempRoot, "outside", "result.txt");
        process.env.EDITOR_REPLACEMENT = "edited from review\n";
        fs.writeFileSync(editorLog, "");

        const event = {
          toolName: "write",
          toolCallId: "write-1",
          input: {
            path: targetPath,
            content: "original\n",
          },
        };

        const result = await getToolCallHandler(pi)(event, ctx);
        assert(result === undefined, "write review should approve when Enter is pressed");
        assert(event.input.content === "edited from review\n", "write review did not use edited staged content");
        assert(!fs.existsSync(targetPath), "write review touched the real target path before approval");

        const loggedPaths = fs.readFileSync(editorLog, "utf-8").trim().split("\n").filter(Boolean);
        assert(loggedPaths.length === 1, `expected one staged write path, got ''${loggedPaths.length}`);
        assert(loggedPaths[0].includes(`''${path.sep}pi-slow-mode-`), "write review did not use the slow-mode temp dir");
        assert(loggedPaths[0] !== targetPath, "write review opened the real target path instead of a staged file");
      }

      // Test: edit review handles modern edits[] input and rewrites edited reviews.
      {
        const pi = createPi();
        slowMode(pi);

        const cwd = path.join(tempRoot, "edit-cwd");
        fs.mkdirSync(cwd, { recursive: true });

        const targetPath = path.join(cwd, "demo.txt");
        fs.writeFileSync(targetPath, "alpha\nbeta\n");

        const customUI = createCustomUI([["<ctrl-e>"], ["<enter>"]]);
        const ctx = createContext(cwd, customUI);
        await enableSlowMode(pi, ctx);

        process.env.EDITOR_REPLACEMENT = "alpha\ngamma\n";
        fs.writeFileSync(editorLog, "");

        const event = {
          toolName: "edit",
          toolCallId: "edit-1",
          input: {
            path: targetPath,
            edits: [
              {
                oldText: "beta",
                newText: "delta",
              },
            ],
          },
        };

        const result = await getToolCallHandler(pi)(event, ctx);
        assert(result === undefined, "edit review should approve when Enter is pressed");
        assert(customUI.calls === 2, `expected two edit review passes, got ''${customUI.calls}`);
        assert(Array.isArray(event.input.edits), "edit review lost edits[] after approval");
        assert(event.input.edits.length === 1, `expected a single rewritten edit, got ''${event.input.edits.length}`);
        assert(event.input.edits[0].oldText === "alpha\nbeta\n", "edit review did not preserve the full original content");
        assert(event.input.edits[0].newText === "alpha\ngamma\n", "edit review did not use the externally edited content");
        assert(!("oldText" in event.input), "legacy oldText should be removed after rewriting edits[]");
        assert(!("newText" in event.input), "legacy newText should be removed after rewriting edits[]");

        const loggedPaths = fs.readFileSync(editorLog, "utf-8").trim().split("\n").filter(Boolean);
        assert(loggedPaths.length === 1, `expected one staged edit path, got ''${loggedPaths.length}`);
        assert(loggedPaths[0].includes(`''${path.sep}pi-slow-mode-`), "edit review did not edit a staged temp file");
        assert(loggedPaths[0] !== targetPath, "edit review opened the real file instead of the staged new file");
      }
    }

    await main();
    EOF

    node "$workdir/test.mjs" "$outdir"

    mkdir -p "$out"
    touch "$out/passed"
  '';

  fence = pkgs.runCommand "fence-check" {
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.typescript
    ];
  } ''
    set -euo pipefail

    workdir="$TMPDIR/fence-check"
    srcdir="$workdir/src"
    outdir="$workdir/out"
    mkdir -p "$srcdir" "$outdir"

    cp -r ${self}/fence "$srcdir/"

    tsc \
      --noCheck \
      --skipLibCheck \
      --module nodenext \
      --moduleResolution nodenext \
      --target es2022 \
      --rootDir "$srcdir" \
      --outDir "$outdir" \
      "$srcdir/fence/index.ts"

    cat > "$workdir/test.mjs" <<'EOF'
    import fs from "node:fs";
    import os from "node:os";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    function assert(condition, message) {
      if (!condition) {
        throw new Error(message);
      }
    }

    function createPi() {
      const handlers = new Map();
      const commands = new Map();

      return {
        handlers,
        commands,
        registerCommand(name, definition) {
          commands.set(name, definition);
        },
        on(event, handler) {
          const list = handlers.get(event) ?? [];
          list.push(handler);
          handlers.set(event, list);
        },
        events: {
          emit() {},
        },
      };
    }

    function createContext(cwd, hasUI = false, selectChoice = "No") {
      return {
        cwd,
        hasUI,
        ui: {
          theme: {
            fg: (_color, text) => text,
          },
          setStatus() {},
          notify() {},
          async select() {
            return selectChoice;
          },
        },
      };
    }

    async function enableFence(pi, ctx) {
      const command = pi.commands.get("fence");
      assert(command, "fence command was not registered");
      await command.handler("", ctx);
    }

    function getToolCallHandler(pi) {
      const handlers = pi.handlers.get("tool_call") ?? [];
      assert(handlers.length === 1, "expected exactly one tool_call handler, got " + handlers.length);
      return handlers[0];
    }

    async function main() {
      const compiledRoot = process.argv[2];
      const moduleUrl = pathToFileURL(path.join(compiledRoot, "fence/index.js")).href;
      const importedModule = await import(moduleUrl);
      const fence = importedModule.default?.default ?? importedModule.default ?? importedModule;
      assert(typeof fence === "function", "fence module did not export a function");

      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fence-check-"));

      // Test: a symlinked directory inside cwd must not bypass the fence.
      {
        const pi = createPi();
        fence(pi);

        const projectDir = path.join(tempRoot, "project-symlink-dir");
        const outsideDir = path.join(tempRoot, "outside-dir");
        fs.mkdirSync(projectDir, { recursive: true });
        fs.mkdirSync(outsideDir, { recursive: true });
        fs.symlinkSync(outsideDir, path.join(projectDir, "escape"));

        const ctx = createContext(projectDir, false);
        await enableFence(pi, ctx);

        const event = {
          toolName: "write",
          toolCallId: "write-1",
          input: {
            path: "escape/new.txt",
            content: "hello\n",
          },
        };

        const result = await getToolCallHandler(pi)(event, ctx);
        assert(result && result.block === true, "fence did not block a write through a symlinked directory");
        assert(String(result.reason).includes(path.join(outsideDir, "new.txt")), "fence reason did not mention the resolved outside path");
      }

      // Test: a symlinked cwd still allows writes that stay inside the real cwd.
      {
        const pi = createPi();
        fence(pi);

        const realProjectDir = path.join(tempRoot, "real-project");
        const cwdLink = path.join(tempRoot, "cwd-link");
        fs.mkdirSync(realProjectDir, { recursive: true });
        fs.symlinkSync(realProjectDir, cwdLink);

        const ctx = createContext(cwdLink, false);
        await enableFence(pi, ctx);

        const event = {
          toolName: "write",
          toolCallId: "write-2",
          input: {
            path: "nested/file.txt",
            content: "hello\n",
          },
        };

        const result = await getToolCallHandler(pi)(event, ctx);
        assert(result === undefined, "fence incorrectly blocked a path inside a symlinked cwd");
      }

      // Test: an existing symlinked file inside cwd must not bypass the fence.
      {
        const pi = createPi();
        fence(pi);

        const projectDir = path.join(tempRoot, "project-symlink-file");
        const outsideDir = path.join(tempRoot, "outside-file");
        fs.mkdirSync(projectDir, { recursive: true });
        fs.mkdirSync(outsideDir, { recursive: true });

        const outsideFile = path.join(outsideDir, "target.txt");
        fs.writeFileSync(outsideFile, "alpha\n");
        fs.symlinkSync(outsideFile, path.join(projectDir, "alias.txt"));

        const ctx = createContext(projectDir, false);
        await enableFence(pi, ctx);

        const event = {
          toolName: "edit",
          toolCallId: "edit-1",
          input: {
            path: "alias.txt",
            edits: [
              {
                oldText: "alpha",
                newText: "beta",
              },
            ],
          },
        };

        const result = await getToolCallHandler(pi)(event, ctx);
        assert(result && result.block === true, "fence did not block an edit through a symlinked file");
        assert(String(result.reason).includes(outsideFile), "fence reason did not mention the resolved symlink target");
      }
    }

    await main();
    EOF

    node "$workdir/test.mjs" "$outdir"

    mkdir -p "$out"
    touch "$out/passed"
  '';

  sandbox = pkgs.runCommand "sandbox-check" {
    nativeBuildInputs = [
      pkgs.nodejs
      pkgs.typescript
    ];
  } ''
    set -euo pipefail

    workdir="$TMPDIR/sandbox-check"
    srcdir="$workdir/src"
    outdir="$workdir/out"
    mkdir -p "$srcdir" "$outdir"

    cp -r ${self}/sandbox "$srcdir/"

    mkdir -p "$outdir/node_modules/@sinclair/typebox"
    cat > "$outdir/node_modules/@sinclair/typebox/package.json" <<'EOF'
    {
      "name": "@sinclair/typebox",
      "type": "module",
      "main": "./index.js"
    }
    EOF

    cat > "$outdir/node_modules/@sinclair/typebox/index.js" <<'EOF'
    export const Type = {
      String(options = {}) {
        return { type: "string", ...options };
      },
      Object(properties) {
        return { type: "object", properties };
      },
    };
    EOF

    mkdir -p "$outdir/node_modules/@mariozechner/pi-coding-agent"
    cat > "$outdir/node_modules/@mariozechner/pi-coding-agent/package.json" <<'EOF'
    {
      "name": "@mariozechner/pi-coding-agent",
      "type": "module",
      "main": "./index.js"
    }
    EOF
    echo 'export {};' > "$outdir/node_modules/@mariozechner/pi-coding-agent/index.js"

    tsc \
      --noCheck \
      --skipLibCheck \
      --module nodenext \
      --moduleResolution nodenext \
      --target es2022 \
      --rootDir "$srcdir" \
      --outDir "$outdir" \
      "$srcdir/sandbox/index.ts"

    cat > "$workdir/test.mjs" <<'EOF'
    import fs from "node:fs";
    import net from "node:net";
    import os from "node:os";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    function assert(condition, message) {
      if (!condition) throw new Error(message);
    }

    async function waitFor(predicate, message, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(message);
    }

    function createPi() {
      const handlers = new Map();
      const commands = new Map();
      const tools = new Map();
      return {
        handlers,
        commands,
        tools,
        registerCommand(name, definition) {
          commands.set(name, definition);
        },
        registerTool(definition) {
          tools.set(definition.name, definition);
        },
        on(event, handler) {
          const list = handlers.get(event) ?? [];
          list.push(handler);
          handlers.set(event, list);
        },
      };
    }

    function createContext({ choices = [], hasUI = true } = {}) {
      const statuses = [];
      const notifications = [];
      const selectCalls = [];
      let choiceIndex = 0;
      return {
        cwd: process.cwd(),
        hasUI,
        statuses,
        notifications,
        selectCalls,
        ui: {
          theme: {
            fg: (_color, text) => text,
          },
          setStatus(name, value) {
            statuses.push({ name, value });
          },
          notify(message, level) {
            notifications.push({ message, level });
          },
          async select(title, items, options = {}) {
            selectCalls.push({ title, items, options });
            const choice = choices[choiceIndex++] ?? items[0];
            if (choice === "__wait_for_abort__") {
              return await new Promise((resolve) => {
                if (options.signal?.aborted) {
                  resolve(undefined);
                  return;
                }
                options.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
              });
            }
            return choice;
          },
        },
      };
    }

    async function startSession(pi, ctx) {
      const handlers = pi.handlers.get("session_start") ?? [];
      for (const handler of handlers) {
        await handler({ type: "session_start", reason: "startup" }, ctx);
      }
    }

    async function shutdownSession(pi) {
      const handlers = pi.handlers.get("session_shutdown") ?? [];
      for (const handler of handlers) {
        await handler({ type: "session_shutdown" }, {});
      }
    }

    async function withApprovalServer(handler) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentsh-approval-ui-"));
      const socketPath = path.join(dir, "approval.sock");
      const requests = [];
      const server = net.createServer((socket) => {
        let buffer = "";
        socket.setEncoding("utf8");
        socket.on("data", async (chunk) => {
          buffer += chunk;
          let nl;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            const request = JSON.parse(line);
            requests.push(request);
            try {
              const response = await handler(request, requests);
              socket.write(JSON.stringify(response) + "\n");
            } catch (error) {
              socket.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + "\n");
            }
          }
        });
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
      return {
        socketPath,
        requests,
        async close() {
          await new Promise((resolve) => server.close(resolve));
        },
      };
    }

    function setAgentSHEnv(socketPath = "") {
      process.env.AGENTSH_SESSION_ID = socketPath ? "sess-test" : "";
      process.env.AGENTSH_APPROVAL_UI_SOCKET = socketPath;
    }

    function clearAgentSHEnv() {
      delete process.env.AGENTSH_SESSION_ID;
      delete process.env.PI_AUTO_SESSION_ID;
      delete process.env.AGENTSH_APPROVAL_UI_SOCKET;
      delete process.env.AGENTSH_API_KEY;
      delete process.env.AGENTSH_APPROVER_API_KEY;
      delete process.env.AGENTSH_ADMIN_TOKEN;
      delete process.env.AUTHORIZATION;
    }

    function assertNoBearerCredentialFields(requests) {
      for (const request of requests) {
        for (const key of Object.keys(request)) {
          assert(!/api[_-]?key|token|bearer|authorization/i.test(key), "approval UI request leaked credential-like field: " + key);
        }
      }
    }

    async function main() {
      process.env.AGENTSH_APPROVAL_POLL_MS = "60000";
      process.env.AGENTSH_APPROVAL_PROMPT_WATCH_MS = "10";

      const compiledRoot = process.argv[2];
      const moduleUrl = pathToFileURL(path.join(compiledRoot, "sandbox/index.js")).href;
      const importedModule = await import(moduleUrl);
      const sandbox = importedModule.default?.default ?? importedModule.default ?? importedModule;
      assert(typeof sandbox === "function", "sandbox module did not export a function");

      // Missing AgentSH env leaves the relay inactive and does not need credentials.
      {
        clearAgentSHEnv();
        process.env.AGENTSH_API_KEY = "must-not-matter";
        process.env.AGENTSH_APPROVER_API_KEY = "must-not-matter";
        const pi = createPi();
        sandbox(pi);
        const ctx = createContext();
        await startSession(pi, ctx);

        assert(ctx.statuses.some((entry) => entry.name === "sandbox" && entry.value === "agentsh inactive"), "missing env did not mark relay inactive");
        assert(ctx.notifications.some((entry) => String(entry.message).includes("approval relay inactive")), "missing env did not notify inactive relay");
        assert(ctx.selectCalls.length === 0, "inactive relay should not prompt");
        await shutdownSession(pi);
      }

      // List polling, approve resolve, and no bearer/API credential relay.
      {
        clearAgentSHEnv();
        process.env.AGENTSH_API_KEY = "server-api-key-should-not-be-sent";
        process.env.AGENTSH_APPROVER_API_KEY = "approver-key-should-not-be-sent";
        let approvals = [{ id: "appr-1", kind: "network", target: "example.com:443", rule: "unknown_https" }];
        let resolved;
        const server = await withApprovalServer(async (request) => {
          if (request.op === "list") return { ok: true, approvals };
          if (request.op === "resolve") {
            resolved = request;
            approvals = [];
            return { ok: true };
          }
          return { ok: false, error: "unknown op" };
        });
        setAgentSHEnv(server.socketPath);
        const pi = createPi();
        sandbox(pi);
        const ctx = createContext();
        await startSession(pi, ctx);
        await waitFor(() => Boolean(resolved), "approval was not resolved");

        assert(server.requests.some((request) => request.op === "list"), "approval list was not polled");
        assert(resolved.op === "resolve", "approval resolve op was not sent");
        assert(resolved.id === "appr-1", "resolved wrong approval id");
        assert(resolved.decision === "approve", "approval was not approved");
        assertNoBearerCredentialFields(server.requests);
        await shutdownSession(pi);
        await server.close();
      }

      // Deny resolve path.
      {
        clearAgentSHEnv();
        let approvals = [{ id: "appr-deny", kind: "file", target: "/private/key" }];
        let resolved;
        const server = await withApprovalServer(async (request) => {
          if (request.op === "list") return { ok: true, approvals };
          if (request.op === "resolve") {
            resolved = request;
            approvals = [];
            return { ok: true };
          }
          return { ok: false, error: "unknown op" };
        });
        setAgentSHEnv(server.socketPath);
        const pi = createPi();
        sandbox(pi);
        const ctx = createContext({ choices: ["Deny file: /private/key"] });
        await startSession(pi, ctx);
        await waitFor(() => Boolean(resolved), "deny approval was not resolved");

        assert(resolved.id === "appr-deny", "denied wrong approval id");
        assert(resolved.decision === "deny", "approval was not denied");
        await shutdownSession(pi);
        await server.close();
      }

      // A stale approval-not-found response is treated as externally resolved, not as task failure.
      {
        clearAgentSHEnv();
        const server = await withApprovalServer(async (request) => {
          if (request.op === "list") return { ok: true, approvals: [{ id: "stale-1", kind: "network", target: "stale.example:443" }] };
          if (request.op === "resolve") return { ok: false, error: "approval not found for session" };
          return { ok: false, error: "unknown op" };
        });
        setAgentSHEnv(server.socketPath);
        const pi = createPi();
        sandbox(pi);
        const ctx = createContext();
        await startSession(pi, ctx);
        await waitFor(
          () => ctx.notifications.some((entry) => String(entry.message).includes("already handled externally")),
          "stale approval was not treated as externally resolved",
        );

        assert(!ctx.notifications.some((entry) => String(entry.message).includes("approval relay failed")), "stale approval surfaced as relay failure");
        await shutdownSession(pi);
        await server.close();
      }

      // Active prompt aborts when the approval disappears from AgentSH state.
      {
        clearAgentSHEnv();
        let listCount = 0;
        const server = await withApprovalServer(async (request) => {
          if (request.op === "list") {
            listCount += 1;
            return { ok: true, approvals: listCount === 1 ? [{ id: "gone-1", kind: "network", target: "gone.example:443" }] : [] };
          }
          if (request.op === "resolve") return { ok: false, error: "resolve should not be called for externally handled approval" };
          return { ok: false, error: "unknown op" };
        });
        setAgentSHEnv(server.socketPath);
        const pi = createPi();
        sandbox(pi);
        const ctx = createContext({ choices: ["__wait_for_abort__"] });
        await startSession(pi, ctx);
        await waitFor(
          () => ctx.notifications.some((entry) => String(entry.message).includes("already handled externally")),
          "disappearing approval did not abort active prompt",
        );

        assert(ctx.selectCalls.length === 1, "disappearing approval did not open exactly one prompt");
        assert(ctx.selectCalls[0].options.signal instanceof AbortSignal, "approval prompt was not given an AbortSignal");
        assert(!server.requests.some((request) => request.op === "resolve"), "externally handled approval should not be resolved by Pi");
        await shutdownSession(pi);
        await server.close();
      }

      // Guidance tools only explain AgentSH-owned grants and do not mutate local Pi policy or call the socket.
      {
        clearAgentSHEnv();
        const server = await withApprovalServer(async () => ({ ok: true, approvals: [] }));
        setAgentSHEnv(server.socketPath);
        const pi = createPi();
        sandbox(pi);
        const ctx = createContext();
        await startSession(pi, ctx);
        const requestCountAfterStartup = server.requests.length;

        const toolInputs = new Map([
          ["sandbox_allow_path", { path: "/tmp/out.txt", reason: "write test" }],
          ["sandbox_allow_read_path", { path: "/tmp/in.txt", reason: "read test" }],
          ["sandbox_allow_domain", { domain: "example.org", reason: "network test" }],
          ["sandbox_allow_unix_socket", { path: "/tmp/sock", reason: "socket test" }],
        ]);
        for (const [name, params] of toolInputs) {
          const tool = pi.tools.get(name);
          assert(tool, "missing registered guidance tool: " + name);
          const result = await tool.execute("tool-call", params);
          const text = result.content?.[0]?.text ?? "";
          assert(text.includes("AgentSH owns"), name + " did not explain AgentSH-owned enforcement");
          assert(text.includes("does not mutate local sandbox policy"), name + " did not say local policy is untouched");
          assert(text.includes("Retry the blocked operation"), name + " did not guide retry flow");
        }

        assert(server.requests.length === requestCountAfterStartup, "guidance tools unexpectedly called approval socket");
        assert(!fs.existsSync(path.join(process.cwd(), ".pi", "sandbox.json")), "guidance tools unexpectedly wrote .pi/sandbox.json");
        await shutdownSession(pi);
        await server.close();
      }
    }

    await main();
    EOF

    node "$workdir/test.mjs" "$outdir"

    mkdir -p "$out"
    touch "$out/passed"
  '';
}
