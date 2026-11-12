import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSubagentModelSettings, resolveSubagentModel } from "./config.ts";
import { DEFAULT_MODEL_TIERS } from "../shared/model-tiers.ts";

function fixture(t: any, value?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "subagent-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (value !== undefined) writeFileSync(join(dir, "subagent.json"), JSON.stringify(value));
  return dir;
}

const tiers = DEFAULT_MODEL_TIERS;
const session = (provider: string, find?: (provider: string, id: string) => unknown) => ({
  model: { provider, id: "main" },
  sessionManager: { getSessionId: () => `provider-${provider}` },
  ...(find ? { modelRegistry: { find } } : {}),
}) as any;
const cheap = { defaultModel: "cheap", defaultThinkingLevel: "low" };
const resolve = (model: string | undefined, ctx?: any, settings = cheap, snapshot?: any) =>
  resolveSubagentModel(model, settings, ctx, snapshot, tiers);

test("missing config uses the cheap tier", t => {
  const settings = readSubagentModelSettings(fixture(t));
  assert.deepEqual(settings, cheap);
  assert.equal(resolve(undefined, undefined, settings), "openai-codex/gpt-6-luna:low");
});
test("child defaults are independent of main settings and ignore the old provider key", t => {
  const dir = fixture(t,
    { defaultProvider: "openai", defaultModel: "gpt-6-luna", defaultThinkingLevel: "low" });
  writeFileSync(join(dir, "settings.json"),
    JSON.stringify({ defaultModel: "gpt-6-astra", defaultThinkingLevel: "high" }));
  const settings = readSubagentModelSettings(dir);
  assert.deepEqual(settings, { defaultModel: "gpt-6-luna", defaultThinkingLevel: "low" });
  assert.equal(resolve("other/model", undefined, settings), "other/model:low");
  assert.equal(resolve("other/model:high", undefined, settings), "other/model:high");
});
test("partial config and configured thinking are respected", t => {
  const settings = readSubagentModelSettings(fixture(t, { defaultThinkingLevel: "medium" }));
  assert.equal(resolve(undefined, session("claude-bridge"), settings),
    "claude-bridge/claude-haiku-5-5:medium");
});
test("tiers and bare IDs follow the session provider, provider/model is kept", () => {
  const claude = session("claude-bridge");
  assert.equal(resolve(undefined, claude), "claude-bridge/claude-haiku-5-5:low");
  assert.equal(resolve("expensive:high", claude), "claude-bridge/claude-opus-5-5:high");
  assert.equal(resolve("claude-sonnet-5-5", claude), "claude-bridge/claude-sonnet-5-5:low");
  assert.equal(resolve("openai-codex/gpt-6-luna:high", claude), "openai-codex/gpt-6-luna:high");
  const codex = session("openai-codex");
  assert.equal(resolve("expensive", codex), "openai-codex/gpt-6.1-sol:low");
  assert.equal(resolve("claude-bridge/claude-opus-5-5", codex),
    "claude-bridge/claude-opus-5-5:low");
});
test("a stale routing profile does not override the selected model's provider", () => {
  const stale = {
    version: 1, ownerSessionId: "provider-claude-bridge", providerId: "openai-codex",
    accountId: null, revision: 1,
  };
  assert.equal(resolve(undefined, session("claude-bridge"), cheap, stale),
    "claude-bridge/claude-haiku-5-5:low");
});
test("unknown providers and missing models fail before the CLI can fall back", () => {
  assert.throws(() => resolve(undefined, session("mystery")),
    /No cheap model is configured for provider mystery/);
  assert.throws(() => resolve("only-openai", session("openai-codex", () => undefined)),
    /Unavailable physical subagent model: openai-codex\/only-openai/);
});

test("invalid config fails visibly", t => {
  for (const value of [null, [], { defaultModel: "" }, { defaultModel: 1 }, { defaultThinkingLevel: "invalid" }]) {
    assert.throws(() => readSubagentModelSettings(fixture(t, value)), /subagent.json/);
  }
  const dir = fixture(t);
  writeFileSync(join(dir, "subagent.json"), "{");
  assert.throws(() => readSubagentModelSettings(dir), /Cannot read subagent.json/);
});
