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
    assert(
      result && result.block === true,
      "fence did not block a write through a symlinked directory",
    );
    assert(
      String(result.reason).includes(path.join(outsideDir, "new.txt")),
      "fence reason did not mention the resolved outside path",
    );
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
    assert(
      String(result.reason).includes(outsideFile),
      "fence reason did not mention the resolved symlink target",
    );
  }
}

await main();
