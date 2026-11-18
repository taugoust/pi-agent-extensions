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
  assert(handlers.length === 1, `expected exactly one tool_call handler, got ${handlers.length}`);
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
      'printf \'%s\\n\' "$1" >> "$EDITOR_LOG"',
      'if [ -n "$EDITOR_REPLACEMENT" ]; then',
      '  printf \'%s\' "$EDITOR_REPLACEMENT" > "$1"',
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
    assert(
      event.input.content === "edited from review\n",
      "write review did not use edited staged content",
    );
    assert(!fs.existsSync(targetPath), "write review touched the real target path before approval");

    const loggedPaths = fs.readFileSync(editorLog, "utf-8").trim().split("\n").filter(Boolean);
    assert(loggedPaths.length === 1, `expected one staged write path, got ${loggedPaths.length}`);
    assert(
      loggedPaths[0].includes(`${path.sep}pi-slow-mode-`),
      "write review did not use the slow-mode temp dir",
    );
    assert(
      loggedPaths[0] !== targetPath,
      "write review opened the real target path instead of a staged file",
    );
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
    assert(customUI.calls === 2, `expected two edit review passes, got ${customUI.calls}`);
    assert(Array.isArray(event.input.edits), "edit review lost edits[] after approval");
    assert(
      event.input.edits.length === 1,
      `expected a single rewritten edit, got ${event.input.edits.length}`,
    );
    assert(
      event.input.edits[0].oldText === "alpha\nbeta\n",
      "edit review did not preserve the full original content",
    );
    assert(
      event.input.edits[0].newText === "alpha\ngamma\n",
      "edit review did not use the externally edited content",
    );
    assert(!("oldText" in event.input), "legacy oldText should be removed after rewriting edits[]");
    assert(!("newText" in event.input), "legacy newText should be removed after rewriting edits[]");

    const loggedPaths = fs.readFileSync(editorLog, "utf-8").trim().split("\n").filter(Boolean);
    assert(loggedPaths.length === 1, `expected one staged edit path, got ${loggedPaths.length}`);
    assert(
      loggedPaths[0].includes(`${path.sep}pi-slow-mode-`),
      "edit review did not edit a staged temp file",
    );
    assert(
      loggedPaths[0] !== targetPath,
      "edit review opened the real file instead of the staged new file",
    );
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
    assert(
      remoteCalls[0].title.includes("Slow mode WRITE review"),
      "Paseo write title omitted operation",
    );
    assert(
      remoteCalls[0].title.includes("remote.txt") &&
        remoteCalls[0].title.includes("remote content"),
      "Paseo write review omitted path or content",
    );
    assert(
      remoteCalls[0].options.join(",") === "Approve,Reject",
      "mirrored Paseo write options changed",
    );
    assert(
      remoteCalls[0].settings.signal === ctx.signal,
      "Paseo write review dropped cancellation signal",
    );

    const oversized = await getToolCallHandler(pi)(
      {
        toolName: "write",
        toolCallId: "paseo-write-oversized",
        input: { path: "oversized.txt", content: "x".repeat(50_001) },
      },
      ctx,
    );
    assert(
      oversized?.block === true,
      "Paseo accepted an approval label omitted from an oversized review",
    );
    assert(customUI.calls === 2, "oversized Paseo review was not mirrored to terminal UI");
    assert(
      remoteCalls[1].options.join(",") === "Reject",
      "oversized mirrored Paseo review offered remote approval",
    );
    assert(
      remoteCalls[1].title.includes("additional characters omitted"),
      "oversized Paseo review omitted truncation warning",
    );
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
    assert(
      remoteCalls[0].title.includes("Slow mode EDIT review"),
      "Paseo edit title omitted operation",
    );
    assert(
      remoteCalls[0].title.includes("-beta") && remoteCalls[0].title.includes("+gamma"),
      "Paseo edit review omitted diff",
    );

    globalThis.__piPaseoRemoteUiV1.select = async () => {
      throw new Error("disconnected");
    };
    const failed = await getToolCallHandler(pi)(
      {
        toolName: "write",
        toolCallId: "paseo-write-failed",
        input: { path: "failed.txt", content: "must not pass\n" },
      },
      ctx,
    );
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
    const result = await getToolCallHandler(pi)(
      {
        toolName: "write",
        toolCallId: "paseo-terminal-1",
        input: { path: "terminal.txt", content: "review locally\n" },
      },
      ctx,
    );
    assert(
      result === undefined && customUI.calls === 1,
      "Paseo terminal handoff did not use custom UI",
    );
    delete globalThis.__piPaseoRemoteUiV1;
  }
}

await main();
