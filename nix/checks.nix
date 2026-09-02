{
  self,
  pkgs,
  pi-mcp-adapter ? null,
  pi-openai-fast-mode ? null,
}:
let
  package = import ./package.nix {
    inherit
      self
      pkgs
      pi-mcp-adapter
      pi-openai-fast-mode
      ;
  };
in
{
  package = package;

  fetch = import ./fetch-check.nix { inherit self pkgs; };
  http-transport = import ./http-transport-check.nix { inherit self pkgs; };

  ssh =
    pkgs.runCommand "ssh-extension-check"
      {
        nativeBuildInputs = [
          pkgs.nodejs
          pkgs.typescript
        ];
      }
      ''
        set -euo pipefail

        workdir="$TMPDIR/ssh-extension-check"
        srcdir="$workdir/src"
        outdir="$workdir/out"
        mkdir -p "$srcdir/ssh" "$srcdir/sandbox" "$srcdir/shared" "$outdir/node_modules/@mariozechner/pi-coding-agent" "$workdir/bin"
        cp ${self}/ssh/index.ts "$srcdir/ssh/index.ts"
        cp ${self}/sandbox/api.ts "$srcdir/sandbox/api.ts"
        cp ${self}/shared/agentsh-mode.ts "$srcdir/shared/agentsh-mode.ts"

        cat > "$outdir/node_modules/@mariozechner/pi-coding-agent/package.json" <<'EOF'
        { "name": "@mariozechner/pi-coding-agent", "type": "module", "main": "./index.js" }
        EOF
        cat > "$outdir/node_modules/@mariozechner/pi-coding-agent/index.js" <<'EOF'
        function tool(name, cwd, options = {}) {
          return {
            name,
            async execute(_id, params) {
              return { content: [{ type: "text", text: `''${name}:''${params.path || cwd}` }], details: { operations: options.operations } };
            },
          };
        }
        export const createReadTool = (cwd, options) => tool("read", cwd, options);
        export const createWriteTool = (cwd, options) => tool("write", cwd, options);
        export const createEditTool = (cwd, options) => tool("edit", cwd, options);
        EOF

        cat > "$workdir/bin/ssh" <<'EOF'
        #!${pkgs.runtimeShell}
        printf '%s\n' "$*" >>"$SSH_TEST_LOG"
        if [ "''${2:-}" = pwd ]; then printf '/remote/home\n'; fi
        EOF
        chmod +x "$workdir/bin/ssh"

        tsc \
          --noCheck \
          --skipLibCheck \
          --module nodenext \
          --moduleResolution nodenext \
          --target es2022 \
          --rootDir "$srcdir" \
          --outDir "$outdir" \
          "$srcdir/ssh/index.ts" "$srcdir/sandbox/api.ts" "$srcdir/shared/agentsh-mode.ts"

        cat > "$workdir/test.mjs" <<'EOF'
        import fs from "node:fs";
        import os from "node:os";
        import path from "node:path";
        import { pathToFileURL } from "node:url";

        const assert = (condition, message) => { if (!condition) throw new Error(message); };

        function createPi(flag) {
          const handlers = new Map();
          const commands = new Map();
          const tools = new Map();
          return {
            handlers, commands, tools,
            registerFlag() {},
            getFlag(name) { return name === "ssh" ? flag : undefined; },
            registerCommand(name, definition) { commands.set(name, definition); },
            registerTool(definition) { tools.set(definition.name, definition); },
            on(name, handler) {
              const values = handlers.get(name) || [];
              values.push(handler);
              handlers.set(name, values);
            },
          };
        }

        function createContext(cwd, sessionFile) {
          const notices = [];
          const statuses = new Map();
          let shutdown = false;
          let waited = false;
          return {
            cwd,
            mode: "tui",
            hasUI: true,
            notices,
            statuses,
            get shutdown() { return shutdown; },
            get waited() { return waited; },
            ui: {
              theme: { fg: (_color, text) => text },
              notify(message, level) { notices.push({ message, level }); },
              setStatus(name, value) { statuses.set(name, value); },
            },
            sessionManager: { getSessionFile: () => sessionFile },
            async waitForIdle() { waited = true; },
            shutdown() { shutdown = true; },
          };
        }

        async function first(pi, name, ...args) {
          const handler = (pi.handlers.get(name) || [])[0];
          assert(handler, `missing handler ''${name}`);
          return await handler(...args);
        }

        const modulePath = path.join(process.argv[2], "ssh/index.js");
        const imported = await import(pathToFileURL(modulePath).href);
        const extension = imported.default?.default ?? imported.default ?? imported;
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-target-test-"));
        const sessionFile = path.join(root, "session.jsonl");

        // Supervised mode selects the AgentSH backend and writes a wrapper request.
        // A brand-new Pi session reserves a path but does not create the file until
        // the first assistant response, so immediate retargeting must request a
        // fresh empty session rather than reject the handoff.
        const requestDir = path.join(root, "control");
        fs.mkdirSync(requestDir, { mode: 0o700 });
        const requestPath = path.join(requestDir, "retarget.json");
        process.env.PI_SUPERVISED = "1";
        process.env.AGENTSH_SESSION_SUPERVISOR = "unix:///tmp/supervisor.sock";
        process.env.PI_AGENTSH_TARGET_KIND = "ssh";
        process.env.PI_AGENTSH_REMOTE_TARGET = "old-host";
        process.env.PI_AGENTSH_REMOTE_CWD = "/old/work";
        process.env.PI_AGENTSH_RETARGET_REQUEST = requestPath;
        process.env.PI_AGENTSH_RETARGET_LOCAL_SUPPORTED = "1";
        let published;
        const execCalls = [];
        globalThis.__AGENTSH_PI__ = {
          setExecutionTarget(target) { published = target; },
          getExecutionTarget() { return published; },
          getSupervisorState() { return { configured: true, active: true, protocol: "rest", status: "connected" }; },
          async exec(command, options) { execCalls.push({ command, options }); return { exitCode: 0 }; },
        };

        const supervisedPi = createPi(undefined);
        extension(supervisedPi);
        const supervisedCtx = createContext(root, sessionFile);
        await first(supervisedPi, "session_start", {}, supervisedCtx);
        assert(published?.kind === "ssh" && published.remote === "old-host" && published.cwd === "/old/work", "supervised target was not published");
        assert(supervisedPi.tools.size === 0, "ssh extension must not replace sandbox tools");
        const userBash = await first(supervisedPi, "user_bash", { command: "pwd" }, supervisedCtx);
        await userBash.operations.exec("pwd", root, { onData() {} });
        assert(execCalls[0]?.command?.cwd === "/old/work", "supervised ! command did not use AgentSH target cwd");
        const prompt = await first(supervisedPi, "before_agent_start", { systemPrompt: `Current working directory: ''${process.cwd()}` }, supervisedCtx);
        assert(prompt.systemPrompt.includes("remote AgentSH sandbox over SSH: old-host"), "supervised prompt did not describe the target");
        await supervisedPi.commands.get("retarget").handler("new-host:/new/work", supervisedCtx);
        assert(supervisedCtx.waited && supervisedCtx.shutdown, "supervised retarget did not wait and shut down gracefully");
        const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
        assert(request.schema_version === 1 && request.target === "new-host:/new/work" && request.session_file === null, "invalid wrapper retarget request for a fresh session");
        assert((fs.statSync(requestPath).mode & 0o777) === 0o600, "retarget request is not private");

        delete globalThis.__AGENTSH_PI__;
        const unavailablePi = createPi(undefined);
        extension(unavailablePi);
        for (const toolName of ["bash", "write", "edit", "read"]) {
          const blocked = await first(unavailablePi, "tool_call", { toolName, input: { command: "printf no-fallback" } }, supervisedCtx);
          assert(blocked?.block === true, "unavailable full mode did not block native " + toolName);
        }

        // Legacy mode owns raw SSH and can switch back to local in-process.
        for (const name of [
          "PI_SUPERVISED", "AGENTSH_SESSION_SUPERVISOR", "PI_AGENTSH_TARGET_KIND",
          "PI_AGENTSH_REMOTE_TARGET", "PI_AGENTSH_REMOTE_CWD", "PI_AGENTSH_RETARGET_REQUEST",
          "PI_AGENTSH_RETARGET_LOCAL_SUPPORTED",
        ]) delete process.env[name];
        delete globalThis.__AGENTSH_PI__;
        const legacyPi = createPi("legacy:/repo");
        extension(legacyPi);
        const legacyCtx = createContext(root, sessionFile);
        await first(legacyPi, "session_start", {}, legacyCtx);
        assert(legacyPi.tools.size === 3, "legacy SSH tools were not registered");
        const event = { toolName: "bash", input: { command: "echo ok" } };
        await first(legacyPi, "tool_call", event, legacyCtx);
        assert(event.input.command.includes("ssh 'legacy'"), "legacy bash was not routed through SSH");
        await legacyPi.commands.get("retarget").handler("", legacyCtx);
        const localBash = await first(legacyPi, "user_bash", { command: "pwd" }, legacyCtx);
        assert(localBash === undefined, "legacy local retarget still intercepted user bash");
        await legacyPi.commands.get("retarget").handler("other-host", legacyCtx);
        const remoteBash = await first(legacyPi, "user_bash", { command: "pwd" }, legacyCtx);
        assert(remoteBash?.operations, "legacy host retarget did not restore SSH routing");
        assert(fs.readFileSync(process.env.SSH_TEST_LOG, "utf8").includes("other-host pwd"), "host-only retarget did not resolve remote pwd");

        let invalidRejected = false;
        try { imported.parseSshArg("\n"); } catch (error) { invalidRejected = /non-empty single-line/.test(String(error)); }
        assert(invalidRejected, "invalid target accepted");
        console.log("ssh extension checks passed");
        EOF

        export SSH_TEST_LOG="$workdir/ssh.log"
        export PATH="$workdir/bin:$PATH"
        cd "$workdir"
        node "$workdir/test.mjs" "$outdir"
        touch "$out"
      '';

  questionnaire =
    let
      moduleResult = pkgs.lib.evalModules {
        modules = [
          {
            options.home.packages = pkgs.lib.mkOption {
              type = pkgs.lib.types.listOf pkgs.lib.types.package;
              default = [ ];
            };
            options.home.file = pkgs.lib.mkOption {
              type = pkgs.lib.types.attrsOf pkgs.lib.types.anything;
              default = { };
            };
          }
          self.homeManagerModules.default
          {
            programs.pi.enable = true;
            programs.pi.package = null;
            programs.pi.extensions.questionnaire.enable = true;
          }
        ];
        specialArgs = { inherit pkgs; };
      };
      moduleFiles = moduleResult.config.home.file;
      questionnaireBundle = self.packages.${pkgs.stdenv.hostPlatform.system}.example-auto-extensions;
    in
    pkgs.runCommand "questionnaire-check"
      {
        nativeBuildInputs = [
          pkgs.nodejs
          pkgs.typescript
        ];
      }
      ''
        set -euo pipefail

        workdir="$TMPDIR/questionnaire-check"
        srcdir="$workdir/src"
        outdir="$workdir/out"
        mkdir -p "$srcdir/questionnaire" "$outdir"
        cp ${self}/questionnaire/paseo.ts "$srcdir/questionnaire/paseo.ts"

        test ${toString (builtins.length (builtins.attrNames moduleFiles))} = 2
        test -f ${moduleFiles.".pi/agent/extensions/questionnaire/index.ts".source}
        test -f ${moduleFiles.".pi/agent/extensions/questionnaire/paseo.ts".source}
        test -f ${questionnaireBundle}/questionnaire/index.ts
        test -f ${questionnaireBundle}/questionnaire/paseo.ts

        tsc \
          --strict \
          --skipLibCheck \
          --module nodenext \
          --moduleResolution nodenext \
          --target es2022 \
          --rootDir "$srcdir" \
          --outDir "$outdir" \
          "$srcdir/questionnaire/paseo.ts"

        cat > "$workdir/test.mjs" <<'EOF'
        import { pathToFileURL } from "node:url";
        import path from "node:path";

        function assert(condition, message) {
          if (!condition) throw new Error(message);
        }

        const moduleUrl = pathToFileURL(path.join(process.argv[2], "questionnaire/paseo.js")).href;
        const { answerQuestionnaireInPaseo } = await import(moduleUrl);
        const questions = [
          {
            id: "scope",
            label: "Scope",
            prompt: "Which scope?",
            options: [
              { value: "one", label: "Same", description: "First choice" },
              { value: "two", label: "Same", description: "Second choice" },
            ],
          },
          {
            id: "priority",
            label: "Priority",
            prompt: "Which priority?",
            options: [{ value: "high", label: "High" }],
          },
        ];

        delete globalThis.__piPaseoRemoteUiV1;
        assert(await answerQuestionnaireInPaseo(questions) === null, "missing Paseo bridge did not use terminal fallback");

        let calls = 0;
        globalThis.__piPaseoRemoteUiV1 = {
          isConnected: () => false,
          select: async () => { calls += 1; return "1. Same"; },
        };
        assert(await answerQuestionnaireInPaseo(questions) === null, "disconnected Paseo bridge did not use terminal fallback");
        assert(calls === 0, "disconnected Paseo bridge was called");

        const remoteCalls = [];
        const controller = new AbortController();
        globalThis.__piPaseoRemoteUiV1 = {
          isConnected: () => true,
          async select(title, options, settings) {
            remoteCalls.push({ title, options, settings });
            return remoteCalls.length === 1 ? "2. Same" : "1. High";
          },
        };
        const answered = await answerQuestionnaireInPaseo(questions, controller.signal);
        assert(answered.kind === "answered", "Paseo questionnaire was not answered");
        assert(answered.answers[0].value === "two" && answered.answers[0].index === 2, "Paseo questionnaire confused duplicate labels");
        assert(answered.answers[1].value === "high", "Paseo questionnaire lost second answer");
        assert(remoteCalls.length === 2, "multi-question Paseo questionnaire did not use sequential cards");
        assert(remoteCalls[0].title.includes("Question 1 of 2 · Scope"), "Paseo questionnaire omitted progress and label");
        assert(remoteCalls[0].title.includes("First choice") && remoteCalls[0].title.includes("Second choice"), "Paseo questionnaire omitted descriptions");
        assert(remoteCalls[0].options.join(",") === "1. Same,2. Same,Answer in terminal,Cancel questionnaire", "Paseo questionnaire choices changed");
        assert(remoteCalls[0].settings.signal === controller.signal, "Paseo questionnaire dropped cancellation signal");

        globalThis.__piPaseoRemoteUiV1.select = async () => "Answer in terminal";
        const terminal = await answerQuestionnaireInPaseo(questions);
        assert(terminal.kind === "terminal", "Paseo questionnaire terminal handoff failed");

        globalThis.__piPaseoRemoteUiV1.select = async () => "unexpected";
        const unknown = await answerQuestionnaireInPaseo(questions);
        assert(unknown.kind === "cancelled", "unknown Paseo questionnaire choice did not fail closed");

        globalThis.__piPaseoRemoteUiV1.select = async () => { throw new Error("disconnected"); };
        const failed = await answerQuestionnaireInPaseo(questions);
        assert(failed.kind === "cancelled", "failed Paseo questionnaire did not fail closed");
        delete globalThis.__piPaseoRemoteUiV1;
        EOF

        node "$workdir/test.mjs" "$outdir"
        mkdir -p "$out"
        touch "$out/passed"
      '';

  slow-mode =
    pkgs.runCommand "slow-mode-check"
      {
        nativeBuildInputs = [
          pkgs.nodejs
          pkgs.typescript
        ];
      }
      ''
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

          // Test: attached Paseo and the terminal receive mirrored write reviews.
          {
            const pi = createPi();
            slowMode(pi);
            const cwd = path.join(tempRoot, "paseo-write");
            fs.mkdirSync(cwd, { recursive: true });
            const customUI = createCustomUI([[], []]);
            const ctx = createContext(cwd, customUI);
            ctx.signal = new AbortController().signal;
            await enableSlowMode(pi, ctx);

            const remoteCalls = [];
            globalThis.__piPaseoRemoteUiV1 = {
              isConnected: () => true,
              async select(title, options, settings) {
                remoteCalls.push({ title, options, settings });
                return "Approve";
              },
              async selectMirrored(title, options, localSelect, settings) {
                remoteCalls.push({ title, options, settings });
                const controller = new AbortController();
                const local = localSelect(controller.signal);
                await new Promise((resolve) => setTimeout(resolve, 0));
                controller.abort();
                await local;
                return options.includes("Approve") ? "Approve" : "Reject";
              },
            };
            const event = {
              toolName: "write",
              toolCallId: "paseo-write-1",
              input: { path: "remote.txt", content: "remote content\n" },
            };
            const result = await getToolCallHandler(pi)(event, ctx);
            assert(result === undefined, "Paseo write approval did not allow the write");
            assert(customUI.calls === 1, "Paseo write approval was not mirrored to terminal UI");
            assert(remoteCalls.length === 1, "Paseo write review was not requested exactly once");
            assert(remoteCalls[0].title.includes("Slow mode WRITE review"), "Paseo write title omitted operation");
            assert(remoteCalls[0].title.includes("remote.txt") && remoteCalls[0].title.includes("remote content"), "Paseo write review omitted path or content");
            assert(remoteCalls[0].options.join(",") === "Approve,Reject", "mirrored Paseo write options changed");
            assert(remoteCalls[0].settings.signal === ctx.signal, "Paseo write review dropped cancellation signal");

            const oversized = await getToolCallHandler(pi)({
              toolName: "write",
              toolCallId: "paseo-write-oversized",
              input: { path: "oversized.txt", content: "x".repeat(50_001) },
            }, ctx);
            assert(oversized?.block === true, "Paseo accepted an approval label omitted from an oversized review");
            assert(customUI.calls === 2, "oversized Paseo review was not mirrored to terminal UI");
            assert(remoteCalls[1].options.join(",") === "Reject", "oversized mirrored Paseo review offered remote approval");
            assert(remoteCalls[1].title.includes("additional characters omitted"), "oversized Paseo review omitted truncation warning");
            delete globalThis.__piPaseoRemoteUiV1;
          }

          // Test: attached Paseo receives edit diffs and denial fails closed.
          {
            const pi = createPi();
            slowMode(pi);
            const cwd = path.join(tempRoot, "paseo-edit");
            fs.mkdirSync(cwd, { recursive: true });
            fs.writeFileSync(path.join(cwd, "demo.txt"), "alpha\nbeta\n");
            const customUI = createCustomUI([]);
            const ctx = createContext(cwd, customUI);
            await enableSlowMode(pi, ctx);

            const remoteCalls = [];
            globalThis.__piPaseoRemoteUiV1 = {
              isConnected: () => true,
              async select(title, options) {
                remoteCalls.push({ title, options });
                return "Reject";
              },
            };
            const event = {
              toolName: "edit",
              toolCallId: "paseo-edit-1",
              input: { path: "demo.txt", edits: [{ oldText: "beta", newText: "gamma" }] },
            };
            const result = await getToolCallHandler(pi)(event, ctx);
            assert(result?.block === true, "Paseo edit denial did not block the edit");
            assert(customUI.calls === 0, "Paseo edit denial also opened terminal UI");
            assert(remoteCalls.length === 1, "Paseo edit review was not requested exactly once");
            assert(remoteCalls[0].title.includes("Slow mode EDIT review"), "Paseo edit title omitted operation");
            assert(remoteCalls[0].title.includes("-beta") && remoteCalls[0].title.includes("+gamma"), "Paseo edit review omitted diff");

            globalThis.__piPaseoRemoteUiV1.select = async () => { throw new Error("disconnected"); };
            const failed = await getToolCallHandler(pi)({
              toolName: "write",
              toolCallId: "paseo-write-failed",
              input: { path: "failed.txt", content: "must not pass\n" },
            }, ctx);
            assert(failed?.block === true, "Paseo review failure did not fail closed");
            delete globalThis.__piPaseoRemoteUiV1;
          }

          // Test: Paseo can hand a review back to the terminal's full custom UI.
          {
            const pi = createPi();
            slowMode(pi);
            const cwd = path.join(tempRoot, "paseo-terminal-fallback");
            fs.mkdirSync(cwd, { recursive: true });
            const customUI = createCustomUI([["<enter>"]]);
            const ctx = createContext(cwd, customUI);
            await enableSlowMode(pi, ctx);
            globalThis.__piPaseoRemoteUiV1 = {
              isConnected: () => true,
              select: async () => "Review in terminal",
            };
            const result = await getToolCallHandler(pi)({
              toolName: "write",
              toolCallId: "paseo-terminal-1",
              input: { path: "terminal.txt", content: "review locally\n" },
            }, ctx);
            assert(result === undefined && customUI.calls === 1, "Paseo terminal handoff did not use custom UI");
            delete globalThis.__piPaseoRemoteUiV1;
          }
        }

        await main();
        EOF

        node "$workdir/test.mjs" "$outdir"

        mkdir -p "$out"
        touch "$out/passed"
      '';

  fence =
    pkgs.runCommand "fence-check"
      {
        nativeBuildInputs = [
          pkgs.nodejs
          pkgs.typescript
        ];
      }
      ''
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

  direnv =
    pkgs.runCommand "direnv-check"
      {
        nativeBuildInputs = [
          pkgs.nodejs
          pkgs.typescript
        ];
      }
      ''
        set -euo pipefail

        workdir="$TMPDIR/direnv-check"
        srcdir="$workdir/src"
        outdir="$workdir/out"
        mkdir -p "$srcdir/direnv" "$srcdir/sandbox" "$srcdir/shared" "$outdir"
        cp ${self}/direnv/index.ts "$srcdir/direnv/index.ts"
        cp ${self}/sandbox/api.ts "$srcdir/sandbox/api.ts"
        cp ${self}/shared/agentsh-mode.ts "$srcdir/shared/agentsh-mode.ts"

        tsc \
          --noCheck \
          --skipLibCheck \
          --module nodenext \
          --moduleResolution nodenext \
          --target es2022 \
          --rootDir "$srcdir" \
          --outDir "$outdir" \
          "$srcdir/direnv/index.ts" \
          "$srcdir/sandbox/api.ts" \
          "$srcdir/shared/agentsh-mode.ts"

        cat > "$workdir/test.mjs" <<'EOF'
        import fs from "node:fs";
        import os from "node:os";
        import path from "node:path";
        import { pathToFileURL } from "node:url";

        function assert(condition, message) {
          if (!condition) throw new Error(message);
        }

        function createPi() {
          const handlers = new Map();
          return {
            handlers,
            on(event, handler) {
              const list = handlers.get(event) ?? [];
              list.push(handler);
              handlers.set(event, list);
            },
          };
        }

        function createContext(cwd, hasUI = true) {
          const statuses = [];
          const notifications = [];
          return {
            cwd,
            hasUI,
            statuses,
            notifications,
            ui: {
              theme: { fg: (_color, text) => text },
              setStatus(name, value) { statuses.push({ name, value }); },
              notify(message, level) { notifications.push({ message, level }); },
            },
          };
        }

        async function emit(pi, event, payload, ctx) {
          for (const handler of pi.handlers.get(event) ?? []) await handler(payload, ctx);
        }

        async function main() {
          const moduleUrl = pathToFileURL(path.join(process.argv[2], "direnv/index.js")).href;
          const imported = await import(moduleUrl);
          const direnv = imported.default?.default ?? imported.default ?? imported;
          assert(typeof direnv === "function", "direnv module did not export a function");

          const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "direnv-check-"));
          const bin = path.join(tempRoot, "bin");
          const spawnMarker = path.join(tempRoot, "spawned.log");
          fs.mkdirSync(bin);
          fs.writeFileSync(path.join(bin, "direnv"), [
            "#!/bin/sh",
            "printf 'spawned\\n' >> \"$DIRENV_SPAWN_MARKER\"",
            "printf '%s\\n' '{\"DIRENV_CHECK_SET\":\"from-local\",\"DIRENV_CHECK_UNSET\":null}'",
          ].join("\n"), { mode: 0o755 });
          process.env.PATH = bin + path.delimiter + process.env.PATH;
          process.env.DIRENV_SPAWN_MARKER = spawnMarker;

          // pi-unsafe/non-AgentSH behaviour remains the local process.env hook.
          for (const name of [
            "PI_SUPERVISED", "PI_AUTO", "PI_AGENTSH_REMOTE", "PI_AGENTSH_READ_MODE",
            "AGENTSH_SESSION_SUPERVISOR", "PI_AGENTSH_MOCK_SUPERVISOR", "PI_AGENTSH_ENABLE",
            "AGENTSH_CHILD_CAPABILITY", "AGENTSH_APPROVAL_UI_SOCKET", "AGENTSH_PERMISSION_GATE_SOCKET",
          ]) delete process.env[name];
          delete globalThis.__AGENTSH_PI__;
          process.env.DIRENV_CHECK_UNSET = "remove-me";
          {
            const pi = createPi();
            direnv(pi);
            const ctx = createContext(tempRoot);
            await emit(pi, "session_start", {}, ctx);
            assert(process.env.DIRENV_CHECK_SET === "from-local", "unsupervised direnv did not set process.env");
            assert(process.env.DIRENV_CHECK_UNSET === undefined, "unsupervised direnv did not unset process.env");
            assert(fs.readFileSync(spawnMarker, "utf8").trim() === "spawned", "unsupervised direnv did not invoke the local binary");
          }

          // Supervised mode delegates session-start and post-bash refreshes, uses
          // the supplied execution cwd, serializes calls, and never spawns locally.
          process.env.PI_SUPERVISED = "1";
          process.env.AGENTSH_SESSION_ID = "sess-direnv";
          fs.writeFileSync(spawnMarker, "");
          process.env.AGENTSH_CONTROL_SENTINEL = "parent-owned";
          const calls = [];
          let active = 0;
          let maxActive = 0;
          let nextState = "loaded";
          globalThis.__AGENTSH_PI__ = {
            getSupervisorState() {
              return { configured: true, active: true, protocol: "rest", status: "connected" };
            },
            async refreshDirenv(options) {
              calls.push(options);
              active += 1;
              maxActive = Math.max(maxActive, active);
              await new Promise((resolve) => setTimeout(resolve, 20));
              active -= 1;
              return { state: nextState, set_count: 1, unset_count: 0, rejected_count: 1, generation: calls.length, duration_ms: 1 };
            },
          };
          {
            const pi = createPi();
            direnv(pi);
            const ctx = createContext("/execution/workspace");
            await emit(pi, "session_start", {}, ctx);
            await Promise.all([
              emit(pi, "tool_result", { toolName: "bash" }, ctx),
              emit(pi, "tool_result", { toolName: "bash" }, ctx),
            ]);
            assert(calls.length === 3, "supervised direnv did not refresh on startup and both bash results");
            assert(calls.every((call) => call.cwd === "/execution/workspace"), "supervised direnv sent the wrong cwd");
            assert(calls.every((call) => call.actor?.kind === "extension"), "supervised direnv omitted its typed extension actor");
            assert(maxActive === 1, "supervised direnv refreshes were not serialized");
            assert(fs.readFileSync(spawnMarker, "utf8") === "", "supervised direnv spawned the local binary");
            assert(process.env.AGENTSH_CONTROL_SENTINEL === "parent-owned", "supervised response mutated protected parent environment");

            nextState = "no_envrc";
            await emit(pi, "tool_result", { toolName: "bash" }, ctx);
            assert(ctx.statuses.some((entry) => entry.name === "direnv" && entry.value === undefined), "no_envrc did not clear the status");

            nextState = "not_allowed";
            await emit(pi, "tool_result", { toolName: "bash" }, ctx);
            await emit(pi, "tool_result", { toolName: "bash" }, ctx);
            const allowWarnings = ctx.notifications.filter((entry) => entry.level === "warning" && entry.message.includes("direnv allow"));
            assert(allowWarnings.length === 1, "repeated not_allowed refreshes emitted duplicate warnings");
          }

          // A separate supervised session still reports an initial policy denial.
          nextState = "policy_denied";
          {
            const pi = createPi();
            direnv(pi);
            const ctx = createContext("/execution/workspace");
            await emit(pi, "session_start", {}, ctx);
            assert(ctx.notifications.some((entry) => entry.level === "error" && entry.message.includes("policy denied")), "policy_denied was not clear and non-fatal");
          }

          // Missing/old sandbox integration fails closed: no trusted-parent fallback.
          delete globalThis.__AGENTSH_PI__;
          fs.writeFileSync(spawnMarker, "");
          {
            const pi = createPi();
            direnv(pi);
            const ctx = createContext(tempRoot);
            await emit(pi, "session_start", {}, ctx);
            assert(fs.readFileSync(spawnMarker, "utf8") === "", "missing AgentSH API fell back to local direnv");
            assert(ctx.notifications.some((entry) => entry.message.includes("will not run direnv in the parent")), "missing AgentSH API diagnostic was not fail-closed");
          }
        }

        await main();
        EOF

        node "$workdir/test.mjs" "$outdir"
        mkdir -p "$out"
        touch "$out/passed"
      '';

  permission-gate =
    pkgs.runCommand "permission-gate-check"
      {
        nativeBuildInputs = [
          pkgs.nodejs
          pkgs.typescript
        ];
      }
      ''
        set -euo pipefail

        workdir="$TMPDIR/permission-gate-check"
        mkdir -p "$workdir/src/permission-gate" "$workdir/src/shared" "$workdir/out"
        cp ${self}/permission-gate/index.ts "$workdir/src/permission-gate/index.ts"
        cp ${self}/shared/agentsh-mode.ts "$workdir/src/shared/agentsh-mode.ts"
        printf '%s\n' '{"type":"module"}' > "$workdir/src/package.json"
        tsc \
          --noCheck \
          --skipLibCheck \
          --module nodenext \
          --moduleResolution nodenext \
          --target es2022 \
          --rootDir "$workdir/src" \
          --outDir "$workdir/out" \
          "$workdir/src/permission-gate/index.ts" \
          "$workdir/src/shared/agentsh-mode.ts"

        cat > "$workdir/test.mjs" <<'EOF'
        import { spawn } from "node:child_process";
        import fs from "node:fs";
        import net from "node:net";
        import os from "node:os";
        import path from "node:path";
        import readline from "node:readline";
        import { once } from "node:events";
        import { fileURLToPath } from "node:url";
        import gate from "./out/permission-gate/index.js";

        const assert = (condition, message) => { if (!condition) throw new Error(message); };
        const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

        function createPi() {
          const handlers = new Map();
          const commands = new Map();
          const emitted = [];
          return {
            handlers,
            commands,
            emitted,
            events: { emit(name) { emitted.push(name); } },
            registerCommand(name, definition) { commands.set(name, definition); },
            on(name, handler) { handlers.set(name, handler); },
          };
        }

        function createContext(options = {}) {
          const statuses = [];
          const notifications = [];
          const selections = [];
          const controller = options.controller || new AbortController();
          return {
            cwd: "/exact/workspace",
            mode: "tui",
            hasUI: options.hasUI !== false,
            signal: controller.signal,
            controller,
            statuses,
            notifications,
            selections,
            ui: {
              theme: { fg: (_color, text) => text },
              setStatus(name, value) { statuses.push({ name, value }); },
              notify(message, level) { notifications.push({ message, level }); },
              async select(title, choices, settings) {
                selections.push({ title, choices, signal: settings?.signal });
                if (options.onSelect) return await options.onSelect(title, choices, settings, controller);
                return options.choice;
              },
            },
          };
        }

        async function runInheritedChild(name) {
          assert(process.env.AGENTSH_PERMISSION_GATE_SOCKET === undefined, "gate socket marker was not claimed and deleted during import");
          const pi = createPi();
          let remoteSelections = [];
          let contextOptions = { choice: "Allow" };
          if (name === "local-deny") contextOptions.choice = "Deny";
          if (name === "cancel") contextOptions.choice = undefined;
          if (name === "headless") contextOptions.hasUI = false;
          if (name === "prompt-timeout") {
            contextOptions.onSelect = async () => await new Promise(() => {});
          }
          if (name === "abort" || name === "transport-eof") {
            contextOptions.onSelect = async (_title, _choices, settings, controller) => {
              assert(settings?.signal, "AgentSH terminal prompt omitted its signal");
              if (name === "abort") setTimeout(() => controller.abort(), 5);
              await new Promise((resolve) => settings.signal.addEventListener("abort", resolve, { once: true }));
              return undefined;
            };
          }
          if (name === "remote-allow") {
            globalThis.__piPaseoRemoteUiV1 = {
              isConnected: () => true,
              async select(title, choices, settings) {
                remoteSelections.push({ title, choices, signal: Boolean(settings?.signal) });
                return "Allow";
              },
              async selectMirrored(title, choices, localSelect, settings) {
                remoteSelections.push({ title, choices, signal: Boolean(settings?.signal) });
                const controller = new AbortController();
                const local = localSelect(controller.signal);
                await new Promise((resolve) => setTimeout(resolve, 0));
                controller.abort();
                await local;
                return "Allow";
              },
            };
            contextOptions.onSelect = async (_title, _choices, settings) => {
              await new Promise((resolve) => settings.signal.addEventListener("abort", resolve, { once: true }));
              return undefined;
            };
          }

          const ctx = createContext(contextOptions);
          gate(pi);
          await pi.handlers.get("session_start")({}, ctx);
          const tool = pi.handlers.get("tool_call");
          const results = [];
          if (name === "local-allow") {
            results.push(await tool({ toolName: "bash", toolCallId: "tool-safe", input: { command: "printf safe" } }, ctx));
          }
          if (name === "background-allow") {
            results.push(await tool({ toolName: "background_job", toolCallId: "tool-background-list", input: { action: "list" } }, ctx));
            results.push(await tool({ toolName: "background_job", toolCallId: "tool-background-start", input: { action: "start", command: "printf background" } }, ctx));
          } else {
            results.push(await tool({ toolName: "bash", toolCallId: "tool-dangerous", input: { command: "sudo true" } }, ctx));
          }
          delete globalThis.__piPaseoRemoteUiV1;
          process.stdout.write(JSON.stringify({
            allowed: results.map((result) => result === undefined),
            blocked: results.map((result) => result?.block === true),
            reasons: results.map((result) => result?.reason || ""),
            selections: ctx.selections.map((selection) => ({
              title: selection.title,
              choices: selection.choices,
              signal: Boolean(selection.signal),
            })),
            remoteSelections: remoteSelections.map((selection) => ({
              title: selection.title,
              choices: selection.choices,
              signal: selection.signal,
            })),
            emitted: pi.emitted,
            notifications: ctx.notifications,
          }));
        }

        function lineReader(socket) {
          const lines = readline.createInterface({ input: socket, crlfDelay: Infinity });
          const iterator = lines[Symbol.asyncIterator]();
          return async () => {
            let timer;
            try {
              const result = await Promise.race([
                iterator.next(),
                new Promise((_, reject) => {
                  timer = setTimeout(() => reject(new Error("timed out waiting for client frame")), 2000);
                }),
              ]);
              if (result.done) throw new Error("permission gate client closed before its next frame");
              return JSON.parse(result.value);
            } finally {
              clearTimeout(timer);
            }
          };
        }

        function send(socket, message) {
          socket.write(JSON.stringify(message) + "\n");
        }

        async function expectHello(read, socket, fragmented = false) {
          const hello = await read();
          assert(JSON.stringify(hello) === JSON.stringify({ v: 1, type: "hello", client: "pi-permission-gate" }), "invalid client hello: " + JSON.stringify(hello));
          const response = JSON.stringify({ v: 1, type: "hello", service: "agentsh-permission-gate", capabilities: ["bash", "resolve", "cancel"] }) + "\n";
          if (fragmented) {
            socket.write(response.slice(0, 9));
            await delay(2);
            socket.write(response.slice(9));
          } else {
            socket.write(response);
          }
        }

        function assertAuthorize(request, command, toolCallId) {
          assert(request.v === 1 && request.type === "authorize" && request.kind === "bash", "invalid authorize envelope");
          assert(request.command === command, "authorize changed the exact Bash command");
          assert(request.cwd === "/exact/workspace", "authorize changed the exact cwd");
          assert(request.tool_call_id === toolCallId, "authorize changed the exact toolCallId");
          assert(typeof request.id === "string" && request.id.length > 0, "authorize omitted its correlation ID");
        }

        const prompt = {
          title: "Dangerous command requires approval",
          message: "Detected: sudo",
          labels: ["sudo"],
          command_preview: "sudo true",
        };

        async function promptedBroker(socket, expectedFinish, fragmentedHello = false) {
          const read = lineReader(socket);
          await expectHello(read, socket, fragmentedHello);
          const request = await read();
          assertAuthorize(request, "sudo true", "tool-dangerous");
          send(socket, { v: 1, type: "decision", id: request.id, decision: "prompt", prompt });
          const finish = await read();
          assert(finish.v === 1 && finish.id === request.id && finish.type === expectedFinish.type, "client sent the wrong terminal prompt frame");
          if (expectedFinish.type === "resolve") {
            assert(finish.decision === expectedFinish.decision, "client sent the wrong resolution");
          } else {
            assert(finish.reason === expectedFinish.reason, "client sent the wrong cancellation reason: " + finish.reason);
          }
          send(socket, {
            v: 1,
            type: "complete",
            id: request.id,
            decision: expectedFinish.decision || "deny",
            reason: expectedFinish.decision === "allow" ? "approved by Pi user interface" : (finish.reason || "denied by Pi user interface"),
          });
        }

        async function spawnInheritedChild(name, broker, timeout) {
          const root = fs.mkdtempSync(path.join(os.tmpdir(), "permission-gate-check-"));
          const socketPath = path.join(root, "gate.sock");
          const server = net.createServer();
          await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, resolve);
          });
          const accepted = new Promise((resolve) => server.once("connection", resolve));

          const environment = {
            ...process.env,
            AGENTSH_PERMISSION_GATE_SOCKET: socketPath,
            PERMISSION_GATE_CHILD_CASE: name,
          };
          if (timeout !== undefined) environment.PI_AGENTSH_PERMISSION_GATE_TIMEOUT_MS = String(timeout);
          for (const variable of [
            "PI_SUPERVISED", "PI_AUTO", "PI_AGENTSH_REMOTE", "PI_AGENTSH_READ_MODE",
            "AGENTSH_SESSION_SUPERVISOR", "AGENTSH_APPROVAL_UI_SOCKET",
            "PI_AGENTSH_MOCK_SUPERVISOR", "PI_AGENTSH_ENABLE", "AGENTSH_CHILD_CAPABILITY",
          ]) delete environment[variable];

          const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
            env: environment,
            stdio: ["ignore", "pipe", "pipe"],
          });
          const peer = await accepted;
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => { stdout += chunk; });
          child.stderr.on("data", (chunk) => { stderr += chunk; });

          try {
            await broker(peer, () => stdout);
            let timer;
            const [code, childSignal] = await Promise.race([
              once(child, "close"),
              new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("permission gate child hung")), 3000);
              }),
            ]).finally(() => clearTimeout(timer));
            assert(code === 0, "permission gate child failed (signal " + childSignal + "): " + stderr);
            return JSON.parse(stdout);
          } catch (error) {
            child.kill("SIGKILL");
            throw error;
          } finally {
            peer.destroy();
            server.close();
            fs.rmSync(root, { recursive: true, force: true });
          }
        }

        async function runInheritedChecks() {
          const allowed = await spawnInheritedChild("local-allow", async (socket, stdout) => {
            const read = lineReader(socket);
            await expectHello(read, socket, true);
            const harmless = await read();
            assertAuthorize(harmless, "printf safe", "tool-safe");
            send(socket, { v: 1, type: "decision", id: harmless.id, decision: "allow" });
            const dangerous = await read();
            assertAuthorize(dangerous, "sudo true", "tool-dangerous");
            send(socket, { v: 1, type: "decision", id: dangerous.id, decision: "prompt", prompt });
            const resolution = await read();
            assert(resolution.type === "resolve" && resolution.decision === "allow", "allow prompt was not resolved");
            await delay(25);
            assert(stdout() === "", "client allowed before AgentSH sent complete");
            send(socket, { v: 1, type: "complete", id: dangerous.id, decision: "allow", reason: "approved by Pi user interface" });
          });
          assert(allowed.allowed.join(",") === "true,true", "AgentSH allow decisions did not allow both exact commands");
          assert(allowed.selections.length === 1, "AgentSH prompt did not use terminal UI exactly once");
          assert(allowed.selections[0].choices.join(",") === "Deny,Allow", "AgentSH prompt was not deny-first");
          assert(allowed.selections[0].signal, "AgentSH terminal prompt omitted cancellation signal");
          assert(allowed.selections[0].title.includes("Dangerous command requires approval") && allowed.selections[0].title.includes("sudo true"), "AgentSH prompt metadata was not rendered");

          const backgroundAllowed = await spawnInheritedChild("background-allow", async (socket) => {
            const read = lineReader(socket);
            await expectHello(read, socket);
            const request = await read();
            assertAuthorize(request, "printf background", "tool-background-start");
            send(socket, { v: 1, type: "decision", id: request.id, decision: "allow" });
          });
          assert(backgroundAllowed.allowed.join(",") === "true,true", "AgentSH did not ignore background list and allow the exact background start");

          const denied = await spawnInheritedChild("local-deny", (socket) => promptedBroker(socket, { type: "resolve", decision: "deny" }));
          assert(denied.blocked[0], "AgentSH explicit denial did not block");

          const remote = await spawnInheritedChild("remote-allow", (socket) => promptedBroker(socket, { type: "resolve", decision: "allow" }));
          assert(remote.allowed[0] && remote.selections.length === 1 && remote.remoteSelections.length === 1, "AgentSH prompt was not mirrored to Paseo and the terminal");
          assert(remote.remoteSelections[0].choices.join(",") === "Deny,Allow" && remote.remoteSelections[0].signal, "Paseo AgentSH prompt was not deny-first or omitted signal");

          const cancelled = await spawnInheritedChild("cancel", (socket) => promptedBroker(socket, { type: "cancel", reason: "authorization prompt cancelled" }));
          assert(cancelled.blocked[0], "dismissed AgentSH prompt did not fail closed");

          const headless = await spawnInheritedChild("headless", (socket) => promptedBroker(socket, { type: "cancel", reason: "no UI available" }));
          assert(headless.blocked[0], "headless AgentSH prompt did not fail closed");

          const aborted = await spawnInheritedChild("abort", (socket) => promptedBroker(socket, { type: "cancel", reason: "caller aborted" }));
          assert(aborted.blocked[0], "aborted AgentSH prompt did not fail closed");

          const promptTimeout = await spawnInheritedChild("prompt-timeout", (socket) => promptedBroker(socket, { type: "cancel", reason: "authorization prompt timed out" }), 40);
          assert(promptTimeout.blocked[0], "AgentSH prompt timeout did not fail closed");

          const malformed = await spawnInheritedChild("malformed", async (socket) => {
            const read = lineReader(socket);
            const hello = await read();
            assert(hello.type === "hello", "malformed test did not receive hello");
            socket.write('{"v":1,"v":1,"type":"hello","service":"agentsh-permission-gate","capabilities":["bash","resolve","cancel"]}\n');
          });
          assert(malformed.blocked[0] && malformed.reasons[0].includes("failed closed"), "duplicate JSON field did not fail closed");

          const eof = await spawnInheritedChild("eof", async (socket) => {
            const read = lineReader(socket);
            await read();
            socket.end();
          });
          assert(eof.blocked[0], "unexpected gate EOF did not fail closed");

          const eofDuringPrompt = await spawnInheritedChild("transport-eof", async (socket) => {
            const read = lineReader(socket);
            await expectHello(read, socket);
            const request = await read();
            assertAuthorize(request, "sudo true", "tool-dangerous");
            send(socket, { v: 1, type: "decision", id: request.id, decision: "prompt", prompt });
            await delay(10);
            socket.end();
          });
          assert(eofDuringPrompt.blocked[0], "gate EOF did not abort and fail closed an open prompt");

          const eofBeforeComplete = await spawnInheritedChild("eof-complete", async (socket) => {
            const read = lineReader(socket);
            await expectHello(read, socket);
            const request = await read();
            assertAuthorize(request, "sudo true", "tool-dangerous");
            send(socket, { v: 1, type: "decision", id: request.id, decision: "prompt", prompt });
            const resolution = await read();
            assert(resolution.type === "resolve", "EOF completion test did not receive a resolution");
            socket.end();
          });
          assert(eofBeforeComplete.blocked[0], "gate EOF before complete did not fail closed");

          const timedOut = await spawnInheritedChild("timeout", async (socket) => {
            const read = lineReader(socket);
            await read();
          }, 40);
          assert(timedOut.blocked[0] && timedOut.reasons[0].includes("timed out"), "gate timeout did not fail closed");
        }

        async function runLegacyChecks() {
          const pi = createPi();
          gate(pi);
          let localCalls = 0;
          const localSignals = [];
          const controller = new AbortController();
          const ctx = createContext({
            controller,
            choice: "Yes",
            onSelect: async (_title, _choices, settings) => {
              localCalls += 1;
              localSignals.push(settings?.signal);
              assert(settings?.signal instanceof AbortSignal, "legacy terminal prompt dropped its cancellation signal");
              return "Yes";
            },
          });
          const dangerous = { toolName: "bash", toolCallId: "legacy-tool", input: { command: "sudo true" } };
          const remoteCalls = [];
          globalThis.__piPaseoRemoteUiV1 = {
            isConnected: () => true,
            async select(title, options, settings) {
              remoteCalls.push({ title, options, settings });
              return "Yes";
            },
            async selectMirrored(title, options, localSelect, settings) {
              remoteCalls.push({ title, options, settings });
              const localController = new AbortController();
              void localSelect(localController.signal);
              localController.abort();
              return "Yes";
            },
          };
          let result = await pi.handlers.get("tool_call")(dangerous, ctx);
          assert(result === undefined, "legacy remote approval did not allow the command");
          assert(remoteCalls.length === 1 && localCalls === 1, "legacy approval was not mirrored to Paseo and the terminal");
          assert(remoteCalls[0].options.join(",") === "Yes,No", "legacy remote approval options changed");
          assert(remoteCalls[0].settings.signal === controller.signal, "legacy Paseo prompt dropped ctx.signal");

          globalThis.__piPaseoRemoteUiV1.selectMirrored = async (_title, _options, localSelect) => {
            const localController = new AbortController();
            void localSelect(localController.signal);
            localController.abort();
            return "No";
          };
          result = await pi.handlers.get("tool_call")(dangerous, ctx);
          assert(result?.block === true, "legacy remote denial did not block the command");

          globalThis.__piPaseoRemoteUiV1.selectMirrored = async () => { throw new Error("disconnected"); };
          result = await pi.handlers.get("tool_call")(dangerous, ctx);
          assert(result?.block === true, "legacy remote UI failure did not fail closed");

          globalThis.__piPaseoRemoteUiV1.isConnected = () => false;
          result = await pi.handlers.get("tool_call")(dangerous, ctx);
          assert(result === undefined && localCalls === 3, "detached Paseo did not fall back to terminal selection");
          assert(localSignals.at(-1) === controller.signal, "detached Paseo fallback dropped ctx.signal");
          delete globalThis.__piPaseoRemoteUiV1;

          result = await pi.handlers.get("tool_call")({ toolName: "background_job", toolCallId: "legacy-background", input: { action: "start", command: "sudo true" } }, ctx);
          assert(result === undefined && localCalls === 4, "legacy gate did not authorize a dangerous background start like Bash");
          const headlessBackground = await pi.handlers.get("tool_call")({ toolName: "background_job", toolCallId: "legacy-background-headless", input: { action: "start", command: "sudo true" } }, createContext({ hasUI: false }));
          assert(headlessBackground?.block === true, "legacy gate did not fail closed for a headless dangerous background start");

          for (const [name, value] of [
            ["PI_SUPERVISED", "1"],
            ["PI_AUTO", "1"],
            ["AGENTSH_SESSION_SUPERVISOR", "unix:///tmp/supervisor.sock"],
            ["PI_AGENTSH_MOCK_SUPERVISOR", "/tmp/mock-supervisor.sock"],
            ["PI_AGENTSH_ENABLE", "1"],
          ]) {
            process.env[name] = value;
            const supervisedPi = createPi();
            gate(supervisedPi);
            const supervisedCtx = createContext({ onSelect: () => { throw new Error("legacy prompt opened in " + name + " mode"); } });
            const supervisedResult = await supervisedPi.handlers.get("tool_call")(dangerous, supervisedCtx);
            assert(supervisedResult?.block === true && supervisedCtx.selections.length === 0, "unavailable full mode did not synchronously block native Bash for " + name);
            const backgroundResult = await supervisedPi.handlers.get("tool_call")({ toolName: "background_job", toolCallId: "bg-unavailable", input: { action: "start", command: "printf no" } }, supervisedCtx);
            assert(backgroundResult?.block === true && supervisedCtx.selections.length === 0, "unavailable full mode did not synchronously block native background start for " + name);
            delete process.env[name];
          }

          process.env.PI_SUPERVISED = "1";
          globalThis.__AGENTSH_PI__ = {
            getSupervisorState() { return { configured: true, active: true, protocol: "rest", status: "connected" }; },
            async exec() { return { exitCode: 0 }; },
          };
          const activePi = createPi();
          gate(activePi);
          const activeResult = await activePi.handlers.get("tool_call")(dangerous, createContext());
          assert(activeResult === undefined, "active full AgentSH mode was blocked by the duplicate permission gate");
          const activeBackgroundResult = await activePi.handlers.get("tool_call")({ toolName: "background_job", toolCallId: "bg-active", input: { action: "start", command: "printf no-native" } }, createContext());
          assert(activeBackgroundResult === undefined, "active full AgentSH background start was blocked by the duplicate permission gate rather than its own backend guard");
          delete globalThis.__AGENTSH_PI__;
          delete process.env.PI_SUPERVISED;
        }

        if (process.env.PERMISSION_GATE_CHILD_CASE) {
          await runInheritedChild(process.env.PERMISSION_GATE_CHILD_CASE);
        } else {
          await runLegacyChecks();
          await runInheritedChecks();
          console.log("permission-gate checks passed");
        }
        EOF

        cd "$workdir"
        node test.mjs
        touch "$out"
      '';

  pdf = import ./pdf-check.nix { inherit self pkgs; };

  sandbox =
    pkgs.runCommand "sandbox-check"
      {
        nativeBuildInputs = [
          pkgs.bun
          pkgs.nodejs
          pkgs.typescript
        ];
        recoverySuccess = pkgs.writeShellScript "pi-agentsh-recovery-success" ''
          test "$PI_AGENTSH_RECOVERY_CONTRACT_VERSION" = 1
          test "$(${pkgs.jq}/bin/jq -r .schema_version "$PI_AGENTSH_LIFECYCLE_STATE")" = 1
          test "$(${pkgs.jq}/bin/jq -r .session_id "$PI_AGENTSH_LIFECYCLE_STATE")" = "$PI_AGENTSH_RECOVERY_EXPECTED_SESSION"
          test -z "''${AGENTSH_SESSION_EVENT_TOKEN-}''${OPENAI_API_KEY-}''${AUTHORIZATION-}"
        '';
        recoveryAutomatic = pkgs.writeShellScript "pi-agentsh-recovery-automatic" ''
          test "$PI_AGENTSH_RECOVERY_CONTRACT_VERSION" = 1
          test "$(${pkgs.jq}/bin/jq -r .session_id "$PI_AGENTSH_LIFECYCLE_STATE")" = "$PI_AGENTSH_RECOVERY_EXPECTED_SESSION"
          test -z "''${AGENTSH_SESSION_EVENT_TOKEN-}''${RECOVERY_CUSTOM_ENV-}''${RECOVERY_UNRELATED_SECRET-}"
          printf '%s\n' "$PI_AGENTSH_RECOVERY_EXPECTED_SESSION" >>"$(${pkgs.coreutils}/bin/dirname "$PI_AGENTSH_LIFECYCLE_STATE")/automatic-recovery.requested"
        '';
        recoveryFailure = pkgs.writeShellScript "pi-agentsh-recovery-failure" ''
          echo 'token=wrapper-secret sk-live-outputsecret' >&2
          exit 7
        '';
        recoverySwap = pkgs.writeShellScript "pi-agentsh-recovery-swap" ''
          ${pkgs.coreutils}/bin/mv "$PI_AGENTSH_LIFECYCLE_STATE" "$PI_AGENTSH_LIFECYCLE_STATE.old"
          ${pkgs.coreutils}/bin/ln -s "$PI_AGENTSH_LIFECYCLE_STATE.old" "$PI_AGENTSH_LIFECYCLE_STATE"
        '';
        localStart = pkgs.writeShellScript "pi-agentsh-local-start" ''
          printf '{"session_id":"sess-local-start","supervisor_sock":"unix://%s"}\n' "$LOCAL_START_SOCKET"
        '';
        recoverySlow = pkgs.writeShellScript "pi-agentsh-recovery-slow" ''
          # The leader exits promptly on TERM, while this same-process-group
          # descendant ignores TERM and closes inherited stdio. Node can therefore
          # emit child close even though the descendant still requires group KILL.
          (
            trap "" TERM
            exec ${pkgs.coreutils}/bin/sleep 30
          ) </dev/null >/dev/null 2>&1 &
          child=$!
          printf '%s\n' "$child" > "$(${pkgs.coreutils}/bin/dirname "$PI_AGENTSH_LIFECYCLE_STATE")/descendant.pid"
          trap 'exit 0' TERM
          wait "$child"
        '';
      }
      ''
        set -euo pipefail

        workdir="$TMPDIR/sandbox-check"
        srcdir="$workdir/src"
        outdir="$workdir/out"
        mkdir -p "$srcdir" "$outdir"

        cp -r ${self}/sandbox "$srcdir/"
        cp -r ${self}/subagent "$srcdir/"
        cp -r ${self}/shared "$srcdir/"
        printf '%s\n' '{"type":"module"}' > "$srcdir/package.json"

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
        export function formatSize(bytes) {
          if (bytes < 1024) return String(bytes) + "B";
          if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "KB";
          return (bytes / (1024 * 1024)).toFixed(1) + "MB";
        }
        export function getMarkdownTheme() { return {}; }
        export function getAgentDir() { return process.env.PI_TEST_AGENT_DIR || "/tmp/pi-test-agent"; }
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
                let start = Math.max(0, bytes.length - maxBytes);
                while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
                selected.unshift(bytes.subarray(start).toString("utf8"));
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
        export function visibleWidth(text) { return String(text).length; }
        export function wrapTextWithAnsi(text, width) {
          const value = String(text);
          if (value.length <= width) return [value];
          const lines = [];
          for (let offset = 0; offset < value.length; offset += width) lines.push(value.slice(offset, offset + width));
          return lines;
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
          "$srcdir/sandbox/index.ts" \
          "$srcdir/subagent/index.ts" \
          "$srcdir/subagent/backend.ts" \
          "$srcdir/subagent/parallel-result.ts" \
          "$srcdir/sandbox/approval-model.test.ts" \
          "$srcdir/sandbox/command-output.test.ts" \
          "$srcdir/sandbox/exec-result.test.ts" \
          "$srcdir/sandbox/tool-result-presentation.test.ts" \
          "$srcdir/sandbox/command-timeout.test.ts" \
          "$srcdir/sandbox/operator-auth.test.ts" \
          "$srcdir/sandbox/subagent-cwd.test.ts" \
          "$srcdir/sandbox/subagent-model.test.ts" \
          "$srcdir/sandbox/subagent-parent-result.test.ts" \
          "$srcdir/sandbox/subagent-protocol.test.ts" \
          "$srcdir/sandbox/subagent-render.test.ts" \
          "$srcdir/sandbox/subagent-result.test.ts" \
          "$srcdir/sandbox/subagent-stream.test.ts" \
          "$srcdir/sandbox/subagent-terminal.test.ts" \
          "$srcdir/sandbox/workspace-paths.test.ts"

        node "$outdir/sandbox/approval-model.test.js"
        node "$outdir/sandbox/command-output.test.js"
        node "$outdir/sandbox/exec-result.test.js"
        node "$outdir/sandbox/tool-result-presentation.test.js"
        node "$outdir/sandbox/command-timeout.test.js"
        node "$outdir/sandbox/operator-auth.test.js"
        node "$outdir/sandbox/subagent-cwd.test.js"
        node "$outdir/sandbox/subagent-model.test.js"
        node "$outdir/sandbox/subagent-parent-result.test.js"
        node "$outdir/sandbox/subagent-protocol.test.js"
        node "$outdir/sandbox/subagent-render.test.js"
        node "$outdir/sandbox/subagent-result.test.js"
        node "$outdir/sandbox/subagent-stream.test.js"
        node "$outdir/sandbox/subagent-terminal.test.js"
        node "$outdir/sandbox/workspace-paths.test.js"

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

        async function waitFor(predicate, message, timeoutMs = 10000) {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            if (await predicate()) return;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          throw new Error(message);
        }

        function processIsAlive(pid) {
          try {
            process.kill(pid, 0);
            return true;
          } catch (error) {
            if (error?.code === "ESRCH") return false;
            throw error;
          }
        }

        function createPi() {
          const handlers = new Map();
          const commands = new Map();
          const tools = new Map();
          const commandRegistrations = [];
          const toolRegistrations = [];
          return {
            handlers,
            commands,
            tools,
            commandRegistrations,
            toolRegistrations,
            registerCommand(name, definition) {
              commandRegistrations.push(name);
              commands.set(name, definition);
            },
            registerTool(definition) {
              toolRegistrations.push(definition.name);
              tools.set(definition.name, definition);
            },
            on(event, handler) {
              const list = handlers.get(event) ?? [];
              list.push(handler);
              handlers.set(event, list);
            },
          };
        }

        function createContext({ choices = [], hasUI = true, customActions, model, cwd = process.cwd() } = {}) {
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
              const customCall = { options, renders: [] };
              customCalls.push(customCall);
              let resolveResult;
              const result = new Promise((resolve) => { resolveResult = resolve; });
              const component = factory({ terminal: { rows: 40 }, requestRender() {} }, theme, {}, (value) => resolveResult(value));
              // Render at two widths to catch stale-width cache regressions in the approval overlay.
              customCall.renders.push(component.render?.(80) ?? []);
              customCall.renders.push(component.render?.(100) ?? []);
              for (const action of customActions) component.handleInput?.(action);
              return await result;
            };
          }
          return {
            cwd,
            mode: "tui",
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

        async function applyToolResultHandlers(pi, toolName, result, ctx, input = {}) {
          const event = { type: "tool_result", toolCallId: "tool-result-test", toolName, input, content: result.content, details: result.details, isError: false };
          const handlers = pi.handlers.get("tool_result") ?? [];
          for (const handler of handlers) {
            const patch = await handler(event, ctx);
            if (patch) Object.assign(event, patch);
          }
          return event;
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
              const request = { method: req.method, url: req.url, body, headers: { ...req.headers } };
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
          delete process.env.AGENTSH_SESSION_SUPERVISOR_GENERATION;
          delete process.env.AGENTSH_SESSION_SUPERVISOR_INCARNATION;
          delete process.env.AGENTSH_SESSION_EVENT_URL;
          delete process.env.AGENTSH_SESSION_EVENT_TOKEN;
          delete process.env.PI_AGENTSH_APPROVAL_CLIENT;
          delete process.env.PI_AGENTSH_APPROVAL_BELL;
          delete process.env.PI_AGENTSH_REQUIRE_NETWORK_ENFORCEMENT;
          delete process.env.PI_AGENTSH_EXPOSE_SUBAGENT_TIMEOUT;
          delete process.env.PI_SUPERVISED;
          delete process.env.PI_AUTO;
          delete process.env.PI_AGENTSH_MOCK_SUPERVISOR;
          delete process.env.PI_AGENTSH_READ_MODE;
          delete process.env.AGENTSH_PERMISSION_GATE_SOCKET;
          delete process.env.PI_AGENTSH_REMOTE;
          delete process.env.PI_AGENTSH_REMOTE_CWD;
          delete process.env.PI_AGENTSH_RECOVERY_COMMAND;
          delete process.env.PI_AGENTSH_LIFECYCLE_STATE;
          delete process.env.PI_AGENTSH_RECOVERY_TIMEOUT_MS;
          delete process.env.PI_AGENTSH_BIN;
          delete process.env.PI_AGENTSH_ENABLE;
          delete process.env.LOCAL_START_SOCKET;
          delete process.env.AGENTSH_API_KEY;
          delete process.env.AGENTSH_APPROVER_API_KEY;
          delete process.env.AGENTSH_ADMIN_TOKEN;
          delete process.env.AGENTSH_CHILD_CAPABILITY;
          delete process.env.AUTHORIZATION;
          delete process.env.RECOVERY_CUSTOM_ENV;
          delete process.env.RECOVERY_UNRELATED_SECRET;
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
          process.env.PI_AGENTSH_RECOVERY_TRIGGER_MS = "20";
          process.env.PI_AGENTSH_WATCH_RECONNECT_MS = "25";
          // Keep deadline tests fast while preserving the production defaults in
          // pure-module coverage. Ordinary commands deliberately get a separate,
          // longer budget than the generic REST tool fixture.
          process.env.PI_AGENTSH_TOOL_REQUEST_TIMEOUT_MS = "100";
          process.env.PI_AGENTSH_APPROVAL_TIMEOUT_SLACK_MS = "20";
          process.env.PI_AGENTSH_CONNECT_TIMEOUT_MS = "100";
          process.env.PI_AGENTSH_COMMAND_EXECUTION_TIMEOUT_MS = "300";
          process.env.PI_AGENTSH_COMMAND_TRANSPORT_SLACK_MS = "80";
          process.env.PI_AGENTSH_SUBAGENT_TRANSPORT_SLACK_MS = "100";

          const compiledRoot = process.argv[2];
          const moduleUrl = pathToFileURL(path.join(compiledRoot, "sandbox/index.js")).href;
          const importedModule = await import(moduleUrl);
          const sandboxExtension = importedModule.default?.default ?? importedModule.default ?? importedModule;
          const subagentModule = await import(pathToFileURL(path.join(compiledRoot, "subagent/index.js")).href);
          const subagent = subagentModule.default?.default ?? subagentModule.default ?? subagentModule;
          const sandbox = (pi) => { sandboxExtension(pi); subagent(pi); };
          const childCapabilityHeaders = importedModule.childExecutionCapabilityHeaders ?? importedModule.default?.childExecutionCapabilityHeaders;
          assert(typeof sandbox === "function", "sandbox module did not export a function");
          assert(typeof childCapabilityHeaders === "function", "sandbox module did not export child capability header derivation");
          const fixtureCapability = "A".repeat(43);
          assert(childCapabilityHeaders("/api/v1/sessions/s/tools/exec_bash", { AGENTSH_CHILD_CAPABILITY: fixtureCapability })["X-AgentSH-Child-Capability"] === fixtureCapability, "pure child capability derivation omitted exec_bash credential");
          assert(Object.keys(childCapabilityHeaders("/api/v1/sessions/s/tools/read_file", { AGENTSH_CHILD_CAPABILITY: fixtureCapability })).length === 0, "pure child capability derivation leaked credential to read_file");
          let malformedCapabilityError;
          try { childCapabilityHeaders("/api/v1/sessions/s/tools/exec_bash", { AGENTSH_CHILD_CAPABILITY: "malformed" }); } catch (error) { malformedCapabilityError = error; }
          assert(String(malformedCapabilityError).includes("AGENTSH_CHILD_CAPABILITY is malformed"), "malformed child capability was accepted");

          // Pi is compiled with Bun. Its node:http compatibility layer can close
          // an aborted Unix-socket request without emitting a terminal event.
          // Exercise the production runtime separately so one orphaned request
          // Promise cannot leave Pi's parallel Promise.all busy forever.
          if (process.env.PI_AGENTSH_BUN_ABORT_REGRESSION === "1") {
            clearAgentSHEnv();
            const sessionId = "sess-bun-parallel-abort";
            const cancelledRequestIds = [];
            const supervisor = await withRestSupervisor(async (request) => {
              if (request.method === "GET" && request.url === "/api/v1/sessions/" + sessionId) {
                return { id: sessionId, session_id: sessionId, workspace: "/workspace", worktree: "/workspace", command_timeout: { default_ms: 200, maximum_ms: 200, source: "policy" } };
              }
              if (request.method === "GET" && request.url === "/api/v1/approvals") return [];
              if (request.method === "POST" && request.url.startsWith("/api/v1/sessions/" + sessionId + "/tools/exec_bash/") && request.url.endsWith("/cancel")) {
                cancelledRequestIds.push(request.url.split("/").at(-2));
                return { cancelled: true };
              }
              if (request.method === "POST" && (request.url.endsWith("/tools/read_file") || request.url.endsWith("/tools/exec_bash") || request.url.endsWith("/tools/spawn_subagent"))) {
                await new Promise((resolve) => setTimeout(resolve, 200));
                if (request.url.endsWith("/tools/read_file")) return { ok: true, result: { path: request.body.path, content: "too late" } };
                if (request.url.endsWith("/tools/exec_bash")) return { ok: true, result: { exit_code: 0, stdout: "too late", stderr: "" } };
                return { ndjsonChunks: [Buffer.from(JSON.stringify({ event: "done", ok: true, result: { mode: "single", final: "too late", results: [] } }) + "\n")] };
              }
              return { statusCode: 404, body: { error: "unexpected supervisor request", request } };
            });
            process.env.AGENTSH_SESSION_ID = sessionId;
            process.env.AGENTSH_SESSION_SUPERVISOR = "unix://" + supervisor.socketPath;
            process.env.PI_AGENTSH_READ_MODE = "supervised";
            const pi = createPi();
            sandbox(pi);
            const ctx = createContext();
            await startSession(pi, ctx);
            const controller = new AbortController();
            const calls = [
              pi.tools.get("read").execute("bun-read-1", { path: "/workspace/one" }, controller.signal, undefined, ctx),
              pi.tools.get("read").execute("bun-read-2", { path: "/workspace/two" }, controller.signal, undefined, ctx),
              pi.tools.get("read").execute("bun-read-3", { path: "/workspace/three" }, controller.signal, undefined, ctx),
              pi.tools.get("bash").execute("bun-bash", { command: "sleep forever" }, controller.signal, undefined, ctx),
            ];
            setTimeout(() => controller.abort(), 20);
            const results = await Promise.race([
              Promise.allSettled(calls),
              new Promise((_, reject) => setTimeout(() => reject(new Error("Bun left an aborted supervised request Promise unresolved")), 1000)),
            ]);
            assert(results.length === 4 && results.every((result) => result.status === "rejected" && result.reason?.name === "AbortError"), "parallel Bun abort did not settle every supervised request: " + JSON.stringify(results));
            assert(cancelledRequestIds.length === 1, "parallel Bun abort did not issue the Bash exact-command cancellation");

            const subagentStartedAt = Date.now();
            let subagentError;
            try {
              await Promise.race([
                globalThis.__AGENTSH_PI__.spawnSubagent({ task: "wait forever", timeout_ms: 20 }),
                new Promise((_, reject) => setTimeout(() => reject(new Error("Bun left an internally timed-out supervised NDJSON Promise unresolved")), 1000)),
              ]);
            } catch (error) {
              subagentError = error;
            }
            assert(subagentError?.name === "SubagentTransportTimeoutError", "Bun NDJSON deadline did not settle as a typed transport timeout: " + subagentError);
            assert(Date.now() - subagentStartedAt < 180, "Bun NDJSON deadline waited for the late supervisor response");
            await shutdownSession(pi);
            await supervisor.close();
            return;
          }

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
            const inactiveState = globalThis.__AGENTSH_PI__.getSupervisorState();
            assert(!inactiveState.configured && !inactiveState.active && inactiveState.protocol === "", "inactive supervisor state semantics are incorrect");
            await shutdownSession(pi);
          }

          // A trusted full-mode signal without a usable transport must still
          // install the supervised frontends and publish unavailable state.
          {
            clearAgentSHEnv();
            process.env.PI_SUPERVISED = "1";
            const pi = createPi();
            sandbox(pi);
            const ctx = createContext();
            assert(pi.tools.has("bash") && pi.tools.has("write") && pi.tools.has("edit"), "selected full mode omitted fail-closed tool frontends");
            await startSession(pi, ctx);
            const unavailableState = globalThis.__AGENTSH_PI__.getSupervisorState();
            assert(unavailableState.configured && !unavailableState.active, "unavailable full mode was published as inactive configuration or active runtime");
            assert(unavailableState.protocol === "" && unavailableState.status === "error", "missing full transport did not publish a terminal unavailable disposition");
            let unavailableError;
            try {
              await pi.tools.get("bash").execute("missing-supervisor", { command: "printf unsafe-fallback" }, undefined, undefined, ctx);
            } catch (error) {
              unavailableError = error;
            }
            assert(String(unavailableError).includes("not ready"), "selected full mode did not fail closed without a supervisor");
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
            const ctx = createContext({ choices: ["Allow once"], customActions: ["<enter>"] });
            ctx.mode = "rpc";
            process.env.PI_AGENTSH_APPROVAL_BELL = "1";
            const originalStdoutWrite = process.stdout.write;
            let approvalBellOutput = "";
            process.stdout.write = function (chunk) {
              approvalBellOutput += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
              return true;
            };
            try {
              await startSession(pi, ctx);
              const approvalOnlyState = globalThis.__AGENTSH_PI__.getSupervisorState();
              assert(approvalOnlyState.configured && approvalOnlyState.active && approvalOnlyState.protocol === "legacy-approval-ui", "approval-only protocol was mispublished as a full or inactive supervisor");
              assert(!pi.tools.has("bash") && !pi.tools.has("write") && !pi.tools.has("edit"), "approval-only mode registered full supervised tools");
              await waitFor(() => Boolean(resolved), "approval was not resolved");
            } finally {
              process.stdout.write = originalStdoutWrite;
              delete process.env.PI_AGENTSH_APPROVAL_BELL;
            }

            assert(approvalBellOutput === "\x07", "approval prompt did not emit exactly one terminal bell: " + JSON.stringify(approvalBellOutput));
            assert(server.requests.some((request) => request.op === "list"), "approval list was not polled");
            assert(resolved.op === "resolve", "approval resolve op was not sent");
            assert(resolved.id === "appr-1", "resolved wrong approval id");
            assert(resolved.decision === "approve", "approval was not approved");
            assert(resolved.scope === "once", "approval should default to once scope");
            assert(ctx.selectCalls[0].items.length === 2, "unscoped approval should only show once approve/deny choices");
            assert(ctx.customCalls.length === 0, "RPC mode used the TUI-only custom approval overlay");
            assert(!ctx.selectCalls[0].items.some((item) => item.includes("for session")), "unscoped approval unexpectedly showed session choices");
            assertNoBearerCredentialFields(server.requests);
            await shutdownSession(pi);
            await server.close();
          }

          // Paseo transports the choice only; the sandbox maps the selected
          // label back to the AgentSH-owned approval ID and exact scope.
          {
            clearAgentSHEnv();
            let approvals = [{
              id: "paseo-appr",
              kind: "command",
              target: "sudo true",
              fields: {
                command: "sudo true",
                scope_options: [{
                  scope: "session",
                  scope_kind: "command",
                  scope_key: "command-invocation:sha256:test",
                  scope_label: "sudo true",
                  scope_path: "sudo",
                  scope_rule: "unknown-command",
                }],
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
            const remoteCalls = [];
            globalThis.__piPaseoRemoteUiV1 = {
              isConnected: () => true,
              async select(title, options, settings) {
                remoteCalls.push({ title, options, settings });
                return "Allow this exact invocation for session";
              },
              async selectMirrored(title, options, localSelect, settings) {
                remoteCalls.push({ title, options, settings });
                const controller = new AbortController();
                void localSelect(controller.signal);
                controller.abort();
                return "Allow this exact invocation for session";
              },
            };
            const pi = createPi();
            sandbox(pi);
            const ctx = createContext({ choices: ["Deny once"], customActions: ["<enter>"] });
            try {
              await startSession(pi, ctx);
              await waitFor(() => Boolean(resolved), "Paseo approval was not resolved");
            } finally {
              delete globalThis.__piPaseoRemoteUiV1;
            }
            assert(remoteCalls.length === 1, "AgentSH approval was not sent through Paseo");
            assert(ctx.selectCalls.length === 0 && ctx.customCalls.length === 1, "AgentSH approval was not mirrored to the terminal");
            assert(resolved.id === "paseo-appr", "Paseo changed the AgentSH approval ID");
            assert(resolved.decision === "approve" && resolved.scope === "session", "Paseo changed the approval decision or lifetime");
            assert(resolved.scope_kind === "command", "Paseo changed the AgentSH scope kind");
            assert(resolved.scope_key === "command-invocation:sha256:test", "Paseo changed the exact command scope key");
            assert(resolved.scope_path === "sudo" && resolved.scope_rule === "unknown-command", "Paseo dropped exact scope metadata");
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
            const ctx = createContext({ choices: ["Allow once"] });
            await startSession(pi, ctx);
            const restState = globalThis.__AGENTSH_PI__.getSupervisorState();
            assert(restState.configured && restState.active && restState.protocol === "rest", "attached REST supervisor protocol/readiness state is incorrect");
            await waitFor(() => Boolean(resolved), "REST supervisor approval was not resolved through supervisor socket");

            const editTool = pi.tools.get("edit");
            assert(editTool, "REST mode did not register AgentSH-backed edit tool");
            assert(editTool.renderShell === "self", "AgentSH-backed edit tool must preserve its self-rendered shell");
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

          // The shared API maps control-plane/real/shadow paths to virtual paths
          // and forwards explicit bounded binary-read limits for sibling extensions.
          {
            clearAgentSHEnv();
            const sessionId = "sess-shared-api";
            const supervisor = await withRestSupervisor(async (request) => {
              if (request.method === "GET" && request.url === "/api/v1/sessions/" + sessionId) {
                return {
                  id: sessionId,
                  session_id: sessionId,
                  real_workspace: "/real/project",
                  worktree: "/shadow/project",
                  workspace_mode: "shadow",
                  virtual_root: "/workspace",
                  workspace_roots: [{ name: "project", real: "/real/project", work: "/shadow/project" }],
                };
              }
              if (request.method === "GET" && request.url === "/api/v1/approvals") return [];
              if (request.method === "POST" && request.url === "/api/v1/sessions/" + sessionId + "/tools/read_file") {
                return { ok: true, result: { path: request.body.path, size: 4, max_bytes: request.body.max_bytes, encoding: "base64", content: "iVBORw==" } };
              }
              return { statusCode: 404, body: { error: "unexpected supervisor request", request } };
            });
            process.env.AGENTSH_SESSION_ID = sessionId;
            process.env.AGENTSH_SESSION_SUPERVISOR = "unix://" + supervisor.socketPath;
            const pi = createPi();
            sandbox(pi);
            const ctx = createContext();
            await startSession(pi, ctx);

            assert(globalThis.__AGENTSH_PI__.toSupervisorPath("/real/project/input.pdf") === "/workspace/input.pdf", "shared API did not map the real workspace");
            assert(globalThis.__AGENTSH_PI__.toSupervisorPath("docs/input.pdf", "/shadow/project/nested") === "/workspace/nested/docs/input.pdf", "shared API did not map a relative shadow-worktree path");
            const binary = await globalThis.__AGENTSH_PI__.readFile("/workspace/image.png", { maxBytes: 4194304, limit: 2147483647 });
            assert(binary.encoding === "base64" && binary.content === "iVBORw==", "shared API did not retain a binary read response");
            const readRequest = supervisor.requests.find((request) => request.url?.endsWith("/tools/read_file"));
            assert(readRequest?.body.max_bytes === 4194304, "shared API did not forward maxBytes as max_bytes");
            assert(readRequest?.body.limit === 2147483647, "shared API did not forward the binary line ceiling");

            await shutdownSession(pi);
            await supervisor.close();
          }

          // Present malformed live timeout metadata fails closed; only omission by
          // an older supervisor enters compatibility mode.
          {
            clearAgentSHEnv();
            const sessionId = "sess-malformed-command-timeout";
            const supervisor = await withRestSupervisor(async (request) => {
              if (request.method === "GET" && request.url === "/api/v1/sessions/" + sessionId) {
                return { id: sessionId, session_id: sessionId, workspace: "/workspace", worktree: "/workspace", command_timeout: { default_ms: 200, maximum_ms: 240, approval_extension_ms: -1, source: "policy" } };
              }
              return [];
            });
            process.env.AGENTSH_SESSION_ID = sessionId;
            process.env.AGENTSH_SESSION_SUPERVISOR = "unix://" + supervisor.socketPath;
            const pi = createPi();
            sandbox(pi);
            const ctx = createContext();
            await startSession(pi, ctx);
            const state = globalThis.__AGENTSH_PI__.getSupervisorState();
            assert(state.status === "error", "malformed live command_timeout metadata did not fail attachment");
            assert(String(state.lastError).includes("command_timeout metadata is malformed") && String(state.lastError).includes("approval_extension_ms"), "malformed approval extension metadata error was not actionable: " + state.lastError);
            await shutdownSession(pi);
            await supervisor.close();
          }

          // Ordinary buffered REST Bash derives execution/transport budgets from
          // live metadata, never from the deliberately smaller generic tool budget.
          // Explicit values retain their original request body while known policy
          // maxima shorten the client lifetime.
          {
            clearAgentSHEnv();
            process.env.AGENTSH_CHILD_CAPABILITY = fixtureCapability;
            const sessionId = "sess-command-timeouts";
            const commandTimeout = { default_ms: 200, maximum_ms: 240, source: "policy" };
            const cancelledRequestIds = [];
            const supervisor = await withRestSupervisor(async (request) => {
              if (request.method === "GET" && request.url === "/api/v1/sessions/" + sessionId) {
                return { id: sessionId, session_id: sessionId, workspace: "/workspace", worktree: "/workspace", workspace_mode: "shadow", command_timeout: commandTimeout };
              }
              if (request.method === "GET" && request.url === "/api/v1/approvals") return [];
              if (request.method === "POST" && request.url.startsWith("/api/v1/sessions/" + sessionId + "/tools/exec_bash/") && request.url.endsWith("/cancel")) {
                cancelledRequestIds.push(request.url.split("/").at(-2));
                return { cancelled: true };
              }
              if (request.method === "POST" && request.url === "/api/v1/sessions/" + sessionId + "/tools/exec_bash") {
                const command = request.body.command;
                if (command === "omitted-outlives-generic") {
                  await new Promise((resolve) => setTimeout(resolve, 160));
                  return { ok: true, result: { exit_code: 0, stdout: "omitted-ok", stderr: "" } };
                }
                if (command === "execution-timeout") {
                  return { ok: true, result: {
                    exit_code: 124,
                    stdout: "partial execution stdout\n",
                    stderr: "partial execution stderr",
                    stdout_truncated: true,
                    stdout_total_bytes: 4096,
                    termination_reason: "command_timeout",
                    command_timeout: { effective_ms: 200, source: "policy_default" },
                    full_output_path: "/workspace/.agentsh/output/timeout.log",
                    artifact_bytes: 4096,
                    artifact_total_bytes: 4096,
                    artifact_complete: true,
                  } };
                }
                if (command === "legacy-effective-unavailable") {
                  return { ok: true, result: {
                    exit_code: 124,
                    stdout: "legacy partial output",
                    stderr: "",
                    termination_reason: "command_timeout",
                    timeout_ms: 200,
                    timeout_source: "policy_default",
                  } };
                }
                if (command === "execution-timeout-http") {
                  return { statusCode: 408, body: { ok: false, error: "command deadline", result: {
                    exit_code: 124,
                    termination_reason: "command_timeout",
                    effective_timeout_ms: 240,
                    timeout_source: "policy_cap",
                    error: { code: "E_COMMAND_TIMEOUT", message: "operator maximum reached" },
                  } } };
                }
                if (command === "metadata-preference-timeout") {
                  await new Promise((resolve) => setTimeout(resolve, 330));
                  return { ok: true, result: { exit_code: 0, stdout: "fallback would be too long", stderr: "" } };
                }
                if (command === "above-cap-budget") {
                  await new Promise((resolve) => setTimeout(resolve, 360));
                  return { ok: true, result: { exit_code: 0, stdout: "uncapped client would wait", stderr: "" } };
                }
                if (command === "transport-timeout" || command === "caller-abort") {
                  await new Promise((resolve) => setTimeout(resolve, 180));
                  return { ok: true, result: { exit_code: 0, stdout: "too late", stderr: "" } };
                }
                if (command === "child-exit-124") return { ok: true, result: { exit_code: 124, stdout: "ordinary child", stderr: "" } };
                return { ok: true, result: { exit_code: 0, stdout: command + "-ok", stderr: "" } };
              }
              return { statusCode: 404, body: { error: "unexpected supervisor request", request } };
            });
            process.env.AGENTSH_SESSION_ID = sessionId;
            process.env.AGENTSH_SESSION_SUPERVISOR = "unix://" + supervisor.socketPath;
            const pi = createPi();
            sandbox(pi);
            const ctx = createContext();
            await startSession(pi, ctx);
            const bashTool = pi.tools.get("bash");
            assert(bashTool, "command timeout fixture did not register bash");
            assert(bashTool.parameters.properties.timeout.exclusiveMinimum === 0, "bash schema did not require positive seconds");
            assert(bashTool.parameters.properties.timeout.description.includes("operator default/maximum"), "bash timeout help omitted operator semantics");
            assert(bashTool.description.includes("buffered") && !bashTool.description.includes("Streams stdout"), "REST bash still claimed live streaming");
            assert(globalThis.__AGENTSH_PI__.getSupervisorMetadata().command_timeout.default_ms === 200, "live command timeout metadata was not retained");

            const omitted = await bashTool.execute("omitted-timeout", { command: "omitted-outlives-generic" }, undefined, undefined, ctx);
            assert(omitted.content[0].text.includes("omitted-ok"), "omitted command was killed by the 100ms generic tool budget");
            const omittedRequest = supervisor.requests.find((request) => request.body?.command === "omitted-outlives-generic");
            assert(omittedRequest && !("timeout_ms" in omittedRequest.body), "omitted bash timeout_ms was serialized instead of left to AgentSH");
            assert(omittedRequest.headers["x-agentsh-child-capability"] === fixtureCapability, "child execution capability was not attached to exec_bash");
            const metadataRequest = supervisor.requests.find((request) => request.method === "GET" && request.url.endsWith("/" + sessionId));
            assert(metadataRequest && metadataRequest.headers["x-agentsh-child-capability"] === undefined, "child execution capability leaked to session metadata request");

            await bashTool.execute("short-timeout", { command: "explicit-short", timeout: 0.02 }, undefined, undefined, ctx);
            const shortRequest = supervisor.requests.find((request) => request.body?.command === "explicit-short");
            assert(shortRequest?.body.timeout_ms === 20, "positive seconds were not sent as exact integer milliseconds");

            let metadataPreferenceError;
            try {
              await globalThis.__AGENTSH_PI__.exec("metadata-preference-timeout");
            } catch (error) {
              metadataPreferenceError = error;
            }
            assert(metadataPreferenceError?.name === "CommandTransportTimeoutError", "live metadata default did not beat the longer wrapper fallback");
            assert(metadataPreferenceError?.executionTimeoutMs === 200 && metadataPreferenceError?.transportTimeoutMs === 280, "metadata-preferred transport budget was incorrect");

            let cappedTransportError;
            try {
              await globalThis.__AGENTSH_PI__.exec({ command: "above-cap-budget", timeout_ms: 500 });
            } catch (error) {
              cappedTransportError = error;
            }
            const cappedRequest = supervisor.requests.find((request) => request.body?.command === "above-cap-budget");
            assert(cappedRequest?.body.timeout_ms === 500, "global/SSH API pre-capped the requested timeout instead of preserving policy_cap reporting");
            assert(cappedTransportError?.name === "CommandTransportTimeoutError", "above-cap request did not use the known maximum for client lifetime");
            assert(cappedTransportError?.executionTimeoutMs === 240 && cappedTransportError?.transportTimeoutMs === 320, "above-cap request used the wrong derived budgets");

            let executionError;
            try {
              await bashTool.execute("execution-timeout", { command: "execution-timeout" }, undefined, undefined, ctx);
            } catch (error) {
              executionError = error;
            }
            assert(executionError?.name === "CommandExecutionTimeoutError", "structured termination_reason was not a typed execution timeout: " + executionError);
            assert(executionError?.code === "E_COMMAND_TIMEOUT" && executionError?.exitCode === 124, "execution timeout lost code 124 semantics");
            assert(executionError?.effectiveTimeoutMs === 200 && executionError?.timeoutSource === "policy_default", "execution timeout lost exact AgentSH command_timeout effective/source fields");
            assert(executionError?.clientExecutionTimeoutMs === 200 && executionError?.clientExecutionTimeoutSource === "policy", "execution timeout lost the separate client-derived budget/source");
            assert(String(executionError).includes("partial execution stdout") && String(executionError).includes("partial execution stderr"), "model-visible execution timeout lost buffered partial stdout/stderr: " + executionError);
            assert(String(executionError).includes("AgentSH response truncated stdout"), "model-visible execution timeout lost the remote truncation warning: " + executionError);
            assert(String(executionError).includes("/workspace/.agentsh/output/timeout.log"), "model-visible execution timeout lost the remote output artifact path: " + executionError);
            assert(executionError?.result?.stdout === "partial execution stdout\n", "typed execution timeout lost its raw buffered result");
            assert(executionError?.toolDetails?.fullOutputPath === "/workspace/.agentsh/output/timeout.log", "typed execution timeout lost model-facing artifact details");

            let legacyExecutionError;
            try {
              await globalThis.__AGENTSH_PI__.exec("legacy-effective-unavailable");
            } catch (error) {
              legacyExecutionError = error;
            }
            assert(legacyExecutionError?.name === "CommandExecutionTimeoutError", "legacy structured timeout lost typed classification: " + legacyExecutionError);
            assert(legacyExecutionError?.effectiveTimeoutMs === undefined && legacyExecutionError?.timeoutSource === undefined, "generic legacy timeout_ms fabricated server-effective reporting");
            assert(String(legacyExecutionError).includes("effective server timeout unavailable"), "legacy timeout did not disclose unavailable effective reporting: " + legacyExecutionError);
            assert(String(legacyExecutionError).includes("client-derived execution budget 200ms (source: policy)"), "legacy timeout omitted the separate client-derived budget/source: " + legacyExecutionError);
            assert(legacyExecutionError?.result?.stdout === "legacy partial output", "global API did not retain the raw legacy timeout result");

            let httpExecutionError;
            try {
              await globalThis.__AGENTSH_PI__.exec({ command: "execution-timeout-http", timeout_ms: 500 });
            } catch (error) {
              httpExecutionError = error;
            }
            assert(httpExecutionError?.name === "CommandExecutionTimeoutError", "structured HTTP E_COMMAND_TIMEOUT was reduced to RestHTTPError: " + httpExecutionError);
            assert(httpExecutionError?.effectiveTimeoutMs === 240 && httpExecutionError?.timeoutSource === "policy_cap", "HTTP execution timeout lost cap details");

            let transportError;
            try {
              await globalThis.__AGENTSH_PI__.exec({ command: "transport-timeout", timeout_ms: 20 });
            } catch (error) {
              transportError = error;
            }
            assert(transportError?.name === "CommandTransportTimeoutError", "internal REST deadline was not a typed transport timeout: " + transportError);
            assert(transportError?.executionTimeoutMs === 20 && transportError?.transportSlackMs === 80 && transportError?.transportTimeoutMs === 100, "transport timeout lost derived budgets/slack");

            const controller = new AbortController();
            const abortTimer = setTimeout(() => controller.abort(), 20);
            let abortError;
            try {
              await globalThis.__AGENTSH_PI__.exec("caller-abort", { signal: controller.signal });
            } catch (error) {
              abortError = error;
            }
            clearTimeout(abortTimer);
            assert(abortError?.name === "AbortError", "caller cancellation was confused with command transport timeout: " + abortError);
            const abortedRequest = supervisor.requests.find((request) => request.body?.command === "caller-abort");
            assert(typeof abortedRequest?.body?.request_id === "string", "exec_bash omitted its stable cancellation request ID");
            assert(cancelledRequestIds.includes(abortedRequest.body.request_id), "caller abort did not send an explicit exact-command cancellation request");

            const child124Result = await bashTool.execute("child-exit-124", { command: "child-exit-124" }, undefined, undefined, ctx);
            assert(child124Result?.isError === true && child124Result?.details?.exitCode === 124, "ordinary child exit 124 was inferred to be command timeout: " + JSON.stringify(child124Result));

            await shutdownSession(pi);
            await supervisor.close();
          }

          // A producer allowance larger than configured command slack raises the
          // dispatched REST lifetime to approval_extension_ms + the bounded
          // connect-timeout terminal/cleanup margin. The response arrives after
          // both the generic and old configured-slack deadlines, proving there is
          // no hidden earlier transport timer.
          {
            clearAgentSHEnv();
            const sessionId = "sess-command-approval-extension";
            let responseReleased = false;
            const supervisor = await withRestSupervisor(async (request) => {
              if (request.method === "GET" && request.url === "/api/v1/sessions/" + sessionId) {
                return {
                  id: sessionId,
                  session_id: sessionId,
                  workspace: "/workspace",
                  worktree: "/workspace",
                  command_timeout: {
                    default_ms: 30,
                    maximum_ms: 30,
                    approval_extension_ms: 300,
                    source: "policy",
                  },
                };
              }
              if (request.method === "GET" && request.url === "/api/v1/approvals") return [];
              if (request.method === "POST" && request.url === "/api/v1/sessions/" + sessionId + "/tools/exec_bash") {
                await new Promise((resolve) => setTimeout(resolve, 180));
                responseReleased = true;
                return { ok: true, result: { exit_code: 0, stdout: "approval-extension-ok", stderr: "" } };
              }
              return { statusCode: 404, body: { error: "unexpected supervisor request", request } };
            });
            process.env.AGENTSH_SESSION_ID = sessionId;
            process.env.AGENTSH_SESSION_SUPERVISOR = "unix://" + supervisor.socketPath;
            const pi = createPi();
            sandbox(pi);
            const ctx = createContext();
            await startSession(pi, ctx);

            const metadata = globalThis.__AGENTSH_PI__.getSupervisorMetadata().command_timeout;
            assert(metadata.approval_extension_ms === 300, "producer approval extension metadata was not retained");
            const result = await globalThis.__AGENTSH_PI__.exec("server-approval-extension-outlives-configured-slack");
            assert(responseReleased && result.stdout === "approval-extension-ok", "server approval allowance did not prevent a hidden earlier command transport deadline");
            const request = supervisor.requests.find((candidate) => candidate.body?.command === "server-approval-extension-outlives-configured-slack");
            assert(request && !("timeout_ms" in request.body), "approval-extension fixture serialized an omitted command timeout");

            await shutdownSession(pi);
            await supervisor.close();
          }

          // Safe pre-dispatch reconnect keeps its established reconnect lifetime,
          // then re-derives the omitted command budget from refreshed metadata and
          // gives the dispatched command a fresh full transport lifetime.
          {
            clearAgentSHEnv();
            const sessionId = "sess-command-timeout-reconnect";
            let execRequests = 0;
            const supervisor = await withRestartableRestSupervisor(async (request) => {
              if (request.method === "GET" && request.url === "/api/v1/sessions/" + sessionId) {
                const commandTimeout = request.generation === 1
                  ? { default_ms: 10, maximum_ms: 10, source: "policy" }
                  : { default_ms: 180, maximum_ms: 180, source: "policy" };
                return { id: sessionId, session_id: sessionId, workspace: "/workspace", worktree: "/workspace", command_timeout: commandTimeout };
              }
              if (request.method === "GET" && request.url === "/api/v1/approvals") return [];
              if (request.method === "POST" && request.url === "/api/v1/sessions/" + sessionId + "/tools/exec_bash") {
                execRequests += 1;
                await new Promise((resolve) => setTimeout(resolve, 120));
                return { ok: true, result: { exit_code: 0, stdout: "reconnected command completed", stderr: "" } };
              }
              return { statusCode: 404, body: { error: "unexpected supervisor request", request } };
            });
            process.env.AGENTSH_SESSION_ID = sessionId;
            process.env.AGENTSH_SESSION_SUPERVISOR = "unix://" + supervisor.socketPath;
            const pi = createPi();
            sandbox(pi);
            const ctx = createContext();
            await startSession(pi, ctx);
            assert(globalThis.__AGENTSH_PI__.getSupervisorMetadata().command_timeout.default_ms === 10, "reconnect fixture did not retain initial timeout metadata");

            await supervisor.stop();
            const restart = (async () => {
              await new Promise((resolve) => setTimeout(resolve, 130));
              await supervisor.start();
            })();
            const startedAt = Date.now();
            const result = await globalThis.__AGENTSH_PI__.exec("reconnect-with-refreshed-timeout");
            await restart;
            const elapsed = Date.now() - startedAt;
            assert(result.stdout === "reconnected command completed", "command did not complete after timeout-policy reconnect");
            assert(elapsed >= 210, "command reused an outer pre-reconnect transport lifetime: " + elapsed + "ms");
            assert(execRequests === 1, "reconnected command was dispatched more than once: " + execRequests);
            const execRequest = supervisor.requests.find((request) => request.method === "POST" && request.url.endsWith("/tools/exec_bash"));
            assert(execRequest?.generation === 2, "command was not dispatched through the reconnected supervisor generation");
            assert(!("timeout_ms" in execRequest.body), "reconnected omitted command serialized timeout_ms");
            assert(globalThis.__AGENTSH_PI__.getSupervisorMetadata().command_timeout.default_ms === 180, "reconnect did not refresh command_timeout metadata before dispatch");

            await shutdownSession(pi);
            await supervisor.close();
          }

          // The typed direnv API targets the exact REST session, uses the effective
          // remote cwd, reconnects only before dispatch, supports cancellation, and
          // never replays an ambiguous mutating refresh.
          {
            clearAgentSHEnv();
            process.env.PI_AGENTSH_APPROVAL_POLL_MS = "15";
            const expectedSession = "sess-direnv-refresh";
            let refreshRequests = 0;
            let destroyRefresh = false;
            const supervisor = await withRestartableRestSupervisor(async (request) => {
              if (request.method === "GET" && request.url === "/api/v1/sessions/" + expectedSession) {
                return { id: expectedSession, session_id: expectedSession, workspace: "/real/project", worktree: "/shadow/work" };
              }
              if (request.method === "GET" && request.url === "/api/v1/approvals") return [];
              if (request.method === "POST" && request.url === "/api/v1/sessions/" + expectedSession + "/tools/refresh_direnv") {
                refreshRequests += 1;
                if (destroyRefresh) return { destroySocket: true };
                return { ok: true, result: { state: "loaded", set_count: 2, unset_count: 1, rejected_count: 3, generation: refreshRequests, duration_ms: 4 } };
              }
              return { statusCode: 404, body: { error: "unexpected supervisor request", request } };
            });
            process.env.AGENTSH_SESSION_ID = expectedSession;
            process.env.AGENTSH_SESSION_SUPERVISOR = "unix://" + supervisor.socketPath;
            process.env.PI_AGENTSH_REMOTE_CWD = "/workspace";
            const pi = createPi();
            sandbox(pi);
            const ctx = createContext();
            await startSession(pi, ctx);

            const first = await globalThis.__AGENTSH_PI__.refreshDirenv({ cwd: "/local/control-plane", actor: { kind: "extension", label: "Pi direnv refresh" } });
            assert(first.state === "loaded" && first.rejected_count === 3, "typed direnv result was not preserved");
            const firstRequest = supervisor.requests.find((request) => request.method === "POST" && request.url.endsWith("/tools/refresh_direnv"));
            assert(firstRequest?.url === "/api/v1/sessions/" + expectedSession + "/tools/refresh_direnv", "direnv refresh used the wrong session endpoint");
            assert(firstRequest?.body.cwd === "/workspace", "direnv refresh used local cwd instead of effective remote cwd");
            assert(firstRequest?.body.actor.kind === "extension", "direnv refresh omitted its typed actor");

            await supervisor.stop();
            assert(!fs.existsSync(supervisor.socketPath), "stopped direnv supervisor left its socket path");
            await waitFor(() => globalThis.__AGENTSH_PI__.getSupervisorState().status === "connecting", "direnv watcher did not enter reconnecting state");
            const restart = (async () => {
              await new Promise((resolve) => setTimeout(resolve, 60));
              await supervisor.start();
            })();
            const reconnected = await globalThis.__AGENTSH_PI__.refreshDirenv({ cwd: "/ignored" });
            await restart;
            assert(reconnected.state === "loaded", "direnv refresh did not recover before dispatch");
            assert(refreshRequests === 2, "pre-dispatch reconnect sent direnv refresh more than once: " + refreshRequests);
            assert(supervisor.requests.some((request) => request.generation === 2 && request.method === "GET" && request.url === "/api/v1/sessions/" + expectedSession), "direnv reconnect did not verify the exact session");

            await supervisor.stop();
            assert(!fs.existsSync(supervisor.socketPath), "stopped direnv cancellation supervisor left its socket path");
            await waitFor(() => globalThis.__AGENTSH_PI__.getSupervisorState().status === "connecting", "direnv cancellation watcher did not enter reconnecting state");
            const controller = new AbortController();
            const abortTimer = setTimeout(() => controller.abort(), 30);
            let abortError;
            try {
              await globalThis.__AGENTSH_PI__.refreshDirenv({ cwd: "/ignored", signal: controller.signal });
            } catch (error) {
              abortError = error;
            }
            clearTimeout(abortTimer);
            assert(abortError?.name === "AbortError", "direnv reconnect cancellation did not preserve AbortError");
            assert(refreshRequests === 2, "cancelled direnv refresh reached the server");

            await supervisor.start();
            await waitFor(() => globalThis.__AGENTSH_PI__.getSupervisorState().status === "connected", "direnv test supervisor did not reconnect after cancellation");
            destroyRefresh = true;
            let ambiguousError;
            try {
              await globalThis.__AGENTSH_PI__.refreshDirenv({ cwd: "/ignored" });
            } catch (error) {
              ambiguousError = error;
            }
            await new Promise((resolve) => setTimeout(resolve, 350));
            assert(ambiguousError, "ambiguous direnv transport failure unexpectedly succeeded");
            assert(refreshRequests === 3, "ambiguous direnv refresh was replayed: " + refreshRequests);

            delete process.env.PI_AGENTSH_REMOTE_CWD;
            delete process.env.PI_AGENTSH_APPROVAL_POLL_MS;
            await shutdownSession(pi);
            await supervisor.close();
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

          // A missing listener has the established bounded reconnect timeout, not
          // the shorter command budget, and does not dispatch the pending command.
          {
            clearAgentSHEnv();
            delete process.env.PI_AGENTSH_APPROVAL_POLL_MS;
            const expectedSession = "sess-reconnect-timeout";
            let execRequests = 0;
            const supervisor = await withRestartableRestSupervisor(async (request) => {
              if (request.method === "GET" && request.url === "/api/v1/sessions/" + expectedSession) return {
                id: expectedSession,
                session_id: expectedSession,
                workspace: "/workspace",
                worktree: "/workspace",
                command_timeout: { default_ms: 10, maximum_ms: 10, source: "policy" },
              };
              if (request.method === "GET" && request.url === "/api/v1/approvals") return [];
              if (request.method === "POST" && request.url.endsWith("/tools/exec_bash")) execRequests += 1;
              return { ok: true, result: { exit_code: 0, stdout: "unexpected", stderr: "" } };
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
              await globalThis.__AGENTSH_PI__.exec("timed-reconnect-command");
            } catch (error) {
              timeoutError = error;
            }
            const elapsed = Date.now() - startedAt;
            assert(timeoutError?.name !== "CommandTransportTimeoutError", "safe reconnect timeout was misclassified as command transport timeout: " + timeoutError);
            assert(String(timeoutError).includes("Timed out waiting 300ms"), "reconnect timeout was not actionable: " + timeoutError);
            assert(elapsed >= 240 && elapsed < 1200, "reconnect timeout was not bounded near its configured deadline: " + elapsed + "ms");
            assert(execRequests === 0, "timed-out command reached the server");
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
            const ctx = createContext({ model: { provider: "openai-codex", id: "gpt-5.5", contextWindow: 200000 }, cwd: "/workspace/project" });
            await startSession(pi, ctx);
            const subagentTool = pi.tools.get("subagent");
            assert(subagentTool, "REST mode did not register subagent tool");
            assert(!("timeout_ms" in subagentTool.parameters.properties), "model-facing subagent timeout override was exposed by default");

            await subagentTool.execute("inherit-model", { task: "ok" }, undefined, undefined, ctx);
            await subagentTool.execute("explicit-model", { task: "ok", model: "google/gemini-pro" }, undefined, undefined, ctx);
            await subagentTool.execute("parallel-model", { tasks: [{ task: "one" }, { task: "two", model: "anthropic/claude-sonnet" }] }, undefined, undefined, ctx);
            await subagentTool.execute("relative-single-cwd", { task: "ok", cwd: "rtl/package" }, undefined, undefined, ctx);
            await subagentTool.execute("relative-parallel-cwd", { tasks: [{ task: "one" }, { task: "two", cwd: "../shared" }] }, undefined, undefined, ctx);
            await subagentTool.execute("short-timeout", { task: "ok", timeout_ms: 1234 }, undefined, undefined, ctx);
            await subagentTool.execute("long-timeout", { task: "ok", timeout_ms: 10800000 }, undefined, undefined, ctx);

            process.env.PI_AGENTSH_EXPOSE_SUBAGENT_TIMEOUT = "1";
            const timeoutOptInPi = createPi();
            sandbox(timeoutOptInPi);
            await startSession(timeoutOptInPi, ctx);
            const timeoutOptInTool = timeoutOptInPi.tools.get("subagent");
            assert(timeoutOptInTool && "timeout_ms" in timeoutOptInTool.parameters.properties, "operator opt-in did not expose the model-facing subagent timeout override");
            await timeoutOptInTool.execute("opt-in-timeout", { task: "ok", timeout_ms: 1234 }, undefined, undefined, ctx);
            delete process.env.PI_AGENTSH_EXPOSE_SUBAGENT_TIMEOUT;

            const spawnRequests = supervisor.requests.filter((request) => request.method === "POST" && request.url.endsWith("/tools/spawn_subagent"));
            assert(spawnRequests.length === 8, "unexpected subagent request count");
            assert(spawnRequests[0].body.model === "openai-codex/gpt-5.5", "single child did not inherit parent model");
            assert(spawnRequests[1].body.model === "google/gemini-pro", "explicit child model was overwritten");
            assert(spawnRequests[2].body.tasks[0].model === "openai-codex/gpt-5.5", "parallel child did not inherit parent model");
            assert(spawnRequests[2].body.tasks[1].model === "anthropic/claude-sonnet", "parallel explicit model was overwritten");
            assert(spawnRequests[3].body.cwd === "/workspace/project/rtl/package", "single relative cwd was not resolved from the parent Pi cwd");
            assert(spawnRequests[4].body.cwd === "/workspace/project", "parallel request omitted the parent Pi cwd");
            assert(spawnRequests[4].body.tasks[0].cwd === undefined, "parallel child without cwd was rewritten unnecessarily");
            assert(spawnRequests[4].body.tasks[1].cwd === "/workspace/shared", "parallel relative cwd was not resolved from the parent Pi cwd");
            assert(spawnRequests[0].body.timeout_ms === undefined, "client overrode the policy-controlled subagent timeout");
            assert(spawnRequests[5].body.timeout_ms === undefined, "hidden shorter subagent timeout reached AgentSH");
            assert(spawnRequests[6].body.timeout_ms === undefined, "hidden longer subagent timeout reached AgentSH");
            assert(spawnRequests[7].body.timeout_ms === 1234, "operator-enabled subagent timeout was not forwarded");
            assert(spawnRequests[0].body.result_artifact_threshold_bytes === 4096, "single subagent artifact threshold did not match parent inline budget");
            assert(spawnRequests[2].body.result_artifact_threshold_bytes === 2048, "parallel subagent artifact threshold did not match per-child capsule budget");
            await shutdownSession(timeoutOptInPi);
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
              if (request.method === "POST" && request.url.startsWith("/api/v1/sessions/sess-subagent-stream/tools/spawn_subagent/") && request.url.endsWith("/cancel")) {
                return { statusCode: 202, body: { ok: true, result: { accepted: true, cause: request.body.cause } } };
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
            process.env.PI_AGENTSH_EXPOSE_SUBAGENT_TIMEOUT = "1";
            const pi = createPi();
            sandbox(pi);
            delete process.env.PI_AGENTSH_EXPOSE_SUBAGENT_TIMEOUT;
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
            assert((await applyToolResultHandlers(pi, "subagent", toolResult, ctx)).isError === false, "completed typed terminal was marked as an error");

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
            assert((await applyToolResultHandlers(pi, "subagent", failedToolResult, ctx)).isError === true, "failed child task was not marked as an error by the Pi tool-result event path");

            const typedTimeoutResult = await subagentTool.execute("stream-typed-timeout", { task: "typed-timeout", timeout_ms: 40 }, undefined, undefined, ctx);
            assert(typedTimeoutResult.details.terminal.state === "timed_out", "server execution deadline was not preserved as a typed timeout");
            assert(typedTimeoutResult.details.terminal.failureKind === "process", "server execution timeout was replaced by a client transport timeout while awaiting HTTP EOF");
            assert(typedTimeoutResult.details.terminal.cancellationCause === "request_timeout", "server timeout lost its cancellation cause");
            assert(typedTimeoutResult.details.results[0].terminal.state === "timed_out", "timed-out child was reduced to a protocol failure");
            assert(!typedTimeoutResult.content[0].text.includes("child Pi stream ended before agent_settled"), "typed timeout was misreported as an unsettled protocol");
            assert((await applyToolResultHandlers(pi, "subagent", typedTimeoutResult, ctx)).isError === true, "typed timeout was not marked as an error by the Pi tool-result event path");
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
            assert((await applyToolResultHandlers(pi, "subagent", clientTimeoutResult, ctx)).isError === true, "client timeout was not marked as an error by the Pi tool-result event path");

            const dishonestToolUseResult = await subagentTool.execute("stream-dishonest-tool-use", { task: "dishonest-tool-use" }, undefined, undefined, ctx);
            assert(dishonestToolUseResult.details.terminal.state === "failed", "tool-use message_end was accepted as completed parent result");
            assert(dishonestToolUseResult.details.results[0].terminal.failureKind === "protocol", "tool-use completion was not classified as a protocol failure");
            assert(dishonestToolUseResult.details.results[0].modelStopReason === "toolUse", "tool-use model stop reason was lost");
            assert(!dishonestToolUseResult.content[0].text.includes("stale-earlier-answer"), "an earlier assistant message was reused as the final answer after tool use");
            assert(dishonestToolUseResult.content[0].text.includes("tool-use"), "tool-use protocol failure diagnostic was not parent-visible");
            assert((await applyToolResultHandlers(pi, "subagent", dishonestToolUseResult, ctx)).isError === true, "dishonest tool-use completion was not marked as an error by the Pi tool-result event path");

            const partialTransportResult = await subagentTool.execute("stream-partial-transport", { task: "partial-transport" }, undefined, undefined, ctx);
            assert(partialTransportResult.details.terminal.state === "failed", "missing terminal stream event was not reported as transport failure");
            assert(partialTransportResult.details.results[0].terminal.state === "completed", "outer transport failure overwrote an already-completed parallel child");
            assert(partialTransportResult.details.results[0].lastAssistantText === "completed-before-transport-failure", "completed child answer was lost during parallel cancellation reduction");
            assert(!partialTransportResult.details.results[0].errorMessage, "outer transport failure was copied onto an already-completed child");
            assert(partialTransportResult.details.results[1].terminal.state === "failed", "interrupted parallel child was not marked failed");
            assert((await applyToolResultHandlers(pi, "subagent", partialTransportResult, ctx)).isError === true, "partial transport failure was not marked as an error by the Pi tool-result event path");

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
            assert(cancelledToolResult.content[0].text.includes("must not be replayed automatically"), "cancelled subagent omitted unknown-side-effect no-replay guidance");
            assert((await applyToolResultHandlers(pi, "subagent", cancelledToolResult, ctx)).isError === true, "cancelled subagent was not marked as an error by the Pi tool-result event path");
            const cancelledSpawnIndex = supervisor.requests.findIndex((request) => request.method === "POST" && request.url.endsWith("/tools/spawn_subagent") && request.body.tasks?.some((task) => task.task === "cancel-stream"));
            const cancelledSpawn = supervisor.requests[cancelledSpawnIndex];
            const cancellationIndex = supervisor.requests.findIndex((request) => request.method === "POST" && request.url.endsWith("/" + cancelledSpawn?.body.request_id + "/cancel"));
            const cancellationRequest = supervisor.requests[cancellationIndex];
            assert(typeof cancelledSpawn?.body.request_id === "string" && cancelledSpawn.body.request_id.startsWith("subagent-request-"), "spawn request omitted its cancellation identity");
            assert(cancellationIndex > cancelledSpawnIndex && cancellationRequest?.body.cause === "user_cancelled", "caller abort closed the stream before propagating typed cancellation: " + JSON.stringify({ cancelledSpawn, cancellationRequest }));

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

          // AgentSH bash outcomes prefer promoted typed fields, retain old nested
          // errors, distinguish terminal classes, and do not confuse a real 127.
          {
            clearAgentSHEnv();
            const sessionId = "sess-exec-outcomes";
            const supervisor = await withRestSupervisor(async (request) => {
              if (request.method === "GET" && request.url === "/api/v1/sessions/" + sessionId) {
                return { id: sessionId, session_id: sessionId, workspace: "/workspace", worktree: "/workspace" };
              }
              if (request.method === "GET" && request.url === "/api/v1/approvals") return [];
              if (request.method === "POST" && request.url.endsWith("/tools/exec_bash")) {
                const command = request.body.command;
                const base = { command_id: "cmd-" + command, session_id: sessionId, stdout: "", stderr: "", duration_ms: 1 };
                if (command === "typed-preexec") return { statusCode: 503, body: { ok: false, error: "generic", result: { ...base, exit_code: 127, command_started: false, outcome: { command_started: false, dispatch_state: "not_dispatched", failure_kind: "pre_exec_enforcement", retryable: false, code: "E_NETHELPER_UNAVAILABLE", message: "helper expired token=top-secret {\"api_key\":\"json-secret\"} ?access_token=query-secret Authorization: Bearer bearer-secret sk-live-providersecret ghp_githubsecret123456" }, error: { code: "E_NETHELPER_UNAVAILABLE", message: "typed helper failure" }, exec_response: { result: { outcome: { command_started: true, failure_kind: "child_exit", message: "wrong nested outcome" }, error: { code: "WRONG", message: "wrong nested error" } } } } } };
                if (command === "legacy-preexec") return { ok: true, result: { ...base, exit_code: 127, exec_response: { result: { exit_code: 127, error: { code: "E_COMMAND_FAILED", message: "legacy child returned 127" } } } } };
                if (command === "legacy-explicit-preexec") return { ok: true, result: { ...base, exit_code: 127, exec_response: { result: { exit_code: 127, error: { code: "E_COMMAND_START_FAILED", message: "legacy helper setup failed" } } } } };
                if (command === "legacy-zero-preexec") return { ok: true, result: { ...base, exit_code: 0, exec_response: { result: { exit_code: 0, error: { code: "E_COMMAND_START_FAILED", message: "legacy zero helper setup failed" } } } } };
                if (command === "mixed-fields") return { ok: true, result: { ...base, exit_code: 1, error: { code: "E_COMMAND_FAILED", message: "promoted message" }, exec_response: { result: { outcome: { command_started: true, dispatch_state: "started", failure_kind: "child_exit", retryable: false, execution_duration_ms: 9 } } } } };
                if (command === "malformed-500") return { statusCode: 503, body: { result: { stdout: "partial" } } };
                if (command === "partial-ok-false") return { statusCode: 500, body: { ok: false, result: { stdout: "partial" } } };
                if (command === "exit-127") return { ok: true, result: { ...base, exit_code: 127, command_started: true, outcome: { command_started: true, dispatch_state: "started", failure_kind: "child_exit", retryable: false } } };
                if (command === "post-start-cleanup") return { ok: true, result: { ...base, exit_code: 0, outcome: { command_started: true, dispatch_state: "started", failure_kind: "post_start_cleanup", retryable: false, code: "E_POST_START_CLEANUP", message: "helper cleanup registration failed" } } };
                if (command === "contradictory-preexec-started") return { ok: true, result: { ...base, exit_code: 0, outcome: { command_started: true, dispatch_state: "pre_exec_refused", failure_kind: "pre_exec_enforcement", retryable: false, code: "E_PRE_EXEC_ENFORCEMENT", message: "legacy contradictory cleanup result" } } };
                const kinds = {
                  "queue-timeout": ["queue_timeout", false],
                  "cancelled": ["caller_cancellation", false],
                  "command-timeout": ["command_timeout", true],
                  "denied": ["policy_or_approval_denial", false],
                };
                const fixture = kinds[command];
                if (fixture) return { ok: true, result: { ...base, exit_code: 1, outcome: { command_started: fixture[1], dispatch_state: fixture[1] ? "started" : "not_dispatched", failure_kind: fixture[0], retryable: false, code: "E_" + fixture[0].toUpperCase(), message: command + " semantic message", queue_duration_ms: 12, execution_duration_ms: fixture[1] ? 34 : 0 } } };
              }
              return { statusCode: 404, body: { error: "unexpected supervisor request", request } };
            });
            process.env.AGENTSH_SESSION_ID = sessionId;
            process.env.AGENTSH_SESSION_SUPERVISOR = "unix://" + supervisor.socketPath;
            const pi = createPi();
            sandbox(pi);
            const ctx = createContext();
            await startSession(pi, ctx);
            const bashTool = pi.tools.get("bash");
            const typed = await bashTool.execute("typed-preexec", { command: "typed-preexec" }, undefined, undefined, ctx);
            assert(typed.isError === true && typed.details.commandStarted === false, "typed pre-exec failure lost non-started evidence");
            assert((await applyToolResultHandlers(pi, "bash", typed, ctx)).isError === true, "AgentSH Bash failure was not promoted through Pi's tool_result channel");
            assert(typed.details.normalizationSource === "top-level" && typed.details.failureKind === "pre_exec_enforcement", "top-level typed outcome did not beat nested fields");
            assert(typed.content[0].text.includes("Command was not executed") && typed.content[0].text.includes("helper expired"), "typed helper failure was not rendered semantically");
            for (const secret of ["top-secret", "json-secret", "query-secret", "bearer-secret", "providersecret", "githubsecret", "wrong nested"]) assert(!JSON.stringify(typed).includes(secret), "typed diagnostics leaked secret/lower-priority text: " + secret);
            const legacy = await bashTool.execute("legacy-preexec", { command: "legacy-preexec" }, undefined, undefined, ctx);
            assert(legacy.isError === true && legacy.details.normalizationSource === "legacy" && legacy.details.commandStarted === undefined, "generic legacy failure falsely proved non-dispatch");
            assert(!legacy.content[0].text.includes("was not executed") && legacy.content[0].text.includes("legacy child returned 127"), "legacy child exit 127 was misreported");
            const legacyExplicit = await bashTool.execute("legacy-explicit-preexec", { command: "legacy-explicit-preexec" }, undefined, undefined, ctx);
            assert(legacyExplicit.details.commandStarted === false && legacyExplicit.content[0].text.includes("was not executed"), "narrow legacy pre-exec code was not retained");
            const legacyZero = await bashTool.execute("legacy-zero-preexec", { command: "legacy-zero-preexec" }, undefined, undefined, ctx);
            assert(legacyZero.details.failed === true && legacyZero.details.exitCode === 0, "legacy exit-zero semantic failure was not classified");
            assert((await applyToolResultHandlers(pi, "bash", legacyZero, ctx)).isError === true, "legacy exit-zero semantic failure was persisted as success");
            const mixed = await bashTool.execute("mixed-fields", { command: "mixed-fields" }, undefined, undefined, ctx);
            assert(mixed.details.commandStarted === true && mixed.details.failureKind === "child_exit" && mixed.details.executionDurationMs === 9 && mixed.content[0].text.includes("promoted message"), "promoted and nested typed fields were not merged individually");
            for (const command of ["malformed-500", "partial-ok-false"]) {
              const transport = await bashTool.execute(command, { command }, undefined, undefined, ctx);
              assert(transport.isError === true && transport.details.failureKind === "transport_ambiguity" && transport.details.commandStarted === undefined && transport.content[0].text.includes("not replayed"), command + " was accepted as semantic exit 0");
              assert((await applyToolResultHandlers(pi, "bash", transport, ctx)).isError === true, command + " was not promoted through Pi's tool_result channel");
            }
            const exit127 = await bashTool.execute("exit-127", { command: "exit-127" }, undefined, undefined, ctx);
            assert(exit127.isError === true && exit127.details.commandStarted === true && exit127.details.failureKind === "child_exit", "genuine child exit 127 was confused with infrastructure failure");
            assert(exit127.content[0].text.includes("Command exited with code 127") && !exit127.content[0].text.includes("was not executed"), "genuine exit 127 rendered as pre-exec refusal");
            for (const command of ["post-start-cleanup", "contradictory-preexec-started"]) {
              const cleanup = await bashTool.execute(command, { command }, undefined, undefined, ctx);
              assert(cleanup.isError === true && cleanup.details.commandStarted === true, command + " lost authoritative start evidence");
              assert(cleanup.content[0].text.includes("Command started") && cleanup.content[0].text.includes("must not be replayed automatically") && !cleanup.content[0].text.includes("was not executed"), command + " rendered a started cleanup failure as safe pre-exec refusal: " + JSON.stringify(cleanup));
            }
            let typedTimeout;
            try {
              await bashTool.execute("command-timeout", { command: "command-timeout" }, undefined, undefined, ctx);
            } catch (error) {
              typedTimeout = error;
            }
            assert(typedTimeout?.name === "CommandExecutionTimeoutError" && String(typedTimeout).includes("command-timeout semantic message"), "command timeout did not retain typed timeout semantics: " + typedTimeout);
            for (const [command, expected] of [["queue-timeout", "execution queue"], ["cancelled", "queued request was cancelled"], ["denied", "policy or approval denied"]]) {
              const result = await bashTool.execute(command, { command }, undefined, undefined, ctx);
              assert(result.isError === true && result.content[0].text.includes(expected), command + " was not rendered distinctly: " + JSON.stringify(result));
              assert(result.details.queueDurationMs === 12, command + " lost structured duration details");
            }
            await shutdownSession(pi);
            await supervisor.close();
          }

          // Typed AgentSH REST failures render as domain errors without exposing
          // transport framing, internal paths, or raw response bodies.
          {
            clearAgentSHEnv();
            const sessionId = "sess-domain-errors";
            const supervisor = await withRestSupervisor(async (request) => {
              if (request.method === "GET" && request.url === "/api/v1/sessions/" + sessionId) {
                return { id: sessionId, session_id: sessionId, workspace: "/workspace", worktree: "/workspace" };
              }
              if (request.method === "GET" && request.url === "/api/v1/approvals") return [];
              if (request.method === "POST" && request.url.endsWith("/tools/read_file")) {
                const requested = String(request.body.path || "");
                if (requested.endsWith("missing.txt")) return { statusCode: 404, body: { ok: false, code: "file_not_found", error: "File not found", path: "/workspace/missing.txt", error_id: "error-file", internal_debug: "/private/shadow/secret-path" } };
                if (requested.endsWith("supervisor.env")) return { statusCode: 404, body: { ok: false, code: "file_not_found", error: "File not found", path: "/workspace/sessions/session-missing/supervisor.env", error_id: "error-session-path-file" } };
                if (requested.endsWith("policy.txt")) return { statusCode: 403, body: { ok: false, code: "policy_denied", error: "operation denied by policy rule read-only", path: "/workspace/policy.txt", error_id: "error-policy" } };
                if (requested.endsWith("approval.txt")) return { statusCode: 403, body: { ok: false, code: "approval_denied", error: "operation denied by approval", path: "/workspace/approval.txt", error_id: "error-approval" } };
                if (requested.endsWith("malformed.txt")) return { statusCode: 500, body: "raw-internal-secret /private/shadow/path" };
                if (requested.endsWith("ambiguous.txt")) return { statusCode: 404, body: { ok: false, error: "ambiguous legacy not found /private/shadow/path" } };
                if (requested.endsWith("session.txt")) return { statusCode: 404, body: { ok: false, code: "session_not_found", error: "AgentSH session not found", error_id: "error-session" } };
              }
              if (request.method === "POST" && request.url.endsWith("/tools/edit_file")) {
                return { statusCode: 409, body: { ok: false, code: "edit_conflict", error: "oldText is not unique", path: "/workspace/edit.txt", error_id: "error-edit" } };
              }
              if (request.method === "POST" && request.url.endsWith("/tools/spawn_subagent")) {
                return { statusCode: 404, body: { ok: false, code: "unsupported_endpoint", error: "endpoint is not supported", error_id: "error-endpoint" } };
              }
              return { statusCode: 404, body: { ok: false, code: "unsupported_endpoint", error: "endpoint is not supported" } };
            });
            process.env.AGENTSH_SESSION_ID = sessionId;
            process.env.AGENTSH_SESSION_SUPERVISOR = "unix://" + supervisor.socketPath;
            process.env.PI_AGENTSH_READ_MODE = "supervised";
            const pi = createPi();
            sandbox(pi);
            const ctx = createContext();
            await startSession(pi, ctx);
            const readTool = pi.tools.get("read");
            const editTool = pi.tools.get("edit");
            const subagentTool = pi.tools.get("subagent");
            const capture = async (run) => {
              try { await run(); throw new Error("expected domain failure"); }
              catch (error) { return String(error); }
            };
            const missing = await capture(() => readTool.execute("domain-missing", { path: "/workspace/missing.txt" }, undefined, undefined, ctx));
            assert(missing.includes("File not found: /workspace/missing.txt") && !missing.includes("HTTP 404") && !missing.includes("/api/v1/") && !missing.includes("private/shadow"), "missing file exposed REST framing: " + missing);
            const missingSessionPath = await capture(() => readTool.execute("domain-missing-session-path", { path: "/workspace/sessions/session-missing/supervisor.env" }, undefined, undefined, ctx));
            assert(missingSessionPath.includes("File not found: /workspace/sessions/session-missing/supervisor.env") && !missingSessionPath.includes("no longer safe to use"), "typed file_not_found containing /sessions/ was misclassified as session loss: " + missingSessionPath);
            assert(globalThis.__AGENTSH_PI__.getSupervisorState().status === "connected", "typed file_not_found containing /sessions/ permanently disabled the AgentSH client");
            const policy = await capture(() => readTool.execute("domain-policy", { path: "/workspace/policy.txt" }, undefined, undefined, ctx));
            assert(policy.includes("AgentSH policy denied") && policy.includes("/workspace/policy.txt") && !policy.includes("HTTP 403"), "policy denial was not normalized: " + policy);
            const approval = await capture(() => readTool.execute("domain-approval", { path: "/workspace/approval.txt" }, undefined, undefined, ctx));
            assert(approval.includes("AgentSH approval denied") && !approval.includes("HTTP 403"), "approval denial was not normalized: " + approval);
            const edit = await capture(() => editTool.execute("domain-edit", { path: "/workspace/edit.txt", edits: [{ oldText: "x", newText: "y" }] }, undefined, undefined, ctx));
            assert(edit.includes("Edit conflict: /workspace/edit.txt") && edit.includes("oldText is not unique") && !edit.includes("HTTP 409"), "edit conflict was not normalized: " + edit);
            const malformed = await capture(() => readTool.execute("domain-malformed", { path: "/workspace/malformed.txt" }, undefined, undefined, ctx));
            assert(malformed.includes("AgentSH request failed") && !malformed.includes("raw-internal-secret") && !malformed.includes("private/shadow") && !malformed.includes("HTTP 500"), "malformed response leaked raw diagnostics: " + malformed);
            const ambiguous = await capture(() => readTool.execute("domain-ambiguous", { path: "/workspace/ambiguous.txt" }, undefined, undefined, ctx));
            assert(ambiguous.includes("AgentSH request failed") && !ambiguous.includes("File not found") && !ambiguous.includes("does not support") && !ambiguous.includes("private/shadow"), "ambiguous legacy 404 was misclassified: " + ambiguous);
            const unsupportedResult = await subagentTool.execute("domain-subagent", { task: "unsupported" }, undefined, undefined, ctx);
            const unsupported = JSON.stringify(unsupportedResult);
            assert((await applyToolResultHandlers(pi, "subagent", unsupportedResult, ctx)).isError === true && unsupported.includes("does not support spawn_subagent") && !unsupported.includes("HTTP 404"), "typed unsupported endpoint was not actionable or marked as a Pi tool error: " + unsupported);
            const sessionLost = await capture(() => readTool.execute("domain-session", { path: "/workspace/session.txt" }, undefined, undefined, ctx));
            assert(sessionLost.includes("session " + sessionId) && sessionLost.includes("no longer safe to use") && !sessionLost.includes("HTTP 404"), "session loss was not distinguished: " + sessionLost);
            await shutdownSession(pi);
            delete process.env.PI_AGENTSH_READ_MODE;
            await supervisor.close();
          }

          // PI_AGENTSH_ENABLE starts and attaches the extension-owned local
          // supervisor during session startup; no runtime lifecycle command exists.
          {
            clearAgentSHEnv();
            const sessionId = "sess-local-start";
            const supervisor = await withRestSupervisor(async (request) => {
              if (request.method === "GET" && request.url === "/api/v1/sessions/" + sessionId) return { id: sessionId, session_id: sessionId };
              if (request.method === "GET" && request.url.endsWith("/network-enforcement")) return { requested: "none", readiness: "none", status: "none" };
              if (request.method === "GET" && request.url === "/api/v1/approvals") return [];
              return { statusCode: 404, body: {} };
            });
            process.env.PI_AGENTSH_ENABLE = "1";
            process.env.PI_AGENTSH_BIN = process.env.localStart;
            process.env.LOCAL_START_SOCKET = supervisor.socketPath;
            const pi = createPi(); sandboxExtension(pi);
            assert(pi.toolRegistrations.filter((name) => name === "subagent").length === 0, "sandbox backend registered a duplicate subagent tool");
            subagent(pi); const ctx = createContext(); await startSession(pi, ctx);
            assert(pi.toolRegistrations.filter((name) => name === "subagent").length === 1, "combined sandbox/adaptive extensions did not register exactly one subagent tool");
            assert(globalThis.__AGENTSH_PI__.getSupervisorState().source === "agentsh-started" && globalThis.__AGENTSH_PI__.getSupervisorState().sessionId === sessionId, "local extension-owned startup did not attach its created session");
            assert(!pi.commands.has("sandbox-control"), "removed sandbox-control lifecycle command was registered");
            await shutdownSession(pi); await supervisor.close();
          }

          // Protocol-v2 crash recovery invokes the trusted wrapper exactly once,
          // accepts only a monotonic incarnation, restores only explicitly requested
          // environment names, refreshes direnv, and dispatches the waiting mutation once.
          {
            clearAgentSHEnv();
            const sessionId = "sess-protocol-v2-recovery";
            const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentsh-v2-recovery-"));
            fs.chmodSync(privateDir, 0o700);
            const statePath = path.join(privateDir, "state.json");
            const recoveryMarker = path.join(privateDir, "automatic-recovery.requested");
            fs.writeFileSync(statePath, JSON.stringify({ schema_version: 1, session_id: sessionId, status: "active" }), { mode: 0o600 });
            let environmentRestored = false;
            let direnvRestored = false;
            let mutationRequests = 0;
            const supervisor = await withRestartableRestSupervisor(async (request) => {
              const durableGeneration = request.generation;
              const incarnation = durableGeneration === 1 ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222";
              if (request.method === "GET" && request.url === "/api/v1/detached/status") {
                const recoveredReady = durableGeneration === 1 || (environmentRestored && direnvRestored);
                return {
                  protocol_version: 2,
                  session_id: sessionId,
                  lifecycle_state: recoveredReady ? "ready" : "degraded",
                  generation: durableGeneration,
                  incarnation_id: incarnation,
                  recoverable: true,
                  required_environment: durableGeneration === 2 && !environmentRestored ? ["RECOVERY_CUSTOM_ENV", "RECOVERY_MISSING_ENV"] : [],
                  direnv_refresh_required: durableGeneration === 2 && !direnvRestored,
                  network_enforcement: { requested: "none", readiness: "none", status: "none" },
                };
              }
              if (request.method === "PATCH" && request.url === "/api/v1/sessions/" + sessionId) {
                assert(request.body.env.RECOVERY_CUSTOM_ENV === "restore-this-value", "recovery omitted the requested parent environment value");
                assert(request.body.unset.length === 1 && request.body.unset[0] === "RECOVERY_MISSING_ENV", "recovery did not explicitly unset an absent requested value");
                assert(!JSON.stringify(request.body).includes("must-never-be-forwarded"), "recovery forwarded an unrequested parent secret");
                environmentRestored = true;
                return { id: sessionId, session_id: sessionId };
              }
              if (request.method === "POST" && request.url === "/api/v1/sessions/" + sessionId + "/tools/refresh_direnv") {
                assert(request.body.cwd === "/workspace", "recovery direnv refresh used a local rather than effective remote cwd");
                direnvRestored = true;
                return { ok: true, result: { state: "loaded", set_count: 1, unset_count: 0, rejected_count: 0, generation: 2, duration_ms: 1 } };
              }
              if (request.method === "GET" && request.url === "/api/v1/sessions/" + sessionId) return { id: sessionId, session_id: sessionId, workspace: "/workspace", worktree: "/workspace" };
              if (request.method === "GET" && request.url.endsWith("/network-enforcement")) return { requested: "none", readiness: "none", status: "none" };
              if (request.method === "GET" && request.url === "/api/v1/approvals") return [];
              if (request.method === "POST" && request.url.endsWith("/tools/write_file")) {
                mutationRequests += 1;
                return { ok: true, result: { text: "v2 recovered write" } };
              }
              return { statusCode: 404, body: { error: "unexpected protocol-v2 request", request } };
            });
            process.env.AGENTSH_SESSION_ID = sessionId;
            process.env.AGENTSH_SESSION_SUPERVISOR = "unix://" + supervisor.socketPath;
            process.env.AGENTSH_SESSION_SUPERVISOR_GENERATION = "1";
            process.env.AGENTSH_SESSION_SUPERVISOR_INCARNATION = "11111111-1111-4111-8111-111111111111";
            process.env.PI_AGENTSH_REMOTE_CWD = "/workspace";
            process.env.PI_AGENTSH_RECOVERY_COMMAND = process.env.recoveryAutomatic;
            process.env.PI_AGENTSH_LIFECYCLE_STATE = statePath;
            process.env.RECOVERY_CUSTOM_ENV = "restore-this-value";
            process.env.RECOVERY_UNRELATED_SECRET = "must-never-be-forwarded";
            const pi = createPi(); sandbox(pi); const ctx = createContext(); await startSession(pi, ctx);

            await supervisor.stop();
            const restart = (async () => {
              await waitFor(() => fs.existsSync(recoveryMarker), "automatic protocol-v2 recovery command was not invoked");
              await supervisor.start();
            })();
            const result = await pi.tools.get("write").execute("v2-recovered-write", { path: "/workspace/recovered.txt", content: "once\n" }, undefined, undefined, ctx);
            await restart;
            assert(result.content[0].text.includes("v2 recovered write"), "protocol-v2 mutation did not complete after exact recovery");
            assert(fs.readFileSync(recoveryMarker, "utf8").trim().split("\n").length === 1, "automatic wrapper recovery was invoked more than once");
            assert(environmentRestored && direnvRestored, "recovery admitted a mutation before environment and direnv restoration");
            assert(mutationRequests === 1, "protocol-v2 recovery replayed the waiting mutation");
            const metadata = globalThis.__AGENTSH_PI__.getSupervisorMetadata();
            assert(metadata.supervisor_generation === 2 && metadata.supervisor_incarnation_id === "22222222-2222-4222-8222-222222222222", "recovery did not retain the monotonic generation/incarnation identity");
            await shutdownSession(pi); await supervisor.close();
          }

          // Session shutdown aborts and joins automatic wrapper recovery,
          // including descendants in the recovery process group.
          {
            clearAgentSHEnv();
            const sessionId = "sess-automatic-recovery-shutdown";
            const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentsh-automatic-recovery-shutdown-"));
            fs.chmodSync(privateDir, 0o700);
            const statePath = path.join(privateDir, "state.json");
            const descendantPath = path.join(privateDir, "descendant.pid");
            fs.writeFileSync(statePath, JSON.stringify({ schema_version: 1, session_id: sessionId, status: "active" }), { mode: 0o600 });
            const supervisor = await withRestartableRestSupervisor(async (request) => {
              if (request.method === "GET" && request.url === "/api/v1/detached/status") return {
                protocol_version: 2, session_id: sessionId, lifecycle_state: "ready", generation: 1,
                incarnation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", recoverable: true,
              };
              if (request.method === "GET" && request.url === "/api/v1/sessions/" + sessionId) return { id: sessionId, session_id: sessionId, workspace: "/workspace", worktree: "/workspace" };
              if (request.method === "GET" && request.url.endsWith("/network-enforcement")) return { requested: "none", readiness: "none", status: "none" };
              if (request.method === "GET" && request.url === "/api/v1/approvals") return [];
              return { statusCode: 404, body: {} };
            });
            process.env.AGENTSH_SESSION_ID = sessionId;
            process.env.AGENTSH_SESSION_SUPERVISOR = "unix://" + supervisor.socketPath;
            process.env.AGENTSH_SESSION_SUPERVISOR_GENERATION = "1";
            process.env.AGENTSH_SESSION_SUPERVISOR_INCARNATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
            process.env.PI_AGENTSH_RECOVERY_COMMAND = process.env.recoverySlow;
            process.env.PI_AGENTSH_LIFECYCLE_STATE = statePath;
            process.env.PI_AGENTSH_RECOVERY_TIMEOUT_MS = "5000";
            const pi = createPi(); sandbox(pi); const ctx = createContext(); await startSession(pi, ctx);
            await supervisor.stop();
            const pending = pi.tools.get("write").execute("shutdown-during-recovery", { path: "/workspace/x", content: "x" }, undefined, undefined, ctx).catch((error) => error);
            await waitFor(() => fs.existsSync(descendantPath), "automatic recovery descendant did not start");
            const descendantPid = Number(fs.readFileSync(descendantPath, "utf8"));
            await shutdownSession(pi);
            await pending;
            await waitFor(() => !processIsAlive(descendantPid), "automatic recovery descendant survived session shutdown");
            assert(globalThis.__AGENTSH_PI__.getSupervisorState().status === "inactive", "automatic recovery changed state after shutdown");
            await supervisor.close();
          }

          // Shutdown can also dispose recovery started by the initial hello,
          // before the candidate client has published capability-bearing state.
          {
            clearAgentSHEnv();
            const sessionId = "sess-startup-recovery-shutdown";
            const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentsh-startup-recovery-shutdown-"));
            fs.chmodSync(privateDir, 0o700);
            const statePath = path.join(privateDir, "state.json");
            const descendantPath = path.join(privateDir, "descendant.pid");
            fs.writeFileSync(statePath, JSON.stringify({ schema_version: 1, session_id: sessionId, status: "active" }), { mode: 0o600 });
            const supervisor = await withRestartableRestSupervisor(async (request) => {
              if (request.method === "GET" && request.url === "/api/v1/detached/status") return {
                protocol_version: 2, session_id: sessionId, lifecycle_state: "degraded", generation: 1,
                incarnation_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", recoverable: true,
              };
              return { statusCode: 404, body: {} };
            });
            process.env.AGENTSH_SESSION_ID = sessionId;
            process.env.AGENTSH_SESSION_SUPERVISOR = "unix://" + supervisor.socketPath;
            process.env.PI_AGENTSH_RECOVERY_COMMAND = process.env.recoverySlow;
            process.env.PI_AGENTSH_LIFECYCLE_STATE = statePath;
            process.env.PI_AGENTSH_RECOVERY_TIMEOUT_MS = "5000";
            const pi = createPi(); sandbox(pi); const ctx = createContext();
            const starting = startSession(pi, ctx);
            await waitFor(() => fs.existsSync(descendantPath), "startup recovery descendant did not start");
            const descendantPid = Number(fs.readFileSync(descendantPath, "utf8"));
            await shutdownSession(pi);
            await starting;
            await waitFor(() => !processIsAlive(descendantPid), "startup recovery descendant survived session shutdown");
            assert(globalThis.__AGENTSH_PI__.getSupervisorState().status === "inactive", "startup recovery published state after shutdown");
            await supervisor.close();
          }

          // The same durable generation with a different incarnation is stale or
          // replaced identity and is terminal; no mutation may reach that listener.
          {
            clearAgentSHEnv();
            const sessionId = "sess-stale-incarnation";
            let mutationRequests = 0;
            const supervisor = await withRestartableRestSupervisor(async (request) => {
              if (request.method === "GET" && request.url === "/api/v1/detached/status") return {
                protocol_version: 2, session_id: sessionId, lifecycle_state: "ready", generation: 7,
                incarnation_id: request.generation === 1 ? "77777777-7777-4777-8777-777777777771" : "77777777-7777-4777-8777-777777777772", recoverable: true,
              };
              if (request.method === "GET" && request.url === "/api/v1/sessions/" + sessionId) return { id: sessionId, session_id: sessionId, workspace: "/workspace", worktree: "/workspace" };
              if (request.method === "GET" && request.url.endsWith("/network-enforcement")) return { requested: "none", readiness: "none", status: "none" };
              if (request.method === "GET" && request.url === "/api/v1/approvals") return [];
              if (request.method === "POST" && request.url.endsWith("/tools/write_file")) { mutationRequests += 1; return { ok: true, result: {} }; }
              return { statusCode: 404, body: {} };
            });
            process.env.AGENTSH_SESSION_ID = sessionId;
            process.env.AGENTSH_SESSION_SUPERVISOR = "unix://" + supervisor.socketPath;
            process.env.AGENTSH_SESSION_SUPERVISOR_GENERATION = "7";
            process.env.AGENTSH_SESSION_SUPERVISOR_INCARNATION = "77777777-7777-4777-8777-777777777771";
            const pi = createPi(); sandbox(pi); const ctx = createContext(); await startSession(pi, ctx);
            await supervisor.stop();
            await waitFor(() => globalThis.__AGENTSH_PI__.getSupervisorState().status === "connecting", "stale-incarnation watcher did not enter reconnecting state");
            await supervisor.start();
            await waitFor(() => globalThis.__AGENTSH_PI__.getSupervisorState().status === "error", "stale incarnation did not become terminal");
            const staleState = globalThis.__AGENTSH_PI__.getSupervisorState();
            assert(String(staleState.lastError).includes("incarnation") || String(staleState.lastError).includes("not found or changed"), "stale incarnation rejection was not actionable: " + JSON.stringify(staleState));
            assert(mutationRequests === 0, "mutation reached a same-generation replacement incarnation");
            await shutdownSession(pi); await supervisor.close();
          }

          // Terminal protocol-v2 lifecycle states are rejected before session
          // discovery and never trigger arbitrary replacement-session adoption.
          {
            clearAgentSHEnv();
            const sessionId = "sess-terminal-v2";
            let sessionQueries = 0;
            const supervisor = await withRestSupervisor(async (request) => {
              if (request.method === "GET" && request.url === "/api/v1/detached/status") return {
                protocol_version: 2, session_id: sessionId, lifecycle_state: "finalized", generation: 3,
                incarnation_id: "33333333-3333-4333-8333-333333333333", recoverable: false,
              };
              if (request.url === "/api/v1/sessions/" + sessionId || request.url === "/api/v1/sessions") sessionQueries += 1;
              return { statusCode: 404, body: {} };
            });
            process.env.AGENTSH_SESSION_ID = sessionId;
            process.env.AGENTSH_SESSION_SUPERVISOR = "unix://" + supervisor.socketPath;
            process.env.AGENTSH_SESSION_SUPERVISOR_GENERATION = "3";
            process.env.AGENTSH_SESSION_SUPERVISOR_INCARNATION = "33333333-3333-4333-8333-333333333333";
            const pi = createPi(); sandbox(pi); const ctx = createContext(); await startSession(pi, ctx);
            assert(globalThis.__AGENTSH_PI__.getSupervisorState().status === "error", "terminal protocol-v2 status remained connected");
            assert(sessionQueries === 0, "terminal protocol-v2 status queried or adopted a session");
            await shutdownSession(pi); await supervisor.close();
          }

          // Lifecycle status is non-secret and distinct from supervisor transport.
          {
            clearAgentSHEnv();
            const sessionId = "sess-helper-lifecycle";
            const network = {
              requested: "strict", readiness: "ready", status: "ready", tier: "helper-ebpf-proxy-required", network_policy_enforced: true,
              helper_lifecycle: {
                schema_version: 1, helper_kind: "ephemeral", lease_id: "lease-visible", unit_name: "agentsh-nethelper-visible.service",
                soft_expires_at: "2026-07-19T12:00:00Z", hard_expires_at: "2026-07-24T12:00:00Z", soft_remaining_seconds: 0, hard_remaining_seconds: 432000,
                binding_generation: 2, renewal_generation: 4, credential_source_live: false, status: "expired", terminal_reason: "soft lease expired",
              },
            };
            const supervisor = await withRestSupervisor(async (request) => {
              if (request.method === "GET" && request.url === "/api/v1/sessions/" + sessionId) return { id: sessionId, session_id: sessionId, network_enforcement: network };
              if (request.method === "GET" && request.url.endsWith("/network-enforcement")) return network;
              if (request.method === "GET" && request.url === "/api/v1/approvals") return [];
              return { statusCode: 404, body: {} };
            });
            process.env.AGENTSH_SESSION_ID = sessionId;
            process.env.AGENTSH_SESSION_SUPERVISOR = "unix://" + supervisor.socketPath;
            process.env.PI_AGENTSH_REMOTE = "ssh";
            const pi = createPi(); sandbox(pi); const ctx = createContext(); await startSession(pi, ctx);
            await pi.commands.get("sandbox").handler("", ctx);
            const statusText = String(ctx.notifications.at(-1).message);
            for (const expected of ["Supervisor: connected", "Helper:   expired", "lease-visible", "agentsh-nethelper-visible.service", "soft 2026", "0s remaining", "binding 2", "renewal 4", "socket unknown", "credential source not live", "soft lease expired"]) assert(statusText.includes(expected), "helper lifecycle status omitted " + expected + ": " + statusText);
            assert(!/credential\s*[:=]|token\s*[:=]/i.test(statusText), "helper lifecycle status rendered secret-shaped data");
            await shutdownSession(pi); await supervisor.close();
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
            const ctx = createContext({ choices: ["Allow once"] });
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
            const ctx = createContext({ choices: ["Deny once"] });
            await startSession(pi, ctx);
            await waitFor(() => Boolean(resolved), "deny approval was not resolved");

            assert(JSON.stringify(ctx.selectCalls[0].items) === JSON.stringify(["Deny once", "Allow once"]), "file approval fallback did not keep the prompt compact with Deny once as the safe default");
            assert(resolved.id === "appr-deny", "denied wrong approval id");
            assert(resolved.decision === "deny", "approval was not denied");
            assert(resolved.scope === "once", "deny approval should default to once scope");
            await shutdownSession(pi);
            await server.close();
          }

          // Session-scoped network approvals promote protocol context without repeating raw policy templates.
          {
            clearAgentSHEnv();
            let approvals = [{
              id: "appr-session",
              kind: "network",
              target: "login.dos.cit.tum.de:22",
              rule: "approve-unknown-ssh",
              message: "Pi wants to connect over SSH to: {{.RemoteAddr}}:{{.RemotePort}}",
              fields: {
                scope_kind: "network",
                scope_key: "network:login.dos.cit.tum.de:22",
                scope_label: "login.dos.cit.tum.de:22",
                scope_options: [{ scope_kind: "command-run", scope_key: "command-run:all-approvals", scope_label: "all requests for this command invocation", scope_lifetime: "command" }],
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
            await waitFor(() => Boolean(resolved), "session approval was not resolved");

            assert(ctx.customCalls.length === 1, "network approval did not use the compact overlay prompt");
            const rendered = ctx.customCalls[0].renders[1];
            const renderedChoices = rendered.filter((line) => /Deny|Allow/.test(line));
            assert(rendered.some((line) => line.includes("Connect over SSH?")), "network approval omitted SSH context");
            assert(rendered.filter((line) => line.includes("login.dos.cit.tum.de:22")).length === 1, "network approval did not show its destination exactly once: " + JSON.stringify(rendered));
            assert(!rendered.some((line) => /\{\{|RemoteAddr|RemotePort|Pi wants to connect|network destination/.test(line)), "network approval exposed or repeated its raw policy message: " + JSON.stringify(rendered));
            assert(renderedChoices.length === 4, "network approval should show exactly four choices");
            assert(renderedChoices[0].endsWith("Deny"), "network approval did not make Deny the safe default");
            assert(renderedChoices[1].endsWith("Allow once"), "network approval omitted Allow once");
            assert(renderedChoices[2].endsWith("Allow for session"), "network approval omitted Allow for session");
            assert(renderedChoices[3].endsWith("Allow all accesses for command"), "network approval omitted command-wide network access");
            assert(resolved.id === "appr-session", "resolved wrong session approval id");
            assert(resolved.decision === "approve", "session approval was not approved");
            assert(resolved.scope === "session", "session approval did not relay scope=session");
            assert(/approved for session/i.test(resolved.reason), "session approval reason did not mention session");
            await shutdownSession(pi);
            await server.close();
          }

          // Command prompts promote the policy reason, hide opaque executable paths, and order exact scope before executable scope.
          {
            clearAgentSHEnv();
            const executable = "/nix/store/05fksbfby6px2yg3ccg6ln3n7c63jps3-deploy-hw/bin/deploy-hw";
            const bitstream = "/scratch/theo/zerog/decoder/zerog-d15-v80-rama-triangular-changed/bitstreams/cyt_top.pdi";
            let approvals = [{
              id: "appr-command-scopes",
              kind: "command",
              target: executable,
              rule: "approve-fpga-hardware-access",
              message: "The project wants to access or modify FPGA hardware state",
              fields: {
                command: executable,
                args: ["deploy-hw", bitstream],
                scope_options: [
                  { scope_kind: "command-run", scope_key: "command-run:all-approvals", scope_label: "all requests for this command invocation", scope_lifetime: "command" },
                  { scope_kind: "command", scope_key: "command-executable:deploy-hw", scope_label: executable, scope_path: executable },
                  { scope_kind: "command", scope_key: "command-invocation:deploy-hw-pdi", scope_label: executable + " deploy-hw " + bitstream, scope_path: executable },
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
            await waitFor(() => Boolean(resolved), "command scope approval was not resolved");

            assert(ctx.customCalls.length === 1, "command approval did not use the compact overlay prompt");
            const rendered = ctx.customCalls[0].renders[1];
            const renderedChoices = rendered.filter((line) => /^(?:→ |  )(?:Allow|Deny)/.test(line));
            assert(rendered.some((line) => line.includes("Access or modify FPGA hardware state?")), "command approval did not promote its policy reason");
            assert(rendered.some((line) => line.includes("deploy-hw /scratch/theo/")) && rendered.some((line) => line.includes("cyt_top.pdi")), "command approval omitted its readable invocation: " + JSON.stringify(rendered));
            assert(!rendered.some((line) => line.includes(executable) || line.includes("deploy-hw deploy-hw") || line.includes("The project wants to")), "command approval exposed redundant or opaque command details: " + JSON.stringify(rendered));
            assert(renderedChoices.length === 6, "command approval should show one-shot decisions, command-wide approval, two session grants, and one exact session denial");
            assert(renderedChoices[0].includes("Deny once"), "command approval did not make Deny once the safe default");
            assert(renderedChoices[1].includes("Allow once"), "command approval did not keep common one-shot approval adjacent to the default");
            assert(renderedChoices[2].includes("Allow all requests for this command invocation"), "missing command-wide approval choice");
            assert(renderedChoices[3].includes("Allow this exact invocation for session"), "missing exact-invocation/session allow choice");
            assert(renderedChoices[4].includes("Allow any deploy-hw invocation for session"), "missing readable executable/session allow choice");
            assert(renderedChoices[5].includes("Deny this exact invocation for session"), "missing exact-invocation/session deny choice");
            assert(!renderedChoices.some((line) => /command-invocation:|command-executable:|Deny any deploy-hw/.test(line)), "command choice exposed transport metadata or a broad session denial");
            assert(resolved.id === "appr-command-scopes", "resolved wrong command approval id");
            assert(resolved.decision === "approve", "command scope approval was not approved");
            assert(resolved.scope === "session", "command scope approval did not relay scope=session");
            assert(resolved.scope_kind === "command", "command approval did not relay scope_kind");
            assert(resolved.scope_key === "command-invocation:deploy-hw-pdi", "command approval did not relay exact invocation scope_key");
            assert(resolved.scope_label === executable + " deploy-hw " + bitstream, "command approval did not relay scope_label");
            await shutdownSession(pi);
            await server.close();
          }

          // Command-wide approval is command-scoped, explicit, and has no broad denial counterpart.
          {
            clearAgentSHEnv();
            let approvals = [{
              id: "appr-command-run",
              command_id: "command-compound",
              kind: "command",
              target: "command1",
              fields: {
                command: "command1",
                args: ["--check"],
                scope_options: [
                  { scope_kind: "command-run", scope_key: "command-run:all-approvals", scope_label: "all requests for this command invocation", scope_lifetime: "command" },
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
            await waitFor(() => Boolean(resolved), "command-wide approval was not resolved");
            const rendered = ctx.customCalls[0].renders[1];
            const renderedChoices = rendered.filter((line) => /^(?:→ |  )(?:Allow|Deny)/.test(line));
            assert(renderedChoices.length === 3, "command-wide approval should add exactly one allow choice: " + JSON.stringify(renderedChoices));
            assert(renderedChoices[2].includes("Allow all requests for this command invocation"), "command-wide approval label missing");
            assert(!renderedChoices.some((line) => line.includes("Deny all requests")), "unsafe broad denial was offered");
            assert(resolved.scope === "once", "command-wide approval must remain command-scoped");
            assert(resolved.scope_kind === "command-run", "command-wide approval did not relay scope kind");
            assert(resolved.scope_key === "command-run:all-approvals", "command-wide approval did not relay canonical key");
            assert(/all requests for this command invocation/.test(resolved.reason), "command-wide approval reason was not explicit");
            await shutdownSession(pi);
            await server.close();
          }

          // A queued approval that disappears while another prompt is active is skipped when its turn reaches the UI.
          {
            clearAgentSHEnv();
            process.env.PI_AGENTSH_APPROVAL_POLL_MS = "10";
            let listCount = 0;
            const initialApprovals = [
              { id: "appr-active-before-stale", kind: "network", target: "active.example:443" },
              { id: "appr-stale-queued", kind: "network", target: "stale.example:443" },
            ];
            const server = await withApprovalServer(async (request) => {
              if (request.op === "list") {
                listCount += 1;
                return { ok: true, approvals: listCount === 1 ? initialApprovals : [] };
              }
              if (request.op === "resolve") return { ok: false, error: "externally handled approvals must not be resolved by Pi" };
              return { ok: false, error: "unknown op" };
            });
            setAgentSHEnv(server.socketPath);
            const pi = createPi();
            sandbox(pi);
            const ctx = createContext({ choices: ["__wait_for_abort__", "__wait_for_abort__"] });
            await startSession(pi, ctx);
            await waitFor(
              () => listCount >= 2 && ctx.notifications.some((entry) => String(entry.message).includes("appr-stale-queued")),
              "queued approval did not disappear from pending state",
            );
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));

            const promptCount = ctx.selectCalls.length;
            const resolveSent = server.requests.some((request) => request.op === "resolve");
            await shutdownSession(pi);
            delete process.env.PI_AGENTSH_APPROVAL_POLL_MS;
            await server.close();

            assert(promptCount === 1, "stale queued approval opened a second prompt");
            assert(!resolveSent, "externally handled queued approval was resolved by Pi");
          }

          // Session-scoped command approval refreshes and dismisses covered sibling prompts immediately.
          {
            clearAgentSHEnv();
            process.env.PI_AGENTSH_APPROVAL_POLL_MS = "60000";
            let approvals = [
              {
                id: "appr-sqlite-1",
                kind: "command",
                target: "sqlite3",
                fields: {
                  scope_options: [
                    { scope_kind: "command", scope_key: "command-executable:sqlite", scope_label: "/nix/store/abc-sqlite/bin/sqlite3" },
                    { scope_kind: "command", scope_key: "command-invocation:sqlite-1", scope_label: "/nix/store/abc-sqlite/bin/sqlite3 events.db 'select 1'" },
                  ],
                },
              },
              {
                id: "appr-sqlite-2",
                kind: "command",
                target: "sqlite3",
                fields: {
                  scope_options: [
                    { scope_kind: "command", scope_key: "command-executable:sqlite", scope_label: "/nix/store/abc-sqlite/bin/sqlite3" },
                    { scope_kind: "command", scope_key: "command-invocation:sqlite-2", scope_label: "/nix/store/abc-sqlite/bin/sqlite3 events.db 'select 2'" },
                  ],
                },
              },
            ];
            const resolved = [];
            const server = await withApprovalServer(async (request) => {
              if (request.op === "list") return { ok: true, approvals };
              if (request.op === "resolve") {
                resolved.push(request);
                approvals = [];
                return { ok: true };
              }
              return { ok: false, error: "unknown op" };
            });
            setAgentSHEnv(server.socketPath);
            const pi = createPi();
            sandbox(pi);
            const ctx = createContext({ choices: ["Allow any sqlite3 invocation for session"] });
            await startSession(pi, ctx);
            await waitFor(
              () => resolved.length >= 1 && server.requests.filter((request) => request.op === "list").length >= 2,
              "session-scoped command approval did not refresh pending approvals",
            );
            await new Promise((resolve) => setImmediate(resolve));
            await new Promise((resolve) => setImmediate(resolve));

            const operations = server.requests.map((request) => request.op);
            const resolveIndex = operations.indexOf("resolve");
            const refreshedAfterResolve = resolveIndex >= 0 && operations.slice(resolveIndex + 1).includes("list");
            const resolvedSnapshot = resolved.slice();
            const promptCount = ctx.selectCalls.length;
            await shutdownSession(pi);
            delete process.env.PI_AGENTSH_APPROVAL_POLL_MS;
            await server.close();

            assert(refreshedAfterResolve, "session-scoped resolution did not list pending approvals afterward");
            assert(resolvedSnapshot.length === 1, "covered queued command approval was prompted/resolved again");
            assert(resolvedSnapshot[0].id === "appr-sqlite-1", "resolved wrong initial command approval");
            assert(promptCount === 1, "covered queued command approval opened a second prompt");
          }

          // File/directory scope_options use the custom overlay prompt and relay the selected directory grant exactly.
          {
            clearAgentSHEnv();
            let approvals = [{
              id: "appr-directory",
              created_at: "2026-07-30T08:13:21Z",
              expires_at: "2026-07-30T08:43:21Z",
              session_id: "sess-test",
              command_id: "command-debug-id",
              kind: "file",
              target: "/workspace/src/secret.txt",
              rule: "approve-outside-workspace-reads",
              message: "Pi wants to read outside the opened workspace: {{.Path}}",
              fields: {
                operation: "stat",
                path: "/workspace/src/secret.txt",
                scope_options: [
                  { scope_kind: "file", scope_key: "file:read:/workspace/src/secret.txt", scope_label: "read /workspace/src/secret.txt", scope_operation: "read", scope_path: "/workspace/src/secret.txt", scope_rule: "approve-outside-workspace-reads", scope_prefix: false },
                  { scope_kind: "file-dir", scope_key: "file-dir:read:approve-outside-workspace-reads:/workspace/src", scope_label: "read directory first-level /workspace/src", scope_operation: "read", scope_path: "/workspace/src", scope_rule: "approve-outside-workspace-reads", scope_prefix: false },
                  { scope_kind: "file-tree", scope_key: "file-tree:read:approve-outside-workspace-reads:/workspace/src", scope_label: "read directory recursively /workspace/src", scope_operation: "read", scope_path: "/workspace/src", scope_rule: "approve-outside-workspace-reads", scope_prefix: true },
                  { scope_kind: "file-tree", scope_key: "file-tree:read:approve-outside-workspace-reads:/workspace", scope_label: "read directory recursively /workspace", scope_operation: "read", scope_path: "/workspace", scope_rule: "approve-outside-workspace-reads", scope_prefix: true },
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
            await waitFor(() => Boolean(resolved) || ctx.notifications.length > 0, "directory approval was not resolved");
            assert(Boolean(resolved), "directory approval failed: " + JSON.stringify(ctx.notifications));

            assert(ctx.customCalls.length === 1, "directory approval did not use the custom overlay prompt");
            assert(ctx.customCalls[0].options.overlay === true, "approval prompt was not an overlay");
            assert(ctx.customCalls[0].options.overlayOptions?.width === "100%", "approval overlay was not full width");
            assert(ctx.customCalls[0].options.overlayOptions?.anchor === "bottom-center", "approval overlay anchor regressed");
            const rendered = ctx.customCalls[0].renders[1];
            const renderedChoices = rendered.filter((line) => /^(?:→ |  )(?:Allow|Deny)/.test(line));
            assert(renderedChoices.filter((line) => line.endsWith("Deny once")).length === 1, "file approval did not collapse scoped denials into one Deny once choice: " + JSON.stringify(renderedChoices));
            assert(!renderedChoices.some((line) => line.includes("Deny this file for session")), "file approval still exposed a scoped denial: " + JSON.stringify(renderedChoices));
            assert(renderedChoices.some((line) => line === "→ Deny once"), "file approval did not select Deny once by default: " + JSON.stringify(renderedChoices));
            assert(renderedChoices.some((line) => line.includes("Allow this file for session")), "file approval lost its exact-file session choice");
            assert(renderedChoices.some((line) => line.includes("Allow /workspace/src/* for session (one level)")), "file approval lost its first-level directory session choice");
            assert(renderedChoices.some((line) => line.includes("Allow /workspace/src/** for session")), "file approval lost its recursive directory session choice");
            assert(renderedChoices.some((line) => line.includes("Allow /workspace/** for session")), "file approval lost its broader parent directory session choice");
            assert(rendered.includes(" Inspect metadata for this path outside the opened workspace?"), "file metadata approval did not render its actual operation: " + JSON.stringify(rendered));
            assert(rendered.includes(" /workspace/src/secret.txt"), "file approval omitted the requested path");
            assert(!rendered.some((line) => /AgentSH approval requested|Fields:|ID:|Session:|scope_key|appr-directory|sess-test|command-debug-id/.test(line)), "file approval exposed transport/debug metadata: " + JSON.stringify(rendered));
            assert(rendered.length <= 13, "file approval regressed to a tall scrolling prompt: " + JSON.stringify(rendered));
            assert(resolved.id === "appr-directory", "resolved wrong directory approval id");
            assert(resolved.decision === "approve", "directory approval was not approved");
            assert(resolved.scope === "session", "directory approval did not relay scope=session");
            assert(resolved.scope_kind === "file-dir", "directory approval did not relay scope_kind");
            assert(resolved.scope_key === "file-dir:read:approve-outside-workspace-reads:/workspace/src", "directory approval did not relay scope_key");
            assert(resolved.scope_path === "/workspace/src", "directory approval did not relay scope_path");
            assert(resolved.scope_rule === "approve-outside-workspace-reads", "directory approval did not relay scope_rule");
            assert(resolved.scope_prefix === false, "directory approval did not relay scope_prefix");
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
            const ctx = createContext({ customActions: ["<down>", "<down>", "<down>", "<down>", "<enter>"] });
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

          // Network denial is deliberately one-shot; the compact network prompt does not persist denials.
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
            const ctx = createContext({ choices: ["Deny"] });
            await startSession(pi, ctx);
            await waitFor(() => Boolean(resolved), "deny-for-session approval was not resolved");

            assert(resolved.id === "appr-deny-session", "resolved wrong deny-session approval id");
            assert(resolved.decision === "deny", "deny-for-session approval was not denied");
            assert(resolved.scope === "once", "network Deny did not remain one-shot");
            assert(/denied in parent Pi/i.test(resolved.reason), "network Deny reason was not preserved");
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
        PI_AGENTSH_BUN_ABORT_REGRESSION=1 bun "$workdir/test.mjs" "$outdir"

        mkdir -p "$out"
        touch "$out/passed"
      '';
}
