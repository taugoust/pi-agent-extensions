import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "./index.ts";
import { parseLegacyAliases as parseGuardedModels } from "./migration.ts";

const directories: string[] = [];
function file(text?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "idle-context-config-"));
  directories.push(dir);
  const path = join(dir, "idle-context-warning.json");
  if (text !== undefined) writeFileSync(path, text);
  return path;
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("idle context configuration", () => {
  it("defaults to normal compaction without configuration", () => {
    expect(readConfig(file(), true)).toEqual({ idleMinutes: 30, contextPercent: 20 });
  });
  it("accepts the Nix-generated selector independently of default thresholds", () => {
    expect(readConfig(file('{"cheapCompactionModel":"openai/gpt-6-luna:low"}'), true)).toEqual({ idleMinutes: 30, contextPercent: 20, cheapCompactionModel: "openai/gpt-6-luna:low" });
    expect(readConfig(file('{"cheapCompactionModel":null}'), true).cheapCompactionModel).toBeNull();
  });
  it("retains guarded model mappings for strict runtime validation", () => {
    const guardedModels = { astra: "openai/gpt-6-astra", nested: "openrouter/vendor/model" };
    expect(readConfig(file(JSON.stringify({ guardedModels })), true).guardedModels).toEqual(guardedModels);
    expect(parseGuardedModels(guardedModels)).toEqual(guardedModels);
    expect(parseGuardedModels(undefined)).toEqual({});
    expect(readConfig(file('{"guardedModels":false}'), true).guardedModels).toBe(false);
  });
  it("rejects malformed, recursive and thinking-suffixed guard mappings", () => {
    for (const value of [false, [], "model", { alias: "model" }, { alias: "p/m:high" }, { alias: "idle-guard/other" }, { alias: "idle-guard-proxy/other" }, { "bad alias": "p/m" }, { alias: "p/has space" }]) {
      expect(() => parseGuardedModels(value)).toThrow();
    }
  });
  it("retains configurable thresholds and existing numeric bounds", () => {
    expect(readConfig(file('{"idleMinutes":5,"contextPercent":50}'), true)).toMatchObject({ idleMinutes: 5, contextPercent: 50 });
    expect(readConfig(file('{"idleMinutes":0,"contextPercent":101}'), true)).toMatchObject({ idleMinutes: 30, contextPercent: 20 });
  });
  it("does not erase invalid selector values and silently enable normal compaction", () => {
    expect(readConfig(file('{"cheapCompactionModel":false}'), true).cheapCompactionModel).toBe(false);
    expect(readConfig(file('{"cheapCompactionModel":""}'), true).cheapCompactionModel).toBe("");
  });
  for (const invalid of ["{", "null", "false", "[]", '"model"']) {
    it(`fails closed for compaction on invalid config ${invalid}`, () => {
      const path = file(invalid);
      expect(() => readConfig(path, true)).toThrow("Cannot read idle-context-warning.json");
      expect(readConfig(path)).toEqual({ idleMinutes: 30, contextPercent: 20 });
    });
  }
});
