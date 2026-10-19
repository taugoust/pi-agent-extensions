import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createJiti } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url);
const module = await jiti.import("../openai-accounts/accounts.ts");
const storageModule = await jiti.import("../openai-accounts/storage.ts");
const { AccountStore } = module;
const { FileAccountStorageBackend } = storageModule;

function waitForLine(child, expected) {
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes(expected)) { child.stdout.off("data", onData); resolve(); }
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => { if (code !== 0) reject(new Error(`lock worker exited ${code}: ${output}`)); });
  });
}

function lockWorker(filePath, value, holdMs) {
  const codingAgent = pathToFileURL(join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs")).href;
  const storage = pathToFileURL(join(process.cwd(), "openai-accounts/storage.ts")).href;
  const code = `
    import { createJiti } from ${JSON.stringify(codingAgent)};
    const jiti = createJiti(import.meta.url);
    const { FileAccountStorageBackend } = await jiti.import(${JSON.stringify(storage)});
    const backend = new FileAccountStorageBackend(process.argv[1]);
    await backend.withLockAsync(async () => {
      process.stdout.write("ACQUIRED\\n");
      await new Promise((resolve) => setTimeout(resolve, Number(process.argv[3])));
      return { result: null, next: process.argv[2] };
    });
  `;
  return spawn(process.execPath, ["--input-type=module", "-e", code, filePath, value, String(holdMs)], { stdio: ["ignore", "pipe", "pipe"] });
}

test("account updates preserve inert provider sections and publish private atomic files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pae-account-store-"));
  const file = join(root, "pi-accounts.json");
  try {
    const store = new AccountStore(new FileAccountStorageBackend(file));
    await store.writeRawForTest(JSON.stringify({ version: 1, future: { keep: true }, providers: {
      openai: { accounts: {} },
      "openai-codex": { active: "legacy", accounts: { legacy: { type: "oauth", access: "opaque", refresh: "opaque-refresh", expires: 1 } } },
      anthropic: { active: "work", accounts: { work: { future: [1, 2, 3] } } },
    } }));
    await store.updateProvider("openai", (state) => ({ ...state, accounts: { named: { type: "api_key", key: "local-fixture" } } }));
    const data = await store.readAsync();
    assert.equal(data.future.keep, true);
    assert.equal(data.providers["openai-codex"].active, "legacy");
    assert.equal(data.providers["openai-codex"].accounts.legacy.access, "opaque");
    assert.equal(data.providers.anthropic.accounts.work.future.length, 3);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("vendored proper-lockfile serializes independent processes on the same credential file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pae-account-cross-process-"));
  const file = join(root, "pi-accounts.json");
  let first;
  let second;
  try {
    first = lockWorker(file, "first-writer", 150);
    await waitForLine(first, "ACQUIRED");
    second = lockWorker(file, "second-writer", 0);
    const firstExit = new Promise((resolve, reject) => {
      first.once("error", reject);
      first.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`first writer exited ${code}`)));
    });
    const secondAcquired = waitForLine(second, "ACQUIRED");
    await firstExit;
    await secondAcquired;
    const secondExit = new Promise((resolve, reject) => {
      second.once("error", reject);
      second.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`second writer exited ${code}`)));
    });
    await secondExit;
    assert.equal(await readFile(file, "utf8"), "second-writer");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  } finally {
    first?.kill("SIGTERM");
    second?.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
});
