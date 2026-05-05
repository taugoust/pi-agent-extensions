{ self, bun2nix, pkgs, pi-mcp-adapter ? null }:
let
  package = import ./package.nix { inherit self bun2nix pkgs pi-mcp-adapter; };
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

    mkdir -p "$outdir/node_modules/@anthropic-ai/sandbox-runtime"
    cat > "$outdir/node_modules/@anthropic-ai/sandbox-runtime/package.json" <<'EOF'
    {
      "name": "@anthropic-ai/sandbox-runtime",
      "type": "module",
      "main": "./index.js"
    }
    EOF

    cat > "$outdir/node_modules/@anthropic-ai/sandbox-runtime/index.js" <<'EOF'
    let currentConfig;
    let askCallback;

    export const SandboxManager = {
      async initialize(config, callback) {
        currentConfig = structuredClone(config);
        askCallback = callback;
      },
      async reset() {
        currentConfig = undefined;
        askCallback = undefined;
      },
      getConfig() {
        return currentConfig;
      },
      updateConfig(config) {
        currentConfig = structuredClone(config);
      },
      async wrapWithSandbox(command) {
        return command;
      },
      async askNetwork(host, port) {
        if (!askCallback) {
          return false;
        }
        return await askCallback({ host, port });
      },
    };
    EOF

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
      Boolean(options = {}) {
        return { type: "boolean", ...options };
      },
      Optional(schema) {
        return { ...schema, optional: true };
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

    cat > "$outdir/node_modules/@mariozechner/pi-coding-agent/index.js" <<'EOF'
    export function createBashTool(cwd, options = {}) {
      return {
        name: "bash",
        label: "bash",
        description: "bash",
        parameters: {},
        async execute(_id, params) {
          return {
            content: [{ type: "text", text: `bash:''${cwd}:''${params?.command ?? ""}` }],
            details: options,
          };
        },
      };
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
      "$srcdir/sandbox/index.ts"

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
      const tools = new Map();
      const flags = new Map();

      return {
        handlers,
        commands,
        tools,
        registerFlag(name, options) {
          flags.set(name, options.default);
        },
        getFlag(name) {
          return flags.get(name);
        },
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
        events: {
          emit() {},
        },
      };
    }

    function createContext(cwd, choices = [], hasUI = true) {
      let choiceIndex = 0;
      const selectCalls = [];

      return {
        cwd,
        hasUI,
        selectCalls,
        ui: {
          theme: {
            fg: (_color, text) => text,
          },
          setStatus() {},
          notify() {},
          async select(title, items) {
            selectCalls.push(title);
            const choice = choices[choiceIndex] ?? items[0];
            choiceIndex += 1;
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

    function getToolCallHandler(pi) {
      const handlers = pi.handlers.get("tool_call") ?? [];
      assert(handlers.length === 1, `expected exactly one tool_call handler, got ''${handlers.length}`);
      return handlers[0];
    }

    async function emitToolResult(pi, event, ctx) {
      const handlers = pi.handlers.get("tool_result") ?? [];
      for (const handler of handlers) {
        await handler(event, ctx);
      }
    }

    async function makeProject(tempRoot, name, config) {
      const cwd = path.join(tempRoot, name);
      fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
      fs.writeFileSync(path.join(cwd, ".pi", "sandbox.json"), JSON.stringify(config, null, 2));
      return cwd;
    }

    async function main() {
      const compiledRoot = process.argv[2];
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-check-"));
      process.env.HOME = tempRoot;

      const runtimeModule = await import(
        pathToFileURL(path.join(compiledRoot, "node_modules/@anthropic-ai/sandbox-runtime/index.js")).href
      );
      const { SandboxManager } = runtimeModule;
      const moduleUrl = pathToFileURL(path.join(compiledRoot, "sandbox/index.js")).href;
      const importedModule = await import(moduleUrl);
      const sandbox = importedModule.default?.default ?? importedModule.default ?? importedModule;
      assert(typeof sandbox === "function", "sandbox module did not export a function");

      fs.mkdirSync(path.join(tempRoot, ".ssh"), { recursive: true });
      const sockDir = path.join(tempRoot, "sock");
      fs.mkdirSync(sockDir, { recursive: true });
      process.env.SSH_AUTH_SOCK = path.join(sockDir, "agent.sock");
      const expectedSocketPath = path.join(fs.realpathSync(sockDir), path.basename(process.env.SSH_AUTH_SOCK));

      const baseConfig = {
        enabled: true,
        network: {
          allowedDomains: [],
          deniedDomains: [],
        },
        filesystem: {
          allowRead: [],
          denyRead: ["~/.ssh"],
          allowWrite: ["."],
          denyWrite: [".env"],
        },
      };

      // Test: protected native reads prompt and session grants relax runtime denyRead.
      {
        const pi = createPi();
        sandbox(pi);

        const cwd = await makeProject(tempRoot, "read-project", baseConfig);
        const ctx = createContext(cwd, ["Allow for this session"]);
        await startSession(pi, ctx);

        const event = {
          toolName: "read",
          toolCallId: "read-1",
          input: {
            path: "~/.ssh/config",
          },
        };

        const result = await getToolCallHandler(pi)(event, ctx);
        assert(result === undefined, "sandbox did not allow the read after approval");
        assert(!SandboxManager.getConfig().filesystem.denyRead.includes("~/.ssh"), "read grant did not relax runtime denyRead");
      }

      // Test: allow-once for protected native reads does not persist.
      {
        const pi = createPi();
        sandbox(pi);

        const cwd = await makeProject(tempRoot, "read-once-project", baseConfig);
        const ctx = createContext(cwd, ["Allow once", "Abort"]);
        await startSession(pi, ctx);

        const firstEvent = {
          toolName: "read",
          toolCallId: "read-once-1",
          input: {
            path: "~/.ssh/config",
          },
        };

        const firstResult = await getToolCallHandler(pi)(firstEvent, ctx);
        assert(firstResult === undefined, "sandbox did not allow the protected read once");
        assert(SandboxManager.getConfig().filesystem.denyRead.includes("~/.ssh"), "allow-once unexpectedly relaxed runtime denyRead");

        const secondEvent = {
          toolName: "read",
          toolCallId: "read-once-2",
          input: {
            path: "~/.ssh/config",
          },
        };

        const secondResult = await getToolCallHandler(pi)(secondEvent, ctx);
        assert(secondResult && secondResult.block === true, "allow-once read should prompt again on the next call");
        assert(ctx.selectCalls.length === 2, `expected two read prompts, got ''${ctx.selectCalls.length}`);
      }

      // Test: writes outside allowWrite prompt and project grants persist to .pi/sandbox.json.
      {
        const pi = createPi();
        sandbox(pi);

        const cwd = await makeProject(tempRoot, "write-project", baseConfig);
        const ctx = createContext(cwd, ["Allow for this project"]);
        await startSession(pi, ctx);

        const event = {
          toolName: "write",
          toolCallId: "write-1",
          input: {
            path: "../outside.txt",
            content: "hello\n",
          },
        };

        const result = await getToolCallHandler(pi)(event, ctx);
        assert(result === undefined, "sandbox did not allow the write after approval");

        const projectConfig = JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "sandbox.json"), "utf-8"));
        assert(
          projectConfig.filesystem.allowWrite.some((entry) => String(entry).includes("outside.txt")),
          "sandbox did not persist the project write grant",
        );
      }

      // Test: denyWrite remains a hard block.
      {
        const pi = createPi();
        sandbox(pi);

        const cwd = await makeProject(tempRoot, "deny-project", baseConfig);
        const ctx = createContext(cwd, []);
        await startSession(pi, ctx);

        const event = {
          toolName: "write",
          toolCallId: "write-2",
          input: {
            path: ".env",
            content: "SECRET=1\n",
          },
        };

        const result = await getToolCallHandler(pi)(event, ctx);
        assert(result && result.block === true, "sandbox did not hard-block denyWrite target");
      }

      // Test: SSH allow-once grants are temporary and cleaned up after the tool result.
      {
        const pi = createPi();
        sandbox(pi);

        const cwd = await makeProject(tempRoot, "ssh-once-project", baseConfig);
        const ctx = createContext(cwd, ["Allow once"]);
        await startSession(pi, ctx);

        const event = {
          toolName: "bash",
          toolCallId: "bash-once-1",
          input: {
            command: "ssh matebook.tailf44e66.ts.net true",
          },
        };

        const result = await getToolCallHandler(pi)(event, ctx);
        assert(result === undefined, "sandbox did not allow ssh after allow-once approval");

        const duringConfig = SandboxManager.getConfig();
        assert(
          duringConfig.network.allowedDomains.includes("matebook.tailf44e66.ts.net"),
          "allow-once ssh did not temporarily add the ssh host to allowedDomains",
        );
        assert(!duringConfig.filesystem.denyRead.includes("~/.ssh"), "allow-once ssh did not temporarily relax denyRead for ~/.ssh");
        assert(
          (duringConfig.network.allowUnixSockets ?? []).includes(expectedSocketPath),
          "allow-once ssh did not temporarily add SSH_AUTH_SOCK to allowUnixSockets",
        );

        await emitToolResult(
          pi,
          {
            type: "tool_result",
            toolName: "bash",
            toolCallId: "bash-once-1",
            input: event.input,
            content: [],
            details: undefined,
            isError: false,
          },
          ctx,
        );

        const afterConfig = SandboxManager.getConfig();
        assert(
          !(afterConfig.network.allowedDomains ?? []).includes("matebook.tailf44e66.ts.net"),
          "allow-once ssh did not clean up the temporary domain grant",
        );
        assert((afterConfig.filesystem.denyRead ?? []).includes("~/.ssh"), "allow-once ssh did not restore denyRead for ~/.ssh");
        assert(
          !((afterConfig.network.allowUnixSockets ?? []).includes(expectedSocketPath)),
          "allow-once ssh did not remove the temporary SSH_AUTH_SOCK grant",
        );
      }

      // Test: ssh-style bash commands prompt once and grant domain, ~/.ssh, and SSH_AUTH_SOCK together.
      {
        const pi = createPi();
        sandbox(pi);

        const cwd = await makeProject(tempRoot, "ssh-project", baseConfig);
        const ctx = createContext(cwd, ["Allow for this session"]);
        await startSession(pi, ctx);

        const event = {
          toolName: "bash",
          toolCallId: "bash-1",
          input: {
            command: "ssh matebook.tailf44e66.ts.net true",
          },
        };

        const result = await getToolCallHandler(pi)(event, ctx);
        assert(result === undefined, "sandbox did not allow ssh after approval");
        assert(ctx.selectCalls.length === 1, `expected one SSH approval prompt, got ''${ctx.selectCalls.length}`);
        assert(String(ctx.selectCalls[0]).includes("Sandbox blocked SSH access"), "SSH approval prompt title was not bundled");

        const config = SandboxManager.getConfig();
        assert(
          config.network.allowedDomains.includes("matebook.tailf44e66.ts.net"),
          "sandbox did not add the ssh host to allowedDomains",
        );
        assert(!config.filesystem.denyRead.includes("~/.ssh"), "sandbox did not relax denyRead for ~/.ssh");
        assert(
          (config.network.allowUnixSockets ?? []).includes(expectedSocketPath),
          "sandbox did not add SSH_AUTH_SOCK to allowUnixSockets",
        );
      }

      // Test: dangerous git allow-once does not persist across bash tool calls.
      {
        const pi = createPi();
        sandbox(pi);

        const cwd = await makeProject(tempRoot, "git-once-project", baseConfig);
        const ctx = createContext(cwd, ["Allow once", "Abort"]);
        await startSession(pi, ctx);

        const firstEvent = {
          toolName: "bash",
          toolCallId: "git-once-1",
          input: {
            command: "git push origin main --force",
          },
        };

        const firstResult = await getToolCallHandler(pi)(firstEvent, ctx);
        assert(firstResult === undefined, "sandbox did not allow the dangerous git command once");
        assert(ctx.selectCalls.length === 1, `expected one dangerous git prompt, got ''${ctx.selectCalls.length}`);
        assert(String(ctx.selectCalls[0]).includes("dangerous git command"), "dangerous git prompt title was not shown");

        const secondEvent = {
          toolName: "bash",
          toolCallId: "git-once-2",
          input: {
            command: "git push origin main --force",
          },
        };

        const secondResult = await getToolCallHandler(pi)(secondEvent, ctx);
        assert(secondResult && secondResult.block === true, "allow-once dangerous git approval should not persist");
        assert(ctx.selectCalls.length === 2, `expected two dangerous git prompts, got ''${ctx.selectCalls.length}`);
      }

      // Test: dangerous git session grants persist for the rest of the session.
      {
        const pi = createPi();
        sandbox(pi);

        const cwd = await makeProject(tempRoot, "git-session-project", baseConfig);
        const ctx = createContext(cwd, ["Allow for this session"]);
        await startSession(pi, ctx);

        const firstEvent = {
          toolName: "bash",
          toolCallId: "git-session-1",
          input: {
            command: "git push origin main --force",
          },
        };

        const firstResult = await getToolCallHandler(pi)(firstEvent, ctx);
        assert(firstResult === undefined, "sandbox did not allow the dangerous git command after a session grant");

        const secondEvent = {
          toolName: "bash",
          toolCallId: "git-session-2",
          input: {
            command: "git push origin other-branch --force",
          },
        };

        const secondResult = await getToolCallHandler(pi)(secondEvent, ctx);
        assert(secondResult === undefined, "session dangerous git grant did not persist across calls");
        assert(ctx.selectCalls.length === 1, `session dangerous git grant unexpectedly re-prompted ''${ctx.selectCalls.length} times`);
      }

      // Test: dangerous git project grants persist to .pi/sandbox.json and survive a new session.
      {
        const pi = createPi();
        sandbox(pi);

        const cwd = await makeProject(tempRoot, "git-project-grant", baseConfig);
        const ctx = createContext(cwd, ["Allow for this project"]);
        await startSession(pi, ctx);

        const event = {
          toolName: "bash",
          toolCallId: "git-project-1",
          input: {
            command: "git reset --hard && git clean -fd",
          },
        };

        const result = await getToolCallHandler(pi)(event, ctx);
        assert(result === undefined, "sandbox did not allow the dangerous git command after a project grant");

        const projectConfig = JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "sandbox.json"), "utf-8"));
        assert(
          projectConfig.git.allowedDangerousCommands.includes("hard-reset"),
          "sandbox did not persist the hard-reset project git grant",
        );
        assert(
          projectConfig.git.allowedDangerousCommands.includes("clean"),
          "sandbox did not persist the git-clean project git grant",
        );

        const piReloaded = createPi();
        sandbox(piReloaded);
        const ctxReloaded = createContext(cwd, [], true);
        await startSession(piReloaded, ctxReloaded);

        const followupEvent = {
          toolName: "bash",
          toolCallId: "git-project-2",
          input: {
            command: "git clean -fd",
          },
        };

        const followupResult = await getToolCallHandler(piReloaded)(followupEvent, ctxReloaded);
        assert(followupResult === undefined, "project dangerous git grant did not persist across sessions");
        assert(ctxReloaded.selectCalls.length === 0, `project dangerous git grant unexpectedly re-prompted ''${ctxReloaded.selectCalls.length} times`);
      }

      // Test: dangerous git global grants persist to ~/.pi/agent/sandbox.json and apply in other projects.
      {
        const pi = createPi();
        sandbox(pi);

        const cwd = await makeProject(tempRoot, "git-global-project", baseConfig);
        const ctx = createContext(cwd, ["Allow for all projects"]);
        await startSession(pi, ctx);

        const event = {
          toolName: "bash",
          toolCallId: "git-global-1",
          input: {
            command: "git restore --staged README.md",
          },
        };

        const result = await getToolCallHandler(pi)(event, ctx);
        assert(result === undefined, "sandbox did not allow the dangerous git command after a global grant");

        const globalConfig = JSON.parse(fs.readFileSync(path.join(tempRoot, ".pi", "agent", "sandbox.json"), "utf-8"));
        assert(
          globalConfig.git.allowedDangerousCommands.includes("restore"),
          "sandbox did not persist the global git restore grant",
        );

        const otherCwd = await makeProject(tempRoot, "git-global-other-project", baseConfig);
        const piReloaded = createPi();
        sandbox(piReloaded);
        const ctxReloaded = createContext(otherCwd, [], true);
        await startSession(piReloaded, ctxReloaded);

        const followupEvent = {
          toolName: "bash",
          toolCallId: "git-global-2",
          input: {
            command: "git restore README.md",
          },
        };

        const followupResult = await getToolCallHandler(piReloaded)(followupEvent, ctxReloaded);
        assert(followupResult === undefined, "global dangerous git grant did not apply in another project");
        assert(ctxReloaded.selectCalls.length === 0, `global dangerous git grant unexpectedly re-prompted ''${ctxReloaded.selectCalls.length} times`);
      }

      // Test: headless dangerous git commands are blocked with a clear reason.
      {
        const pi = createPi();
        sandbox(pi);

        const cwd = await makeProject(tempRoot, "git-headless-project", baseConfig);
        const ctx = createContext(cwd, [], false);
        await startSession(pi, ctx);

        const event = {
          toolName: "bash",
          toolCallId: "git-headless-1",
          input: {
            command: "git checkout -- README.md",
          },
        };

        const result = await getToolCallHandler(pi)(event, ctx);
        assert(result && result.block === true, "sandbox did not hard-block dangerous git commands in headless mode");
        assert(String(result.reason).includes("dangerous git command"), "headless dangerous git reason did not mention the command class");
        assert(String(result.reason).includes("git.allowedDangerousCommands"), "headless dangerous git reason did not mention the config key");
      }

      // Test: GitHub allow-once does not persist across bash tool calls.
      {
        const pi = createPi();
        sandbox(pi);

        const cwd = await makeProject(tempRoot, "github-once-project", baseConfig);
        const ctx = createContext(cwd, ["Allow once", "Abort"]);
        await startSession(pi, ctx);

        const firstEvent = {
          toolName: "bash",
          toolCallId: "github-once-1",
          input: {
            command: "gh pr create --title test --body hello",
          },
        };

        const firstResult = await getToolCallHandler(pi)(firstEvent, ctx);
        assert(firstResult === undefined, "sandbox did not allow the GitHub command once");
        assert(ctx.selectCalls.length === 1, `expected one GitHub command prompt, got ''${ctx.selectCalls.length}`);
        assert(String(ctx.selectCalls[0]).includes("GitHub command"), "GitHub command prompt title was not shown");

        const secondEvent = {
          toolName: "bash",
          toolCallId: "github-once-2",
          input: {
            command: "gh pr create --title test2 --body hello",
          },
        };

        const secondResult = await getToolCallHandler(pi)(secondEvent, ctx);
        assert(secondResult && secondResult.block === true, "allow-once GitHub approval should not persist");
        assert(ctx.selectCalls.length === 2, `expected two GitHub command prompts, got ''${ctx.selectCalls.length}`);
      }

      // Test: GitHub session grants persist for the rest of the session.
      {
        const pi = createPi();
        sandbox(pi);

        const cwd = await makeProject(tempRoot, "github-session-project", baseConfig);
        const ctx = createContext(cwd, ["Allow for this session"]);
        await startSession(pi, ctx);

        const firstEvent = {
          toolName: "bash",
          toolCallId: "github-session-1",
          input: {
            command: "gh pr merge 123 --delete-branch",
          },
        };

        const firstResult = await getToolCallHandler(pi)(firstEvent, ctx);
        assert(firstResult === undefined, "sandbox did not allow the GitHub command after a session grant");

        const secondEvent = {
          toolName: "bash",
          toolCallId: "github-session-2",
          input: {
            command: "gh pr review 123 --approve",
          },
        };

        const secondResult = await getToolCallHandler(pi)(secondEvent, ctx);
        assert(secondResult === undefined, "session GitHub grant did not persist across calls");
        assert(ctx.selectCalls.length === 1, `session GitHub grant unexpectedly re-prompted ''${ctx.selectCalls.length} times`);
      }

      // Test: GitHub project grants persist to .pi/sandbox.json and survive a new session.
      {
        const pi = createPi();
        sandbox(pi);

        const cwd = await makeProject(tempRoot, "github-project-grant", baseConfig);
        const ctx = createContext(cwd, ["Allow for this project"]);
        await startSession(pi, ctx);

        const event = {
          toolName: "bash",
          toolCallId: "github-project-1",
          input: {
            command: "gh issue create --title bug --body details",
          },
        };

        const result = await getToolCallHandler(pi)(event, ctx);
        assert(result === undefined, "sandbox did not allow the GitHub command after a project grant");

        const projectConfig = JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "sandbox.json"), "utf-8"));
        assert(
          projectConfig.github.allowedCommands.includes("issue-create"),
          "sandbox did not persist the project GitHub grant",
        );

        const piReloaded = createPi();
        sandbox(piReloaded);
        const ctxReloaded = createContext(cwd, [], true);
        await startSession(piReloaded, ctxReloaded);

        const followupEvent = {
          toolName: "bash",
          toolCallId: "github-project-2",
          input: {
            command: "gh issue create --title bug2 --body more",
          },
        };

        const followupResult = await getToolCallHandler(piReloaded)(followupEvent, ctxReloaded);
        assert(followupResult === undefined, "project GitHub grant did not persist across sessions");
        assert(ctxReloaded.selectCalls.length === 0, `project GitHub grant unexpectedly re-prompted ''${ctxReloaded.selectCalls.length} times`);
      }

      // Test: GitHub global grants persist to ~/.pi/agent/sandbox.json and apply in other projects.
      {
        const pi = createPi();
        sandbox(pi);

        const cwd = await makeProject(tempRoot, "github-global-project", baseConfig);
        const ctx = createContext(cwd, ["Allow for all projects"]);
        await startSession(pi, ctx);

        const event = {
          toolName: "bash",
          toolCallId: "github-global-1",
          input: {
            command: "gh repo archive owner/repo",
          },
        };

        const result = await getToolCallHandler(pi)(event, ctx);
        assert(result === undefined, "sandbox did not allow the GitHub command after a global grant");

        const globalConfig = JSON.parse(fs.readFileSync(path.join(tempRoot, ".pi", "agent", "sandbox.json"), "utf-8"));
        assert(
          globalConfig.github.allowedCommands.includes("repo-modify"),
          "sandbox did not persist the global GitHub grant",
        );

        const otherCwd = await makeProject(tempRoot, "github-global-other-project", baseConfig);
        const piReloaded = createPi();
        sandbox(piReloaded);
        const ctxReloaded = createContext(otherCwd, [], true);
        await startSession(piReloaded, ctxReloaded);

        const followupEvent = {
          toolName: "bash",
          toolCallId: "github-global-2",
          input: {
            command: "gh repo rename owner/repo new-name",
          },
        };

        const followupResult = await getToolCallHandler(piReloaded)(followupEvent, ctxReloaded);
        assert(followupResult === undefined, "global GitHub grant did not apply in another project");
        assert(ctxReloaded.selectCalls.length === 0, `global GitHub grant unexpectedly re-prompted ''${ctxReloaded.selectCalls.length} times`);
      }

      // Test: headless GitHub commands are blocked with a clear reason.
      {
        const pi = createPi();
        sandbox(pi);

        const cwd = await makeProject(tempRoot, "github-headless-project", baseConfig);
        const ctx = createContext(cwd, [], false);
        await startSession(pi, ctx);

        const event = {
          toolName: "bash",
          toolCallId: "github-headless-1",
          input: {
            command: "gh release delete v1.0.0 --yes",
          },
        };

        const result = await getToolCallHandler(pi)(event, ctx);
        assert(result && result.block === true, "sandbox did not hard-block GitHub commands in headless mode");
        assert(String(result.reason).includes("GitHub command"), "headless GitHub reason did not mention the command class");
        assert(String(result.reason).includes("github.allowedCommands"), "headless GitHub reason did not mention the config key");
      }

      // Test: Nix flake mutation allow-once does not persist across bash tool calls.
      {
        const pi = createPi();
        sandbox(pi);

        const cwd = await makeProject(tempRoot, "nix-once-project", baseConfig);
        const ctx = createContext(cwd, ["Allow once", "Abort"]);
        await startSession(pi, ctx);

        const firstEvent = {
          toolName: "bash",
          toolCallId: "nix-once-1",
          input: {
            command: "nix flake update",
          },
        };

        const firstResult = await getToolCallHandler(pi)(firstEvent, ctx);
        assert(firstResult === undefined, "sandbox did not allow the Nix flake mutation command once");
        assert(ctx.selectCalls.length === 1, `expected one Nix flake mutation prompt, got ''${ctx.selectCalls.length}`);
        assert(String(ctx.selectCalls[0]).includes("Nix flake mutation command"), "Nix flake mutation prompt title was not shown");

        const secondEvent = {
          toolName: "bash",
          toolCallId: "nix-once-2",
          input: {
            command: "nix flake update",
          },
        };

        const secondResult = await getToolCallHandler(pi)(secondEvent, ctx);
        assert(secondResult && secondResult.block === true, "allow-once Nix flake mutation approval should not persist");
        assert(ctx.selectCalls.length === 2, `expected two Nix flake mutation prompts, got ''${ctx.selectCalls.length}`);
      }

      // Test: Nix flake mutation session grants persist for the rest of the session and stay sandboxed.
      {
        const pi = createPi();
        sandbox(pi);

        const cwd = await makeProject(tempRoot, "nix-session-project", baseConfig);
        const ctx = createContext(cwd, ["Allow for this session"]);
        await startSession(pi, ctx);

        const firstEvent = {
          toolName: "bash",
          toolCallId: "nix-session-1",
          input: {
            command: "nix flake lock --update-input nixpkgs",
          },
        };

        const firstResult = await getToolCallHandler(pi)(firstEvent, ctx);
        assert(firstResult === undefined, "sandbox did not allow the Nix flake mutation command after a session grant");

        const bashTool = pi.tools.get("bash");
        assert(bashTool, "sandbox did not register the bash tool");
        const firstExecution = await bashTool.execute(firstEvent.toolCallId, firstEvent.input);
        assert(firstExecution.details.operations !== undefined, "approved Nix flake mutation command should stay inside the filesystem sandbox");

        const secondEvent = {
          toolName: "bash",
          toolCallId: "nix-session-2",
          input: {
            command: "nix flake lock --update-input home-manager",
          },
        };

        const secondResult = await getToolCallHandler(pi)(secondEvent, ctx);
        assert(secondResult === undefined, "session Nix flake mutation grant did not persist across calls");
        assert(ctx.selectCalls.length === 1, `session Nix flake mutation grant unexpectedly re-prompted ''${ctx.selectCalls.length} times`);
      }

      // Test: Nix flake mutation project grants persist to .pi/sandbox.json and survive a new session.
      {
        const pi = createPi();
        sandbox(pi);

        const cwd = await makeProject(tempRoot, "nix-project-grant", baseConfig);
        const ctx = createContext(cwd, ["Allow for this project"]);
        await startSession(pi, ctx);

        const event = {
          toolName: "bash",
          toolCallId: "nix-project-1",
          input: {
            command: "nix flake update && nix flake lock --update-input nixpkgs",
          },
        };

        const result = await getToolCallHandler(pi)(event, ctx);
        assert(result === undefined, "sandbox did not allow the Nix flake mutation command after a project grant");

        const projectConfig = JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "sandbox.json"), "utf-8"));
        assert(
          projectConfig.nix.allowedCommands.includes("flake-update"),
          "sandbox did not persist the flake-update project grant",
        );
        assert(
          projectConfig.nix.allowedCommands.includes("flake-lock-update-input"),
          "sandbox did not persist the flake-lock-update-input project grant",
        );

        const piReloaded = createPi();
        sandbox(piReloaded);
        const ctxReloaded = createContext(cwd, [], true);
        await startSession(piReloaded, ctxReloaded);

        const followupEvent = {
          toolName: "bash",
          toolCallId: "nix-project-2",
          input: {
            command: "nix flake lock --update-input home-manager",
          },
        };

        const followupResult = await getToolCallHandler(piReloaded)(followupEvent, ctxReloaded);
        assert(followupResult === undefined, "project Nix flake mutation grant did not persist across sessions");
        assert(ctxReloaded.selectCalls.length === 0, `project Nix flake mutation grant unexpectedly re-prompted ''${ctxReloaded.selectCalls.length} times`);
      }

      // Test: Nix flake mutation global grants persist to ~/.pi/agent/sandbox.json and apply in other projects.
      {
        const pi = createPi();
        sandbox(pi);

        const cwd = await makeProject(tempRoot, "nix-global-project", baseConfig);
        const ctx = createContext(cwd, ["Allow for all projects"]);
        await startSession(pi, ctx);

        const event = {
          toolName: "bash",
          toolCallId: "nix-global-1",
          input: {
            command: "nix flake update",
          },
        };

        const result = await getToolCallHandler(pi)(event, ctx);
        assert(result === undefined, "sandbox did not allow the Nix flake mutation command after a global grant");

        const globalConfig = JSON.parse(fs.readFileSync(path.join(tempRoot, ".pi", "agent", "sandbox.json"), "utf-8"));
        assert(
          globalConfig.nix.allowedCommands.includes("flake-update"),
          "sandbox did not persist the global Nix flake mutation grant",
        );

        const otherCwd = await makeProject(tempRoot, "nix-global-other-project", baseConfig);
        const piReloaded = createPi();
        sandbox(piReloaded);
        const ctxReloaded = createContext(otherCwd, [], true);
        await startSession(piReloaded, ctxReloaded);

        const followupEvent = {
          toolName: "bash",
          toolCallId: "nix-global-2",
          input: {
            command: "nix flake update",
          },
        };

        const followupResult = await getToolCallHandler(piReloaded)(followupEvent, ctxReloaded);
        assert(followupResult === undefined, "global Nix flake mutation grant did not apply in another project");
        assert(ctxReloaded.selectCalls.length === 0, `global Nix flake mutation grant unexpectedly re-prompted ''${ctxReloaded.selectCalls.length} times`);
      }

      // Test: headless Nix flake mutation commands are blocked with a clear reason.
      {
        const pi = createPi();
        sandbox(pi);

        const cwd = await makeProject(tempRoot, "nix-headless-project", baseConfig);
        const ctx = createContext(cwd, [], false);
        await startSession(pi, ctx);

        const event = {
          toolName: "bash",
          toolCallId: "nix-headless-1",
          input: {
            command: "nix flake lock --update-input nixpkgs",
          },
        };

        const result = await getToolCallHandler(pi)(event, ctx);
        assert(result && result.block === true, "sandbox did not hard-block Nix flake mutation commands in headless mode");
        assert(String(result.reason).includes("Nix flake mutation command"), "headless Nix flake mutation reason did not mention the command class");
        assert(String(result.reason).includes("nix.allowedCommands"), "headless Nix flake mutation reason did not mention the config key");
      }

      // Test: configuration apply allow-once does not persist across bash tool calls.
      {
        const pi = createPi();
        sandbox(pi);

        const cwd = await makeProject(tempRoot, "config-apply-once-project", baseConfig);
        const ctx = createContext(cwd, ["Allow once", "Abort"]);
        await startSession(pi, ctx);

        const firstEvent = {
          toolName: "bash",
          toolCallId: "config-apply-once-1",
          input: {
            command: "sudo darwin-rebuild switch --flake /tmp/nix-config",
          },
        };

        const firstResult = await getToolCallHandler(pi)(firstEvent, ctx);
        assert(firstResult === undefined, "sandbox did not allow the configuration apply command once");
        assert(ctx.selectCalls.length === 1, `expected one configuration apply prompt, got ''${ctx.selectCalls.length}`);
        assert(String(ctx.selectCalls[0]).includes("configuration apply command"), "configuration apply prompt title was not shown");

        const secondEvent = {
          toolName: "bash",
          toolCallId: "config-apply-once-2",
          input: {
            command: "darwin-rebuild switch --flake /tmp/nix-config",
          },
        };

        const secondResult = await getToolCallHandler(pi)(secondEvent, ctx);
        assert(secondResult && secondResult.block === true, "allow-once configuration apply approval should not persist");
        assert(ctx.selectCalls.length === 2, `expected two configuration apply prompts, got ''${ctx.selectCalls.length}`);
      }

      // Test: configuration apply session grants persist for the rest of the session.
      {
        const pi = createPi();
        sandbox(pi);

        const cwd = await makeProject(tempRoot, "config-apply-session-project", baseConfig);
        const ctx = createContext(cwd, ["Allow for this session"]);
        await startSession(pi, ctx);

        const firstEvent = {
          toolName: "bash",
          toolCallId: "config-apply-session-1",
          input: {
            command: "nix run nixpkgs#home-manager -- generations",
          },
        };

        const firstResult = await getToolCallHandler(pi)(firstEvent, ctx);
        assert(firstResult === undefined, "sandbox did not allow the configuration apply command after a session grant");

        const bashTool = pi.tools.get("bash");
        assert(bashTool, "sandbox did not register the bash tool");
        const firstExecution = await bashTool.execute(firstEvent.toolCallId, firstEvent.input);
        assert(firstExecution.details.operations === undefined, "approved configuration apply command should run outside the filesystem sandbox");

        const secondEvent = {
          toolName: "bash",
          toolCallId: "config-apply-session-2",
          input: {
            command: "nix run nixpkgs#home-manager -- news",
          },
        };

        const secondResult = await getToolCallHandler(pi)(secondEvent, ctx);
        assert(secondResult === undefined, "session configuration apply grant did not persist across calls");
        assert(ctx.selectCalls.length === 1, `session configuration apply grant unexpectedly re-prompted ''${ctx.selectCalls.length} times`);
      }

      // Test: configuration apply project grants persist to .pi/sandbox.json and survive a new session.
      {
        const pi = createPi();
        sandbox(pi);

        const cwd = await makeProject(tempRoot, "config-apply-project-grant", baseConfig);
        const ctx = createContext(cwd, ["Allow for this project"]);
        await startSession(pi, ctx);

        const event = {
          toolName: "bash",
          toolCallId: "config-apply-project-1",
          input: {
            command: "sudo nixos-rebuild dry-build --flake ~/Workspace/nix-config/.#homecontrol",
          },
        };

        const result = await getToolCallHandler(pi)(event, ctx);
        assert(result === undefined, "sandbox did not allow the configuration apply command after a project grant");

        const projectConfig = JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "sandbox.json"), "utf-8"));
        assert(
          projectConfig.configApply.allowedCommands.includes("nixos-rebuild"),
          "sandbox did not persist the project configuration apply grant",
        );

        const piReloaded = createPi();
        sandbox(piReloaded);
        const ctxReloaded = createContext(cwd, [], true);
        await startSession(piReloaded, ctxReloaded);

        const followupEvent = {
          toolName: "bash",
          toolCallId: "config-apply-project-2",
          input: {
            command: "nixos-rebuild test --flake ~/Workspace/nix-config/.#homecontrol",
          },
        };

        const followupResult = await getToolCallHandler(piReloaded)(followupEvent, ctxReloaded);
        assert(followupResult === undefined, "project configuration apply grant did not persist across sessions");
        assert(ctxReloaded.selectCalls.length === 0, `project configuration apply grant unexpectedly re-prompted ''${ctxReloaded.selectCalls.length} times`);
      }

      // Test: configuration apply global grants persist to ~/.pi/agent/sandbox.json and apply in other projects.
      {
        const pi = createPi();
        sandbox(pi);

        const cwd = await makeProject(tempRoot, "config-apply-global-project", baseConfig);
        const ctx = createContext(cwd, ["Allow for all projects"]);
        await startSession(pi, ctx);

        const event = {
          toolName: "bash",
          toolCallId: "config-apply-global-1",
          input: {
            command: "darwin-rebuild build --flake /Users/taugoust/Workspace/nix-config",
          },
        };

        const result = await getToolCallHandler(pi)(event, ctx);
        assert(result === undefined, "sandbox did not allow the configuration apply command after a global grant");

        const globalConfig = JSON.parse(fs.readFileSync(path.join(tempRoot, ".pi", "agent", "sandbox.json"), "utf-8"));
        assert(
          globalConfig.configApply.allowedCommands.includes("darwin-rebuild"),
          "sandbox did not persist the global configuration apply grant",
        );

        const otherCwd = await makeProject(tempRoot, "config-apply-global-other-project", baseConfig);
        const piReloaded = createPi();
        sandbox(piReloaded);
        const ctxReloaded = createContext(otherCwd, [], true);
        await startSession(piReloaded, ctxReloaded);

        const followupEvent = {
          toolName: "bash",
          toolCallId: "config-apply-global-2",
          input: {
            command: "darwin-rebuild changelog --flake /Users/taugoust/Workspace/nix-config/.#macos-work",
          },
        };

        const followupResult = await getToolCallHandler(piReloaded)(followupEvent, ctxReloaded);
        assert(followupResult === undefined, "global configuration apply grant did not apply in another project");
        assert(ctxReloaded.selectCalls.length === 0, `global configuration apply grant unexpectedly re-prompted ''${ctxReloaded.selectCalls.length} times`);
      }

      // Test: headless configuration apply commands are blocked with a clear reason.
      {
        const pi = createPi();
        sandbox(pi);

        const cwd = await makeProject(tempRoot, "config-apply-headless-project", baseConfig);
        const ctx = createContext(cwd, [], false);
        await startSession(pi, ctx);

        const event = {
          toolName: "bash",
          toolCallId: "config-apply-headless-1",
          input: {
            command: "nix run nixpkgs#nixos-rebuild -- .",
          },
        };

        const result = await getToolCallHandler(pi)(event, ctx);
        assert(result && result.block === true, "sandbox did not hard-block configuration apply commands in headless mode");
        assert(String(result.reason).includes("configuration apply command"), "headless configuration apply reason did not mention the command class");
        assert(String(result.reason).includes("configApply.allowedCommands"), "headless configuration apply reason did not mention the config key");
      }

      // Test: headless mode hard-blocks protected reads with a clear reason.
      {
        const pi = createPi();
        sandbox(pi);

        const cwd = await makeProject(tempRoot, "headless-project", baseConfig);
        const ctx = createContext(cwd, [], false);
        await startSession(pi, ctx);

        const event = {
          toolName: "read",
          toolCallId: "read-2",
          input: {
            path: "~/.ssh/config",
          },
        };

        const result = await getToolCallHandler(pi)(event, ctx);
        assert(result && result.block === true, "sandbox did not hard-block protected reads in headless mode");
        assert(String(result.reason).includes("Blocked in headless mode"), "sandbox headless read reason was not clear");
      }

      // Test: shell builtins mentioning ssh do not trigger SSH capability prompts.
      {
        const pi = createPi();
        sandbox(pi);

        const cwd = await makeProject(tempRoot, "builtin-project", baseConfig);
        const ctx = createContext(cwd, [], true);
        await startSession(pi, ctx);

        const event = {
          toolName: "bash",
          toolCallId: "bash-2",
          input: {
            command: "command -v ssh || true",
          },
        };

        const result = await getToolCallHandler(pi)(event, ctx);
        assert(result === undefined, "shell builtin lookup for ssh should not be blocked");
        const config = SandboxManager.getConfig();
        assert((config.network.allowedDomains ?? []).length === 0, "ssh lookup unexpectedly granted a network domain");
        assert((config.filesystem.denyRead ?? []).includes("~/.ssh"), "ssh lookup unexpectedly relaxed ~/.ssh read policy");
      }

      // Test: harmless URL-like literals do not trigger generic network preflight.
      {
        const pi = createPi();
        sandbox(pi);

        const cwd = await makeProject(tempRoot, "printf-project", baseConfig);
        const ctx = createContext(cwd, [], true);
        await startSession(pi, ctx);

        const event = {
          toolName: "bash",
          toolCallId: "bash-3",
          input: {
            command: "printf 'https://foo.invalid\\n'",
          },
        };

        const result = await getToolCallHandler(pi)(event, ctx);
        assert(result === undefined, "printf with a URL literal should not be blocked");
        assert(ctx.selectCalls.length === 0, `printf unexpectedly prompted ''${ctx.selectCalls.length} times`);
        const config = SandboxManager.getConfig();
        assert(!(config.network.allowedDomains ?? []).includes("foo.invalid"), "printf unexpectedly granted a network domain");
      }

      // Test: generic network approvals come from the runtime ask callback, not bash preflight.
      {
        const pi = createPi();
        sandbox(pi);

        const cwd = await makeProject(tempRoot, "runtime-network-project", baseConfig);
        const ctx = createContext(cwd, ["Allow for this session"], true);
        await startSession(pi, ctx);

        const event = {
          toolName: "bash",
          toolCallId: "bash-4",
          input: {
            command: "curl -I https://example.com",
          },
        };

        const result = await getToolCallHandler(pi)(event, ctx);
        assert(result === undefined, "curl preflight should not block before the runtime callback");
        assert(ctx.selectCalls.length === 0, `curl unexpectedly prompted during bash preflight ''${ctx.selectCalls.length} times`);

        const allowed = await SandboxManager.askNetwork("example.com", 443);
        assert(allowed === true, "runtime network callback did not allow the host after approval");
        assert(ctx.selectCalls.length === 1, `expected one runtime network prompt, got ''${ctx.selectCalls.length}`);
        assert(String(ctx.selectCalls[0]).includes("Sandbox blocked network access"), "runtime network prompt title was not shown");

        const config = SandboxManager.getConfig();
        assert((config.network.allowedDomains ?? []).includes("example.com"), "runtime network approval did not update allowedDomains");
      }

      // Test: headless runtime network requests remain blocked.
      {
        const pi = createPi();
        sandbox(pi);

        const cwd = await makeProject(tempRoot, "runtime-headless-project", baseConfig);
        const ctx = createContext(cwd, [], false);
        await startSession(pi, ctx);

        const allowed = await SandboxManager.askNetwork("example.net", 443);
        assert(allowed === false, "headless runtime network approval should stay blocked");
        const config = SandboxManager.getConfig();
        assert(!(config.network.allowedDomains ?? []).includes("example.net"), "headless runtime network request unexpectedly granted a domain");
      }
    }

    await main();
    EOF

    node "$workdir/test.mjs" "$outdir"

    mkdir -p "$out"
    touch "$out/passed"
  '';
}
