import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "bun:test";
import { ConfigChangeDetector, readConfigFingerprint } from "./fingerprint.js";

/**
 * A fake store with Pi packages, Home Manager generations that link to them,
 * and an agent directory linked to a generation, like Home Manager lays out.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "reload-on-deploy-"));
  const store = join(root, "store");
  const file = (path: string) => {
    mkdirSync(dirname(join(store, path)), { recursive: true });
    writeFileSync(join(store, path), path);
    return join(store, path);
  };
  const generation = (name: string, files: Record<string, string>) => {
    for (const [path, target] of Object.entries(files)) {
      mkdirSync(dirname(join(store, name, path)), { recursive: true });
      symlinkSync(target, join(store, name, path));
    }
    return join(store, name);
  };
  const agent = join(root, "agent");
  const link = (generationDir: string, paths: string[]) => {
    for (const path of paths) {
      const at = join(agent, path);
      mkdirSync(dirname(at), { recursive: true });
      try {
        unlinkSync(at);
      } catch {}
      symlinkSync(join(generationDir, path), at);
    }
  };
  return { root, store: `${store}/`, agent, file, generation, link };
}

const PATHS = ["settings.json", "extensions/fetch/index.ts", "extensions/subagent/agents/worker.md"];

test("a deploy that changes a Pi file changes the fingerprint", () => {
  const f = fixture();
  try {
    const settings = f.file("aaa-settings/settings.json");
    const fetchOld = f.file("bbb-bundle/fetch/index.ts");
    const worker = f.file("bbb-bundle/subagent/agents/worker.md");
    const files = (fetch: string) => ({
      "settings.json": settings,
      "extensions/fetch/index.ts": fetch,
      "extensions/subagent/agents/worker.md": worker,
    });
    f.link(f.generation("gen1", files(fetchOld)), PATHS);
    const before = readConfigFingerprint(f.agent, f.store);
    f.link(f.generation("gen2", files(f.file("ccc-bundle/fetch/index.ts"))), PATHS);
    assert.notEqual(readConfigFingerprint(f.agent, f.store), before);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a deploy that changes nothing in Pi keeps the fingerprint", () => {
  const f = fixture();
  try {
    const files = {
      "settings.json": f.file("aaa-settings/settings.json"),
      "extensions/fetch/index.ts": f.file("bbb-bundle/fetch/index.ts"),
      "extensions/subagent/agents/worker.md": f.file("bbb-bundle/subagent/agents/worker.md"),
    };
    f.link(f.generation("gen1", files), PATHS);
    const before = readConfigFingerprint(f.agent, f.store);
    // A new Home Manager generation with the same Pi files
    f.link(f.generation("gen2", files), PATHS);
    assert.equal(readConfigFingerprint(f.agent, f.store), before);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("files Pi writes itself don't change the fingerprint", () => {
  const f = fixture();
  try {
    f.link(f.generation("gen1", { "settings.json": f.file("aaa-settings/settings.json") }), [
      "settings.json",
    ]);
    const before = readConfigFingerprint(f.agent, f.store);
    mkdirSync(join(f.agent, "sessions"), { recursive: true });
    writeFileSync(join(f.agent, "crashes.json"), "{}");
    writeFileSync(join(f.agent, "sessions", "s.jsonl"), "{}");
    symlinkSync(f.file("ddd-other/x"), join(f.agent, "sessions", "not-a-resource"));
    assert.equal(readConfigFingerprint(f.agent, f.store), before);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a missing agent directory has an empty fingerprint", () => {
  assert.equal(readConfigFingerprint(join(tmpdir(), "reload-on-deploy-missing")), "");
});

test("a change is reported only after it has settled", () => {
  const detector = new ConfigChangeDetector("old");
  assert.equal(detector.observe("old"), false);
  assert.equal(detector.observe("half"), false);
  assert.equal(detector.observe("new"), false);
  assert.equal(detector.observe("new"), true);
  // Still pending until the reload accepts it
  assert.equal(detector.observe("new"), true);
  detector.accept("new");
  assert.equal(detector.observe("new"), false);
});

test("a change that is undone before it settles is not reported", () => {
  const detector = new ConfigChangeDetector("old");
  assert.equal(detector.observe("new"), false);
  assert.equal(detector.observe("old"), false);
  assert.equal(detector.observe("old"), false);
});
