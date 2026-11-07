import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileWatchStore } from "./storage.ts";
import { parseTarget } from "./types.ts";

async function fixture(run: (file: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "forge-storage-"));
  try { await run(join(root, "state.json")); } finally { await rm(root, { recursive: true, force: true }); }
}
test("private atomic state serializes concurrent writes and restores only its owning session", async () => fixture(async file => {
  const storage = await FileWatchStore.load(file, "session-a");
  await Promise.all(Array.from({ length: 20 }, () => storage.update(s => ++s.nextEvent)));
  assert.equal(await storage.update(s => s.nextEvent), 21);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await storage.close();
  await assert.rejects(() => storage.update(s => s.nextEvent), /closed/);
  const restored = await FileWatchStore.load(file, "session-a");
  assert.equal(await restored.update(s => s.nextEvent), 21);
  await assert.rejects(() => FileWatchStore.load(file, "session-b"), /foreign/);
  await restored.close();
}));
test("failed mutations never commit and approval obligations survive subscription removal", async () => fixture(async file => {
  const storage = await FileWatchStore.load(file, "session-a");
  await storage.requireApproval({ goalId: "goal", target: parseTarget("https://github.com/o/r/pull/1"), reviewer: "human", expectedHead: "a".repeat(40) });
  const before = await readFile(file, "utf8");
  await assert.rejects(() => storage.update(s => { s.nextEvent++; throw new Error("reject"); }), /reject/);
  assert.equal(await readFile(file, "utf8"), before);
  await assert.rejects(() => storage.requireApproval({ goalId: "goal", target: parseTarget("https://github.com/o/r/pull/1"), reviewer: "agent", expectedHead: "a".repeat(40) }), /reviewer/);
  await storage.update(s => { s.subscriptions = {}; s.queues = {}; });
  assert.equal((await storage.obligations("goal")).length, 1);
  await storage.close();
}));
test("unsafe, corrupt, oversized and symlink state fail closed", async () => fixture(async file => {
  await writeFile(file, "bad json", { mode: 0o600 });
  await assert.rejects(() => FileWatchStore.load(file, "s"));
  await chmod(file, 0o644);
  await assert.rejects(() => FileWatchStore.load(file, "s"), /permissions/);
  await chmod(file, 0o600);
  await writeFile(file, "x".repeat(4 * 1024 * 1024 + 1));
  await assert.rejects(() => FileWatchStore.load(file, "s"), /size/);
  await rm(file);
  await symlink("/nonexistent", file);
  await assert.rejects(() => FileWatchStore.load(file, "s"));
}));
