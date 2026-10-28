import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAgentProfiles, resolveAgentProfileLaunch } from "./profiles.ts";
import { resolveCoordinatorRole } from "./coordinator-role.ts";

test("new dedicated coordinator uses the real named Sol profile; explicit selection wins", async () => {
  const root = await mkdtemp(join(tmpdir(), "coordinator-role-"));
  try {
    const profiles = await discoverAgentProfiles({ cwd: root, agentDir: root, projectTrusted: false });
    const discover = async (input: { agent: "coordinator" }) => resolveAgentProfileLaunch(input, profiles, { defaultModel: "gpt-6-luna" });
    const role = await resolveCoordinatorRole(undefined, discover);
    assert.equal(role.model, "gpt-6.1-sol:high");
    assert.match(role.systemPrompt!, /single-coordinator execution controls/);
    assert.equal(resolveAgentProfileLaunch({ agent: "coordinator", model: "gpt-6-astra:low" }, profiles, { defaultModel: "gpt-6-luna" }).model, "gpt-6-astra:low");
    assert.equal(resolveAgentProfileLaunch({ agent: "worker" }, profiles, { defaultModel: "gpt-6-luna" }).model, "gpt-6-luna:high");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("dedicated Resume retains explicit model, instructions and tool policy without profile discovery", async () => {
  const retained = { model: "legacy-provider/gpt-6-astra:low", systemPrompt: "retained coordinator", tools: ["read"] };
  assert.equal(await resolveCoordinatorRole(retained, async () => { throw new Error("changed/broken profile must not affect Resume"); }), retained);
});

test("new coordinator discovery failures are not replaced with a hardcoded model", async () => {
  await assert.rejects(resolveCoordinatorRole(undefined, async () => { throw new Error("invalid coordinator model"); }), /invalid coordinator model/);
});
