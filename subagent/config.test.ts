import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSubagentModelSettings, resolveSubagentModel } from "./config.ts";

function fixture(t: any, value?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "subagent-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (value !== undefined) writeFileSync(join(dir, "subagent.json"), JSON.stringify(value));
  return dir;
}

test("missing config preserves historical defaults", t => {
  assert.equal(resolveSubagentModel(undefined, readSubagentModelSettings(fixture(t))), "openai-codex/gpt-6-astra:low");
});
test("child defaults are independent of main settings", t => {
  const dir = fixture(t, { defaultProvider: "openai-codex", defaultModel: "gpt-6-luna", defaultThinkingLevel: "low" });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultModel: "gpt-6-astra", defaultThinkingLevel: "high" }));
  const settings = readSubagentModelSettings(dir);
  assert.equal(resolveSubagentModel(undefined, settings), "openai-codex/gpt-6-luna:low");
  assert.equal(resolveSubagentModel("other/model", settings), "other/model:low");
  assert.equal(resolveSubagentModel("other/model:high", settings), "other/model:high");
  assert.equal(resolveSubagentModel("other/model:off", settings), "other/model:off");
});
test("partial config and configured thinking are respected", t => {
  const settings = readSubagentModelSettings(fixture(t, { defaultThinkingLevel: "medium" }));
  assert.equal(resolveSubagentModel(undefined, settings), "openai-codex/gpt-6-astra:medium");
});
test("invalid config fails visibly", t => {
  for (const value of [null, [], { defaultModel: "" }, { defaultModel: 1 }, { defaultThinkingLevel: "invalid" }]) {
    assert.throws(() => readSubagentModelSettings(fixture(t, value)), /subagent.json/);
  }
  const dir = fixture(t);
  writeFileSync(join(dir, "subagent.json"), "{");
  assert.throws(() => readSubagentModelSettings(dir), /Cannot read subagent.json/);
});
