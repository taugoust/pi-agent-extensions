import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MODEL_TIERS,
  parseModelSelector,
  readModelTiers,
  resolveSessionTierSelector,
  resolveTierSelector,
  validateModelTiers,
} from "./model-tiers.ts";

const session = (provider: string) => ({
  model: { provider, id: "current" },
  sessionManager: { getSessionId: () => `tiers-${provider}` },
});

test("selectors distinguish tiers, model IDs and provider/model", () => {
  assert.deepEqual(parseModelSelector("cheap"), { tier: "cheap", thinking: undefined });
  assert.deepEqual(parseModelSelector("expensive:high"), { tier: "expensive", thinking: "high" });
  assert.deepEqual(parseModelSelector("gpt-6-luna"), { id: "gpt-6-luna", thinking: undefined });
  assert.deepEqual(parseModelSelector("openai-codex/cheap:low"),
    { provider: "openai-codex", id: "cheap", thinking: "low" });
  for (const bad of ["", "a b", "/model", "provider/"]) {
    assert.throws(() => parseModelSelector(bad));
  }
});

test("tiers resolve against the session provider", () => {
  const tiers = DEFAULT_MODEL_TIERS;
  assert.equal(resolveTierSelector("cheap", "openai-codex", tiers), "openai-codex/gpt-6-luna");
  assert.equal(resolveTierSelector("cheap", "claude-bridge", tiers),
    "claude-bridge/claude-haiku-5-5");
  assert.equal(resolveTierSelector("expensive:high", "claude-bridge", tiers),
    "claude-bridge/claude-opus-5-5:high");
  assert.equal(resolveTierSelector("superintelligence", "openai-codex", tiers),
    "openai-codex/gpt-6-astra");
  assert.equal(resolveTierSelector("expensive", "openai-codex", tiers), "openai-codex/gpt-6.1-sol");
  assert.equal(resolveTierSelector("gpt-6-luna", "openai-codex", tiers, { defaultThinking: "low" }),
    "openai-codex/gpt-6-luna:low");
});

test("explicit provider/model is kept only across providers when allowed", () => {
  const tiers = DEFAULT_MODEL_TIERS;
  assert.equal(resolveTierSelector("openai-codex/gpt-6-luna", "claude-bridge", tiers,
    { crossProvider: true }), "openai-codex/gpt-6-luna");
  assert.equal(resolveTierSelector("openai-codex/gpt-6-luna", "claude-bridge", tiers),
    "claude-bridge/gpt-6-luna");
});

test("unknown providers fail with configuration guidance", () => {
  assert.throws(() => resolveTierSelector("cheap", "mystery", DEFAULT_MODEL_TIERS),
    /provider mystery; set programs\.pi\.modelTiers\.mystery\.cheap/);
});

test("session tier selectors follow the selected model's provider", () => {
  const claude = session("claude-bridge");
  assert.equal(resolveSessionTierSelector(claude, "cheap", undefined, DEFAULT_MODEL_TIERS),
    "claude-bridge/claude-haiku-5-5");
  const stale = {
    version: 1 as const,
    ownerSessionId: "tiers-claude-bridge",
    providerId: "openai-codex",
    accountId: null,
    revision: 1,
  };
  assert.equal(resolveSessionTierSelector(claude, "cheap", stale, DEFAULT_MODEL_TIERS),
    "claude-bridge/claude-haiku-5-5");
  assert.equal(resolveSessionTierSelector(session("openai-codex"), "gpt-6-luna"),
    "openai-codex/gpt-6-luna");
});

test("configuration merges over built-ins and validates entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "model-tiers-"));
  try {
    mkdirSync(join(dir, "defaults"));
    writeFileSync(join(dir, "defaults", "model-tiers.json"),
      JSON.stringify({
        "claude-bridge": { cheap: "claude-sonnet-5-5" },
        local: { cheap: "tiny" },
      }));
    writeFileSync(join(dir, "model-tiers.json"), JSON.stringify({ local: { expensive: "big" } }));
    const tiers = readModelTiers(dir);
    assert.equal(tiers["claude-bridge"].cheap, "claude-sonnet-5-5");
    assert.equal(tiers["claude-bridge"].expensive, "claude-opus-5-5");
    assert.deepEqual(tiers.local, { cheap: "tiny", expensive: "big" });
    assert.throws(() => validateModelTiers({ p: { bogus: "x" } }), /Unknown model tier p\.bogus/);
    assert.throws(() => validateModelTiers({ p: { cheap: "a b" } }), /must be a model ID/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
