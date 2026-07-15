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
      Number(options = {}) {
        return { type: "number", ...options };
      },
      Array(items, options = {}) {
        return { type: "array", items, ...options };
      },
      Object(properties) {
        return { type: "object", properties };
      },
      Optional(schema) {
        return { ...schema, optional: true };
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
    cat > "$outdir/node_modules/@mariozechner/pi-coding-agent/index.js" <<'EOF'
    export const DEFAULT_MAX_BYTES = 50 * 1024;
    export const DEFAULT_MAX_LINES = 2000;
    export function formatSize(bytes) { return String(bytes) + "B"; }
    export function getMarkdownTheme() { return {}; }
    export function truncateHead(value, options = {}) {
      const text = String(value);
      const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
      const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
      const lines = text.split("\n");
      const totalBytes = Buffer.byteLength(text);
      if (lines.length <= maxLines && totalBytes <= maxBytes) {
        return { content: text, truncated: false, truncatedBy: null, totalLines: lines.length, totalBytes, outputLines: lines.length, outputBytes: totalBytes, maxLines, maxBytes, firstLineExceedsLimit: false };
      }
      if (Buffer.byteLength(lines[0]) > maxBytes) {
        return { content: "", truncated: true, truncatedBy: "bytes", totalLines: lines.length, totalBytes, outputLines: 0, outputBytes: 0, maxLines, maxBytes, firstLineExceedsLimit: true };
      }
      const selected = [];
      let selectedBytes = 0;
      for (let index = 0; index < lines.length && selected.length < maxLines; index++) {
        const lineBytes = Buffer.byteLength(lines[index]) + (selected.length ? 1 : 0);
        if (selectedBytes + lineBytes > maxBytes) break;
        selected.push(lines[index]);
        selectedBytes += lineBytes;
      }
      const content = selected.join("\n");
      return { content, truncated: true, truncatedBy: selected.length >= maxLines ? "lines" : "bytes", totalLines: lines.length, totalBytes, outputLines: selected.length, outputBytes: Buffer.byteLength(content), maxLines, maxBytes, firstLineExceedsLimit: false };
    }
    export function truncateTail(value, options = {}) {
      const text = String(value);
      const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
      const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
      const lines = text.split("\n");
      const totalBytes = Buffer.byteLength(text);
      if (lines.length <= maxLines && totalBytes <= maxBytes) {
        return { content: text, truncated: false, truncatedBy: null, totalLines: lines.length, totalBytes, outputLines: lines.length, outputBytes: totalBytes, maxLines, maxBytes, lastLinePartial: false };
      }
      const selected = [];
      let selectedBytes = 0;
      let lastLinePartial = false;
      let truncatedBy = lines.length > maxLines ? "lines" : "bytes";
      for (let index = lines.length - 1; index >= 0 && selected.length < maxLines; index--) {
        const line = lines[index];
        const lineBytes = Buffer.byteLength(line) + (selected.length ? 1 : 0);
        if (selectedBytes + lineBytes > maxBytes) {
          truncatedBy = "bytes";
          if (selected.length === 0) {
            const bytes = Buffer.from(line);
            selected.unshift(bytes.subarray(Math.max(0, bytes.length - maxBytes)).toString("utf8"));
            selectedBytes = Buffer.byteLength(selected[0]);
            lastLinePartial = true;
          }
          break;
        }
        selected.unshift(line);
        selectedBytes += lineBytes;
      }
      const content = selected.join("\n");
      return { content, truncated: true, truncatedBy, totalLines: lines.length, totalBytes, outputLines: selected.length, outputBytes: Buffer.byteLength(content), maxLines, maxBytes, lastLinePartial };
    }
    export function renderDiff(text) { return String(text); }
    EOF

    mkdir -p "$outdir/node_modules/@mariozechner/pi-tui"
    cat > "$outdir/node_modules/@mariozechner/pi-tui/package.json" <<'EOF'
    {
      "name": "@mariozechner/pi-tui",
      "type": "module",
      "main": "./index.js"
    }
    EOF
    cat > "$outdir/node_modules/@mariozechner/pi-tui/index.js" <<'EOF'
    export class Container {
      constructor() { this.children = []; }
      addChild(child) { this.children.push(child); }
      clear() { this.children = []; }
      render(width) { return this.children.flatMap((child) => child.render ? child.render(width) : []); }
    }
    export class Box extends Container {
      constructor(_x = 0, _y = 0, bgFn = (text) => text) { super(); this.bgFn = bgFn; }
      setBgFn(bgFn) { this.bgFn = bgFn; }
      render(width) { return super.render(width).map((line) => this.bgFn(line)); }
    }
    export class Spacer {
      constructor(lines = 1) { this.lines = lines; }
      render() { return Array(this.lines).fill(""); }
    }
    export class Text {
      constructor(text, x = 0, y = 0) {
        this.text = text;
        this.x = x;
        this.y = y;
      }
      render() {
        return String(this.text || "").split("\n");
      }
    }
    export class Markdown extends Text {}
    export const Key = { enter: "<enter>", escape: "<escape>", up: "<up>", down: "<down>", pageUp: "<page-up>", pageDown: "<page-down>" };
    export function matchesKey(data, key) { return data === key; }
    export function truncateToWidth(text) { return String(text); }
    EOF

    tsc \
      --noCheck \
      --skipLibCheck \
      --module nodenext \
      --moduleResolution nodenext \
      --target es2022 \
      --rootDir "$srcdir" \
      --outDir "$outdir" \
      "$srcdir/sandbox/index.ts" \
      "$srcdir/sandbox/subagent-model.test.ts" \
      "$srcdir/sandbox/subagent-protocol.test.ts" \
      "$srcdir/sandbox/subagent-result.test.ts" \
      "$srcdir/sandbox/subagent-stream.test.ts" \
      "$srcdir/sandbox/subagent-terminal.test.ts"

    node "$outdir/sandbox/subagent-model.test.js"
    node "$outdir/sandbox/subagent-protocol.test.js"
    node "$outdir/sandbox/subagent-result.test.js"
    node "$outdir/sandbox/subagent-stream.test.js"
    node "$outdir/sandbox/subagent-terminal.test.js"

    cat > "$workdir/test.mjs" <<'EOF'
    import fs from "node:fs";
    import http from "node:http";
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

    function createContext({ choices = [], hasUI = true, customActions, model } = {}) {
      const statuses = [];
      const notifications = [];
      const selectCalls = [];
      const customCalls = [];
      let choiceIndex = 0;
      const theme = {
        fg: (_color, text) => text,
        bg: (_color, text) => text,
        bold: (text) => text,
      };
      const ui = {
        theme,
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
      };
      if (customActions) {
        ui.custom = async (factory, options = {}) => {
          customCalls.push({ options });
          let resolveResult;
          const result = new Promise((resolve) => { resolveResult = resolve; });
          const component = factory({ terminal: { rows: 40 }, requestRender() {} }, theme, {}, (value) => resolveResult(value));
          // Render at two widths to catch stale-width cache regressions in the approval overlay.
          component.render?.(80);
          component.render?.(100);
          for (const action of customActions) component.handleInput?.(action);
          return await result;
        };
      }
      return {
        cwd: process.cwd(),
        hasUI,
        model,
        statuses,
        notifications,
        selectCalls,
        customCalls,
        ui,
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

    async function withRestSupervisor(handler) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentsh-rest-supervisor-"));
      const socketPath = path.join(dir, "supervisor.sock");
      const requests = [];
      const server = http.createServer(async (req, res) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        req.on("end", async () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let body;
          if (raw.trim()) body = JSON.parse(raw);
          const request = { method: req.method, url: req.url, body };
          requests.push(request);
          try {
            const response = await handler(request, requests);
            res.statusCode = response?.statusCode ?? 200;
            if (Array.isArray(response?.ndjsonChunks)) {
              res.setHeader("Content-Type", "application/x-ndjson");
              for (const chunk of response.ndjsonChunks) {
                res.write(chunk);
                await new Promise((resolve) => setImmediate(resolve));
              }
              if (response.keepOpenMs) await new Promise((resolve) => setTimeout(resolve, response.keepOpenMs));
              res.end();
              return;
            }
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(response?.body ?? response ?? {}));
          } catch (error) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
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

    async function withRestartableRestSupervisor(handler) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentsh-restartable-rest-"));
      const socketPath = path.join(dir, "supervisor.sock");
      const requests = [];
      let server;
      let generation = 0;

      async function start() {
        assert(!server, "restartable supervisor is already listening");
        fs.rmSync(socketPath, { force: true });
        generation += 1;
        const currentGeneration = generation;
        server = http.createServer((req, res) => {
          const chunks = [];
          req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          req.on("end", async () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let body;
            if (raw.trim()) body = JSON.parse(raw);
            const request = { method: req.method, url: req.url, body, generation: currentGeneration };
            requests.push(request);
            try {
              const response = await handler(request, requests);
              if (response?.destroySocket) {
                req.socket.destroy();
                return;
              }
              res.statusCode = response?.statusCode ?? 200;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(response?.body ?? response ?? {}));
            } catch (error) {
              if (req.socket.destroyed) return;
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
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
      }

      async function stop() {
        if (!server) return;
        const closing = server;
        server = undefined;
        await new Promise((resolve) => closing.close(resolve));
      }

      await start();
      return {
        socketPath,
        requests,
        get generation() { return generation; },
        start,
        stop,
        async close() {
          await stop();
          fs.rmSync(dir, { recursive: true, force: true });
        },
      };
    }

    async function withHttpServer(handler) {
      const requests = [];
      const server = http.createServer(async (req, res) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        req.on("end", async () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let body;
          if (raw.trim()) body = JSON.parse(raw);
          const request = { method: req.method, url: req.url, body };
          requests.push(request);
          const response = await handler(request, requests);
          res.statusCode = response?.statusCode ?? 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(response?.body ?? response ?? {}));
        });
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      return {
        url: "http://127.0.0.1:" + address.port,
        requests,
        async close() {
          await new Promise((resolve) => server.close(resolve));
        },
      };
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
      delete process.env.AGENTSH_SESSION_SUPERVISOR;
      delete process.env.AGENTSH_SESSION_EVENT_URL;
      delete process.env.AGENTSH_SESSION_EVENT_TOKEN;
      delete process.env.PI_AGENTSH_APPROVAL_CLIENT;
      delete process.env.PI_AGENTSH_REQUIRE_NETWORK_ENFORCEMENT;
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
      delete process.env.PI_AGENTSH_APPROVAL_POLL_MS;
      process.env.AGENTSH_APPROVAL_PROMPT_WATCH_MS = "10";
      process.env.PI_AGENTSH_RECONNECT_TIMEOUT_MS = "300";
      process.env.PI_AGENTSH_RECONNECT_INITIAL_MS = "10";
      process.env.PI_AGENTSH_WATCH_RECONNECT_MS = "25";
      // Keep deadline tests fast while preserving the production default
      // execution timeout loaded by the extension.
      process.env.PI_AGENTSH_SUBAGENT_TRANSPORT_SLACK_MS = "100";

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
        assert(resolved.scope === "once", "approval should default to once scope");
        assert(ctx.selectCalls[0].items.length === 2, "unscoped approval should only show once approve/deny choices");
        assert(!ctx.selectCalls[0].items.some((item) => item.includes("for session")), "unscoped approval unexpectedly showed session choices");
        assertNoBearerCredentialFields(server.requests);
        await shutdownSession(pi);
        await server.close();
      }

      // REST supervisor approvals resolve through the same supervisor socket even when a central event URL is present.
      {
        clearAgentSHEnv();
        let approvals = [{ id: "rest-appr", session_id: "sess-rest", kind: "file", target: "/workspace/.env" }];
        let resolved;
        const supervisor = await withRestSupervisor(async (request) => {
          if (request.method === "GET" && request.url === "/api/v1/sessions/sess-rest") return { id: "sess-rest", session_id: "sess-rest", workspace: "/workspace", worktree: "/workspace" };
          if (request.method === "GET" && request.url === "/api/v1/approvals") return approvals;
          if (request.method === "POST" && request.url === "/api/v1/approvals/rest-appr") {
            resolved = request;
            approvals = [];
            return {};
          }
          return { statusCode: 404, body: { error: "unexpected supervisor request", request } };
        });
        const central = await withHttpServer(async (request) => ({ statusCode: 500, body: { error: "central should not be used", request } }));
        process.env.AGENTSH_SESSION_ID = "sess-rest";
        process.env.AGENTSH_SESSION_SUPERVISOR = "unix://" + supervisor.socketPath;
        process.env.AGENTSH_SESSION_EVENT_URL = central.url;
        process.env.AGENTSH_SESSION_EVENT_TOKEN = "central-token";
        const pi = createPi();
        sandbox(pi);
        const ctx = createContext();
        await startSession(pi, ctx);
        await waitFor(() => Boolean(resolved), "REST supervisor approval was not resolved through supervisor socket");

        const editTool = pi.tools.get("edit");
        assert(editTool, "REST mode did not register AgentSH-backed edit tool");
        assert(typeof editTool.renderCall === "function", "AgentSH-backed edit tool must provide its own renderCall to avoid local preview reads");
        assert(typeof editTool.renderResult === "function", "AgentSH-backed edit tool must provide its own renderResult");
        const renderedCall = editTool.renderCall({ path: "hw/src/file.cpp", edits: [{ oldText: "a", newText: "b" }] }, ctx.ui.theme).render().join("\n");
        assert(renderedCall.includes("edit") && renderedCall.includes("hw/src/file.cpp"), "edit renderCall did not render path without built-in preview");
        const renderedResult = editTool.renderResult({ content: [{ type: "text", text: "Edited hw/src/file.cpp" }], details: { diff: "--- a\n+++ b\n@@\n-a\n+b" } }, {}, ctx.ui.theme).render().join("\n");
        assert(renderedResult.includes("Edited hw/src/file.cpp") && renderedResult.includes("@@"), "edit renderResult did not include result text and diff");

        assert(resolved.body.decision === "approve", "REST supervisor approval was not approved");
        assert(central.requests.length === 0, "central approval bridge was used without explicit opt-in");
        await shutdownSession(pi);
        await supervisor.close();
        await central.close();
      }

      // A missing watcher socket enters reconnecting, tools wait for the same
      // session at the same path, and a mutating request is dispatched once.
      {
        clearAgentSHEnv();
        process.env.PI_AGENTSH_APPROVAL_POLL_MS = "15";
        const expectedSession = "sess-reconnect";
        let returnedSession = expectedSession;
        let mutatingRequests = 0;
        const supervisor = await withRestartableRestSupervisor(async (request) => {
          if (request.method === "GET" && request.url === "/api/v1/sessions/" + expectedSession) {
            return { id: returnedSession, session_id: returnedSession, workspace: "/workspace", worktree: "/workspace" };
          }
          if (request.method === "GET" && request.url === "/api/v1/approvals") return [];
          if (request.method === "POST" && request.url === "/api/v1/sessions/" + expectedSession + "/tools/write_file") {
            mutatingRequests += 1;
            return { ok: true, result: { text: "reconnected write completed" } };
          }
          return { statusCode: 404, body: { error: "unexpected supervisor request", request } };
        });
        process.env.AGENTSH_SESSION_ID = expectedSession;
        process.env.AGENTSH_SESSION_SUPERVISOR = "unix://" + supervisor.socketPath;
        const pi = createPi();
        sandbox(pi);
        const ctx = createContext();
        await startSession(pi, ctx);
        const writeTool = pi.tools.get("write");
        assert(writeTool, "reconnect test did not register write tool");
        const initialConnectedIndex = ctx.statuses.findIndex((entry) => entry.name === "sandbox" && entry.value === "agentsh ✓");
        assert(initialConnectedIndex >= 0, "REST client never reached initial connected state");

        await supervisor.stop();
        assert(!fs.existsSync(supervisor.socketPath), "stopped supervisor left a socket path instead of producing ENOENT");
        await waitFor(
          () => ctx.statuses.some((entry, index) => index > initialConnectedIndex && entry.name === "sandbox" && entry.value === "agentsh …"),
          "approval watcher socket loss did not transition to connecting; state=" + JSON.stringify(globalThis.__AGENTSH_PI__.getSupervisorState()) + " statuses=" + JSON.stringify(ctx.statuses),
          1000,
        );
        const reconnectingIndex = ctx.statuses.findIndex((entry, index) => index > initialConnectedIndex && entry.name === "sandbox" && entry.value === "agentsh …");
        assert(reconnectingIndex > initialConnectedIndex, "status history did not record connected -> connecting");

        const restart = (async () => {
          await new Promise((resolve) => setTimeout(resolve, 70));
          await supervisor.start();
        })();
        const result = await writeTool.execute("reconnect-write", { path: "/workspace/reconnected.txt", content: "once\n" }, undefined, undefined, ctx);
        await restart;
        assert(result.content[0].text.includes("reconnected write completed"), "tool did not complete after delayed socket return");
        assert(mutatingRequests === 1, "mutating request was dispatched more than once: " + mutatingRequests);
        assert(globalThis.__AGENTSH_PI__.getSupervisorState().sessionId === expectedSession, "reconnect changed the attached session ID");
        assert(globalThis.__AGENTSH_PI__.getSupervisorState().status === "connected", "successful reconnect did not restore connected state");
        assert(supervisor.requests.some((request) => request.generation === 2 && request.method === "GET" && request.url === "/api/v1/sessions/" + expectedSession), "reconnect did not poll the exact original session");
        const recoveredIndex = ctx.statuses.findIndex((entry, index) => index > reconnectingIndex && entry.name === "sandbox" && entry.value === "agentsh ✓");
        assert(recoveredIndex > reconnectingIndex, "status history did not record connecting -> connected");

        delete process.env.PI_AGENTSH_APPROVAL_POLL_MS;
        await shutdownSession(pi);
        await supervisor.close();
      }

      // Cancelling during reconnect interrupts the caller's backoff and never
      // dispatches the abandoned mutation after the shared poll recovers.
      {
        clearAgentSHEnv();
        delete process.env.PI_AGENTSH_APPROVAL_POLL_MS;
        const expectedSession = "sess-reconnect-abort";
        let mutatingRequests = 0;
        const supervisor = await withRestartableRestSupervisor(async (request) => {
          if (request.method === "GET" && request.url === "/api/v1/sessions/" + expectedSession) return { id: expectedSession, session_id: expectedSession, workspace: "/workspace", worktree: "/workspace" };
          if (request.method === "GET" && request.url === "/api/v1/approvals") return [];
          if (request.method === "POST" && request.url.endsWith("/tools/write_file")) {
            mutatingRequests += 1;
            return { ok: true, result: { text: "must not run" } };
          }
          return { statusCode: 404, body: { error: "unexpected supervisor request", request } };
        });
        process.env.AGENTSH_SESSION_ID = expectedSession;
        process.env.AGENTSH_SESSION_SUPERVISOR = "unix://" + supervisor.socketPath;
        const pi = createPi();
        sandbox(pi);
        const ctx = createContext();
        await startSession(pi, ctx);
        await supervisor.stop();

        const controller = new AbortController();
        const startedAt = Date.now();
        const abortTimer = setTimeout(() => controller.abort(), 35);
        let abortError;
        try {
          await pi.tools.get("write").execute("aborted-reconnect", { path: "/workspace/aborted.txt", content: "no\n" }, controller.signal, undefined, ctx);
        } catch (error) {
          abortError = error;
        }
        clearTimeout(abortTimer);
        assert(abortError?.name === "AbortError", "reconnect cancellation did not preserve AbortError");
        assert(Date.now() - startedAt < 220, "reconnect cancellation did not interrupt backoff promptly");
        assert(mutatingRequests === 0, "aborted mutation reached the server");

        await supervisor.start();
        await waitFor(() => globalThis.__AGENTSH_PI__.getSupervisorState().status === "connected", "shared reconnect poll did not recover after caller abort");
        await new Promise((resolve) => setTimeout(resolve, 40));
        assert(mutatingRequests === 0, "aborted mutation was replayed after reconnect");
        await shutdownSession(pi);
        await supervisor.close();
      }

      // A missing listener has a deterministic bounded reconnect timeout and
      // does not dispatch the pending mutation.
      {
        clearAgentSHEnv();
        delete process.env.PI_AGENTSH_APPROVAL_POLL_MS;
        const expectedSession = "sess-reconnect-timeout";
        let mutatingRequests = 0;
        const supervisor = await withRestartableRestSupervisor(async (request) => {
          if (request.method === "GET" && request.url === "/api/v1/sessions/" + expectedSession) return { id: expectedSession, session_id: expectedSession, workspace: "/workspace", worktree: "/workspace" };
          if (request.method === "GET" && request.url === "/api/v1/approvals") return [];
          if (request.method === "POST" && request.url.endsWith("/tools/write_file")) mutatingRequests += 1;
          return { ok: true, result: { text: "unexpected" } };
        });
        process.env.AGENTSH_SESSION_ID = expectedSession;
        process.env.AGENTSH_SESSION_SUPERVISOR = "unix://" + supervisor.socketPath;
        const pi = createPi();
        sandbox(pi);
        const ctx = createContext();
        await startSession(pi, ctx);
        await supervisor.stop();

        const startedAt = Date.now();
        let timeoutError;
        try {
          await pi.tools.get("write").execute("timed-reconnect", { path: "/workspace/timeout.txt", content: "no\n" }, undefined, undefined, ctx);
        } catch (error) {
          timeoutError = error;
        }
        const elapsed = Date.now() - startedAt;
        assert(String(timeoutError).includes("Timed out waiting 300ms"), "reconnect timeout was not actionable: " + timeoutError);
        assert(elapsed >= 240 && elapsed < 1200, "reconnect timeout was not bounded near its configured deadline: " + elapsed + "ms");
        assert(mutatingRequests === 0, "timed-out mutation reached the server");
        await shutdownSession(pi);
        await supervisor.close();
      }

      // A 404 session loss is terminal and an ambiguous post-dispatch reset is
      // surfaced without replaying either request.
      {
        clearAgentSHEnv();
        delete process.env.PI_AGENTSH_APPROVAL_POLL_MS;
        const expectedSession = "sess-terminal-404";
        let mutatingRequests = 0;
        const supervisor = await withRestartableRestSupervisor(async (request) => {
          if (request.method === "GET" && request.url === "/api/v1/sessions/" + expectedSession) return { id: expectedSession, session_id: expectedSession, workspace: "/workspace", worktree: "/workspace" };
          if (request.method === "GET" && request.url === "/api/v1/approvals") return [];
          if (request.method === "POST" && request.url.endsWith("/tools/write_file")) {
            mutatingRequests += 1;
            return { statusCode: 404, body: { error: "session_not_found" } };
          }
          return { statusCode: 404, body: { error: "unexpected supervisor request", request } };
        });
        process.env.AGENTSH_SESSION_ID = expectedSession;
        process.env.AGENTSH_SESSION_SUPERVISOR = "unix://" + supervisor.socketPath;
        const pi = createPi();
        sandbox(pi);
        const ctx = createContext();
        await startSession(pi, ctx);
        let terminalError;
        try {
          await pi.tools.get("write").execute("terminal-404", { path: "/workspace/missing.txt", content: "once\n" }, undefined, undefined, ctx);
        } catch (error) {
          terminalError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 350));
        assert(String(terminalError).includes("was not found or changed"), "session 404 did not produce a terminal diagnostic: " + terminalError);
        assert(mutatingRequests === 1, "HTTP 404 mutation was retried: " + mutatingRequests);
        assert(globalThis.__AGENTSH_PI__.getSupervisorState().status === "error", "session 404 did not leave terminal error state");
        await shutdownSession(pi);
        await supervisor.close();
      }

      {
        clearAgentSHEnv();
        delete process.env.PI_AGENTSH_APPROVAL_POLL_MS;
        const expectedSession = "sess-ambiguous-reset";
        let mutatingRequests = 0;
        const supervisor = await withRestartableRestSupervisor(async (request) => {
          if (request.method === "GET" && request.url === "/api/v1/sessions/" + expectedSession) return { id: expectedSession, session_id: expectedSession, workspace: "/workspace", worktree: "/workspace" };
          if (request.method === "GET" && request.url === "/api/v1/approvals") return [];
          if (request.method === "POST" && request.url.endsWith("/tools/write_file")) {
            mutatingRequests += 1;
            return { destroySocket: true };
          }
          return { statusCode: 404, body: { error: "unexpected supervisor request", request } };
        });
        process.env.AGENTSH_SESSION_ID = expectedSession;
        process.env.AGENTSH_SESSION_SUPERVISOR = "unix://" + supervisor.socketPath;
        const pi = createPi();
        sandbox(pi);
        const ctx = createContext();
        await startSession(pi, ctx);
        let resetError;
        try {
          await pi.tools.get("write").execute("ambiguous-reset", { path: "/workspace/ambiguous.txt", content: "once\n" }, undefined, undefined, ctx);
        } catch (error) {
          resetError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 350));
        assert(resetError, "ambiguous post-dispatch reset unexpectedly succeeded");
        assert(mutatingRequests === 1, "ambiguous post-dispatch mutation was replayed: " + mutatingRequests);
        await shutdownSession(pi);
        await supervisor.close();
      }

      // Reconnection refuses a listener that returns a different session ID;
      // the original mutation is never dispatched to that listener.
      {
        clearAgentSHEnv();
        delete process.env.PI_AGENTSH_APPROVAL_POLL_MS;
        const expectedSession = "sess-exact-original";
        let returnedSession = expectedSession;
        let mutatingRequests = 0;
        const supervisor = await withRestartableRestSupervisor(async (request) => {
          if (request.method === "GET" && request.url === "/api/v1/sessions/" + expectedSession) return { id: returnedSession, session_id: returnedSession, workspace: "/workspace", worktree: "/workspace" };
          if (request.method === "GET" && request.url === "/api/v1/approvals") return [];
          if (request.method === "POST" && request.url.endsWith("/tools/write_file")) {
            mutatingRequests += 1;
            return { ok: true, result: { text: "wrong session write" } };
          }
          return { statusCode: 404, body: { error: "unexpected supervisor request", request } };
        });
        process.env.AGENTSH_SESSION_ID = expectedSession;
        process.env.AGENTSH_SESSION_SUPERVISOR = "unix://" + supervisor.socketPath;
        const pi = createPi();
        sandbox(pi);
        const ctx = createContext();
        await startSession(pi, ctx);
        await supervisor.stop();
        returnedSession = "sess-wrong-listener";
        const restart = (async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          await supervisor.start();
        })();
        let mismatchError;
        try {
          await pi.tools.get("write").execute("wrong-session", { path: "/workspace/wrong.txt", content: "no\n" }, undefined, undefined, ctx);
        } catch (error) {
          mismatchError = error;
        }
        await restart;
        assert(String(mismatchError).includes("Expected " + expectedSession), "session mismatch was not actionable: " + mismatchError);
        assert(mutatingRequests === 0, "mutation reached a listener for the wrong session");
        assert(globalThis.__AGENTSH_PI__.getSupervisorState().status === "error", "session mismatch did not become terminal");
        await shutdownSession(pi);
        await supervisor.close();
      }

      // Subagents inherit the trusted parent's active model unless a child selects one explicitly.
      {
        clearAgentSHEnv();
        const supervisor = await withRestSupervisor(async (request) => {
          if (request.method === "GET" && request.url === "/api/v1/sessions/sess-subagent-model") {
            return { id: "sess-subagent-model", session_id: "sess-subagent-model", workspace: "/workspace", worktree: "/workspace" };
          }
          if (request.method === "GET" && request.url === "/api/v1/approvals") return [];
          if (request.method === "POST" && request.url === "/api/v1/sessions/sess-subagent-model/tools/spawn_subagent") {
            return {
              event: "done",
              ok: true,
              result: { mode: "single", final: "ok", results: [{ label: "subagent", task: "ok", exit_code: 0, stop_reason: "completed", final: "ok" }] },
            };
          }
          return { statusCode: 404, body: { error: "unexpected supervisor request", request } };
        });
        process.env.AGENTSH_SESSION_ID = "sess-subagent-model";
        process.env.AGENTSH_SESSION_SUPERVISOR = "unix://" + supervisor.socketPath;
        const pi = createPi();
        sandbox(pi);
        const ctx = createContext({ model: { provider: "openai-codex", id: "gpt-5.5", contextWindow: 200000 } });
        await startSession(pi, ctx);
        const subagentTool = pi.tools.get("subagent");
        assert(subagentTool, "REST mode did not register subagent tool");

        await subagentTool.execute("inherit-model", { task: "ok" }, undefined, undefined, ctx);
        await subagentTool.execute("explicit-model", { task: "ok", model: "google/gemini-pro" }, undefined, undefined, ctx);
        await subagentTool.execute("parallel-model", { tasks: [{ task: "one" }, { task: "two", model: "anthropic/claude-sonnet" }] }, undefined, undefined, ctx);
        await subagentTool.execute("short-timeout", { task: "ok", timeout_ms: 1234 }, undefined, undefined, ctx);
        await subagentTool.execute("long-timeout", { task: "ok", timeout_ms: 10800000 }, undefined, undefined, ctx);

        const spawnRequests = supervisor.requests.filter((request) => request.method === "POST" && request.url.endsWith("/tools/spawn_subagent"));
        assert(spawnRequests.length === 5, "unexpected subagent request count");
        assert(spawnRequests[0].body.model === "openai-codex/gpt-5.5", "single child did not inherit parent model");
        assert(spawnRequests[1].body.model === "google/gemini-pro", "explicit child model was overwritten");
        assert(spawnRequests[2].body.tasks[0].model === "openai-codex/gpt-5.5", "parallel child did not inherit parent model");
        assert(spawnRequests[2].body.tasks[1].model === "anthropic/claude-sonnet", "parallel explicit model was overwritten");
        assert(spawnRequests[0].body.timeout_ms === 7200000, "default subagent execution timeout was not two hours");
        assert(spawnRequests[3].body.timeout_ms === 1234, "explicit shorter subagent timeout was overwritten");
        assert(spawnRequests[4].body.timeout_ms === 7200000, "explicit timeout bypassed the configured execution ceiling");
        assert(spawnRequests[0].body.result_artifact_threshold_bytes === 4096, "single subagent artifact threshold did not match parent inline budget");
        assert(spawnRequests[2].body.result_artifact_threshold_bytes === 2048, "parallel subagent artifact threshold did not match per-child capsule budget");
        await shutdownSession(pi);
        await supervisor.close();
      }

      // REST NDJSON preserves split UTF-8 and never copies child thinking into parent updates.
      {
        clearAgentSHEnv();
        const visible = "streamed 🌍 answer";
        const hidden = "streamed-hidden-thinking-sentinel";
        const childStdout = JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: hidden },
              { type: "text", text: visible },
            ],
          },
        }) + "\n" + JSON.stringify({ type: "agent_settled" }) + "\n";
        const completedTerminal = { state: "completed", exit_code: 0, termination: "natural", retryable: false };
        // Reproduce an older/truncated AgentSH result: the live stream observed
        // the answer, but the terminal item does not repeat stdout or final.
        const terminalResult = { mode: "single", final: "", terminal: completedTerminal, results: [{ label: "child", task: "utf8", exit_code: 0, stop_reason: "completed", model_stop_reason: "stop", terminal: completedTerminal, final: "", protocol_settled: true, stdout_truncated: true, stdout_total_bytes: 3145728 }] };
        const artifactPath = "/remote/session/tmp/output-artifacts/subagent-long-result.md";
        const artifactTail = "REMOTE-SUBAGENT-TAIL-SENTINEL";
        const artifactFinal = "Long result start\n" + "visible detail ".repeat(600) + "\n" + artifactTail;
        const bashArtifactPath = "/remote/session/tmp/output-artifacts/bash-long-output.log";
        const bashHead = "REMOTE-BASH-HEAD-SENTINEL";
        const bashTail = "REMOTE-BASH-TAIL-SENTINEL";
        const bashOutput = bashHead + "\n" + "remote bash detail\n".repeat(5000) + bashTail + "\n";
        const outerStream = [
          { event: "subagent_child_start", label: "child", task: "utf8" },
          { event: "stdout", label: "child", data: childStdout },
          { event: "subagent_result", label: "child", result: terminalResult.results[0] },
          { event: "done", ok: true, result: terminalResult },
        ].map((event) => JSON.stringify(event)).join("\n");
        const bytes = Buffer.from(outerStream, "utf8");
        const emojiOffset = bytes.indexOf(Buffer.from("🌍", "utf8"));
        assert(emojiOffset >= 0, "UTF-8 fixture did not contain the expected emoji");

        const supervisor = await withRestSupervisor(async (request) => {
          if (request.method === "GET" && request.url === "/api/v1/sessions/sess-subagent-stream") {
            return { id: "sess-subagent-stream", session_id: "sess-subagent-stream", workspace: "/workspace", worktree: "/workspace" };
          }
          if (request.method === "GET" && request.url === "/api/v1/approvals") return [];
          if (request.method === "POST" && request.url === "/api/v1/sessions/sess-subagent-stream/tools/exec_bash") {
            return { ok: true, result: {
              command_id: "cmd-artifact",
              session_id: "sess-subagent-stream",
              exit_code: 0,
              stdout: bashOutput,
              stderr: "",
              stdout_truncated: false,
              stdout_total_bytes: Buffer.byteLength(bashOutput),
              full_output_path: bashArtifactPath,
              artifact_bytes: Buffer.byteLength(bashOutput),
              artifact_total_bytes: Buffer.byteLength(bashOutput),
              artifact_complete: true,
            } };
          }
          if (request.method === "POST" && request.url === "/api/v1/sessions/sess-subagent-stream/tools/read_file") {
            const content = request.body.path === artifactPath ? artifactFinal : request.body.path === bashArtifactPath ? bashOutput : undefined;
            if (content === undefined) return { statusCode: 403, body: { ok: false, error: "unowned artifact path" } };
            return { ok: true, result: { path: request.body.path, real_path: request.body.path, encoding: "utf-8", content, size: Buffer.byteLength(content), truncated: false } };
          }
          if (request.method === "POST" && request.url === "/api/v1/sessions/sess-subagent-stream/tools/spawn_subagent") {
            if (request.body.task === "typed-timeout") {
              await new Promise((resolve) => setTimeout(resolve, 80));
              const timedOutTerminal = { state: "timed_out", failure_kind: "process", cancellation_cause: "request_timeout", exit_code: 124, termination: "graceful", retryable: true, message: "subagent request timed out" };
              const timedOutChild = { label: "child", task: "typed-timeout", exit_code: 124, stop_reason: "timeout", terminal: timedOutTerminal, error: "subagent request timed out" };
              return {
                ndjsonChunks: [Buffer.from([
                  JSON.stringify({ event: "subagent_child_start", label: "child", task: "typed-timeout" }),
                  JSON.stringify({ event: "subagent_result", label: "child", result: timedOutChild }),
                  JSON.stringify({ event: "done", ok: true, result: { mode: "single", final: "subagent request timed out", terminal: timedOutTerminal, results: [timedOutChild] }, error: "subagent request timed out" }),
                ].join("\n") + "\n", "utf8")],
                keepOpenMs: 200,
              };
            }
            if (request.body.tasks?.some((task) => task.task === "client-timeout")) {
              const retained = "completed-before-client-timeout";
              const completedChild = { label: "task 1", task: "completed", exit_code: 0, stop_reason: "completed", terminal: { state: "completed", exit_code: 0, termination: "natural", retryable: false }, final: retained, protocol_settled: true };
              return {
                ndjsonChunks: [Buffer.from([
                  JSON.stringify({ event: "subagent_child_start", label: "task 1", task: "completed" }),
                  JSON.stringify({ event: "stdout", label: "task 1", data: JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: retained }], stopReason: "stop" } }) + "\n" + JSON.stringify({ type: "agent_settled" }) + "\n" }),
                  JSON.stringify({ event: "subagent_result", label: "task 1", result: completedChild }),
                  JSON.stringify({ event: "subagent_child_start", label: "task 2", task: "client-timeout" }),
                  JSON.stringify({ event: "stdout", label: "task 2", data: JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "sleep forever" } }], stopReason: "toolUse" } }) + "\n" }),
                ].join("\n") + "\n", "utf8")],
                keepOpenMs: 200,
              };
            }
            if (request.body.task === "artifact-overflow") {
              const child = {
                label: "child",
                task: "artifact-overflow",
                exit_code: 0,
                stop_reason: "completed",
                model_stop_reason: "stop",
                terminal: completedTerminal,
                final: artifactFinal,
                protocol_settled: true,
                full_result_path: artifactPath,
                final_truncated: true,
                final_total_bytes: Buffer.byteLength(artifactFinal),
                final_inline_bytes: 4096,
                artifact_bytes: Buffer.byteLength(artifactFinal),
                artifact_complete: true,
              };
              return { ndjsonChunks: [Buffer.from([
                JSON.stringify({ event: "subagent_child_start", label: "child", task: "artifact-overflow" }),
                JSON.stringify({ event: "subagent_result", label: "child", result: child }),
                JSON.stringify({ event: "done", ok: true, result: { mode: "single", final: artifactFinal, terminal: completedTerminal, results: [child] } }),
              ].join("\n") + "\n", "utf8")] };
            }
            if (request.body.tasks?.some((task) => task.task === "cancel-stream")) {
              const retained = "completed-before-user-cancellation";
              const completedChild = { label: "task 1", task: "cancel-stream", exit_code: 0, stop_reason: "completed", terminal: { state: "completed", exit_code: 0, termination: "natural", retryable: false }, final: retained, protocol_settled: true };
              return {
                ndjsonChunks: [Buffer.from([
                  JSON.stringify({ event: "subagent_child_start", label: "task 1", task: "cancel-stream" }),
                  JSON.stringify({ event: "stdout", label: "task 1", data: JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: retained }], stopReason: "stop" } }) + "\n" + JSON.stringify({ type: "agent_settled" }) + "\n" }),
                  JSON.stringify({ event: "subagent_result", label: "task 1", result: completedChild }),
                  JSON.stringify({ event: "subagent_child_start", label: "task 2", task: "wait-for-cancel" }),
                  JSON.stringify({ event: "stdout", label: "task 2", data: JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "wait" } }], stopReason: "toolUse" } }) + "\n" }),
                ].join("\n") + "\n", "utf8")],
                keepOpenMs: 250,
              };
            }
            if (request.body.task === "typed-failure") {
              const failedTerminal = { state: "failed", failure_kind: "model", exit_code: 1, termination: "natural", retryable: false, message: "model failed" };
              const failedChild = { label: "child", task: "typed-failure", exit_code: 1, stop_reason: "error", terminal: failedTerminal, error: "model failed" };
              const failedResult = { mode: "single", final: "", terminal: failedTerminal, results: [failedChild] };
              return { ndjsonChunks: [Buffer.from([
                JSON.stringify({ event: "subagent_child_start", label: "child", task: "typed-failure" }),
                JSON.stringify({ event: "subagent_result", label: "child", result: failedChild }),
                JSON.stringify({ event: "done", ok: true, result: failedResult, error: "child task failed" }),
              ].join("\n"), "utf8")] };
            }
            if (request.body.task === "dishonest-tool-use") {
              const completedTerminal = { state: "completed", exit_code: 0, termination: "natural", retryable: false };
              const child = { label: "child", task: "dishonest-tool-use", exit_code: 0, stop_reason: "completed", model_stop_reason: "toolUse", terminal: completedTerminal, final: "stale-earlier-answer", protocol_settled: true };
              const stdout = [
                { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "stale-earlier-answer" }], stopReason: "stop" } },
                { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "/tmp/x" } }], stopReason: "toolUse" } },
                { type: "agent_settled" },
              ].map((event) => JSON.stringify(event)).join("\n") + "\n";
              return { ndjsonChunks: [Buffer.from([
                JSON.stringify({ event: "subagent_child_start", label: "child", task: "dishonest-tool-use" }),
                JSON.stringify({ event: "stdout", label: "child", data: stdout }),
                JSON.stringify({ event: "subagent_result", label: "child", result: child }),
                JSON.stringify({ event: "done", ok: true, result: { mode: "single", final: "stale-earlier-answer", terminal: completedTerminal, results: [child] } }),
              ].join("\n") + "\n", "utf8")] };
            }
            if (request.body.task === "partial-transport") {
              const retained = "completed-before-transport-failure";
              return { ndjsonChunks: [Buffer.from([
                JSON.stringify({ event: "subagent_child_start", label: "task 1", task: "finished" }),
                JSON.stringify({ event: "stdout", label: "task 1", data: JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: retained }], stopReason: "stop" } }) + "\n" + JSON.stringify({ type: "agent_settled" }) + "\n" }),
                JSON.stringify({ event: "subagent_child_start", label: "task 2", task: "interrupted" }),
              ].join("\n") + "\n", "utf8")] };
            }
            return {
              ndjsonChunks: [
                bytes.subarray(0, emojiOffset + 1),
                bytes.subarray(emojiOffset + 1, emojiOffset + 3),
                bytes.subarray(emojiOffset + 3),
              ],
            };
          }
          return { statusCode: 404, body: { error: "unexpected supervisor request", request } };
        });
        process.env.AGENTSH_SESSION_ID = "sess-subagent-stream";
        process.env.AGENTSH_SESSION_SUPERVISOR = "unix://" + supervisor.socketPath;
        process.env.PI_AGENTSH_READ_MODE = "supervised";
        const pi = createPi();
        sandbox(pi);
        const ctx = createContext();
        await startSession(pi, ctx);
        const bashTool = pi.tools.get("bash");
        const bashArtifactResult = await bashTool.execute("bash-artifact", { command: "emit-long-output" }, undefined, undefined, ctx);
        assert(bashArtifactResult.details.fullOutputPath === bashArtifactPath, "bash result did not retain remote artifact path");
        assert(bashArtifactResult.content[0].text.includes(bashArtifactPath), "bash result omitted remote artifact path");
        assert(!bashArtifactResult.content[0].text.includes(bashHead), "bash overflow prefix was injected into bounded model context");
        assert(bashArtifactResult.content[0].text.includes(bashTail), "bash bounded tail omitted the actual command suffix");
        const bashRequest = supervisor.requests.find((request) => request.method === "POST" && request.url.endsWith("/tools/exec_bash"));
        assert(bashRequest?.body.persist_output_over_bytes === 50 * 1024, "bash did not request the 50 KiB remote artifact threshold: " + JSON.stringify(bashRequest));
        assert(bashRequest?.body.persist_output_over_lines === 2000, "bash did not request the Pi line threshold");

        const subagentTool = pi.tools.get("subagent");
        const updates = [];
        const toolResult = await subagentTool.execute("stream-utf8", { task: "utf8" }, undefined, (update) => updates.push(update), ctx);
        const serializedUpdates = JSON.stringify(updates);
        assert(serializedUpdates.includes(visible), "split UTF-8 child answer was not preserved in streamed updates");
        assert(!serializedUpdates.includes("�"), "split UTF-8 introduced a replacement character");
        assert(!serializedUpdates.includes(hidden), "child thinking leaked into parent streamed updates");
        assert(!JSON.stringify(toolResult).includes(hidden), "child thinking leaked into the final parent tool result");
        assert(toolResult.details.terminal.state === "completed", "typed completed terminal was not preserved");
        assert(toolResult.details.final === visible, "live final answer was overwritten by an empty bounded terminal result");
        assert(toolResult.details.results[0].lastAssistantText === visible, "live child message state was not retained through terminal reduction");
        assert(toolResult.details.results[0].protocolSettled === true, "agent_settled lifecycle state was lost");
        assert(toolResult.details.results[0].modelStopReason === "stop", "last assistant model stop reason was lost");
        assert(toolResult.details.results[0].stdoutTruncated === true, "raw diagnostic truncation metadata was lost");
        assert(toolResult.content[0].text.includes(visible), "parent-facing result omitted the retained live final answer");
        assert(toolResult.isError === false, "completed typed terminal was marked as an error");

        const artifactToolResult = await subagentTool.execute("stream-artifact", { task: "artifact-overflow" }, undefined, undefined, ctx);
        assert(artifactToolResult.details.results[0].fullResultPath === artifactPath, "remote subagent artifact path was not retained");
        assert(artifactToolResult.details.fullResultPath === artifactPath, "single-result top-level artifact path was not mirrored");
        assert(artifactToolResult.content[0].text.includes(artifactPath), "parent-facing result omitted remote artifact path");
        assert(!artifactToolResult.content[0].text.includes(artifactTail), "long artifact tail was injected into bounded parent context");
        const artifactSpawnRequest = supervisor.requests.find((request) => request.method === "POST" && request.url.endsWith("/tools/spawn_subagent") && request.body.task === "artifact-overflow");
        assert(artifactSpawnRequest?.body.result_artifact_threshold_bytes === 4096, "extension did not request the 4 KiB remote artifact threshold");
        const readTool = pi.tools.get("read");
        assert(readTool, "supervised read tool was not registered");
        const readBashArtifactResult = await readTool.execute("read-bash-artifact", { path: bashArtifactPath }, undefined, undefined, ctx);
        assert(readBashArtifactResult.content[0].text.includes(bashHead), "supervised read did not retrieve remote bash overflow prefix");
        assert(!readBashArtifactResult.content[0].text.includes(bashTail), "supervised read injected an ignored supervisor's unbounded response");
        assert(readBashArtifactResult.content[0].text.includes("Use offset="), "locally bounded supervised read omitted continuation guidance");
        assert(Buffer.byteLength(readBashArtifactResult.content[0].text) < 55 * 1024, "supervised read exceeded its bounded model-context budget");
        const readArtifactResult = await readTool.execute("read-artifact", { path: artifactPath }, undefined, undefined, ctx);
        assert(readArtifactResult.content[0].text.includes(artifactTail), "supervised read did not retrieve remote artifact tail");

        const failedToolResult = await subagentTool.execute("stream-failure", { task: "typed-failure" }, undefined, undefined, ctx);
        assert(failedToolResult.details.terminal.state === "failed", "typed failed terminal was not preserved");
        assert(failedToolResult.details.results[0].terminal.failureKind === "model", "child failure kind was not normalized");
        assert(failedToolResult.content[0].text.includes("model failed"), "typed failure diagnostic was reduced to a generic stop reason");
        assert(failedToolResult.isError === true, "failed child task was not marked as an error");

        const typedTimeoutResult = await subagentTool.execute("stream-typed-timeout", { task: "typed-timeout", timeout_ms: 40 }, undefined, undefined, ctx);
        assert(typedTimeoutResult.details.terminal.state === "timed_out", "server execution deadline was not preserved as a typed timeout");
        assert(typedTimeoutResult.details.terminal.failureKind === "process", "server execution timeout was replaced by a client transport timeout while awaiting HTTP EOF");
        assert(typedTimeoutResult.details.terminal.cancellationCause === "request_timeout", "server timeout lost its cancellation cause");
        assert(typedTimeoutResult.details.results[0].terminal.state === "timed_out", "timed-out child was reduced to a protocol failure");
        assert(!typedTimeoutResult.content[0].text.includes("child Pi stream ended before agent_settled"), "typed timeout was misreported as an unsettled protocol");
        assert(typedTimeoutResult.isError === true, "typed timeout was not marked as an error");
        const typedTimeoutRequest = supervisor.requests.find((request) => request.method === "POST" && request.url.endsWith("/tools/spawn_subagent") && request.body.task === "typed-timeout");
        assert(typedTimeoutRequest?.body.timeout_ms === 40, "explicit execution deadline was not sent to AgentSH");

        const clientTimeoutResult = await subagentTool.execute("stream-client-timeout", { tasks: [{ task: "completed" }, { task: "client-timeout" }], timeout_ms: 40 }, undefined, undefined, ctx);
        assert(clientTimeoutResult.details.terminal.state === "timed_out", "client transport deadline was reported as a generic failure");
        assert(clientTimeoutResult.details.terminal.failureKind === "transport", "client transport timeout lost its fallback classification");
        assert(clientTimeoutResult.details.terminal.cancellationCause === "request_timeout", "client transport timeout lost its deadline cause");
        assert(clientTimeoutResult.details.results[0].terminal.state === "completed", "client timeout overwrote an already-completed parallel child");
        assert(clientTimeoutResult.details.results[0].lastAssistantText === "completed-before-client-timeout", "client timeout lost completed child progress");
        assert(clientTimeoutResult.details.results[1].terminal.state === "timed_out", "active sibling was not reduced to a typed timeout");
        assert(!clientTimeoutResult.content[0].text.includes("The operation was aborted"), "client timeout regressed to an untyped AbortError");
        assert(clientTimeoutResult.content[0].text.includes("subagent timed out"), "client timeout was rendered as a generic transport failure");

        const dishonestToolUseResult = await subagentTool.execute("stream-dishonest-tool-use", { task: "dishonest-tool-use" }, undefined, undefined, ctx);
        assert(dishonestToolUseResult.details.terminal.state === "failed", "tool-use message_end was accepted as completed parent result");
        assert(dishonestToolUseResult.details.results[0].terminal.failureKind === "protocol", "tool-use completion was not classified as a protocol failure");
        assert(dishonestToolUseResult.details.results[0].modelStopReason === "toolUse", "tool-use model stop reason was lost");
        assert(!dishonestToolUseResult.content[0].text.includes("stale-earlier-answer"), "an earlier assistant message was reused as the final answer after tool use");
        assert(dishonestToolUseResult.content[0].text.includes("tool-use"), "tool-use protocol failure diagnostic was not parent-visible");
        assert(dishonestToolUseResult.isError === true, "dishonest tool-use completion was not marked as an error");

        const partialTransportResult = await subagentTool.execute("stream-partial-transport", { task: "partial-transport" }, undefined, undefined, ctx);
        assert(partialTransportResult.details.terminal.state === "failed", "missing terminal stream event was not reported as transport failure");
        assert(partialTransportResult.details.results[0].terminal.state === "completed", "outer transport failure overwrote an already-completed parallel child");
        assert(partialTransportResult.details.results[0].lastAssistantText === "completed-before-transport-failure", "completed child answer was lost during parallel cancellation reduction");
        assert(!partialTransportResult.details.results[0].errorMessage, "outer transport failure was copied onto an already-completed child");
        assert(partialTransportResult.details.results[1].terminal.state === "failed", "interrupted parallel child was not marked failed");
        assert(partialTransportResult.isError === true, "partial transport failure was not marked as an error");

        const abortController = new AbortController();
        const abortTimer = setTimeout(() => abortController.abort(), 500);
        const cancelledToolResult = await subagentTool.execute("stream-cancel", { tasks: [{ task: "cancel-stream" }, { task: "wait-for-cancel" }] }, abortController.signal, (update) => {
          const children = update?.details?.results ?? [];
          if (children.some((child) => child.label === "task 1" && child.terminal?.state === "completed") && children.some((child) => child.label === "task 2")) abortController.abort();
        }, ctx);
        clearTimeout(abortTimer);
        assert(cancelledToolResult.details.terminal.state === "cancelled", "aborted request did not produce a cancelled terminal");
        assert(cancelledToolResult.details.terminal.cancellationCause === "user_cancelled", "aborted request lost its user cancellation cause");
        assert(cancelledToolResult.details.results[0].terminal.state === "completed", "parallel cancellation overwrote an already-completed child");
        assert(cancelledToolResult.details.results[0].lastAssistantText === "completed-before-user-cancellation", "parallel cancellation lost the completed child answer");
        assert(!cancelledToolResult.details.results[0].errorMessage, "parallel cancellation copied its error onto an already-completed child");
        assert(cancelledToolResult.details.results[1].terminal.state === "cancelled", "active parallel sibling was not marked cancelled");
        assert(cancelledToolResult.content[0].text.includes("subagent cancelled"), "cancelled request was rendered as a generic failure");

        const retainedCommand = "printf 'retained-progress-smoke\\n'";
        const renderedRunning = subagentTool.renderResult({
          content: [],
          details: {
            mode: "parallel",
            results: [{
              label: "task 1",
              exitCode: -1,
              stopReason: "running",
              messages: [],
              completedTools: [{ name: "bash", args: { command: retainedCommand }, isError: false }],
              usage: {},
            }],
          },
        }, { expanded: false }, ctx.ui.theme).render(120).join("\n");
        assert(renderedRunning.includes(retainedCommand), "collapsed running result lost the last completed command summary");
        assert(!renderedRunning.includes("(running...)"), "collapsed running result regressed to a generic running placeholder despite completed progress");

        const mixedRunningDetails = {
          mode: "parallel",
          results: [
            {
              label: "active child",
              task: "inspect sources",
              exitCode: -1,
              stopReason: "running",
              model: "test/model",
              tools: ["ls", "grep"],
              cwd: "/workspace",
              messages: [],
              activeTool: { name: "grep", args: { pattern: "needle", path: "/workspace" } },
              completedTools: [{ name: "ls", args: { path: "/workspace/src", limit: 500 }, isError: false }],
              usage: { input: 10, output: 2 },
            },
            {
              label: "completed child",
              task: "find TypeScript",
              exitCode: 0,
              stopReason: "completed",
              messages: [],
              completedTools: [{ name: "find", args: { pattern: "**/*.ts", path: "/workspace", limit: 1000 }, isError: false }],
              usage: { input: 5, output: 1 },
            },
            {
              label: "failed child",
              task: "search sources",
              exitCode: 1,
              stopReason: "error",
              errorMessage: "search failed",
              messages: [],
              completedTools: [{ name: "grep", args: { pattern: "needle", path: "/workspace", glob: "*.ts" }, isError: true }],
              usage: { input: 3, output: 1 },
            },
          ],
        };
        const collapsedMixed = subagentTool.renderResult({ content: [], details: mixedRunningDetails }, { expanded: false }, ctx.ui.theme).render(120).join("\n");
        const expandedMixed = subagentTool.renderResult({ content: [], details: mixedRunningDetails }, { expanded: true }, ctx.ui.theme).render(120).join("\n");
        assert(collapsedMixed.includes("ls /workspace/src"), "collapsed running result lost the canonical ls summary");
        assert(collapsedMixed.includes("find **/*.ts in /workspace"), "collapsed result lost the canonical find summary");
        assert(collapsedMixed.includes("grep /needle/ in /workspace"), "collapsed failed result lost the canonical grep summary");
        assert(!collapsedMixed.includes("ls {}") && !collapsedMixed.includes("find {}") && !collapsedMixed.includes("grep {}"), "known tools regressed to empty generic argument objects");
        assert(collapsedMixed.includes("(Ctrl+O to expand)"), "collapsed running result omitted the expansion hint");
        assert(expandedMixed.includes("Status: running (exit -1)"), "expanded running result did not render truthful active state");
        assert(expandedMixed.includes("Active tool: grep /needle/ in /workspace"), "expanded running result omitted the active tool");
        assert(expandedMixed.includes("Last completed tool: ls /workspace/src"), "expanded running result omitted retained completed progress");
        assert(expandedMixed.includes("Last completed tool: find **/*.ts in /workspace"), "expanded result omitted completed child details");
        assert(expandedMixed.includes("Last completed tool: grep /needle/ in /workspace (failed)"), "expanded result omitted failed child details");
        assert(!expandedMixed.includes("(Ctrl+O to expand)"), "expanded running result still advertised expansion");
        assert(expandedMixed !== collapsedMixed, "Ctrl+O expansion produced no visible running-state change");
        await shutdownSession(pi);
        delete process.env.PI_AGENTSH_READ_MODE;
        await supervisor.close();
      }

      // Strict REST attachment requires fresh, proven network-enforcement evidence.
      {
        clearAgentSHEnv();
        const network = {
          requested: "strict",
          readiness: "ready",
          status: "ready",
          tier: "helper-ebpf-proxy-required",
          network_policy_enforced: true,
          detail: "strict preflight passed",
        };
        const supervisor = await withRestSupervisor(async (request) => {
          if (request.method === "GET" && request.url === "/api/v1/sessions/sess-network-ready") {
            return { id: "sess-network-ready", session_id: "sess-network-ready", workspace: "/workspace", worktree: "/workspace", network_enforcement: network };
          }
          if (request.method === "GET" && request.url === "/api/v1/sessions/sess-network-ready/network-enforcement") return network;
          if (request.method === "GET" && request.url === "/api/v1/approvals") return [];
          return { statusCode: 404, body: { error: "unexpected supervisor request", request } };
        });
        process.env.AGENTSH_SESSION_ID = "sess-network-ready";
        process.env.AGENTSH_SESSION_SUPERVISOR = "unix://" + supervisor.socketPath;
        const pi = createPi();
        sandbox(pi);
        const ctx = createContext();
        await startSession(pi, ctx);

        assert(supervisor.requests.some((request) => request.url === "/api/v1/sessions/sess-network-ready/network-enforcement"), "sandbox did not query live network enforcement");
        assert(ctx.statuses.some((entry) => entry.name === "sandbox" && entry.value === "agentsh net ✓"), "proven strict network enforcement was not shown in status");
        await pi.commands.get("sandbox").handler("", ctx);
        assert(ctx.notifications.some((entry) => String(entry.message).includes("Network:  strict / ready / helper-ebpf-proxy-required (live)")), "sandbox status omitted live network evidence");
        await shutdownSession(pi);
        await supervisor.close();
      }

      // A strict report that is degraded must leave AgentSH-backed tools unusable.
      {
        clearAgentSHEnv();
        const network = {
          requested: "strict",
          readiness: "failed",
          status: "failed",
          tier: "helper-ebpf-proxy-required",
          network_policy_enforced: false,
          detail: "helper attachment unavailable",
        };
        const supervisor = await withRestSupervisor(async (request) => {
          if (request.method === "GET" && request.url === "/api/v1/sessions/sess-network-failed") {
            return { id: "sess-network-failed", session_id: "sess-network-failed", workspace: "/workspace", worktree: "/workspace", network_enforcement: network };
          }
          if (request.method === "GET" && request.url === "/api/v1/sessions/sess-network-failed/network-enforcement") return network;
          return { statusCode: 404, body: { error: "unexpected supervisor request", request } };
        });
        process.env.AGENTSH_SESSION_ID = "sess-network-failed";
        process.env.AGENTSH_SESSION_SUPERVISOR = "unix://" + supervisor.socketPath;
        const pi = createPi();
        sandbox(pi);
        const ctx = createContext();
        await startSession(pi, ctx);

        assert(ctx.statuses.some((entry) => entry.name === "sandbox" && entry.value === "agentsh ✗"), "failed strict network enforcement did not set error status");
        const bashTool = pi.tools.get("bash");
        assert(bashTool, "strict failure test did not register AgentSH-backed bash");
        let rejected = false;
        try {
          await bashTool.execute("network-failed", { command: "true" }, undefined, undefined, ctx);
        } catch (error) {
          rejected = String(error).includes("strict network enforcement is not ready");
        }
        assert(rejected, "AgentSH-backed bash remained usable after strict network evidence failed");
        await shutdownSession(pi);
        await supervisor.close();
      }

      // Single-root shadow sessions expose workspace_roots for review metadata, but the REST
      // file tools still resolve /workspace/<rel> directly against the flat worktree. Do not
      // rewrite absolute real/work paths to /workspace/<root-name>/<rel> unless this is a true
      // multi-root worktree, or edits like /real/helios/.gitignore resolve to work/helios/.gitignore.
      {
        clearAgentSHEnv();
        let editRequest;
        const supervisor = await withRestSupervisor(async (request) => {
          if (request.method === "GET" && request.url === "/api/v1/sessions/sess-single-root") {
            return {
              id: "sess-single-root",
              session_id: "sess-single-root",
              workspace: "/real/helios",
              worktree: "/shadow/work",
              virtual_root: "/workspace",
              workspace_roots: [{ name: "helios", real: "/real/helios", work: "/shadow/work" }],
            };
          }
          if (request.method === "GET" && request.url === "/api/v1/approvals") return [];
          if (request.method === "POST" && request.url === "/api/v1/sessions/sess-single-root/tools/edit_file") {
            editRequest = request;
            return { ok: true, result: { text: "Edited /workspace/.gitignore" } };
          }
          return { statusCode: 404, body: { error: "unexpected supervisor request", request } };
        });
        process.env.AGENTSH_SESSION_ID = "sess-single-root";
        process.env.AGENTSH_SESSION_SUPERVISOR = "unix://" + supervisor.socketPath;
        const pi = createPi();
        sandbox(pi);
        const ctx = createContext();
        await startSession(pi, ctx);
        const editTool = pi.tools.get("edit");
        assert(editTool, "REST mode did not register edit tool for single-root path test");
        await editTool.execute("edit-single-root", { path: "/real/helios/.gitignore", edits: [{ oldText: "old", newText: "new" }] }, undefined, undefined, ctx);
        assert(editRequest?.body?.path === "/workspace/.gitignore", "single-root absolute path mapped to wrong virtual path: " + JSON.stringify(editRequest?.body));
        await shutdownSession(pi);
        await supervisor.close();
      }

      // Explicit central approval client opt-in resolves via the central detached-session bridge.
      {
        clearAgentSHEnv();
        const approvals = [{ id: "central-appr", session_id: "sess-rest", kind: "file", target: "/workspace/.env" }];
        let centralResolved;
        const supervisor = await withRestSupervisor(async (request) => {
          if (request.method === "GET" && request.url === "/api/v1/sessions/sess-rest") return { id: "sess-rest", session_id: "sess-rest", workspace: "/workspace", worktree: "/workspace" };
          if (request.method === "GET" && request.url === "/api/v1/approvals") return approvals;
          if (request.method === "POST" && request.url === "/api/v1/approvals/central-appr") return { statusCode: 500, body: { error: "supervisor should not resolve when central is requested" } };
          return { statusCode: 404, body: { error: "unexpected supervisor request", request } };
        });
        const central = await withHttpServer(async (request) => {
          if (request.method === "POST" && request.url === "/api/v1/detached-sessions/sess-rest/approvals/central-appr/resolution") {
            centralResolved = request;
            return {};
          }
          return { statusCode: 404, body: { error: "unexpected central request", request } };
        });
        process.env.AGENTSH_SESSION_ID = "sess-rest";
        process.env.AGENTSH_SESSION_SUPERVISOR = "unix://" + supervisor.socketPath;
        process.env.AGENTSH_SESSION_EVENT_URL = central.url;
        process.env.AGENTSH_SESSION_EVENT_TOKEN = "central-token";
        process.env.PI_AGENTSH_APPROVAL_CLIENT = "central";
        const pi = createPi();
        sandbox(pi);
        const ctx = createContext();
        await startSession(pi, ctx);
        await waitFor(() => Boolean(centralResolved), "central approval client opt-in did not resolve through central bridge");

        assert(centralResolved.body.decision === "approve", "central approval was not approved");
        assert(centralResolved.body.scope === "once", "central approval default scope was not relayed");
        await shutdownSession(pi);
        await supervisor.close();
        await central.close();
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
        assert(resolved.scope === "once", "deny approval should default to once scope");
        await shutdownSession(pi);
        await server.close();
      }

      // Session-scoped approvals expose four choices and relay scope=session.
      {
        clearAgentSHEnv();
        let approvals = [{
          id: "appr-session",
          kind: "network",
          target: "example.com:443",
          rule: "approve-unknown-https",
          fields: { scope_kind: "network", scope_key: "network:example.com:443", scope_label: "example.com:443" },
        }];
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
        const ctx = createContext({ choices: ["Approve for session network: example.com:443"] });
        await startSession(pi, ctx);
        await waitFor(() => Boolean(resolved), "session approval was not resolved");

        assert(ctx.selectCalls[0].items.length === 4, "scoped approval should show four choices");
        assert(ctx.selectCalls[0].items.includes("Approve for session network: example.com:443"), "missing approve-for-session choice");
        assert(ctx.selectCalls[0].items.includes("Deny for session network: example.com:443"), "missing deny-for-session choice");
        assert(resolved.id === "appr-session", "resolved wrong session approval id");
        assert(resolved.decision === "approve", "session approval was not approved");
        assert(resolved.scope === "session", "session approval did not relay scope=session");
        assert(/approved for session/i.test(resolved.reason), "session approval reason did not mention session");
        await shutdownSession(pi);
        await server.close();
      }

      // Command scope_options distinguish executable/session from exact-invocation/session approvals.
      {
        clearAgentSHEnv();
        let approvals = [{
          id: "appr-command-scopes",
          kind: "command",
          target: "bash -lc 'echo hi'",
          fields: {
            scope_options: [
              { scope_kind: "command", scope_key: "command-executable:bash", scope_label: "bash" },
              { scope_kind: "command", scope_key: "command-invocation:bash -lc 'echo hi'", scope_label: "bash -lc 'echo hi'" },
            ],
          },
        }];
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
        const ctx = createContext({ choices: ["Approve this exact invocation for session: bash -lc 'echo hi'"] });
        await startSession(pi, ctx);
        await waitFor(() => Boolean(resolved), "command scope approval was not resolved");

        assert(ctx.selectCalls[0].items.length === 6, "command scope_options should show approve/deny choices for both session scopes");
        assert(ctx.selectCalls[0].items.includes("Approve this command for session: bash"), "missing executable/session approve choice");
        assert(ctx.selectCalls[0].items.includes("Approve this exact invocation for session: bash -lc 'echo hi'"), "missing exact-invocation/session approve choice");
        assert(ctx.selectCalls[0].items.includes("Deny this command for session: bash"), "missing executable/session deny choice");
        assert(ctx.selectCalls[0].items.includes("Deny this exact invocation for session: bash -lc 'echo hi'"), "missing exact-invocation/session deny choice");
        assert(!ctx.selectCalls[0].items.includes("Approve for session command: bash"), "command executable choice used the ambiguous legacy label");
        assert(resolved.id === "appr-command-scopes", "resolved wrong command approval id");
        assert(resolved.decision === "approve", "command scope approval was not approved");
        assert(resolved.scope === "session", "command scope approval did not relay scope=session");
        assert(resolved.scope_kind === "command", "command approval did not relay scope_kind");
        assert(resolved.scope_key === "command-invocation:bash -lc 'echo hi'", "command approval did not relay exact invocation scope_key");
        assert(resolved.scope_label === "bash -lc 'echo hi'", "command approval did not relay scope_label");
        await shutdownSession(pi);
        await server.close();
      }

      // File/directory scope_options use the custom overlay prompt and relay the selected directory grant exactly.
      {
        clearAgentSHEnv();
        let approvals = [{
          id: "appr-directory",
          kind: "file",
          target: "/workspace/src/secret.txt",
          fields: {
            scope_options: [
              { scope_kind: "file", scope_key: "file:/workspace/src/secret.txt", scope_label: "/workspace/src/secret.txt", scope_operation: "read", scope_path: "/workspace/src/secret.txt", scope_prefix: false },
              { scope_kind: "directory", scope_key: "dir:/workspace/src", scope_label: "/workspace/src", scope_operation: "read", scope_path: "/workspace/src", scope_prefix: true },
            ],
          },
        }];
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
        const ctx = createContext({ customActions: ["<down>", "<down>", "<enter>"] });
        await startSession(pi, ctx);
        await waitFor(() => Boolean(resolved), "directory approval was not resolved");

        assert(ctx.customCalls.length === 1, "directory approval did not use the custom overlay prompt");
        assert(ctx.customCalls[0].options.overlay === true, "approval prompt was not an overlay");
        assert(ctx.customCalls[0].options.overlayOptions?.width === "100%", "approval overlay was not full width");
        assert(ctx.customCalls[0].options.overlayOptions?.anchor === "bottom-center", "approval overlay anchor regressed");
        assert(resolved.id === "appr-directory", "resolved wrong directory approval id");
        assert(resolved.decision === "approve", "directory approval was not approved");
        assert(resolved.scope === "session", "directory approval did not relay scope=session");
        assert(resolved.scope_kind === "directory", "directory approval did not relay scope_kind");
        assert(resolved.scope_key === "dir:/workspace/src", "directory approval did not relay scope_key");
        assert(resolved.scope_path === "/workspace/src", "directory approval did not relay scope_path");
        assert(resolved.scope_prefix === true, "directory approval did not relay scope_prefix");
        await shutdownSession(pi);
        await server.close();
      }

      // Parent directory scope_options from AgentSH are shown and relayed exactly.
      {
        clearAgentSHEnv();
        let approvals = [{
          id: "appr-parent-directory",
          kind: "file",
          target: "/workspace/dir/subdir/file.txt",
          fields: {
            scope_options: [
              { scope_kind: "file", scope_key: "file:read:/workspace/dir/subdir/file.txt", scope_label: "read /workspace/dir/subdir/file.txt", scope_operation: "read", scope_path: "/workspace/dir/subdir/file.txt" },
              { scope_kind: "file-tree", scope_key: "file-tree:read:outside-read:/workspace/dir/subdir", scope_label: "read directory recursively /workspace/dir/subdir", scope_operation: "read", scope_path: "/workspace/dir/subdir", scope_rule: "outside-read", scope_prefix: true },
              { scope_kind: "file-tree", scope_key: "file-tree:read:outside-read:/workspace/dir", scope_label: "read directory recursively /workspace/dir", scope_operation: "read", scope_path: "/workspace/dir", scope_rule: "outside-read", scope_prefix: true },
            ],
          },
        }];
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
        const ctx = createContext({ customActions: ["<down>", "<down>", "<down>", "<enter>"] });
        await startSession(pi, ctx);
        await waitFor(() => Boolean(resolved), "parent directory approval was not resolved");

        assert(resolved.id === "appr-parent-directory", "resolved wrong parent-directory approval id");
        assert(resolved.decision === "approve", "parent-directory approval was not approved");
        assert(resolved.scope === "session", "parent-directory approval did not relay scope=session");
        assert(resolved.scope_kind === "file-tree", "parent-directory approval did not relay scope_kind");
        assert(resolved.scope_key === "file-tree:read:outside-read:/workspace/dir", "parent-directory approval did not relay scope_key");
        assert(resolved.scope_path === "/workspace/dir", "parent-directory approval did not relay scope_path");
        assert(resolved.scope_rule === "outside-read", "parent-directory approval did not relay scope_rule");
        assert(resolved.scope_prefix === true, "parent-directory approval did not relay scope_prefix");
        await shutdownSession(pi);
        await server.close();
      }

      // Deny-for-session relays decision=deny with scope=session.
      {
        clearAgentSHEnv();
        let approvals = [{
          id: "appr-deny-session",
          kind: "network",
          target: "deny.example:443",
          fields: { scope_kind: "network", scope_key: "network:deny.example:443", scope_label: "deny.example:443" },
        }];
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
        const ctx = createContext({ choices: ["Deny for session network: deny.example:443"] });
        await startSession(pi, ctx);
        await waitFor(() => Boolean(resolved), "deny-for-session approval was not resolved");

        assert(resolved.id === "appr-deny-session", "resolved wrong deny-session approval id");
        assert(resolved.decision === "deny", "deny-for-session approval was not denied");
        assert(resolved.scope === "session", "deny-for-session did not relay scope=session");
        assert(/denied for session/i.test(resolved.reason), "deny-for-session reason did not mention session");
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
