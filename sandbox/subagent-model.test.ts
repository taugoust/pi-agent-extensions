import assert from "node:assert/strict";
import { canonicalModelReference, inheritSubagentModels } from "./subagent-model.js";

assert.equal(canonicalModelReference({ provider: "openai-codex", id: "gpt-5.5" }), "openai-codex/gpt-5.5");
assert.equal(canonicalModelReference({ provider: "", id: "gpt-5.5" }), undefined);

const single = { task: "inspect" };
assert.deepEqual(inheritSubagentModels(single, { provider: "openai-codex", id: "gpt-5.5" }), {
  task: "inspect",
  model: "openai-codex/gpt-5.5",
});
assert.deepEqual(single, { task: "inspect" }, "model inheritance mutated the caller's request");

const explicit = { task: "inspect", model: "anthropic/claude-sonnet" };
assert.equal(inheritSubagentModels(explicit, { provider: "openai-codex", id: "gpt-5.5" }), explicit);

const parallel = {
  tasks: [
    { task: "one" },
    { task: "two", model: "google/gemini-pro" },
  ],
};
assert.deepEqual(inheritSubagentModels(parallel, { provider: "openai-codex", id: "gpt-5.5" }), {
  tasks: [
    { task: "one", model: "openai-codex/gpt-5.5" },
    { task: "two", model: "google/gemini-pro" },
  ],
});
assert.deepEqual(parallel, { tasks: [{ task: "one" }, { task: "two", model: "google/gemini-pro" }] });

assert.deepEqual(
  inheritSubagentModels({ chain: [{ task: "one" }, { task: "two" }] }, { provider: "openai-codex", id: "gpt-5.5" }),
  { chain: [{ task: "one", model: "openai-codex/gpt-5.5" }, { task: "two", model: "openai-codex/gpt-5.5" }] },
);

const noParentModel = { task: "inspect" };
assert.equal(inheritSubagentModels(noParentModel, undefined), noParentModel);

console.log("sandbox subagent model inheritance checks passed");
