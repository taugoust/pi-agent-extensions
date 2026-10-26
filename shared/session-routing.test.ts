import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeInheritedSessionRoutingProfile, readSessionRoutingProfile, getSessionRoutingProfile, isInheritedSessionRouting, notifySessionRoutingChanged, onSessionRoutingChanged, prepareSessionRoutingRequest, publishAgentSHRoutingBinding, releaseAgentSHRoutingBinding, readInheritedSessionRoutingProfile, registerSessionModelReference, registerSessionRouting, resolveSessionPhysicalModelReference, resolveSessionModelSelector, routingProfilePath, sessionRoutingEnvironment, validateRoutingProfile, writeSessionRoutingProfile, type RoutingProfile } from "./session-routing.ts";
const context = (id: string, provider = "openai") => ({ model: { provider, id: "gpt-6-astra" }, sessionManager: { getSessionId: () => id } });
function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "session-routing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const profile = (owner = "parent", provider = "openai", account: string | null = "Personal", revision = 0): RoutingProfile => ({ version: 1, ownerSessionId: owner, providerId: provider, accountId: account, revision });

test("role defaults and explicit legacy provider prefixes follow physical session provider", () => {
  const ctx = context("direct", "openai-codex");
  assert.equal(resolveSessionModelSelector(ctx, "gpt-6-luna:low"), "openai-codex/gpt-6-luna:low");
  assert.equal(resolveSessionModelSelector(ctx, "openai/gpt-6-luna:high"), "openai-codex/gpt-6-luna:high");
  ctx.model.provider = "openai";
  assert.equal(resolveSessionModelSelector(ctx, "openai-codex/gpt-6-luna"), "openai/gpt-6-luna");
});

test("virtual selection resolves registered physical profile and does not affect another session", t => {
  const dir = fixture(t), a = context("a", "idle-guard"), b = context("b", "idle-guard");
  const offA = registerSessionRouting(a, { file: routingProfilePath(dir, "a"), getProfile: () => profile("a", "openai-codex", "Work") });
  const offB = registerSessionRouting(b, { file: routingProfilePath(dir, "b"), getProfile: () => profile("b", "openai", "Personal") });
  t.after(offA); t.after(offB);
  assert.equal(resolveSessionModelSelector(a, "gpt-6-luna"), "openai-codex/gpt-6-luna");
  assert.equal(resolveSessionModelSelector(b, "gpt-6-luna"), "openai/gpt-6-luna");
});

test("descriptor is atomic private metadata, snapshots remain unchanged after switching", t => {
  const file = routingProfilePath(fixture(t), "parent/../../not-a-path");
  writeSessionRoutingProfile(file, profile());
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(file, "..")).mode & 0o777, 0o700);
  const child = context("child");
  const env = { PI_SESSION_ROUTING_FILE: file, PI_SESSION_ROUTING_OWNER_SESSION: "parent" };
  const captured = getSessionRoutingProfile(child, env)!;
  writeSessionRoutingProfile(file, profile("parent", "openai-codex", "Work", 1));
  assert.equal(captured.providerId, "openai");
  assert.equal(captured.accountId, "Personal");
  assert.deepEqual(readInheritedSessionRoutingProfile(child, env), profile("parent", "openai-codex", "Work", 1));
  assert.equal(readFileSync(file, "utf8").includes("credential"), false);
  assert.equal(isInheritedSessionRouting(child, env), true);
  assert.deepEqual(sessionRoutingEnvironment(child, env), env);
});

test("missing, corrupt and wrong-owner inherited routing never falls back", t => {
  const file = routingProfilePath(fixture(t), "parent"), ctx = context("child");
  const env = { PI_SESSION_ROUTING_FILE: file, PI_SESSION_ROUTING_OWNER_SESSION: "parent" };
  assert.throws(() => getSessionRoutingProfile(ctx, env));
  writeSessionRoutingProfile(file, profile("someone-else"));
  assert.throws(() => getSessionRoutingProfile(ctx, env), /mismatched/);
  writeFileSync(file, "{");
  assert.throws(() => getSessionRoutingProfile(ctx, env));
  assert.throws(() => sessionRoutingEnvironment(ctx, { PI_SESSION_ROUTING_FILE: file }), /Incomplete/);
  assert.throws(() => validateRoutingProfile({ ...profile(), providerId: "idle-guard" }));
});

test("AgentSH request bindings follow the original owner without cross-session or ambient defaults", t => {
  const dir = fixture(t), file = routingProfilePath(dir, "parent"), otherFile = routingProfilePath(dir, "other");
  const request = "pi-route-11111111-1111-4111-8111-111111111111";
  const otherRequest = "pi-route-22222222-2222-4222-8222-222222222222";
  writeSessionRoutingProfile(file, profile());
  writeSessionRoutingProfile(otherFile, profile("other", "openai-codex", "Other"));
  publishAgentSHRoutingBinding(dir, request, { PI_SESSION_ROUTING_FILE: file, PI_SESSION_ROUTING_OWNER_SESSION: "parent" });
  publishAgentSHRoutingBinding(dir, otherRequest, { PI_SESSION_ROUTING_FILE: otherFile, PI_SESSION_ROUTING_OWNER_SESSION: "other" });
  const env = { AGENTSH_SUBAGENT_ID: "worker", AGENTSH_SUBAGENT_REQUEST_ID: request, PI_CODING_AGENT_DIR: dir };
  const child = context("agentsh-child"), other = context("other-child");
  assert.equal(getSessionRoutingProfile(child, env)!.accountId, "Personal");
  writeSessionRoutingProfile(file, profile("parent", "openai-codex", "Work", 1));
  assert.equal(getSessionRoutingProfile(child, env)!.accountId, "Work");
  assert.equal(getSessionRoutingProfile(other, { ...env, AGENTSH_SUBAGENT_REQUEST_ID: otherRequest })!.accountId, "Other");
  releaseAgentSHRoutingBinding(dir, request);
  assert.throws(() => getSessionRoutingProfile(context("late"), env));
  assert.equal(getSessionRoutingProfile(context("unbound"), { ...env, AGENTSH_SUBAGENT_REQUEST_ID: "unbound-generic-request" }), undefined);
});

test("registered failed routing cannot fall back through the virtual alias bootstrap", async t => {
  const ctx = context("failed", "idle-guard"), file = routingProfilePath(fixture(t), "failed");
  t.after(registerSessionRouting(ctx, { file, getProfile: () => undefined, prepareRequest: async () => undefined }));
  assert.throws(() => resolveSessionModelSelector(ctx, "openai/gpt-6-luna"), /refusing provider fallback/);
  await assert.rejects(prepareSessionRoutingRequest(ctx), /request blocked/);
});

test("virtual physical role resolution preserves a captured request provider", t => {
  const ctx = context("virtual", "idle-guard");
  t.after(registerSessionModelReference(ctx, () => ({ provider: "openai", id: "gpt-6-astra" })));
  assert.deepEqual(resolveSessionPhysicalModelReference(ctx, profile("virtual", "openai-codex", "Work")), { provider: "openai-codex", id: "gpt-6-astra" });
});

test("inherited revision rollback and same-revision identity changes fail closed", t => {
  const file = routingProfilePath(fixture(t), "parent"), ctx = context("child");
  const env = { PI_SESSION_ROUTING_FILE: file, PI_SESSION_ROUTING_OWNER_SESSION: "parent" };
  writeSessionRoutingProfile(file, profile("parent", "openai-codex", "Work", 3));
  getSessionRoutingProfile(ctx, env);
  writeSessionRoutingProfile(file, profile("parent", "openai", "Personal", 2));
  assert.throws(() => getSessionRoutingProfile(ctx, env), /revision regressed/);
  writeSessionRoutingProfile(file, profile("parent", "openai", "Personal", 3));
  assert.throws(() => getSessionRoutingProfile(ctx, env), /revision regressed/);
});

test("preparation and notifications remain session scoped and disposed callbacks stay disposed", async t => {
  const dir = fixture(t), a = context("a"), b = context("b");
  writeSessionRoutingProfile(routingProfilePath(dir, "a"), profile("a"));
  let count = 0, other = 0, prepared = 0;
  const off = registerSessionRouting(a, { file: routingProfilePath(dir, "a"), getProfile: () => profile("a"), prepareRequest: async () => { prepared++; return profile("a", "openai-codex", "Work", 2); } });
  t.after(off);
  const stop = onSessionRoutingChanged(a, () => count++);
  t.after(onSessionRoutingChanged(b, () => other++));
  notifySessionRoutingChanged(a); stop(); notifySessionRoutingChanged(a);
  assert.equal(count, 1); assert.equal(other, 0);
  assert.equal((await prepareSessionRoutingRequest(a))!.providerId, "openai-codex");
  assert.equal(prepared, 1);
  assert.deepEqual(sessionRoutingEnvironment(a, {}), { PI_SESSION_ROUTING_FILE: routingProfilePath(dir, "a"), PI_SESSION_ROUTING_OWNER_SESSION: "a" });
});

test("private immediate-parent chain follows nearest override and isolates siblings", t => {
  const dir = fixture(t), root = routingProfilePath(dir, "root"), child = routingProfilePath(dir, "child"), sibling = routingProfilePath(dir, "sibling"), grandchild = routingProfilePath(dir, "grandchild");
  const env = (file: string, owner: string) => ({ PI_SESSION_ROUTING_FILE: file, PI_SESSION_ROUTING_OWNER_SESSION: owner });
  writeSessionRoutingProfile(root, profile("root", "openai", "Personal", 1));
  writeInheritedSessionRoutingProfile(child, "child", env(root, "root"));
  writeInheritedSessionRoutingProfile(sibling, "sibling", env(root, "root"));
  writeInheritedSessionRoutingProfile(grandchild, "grandchild", env(child, "child"));
  assert.equal(readSessionRoutingProfile(grandchild, "grandchild").accountId, "Personal");
  writeSessionRoutingProfile(child, profile("child", "openai-codex", "Work", 2));
  assert.equal(readSessionRoutingProfile(grandchild, "grandchild").accountId, "Work");
  assert.equal(readSessionRoutingProfile(root, "root").accountId, "Personal");
  assert.equal(readSessionRoutingProfile(sibling, "sibling").accountId, "Personal");
  writeSessionRoutingProfile(grandchild, profile("grandchild", "openai", null, 3));
  writeSessionRoutingProfile(root, profile("root", "openai", "Other", 4));
  assert.equal(readSessionRoutingProfile(child, "child").accountId, "Work");
  assert.equal(readSessionRoutingProfile(grandchild, "grandchild").accountId, null, "explicit default is not inherit");
  writeInheritedSessionRoutingProfile(child, "child", env(root, "root"), 5);
  assert.equal(readSessionRoutingProfile(child, "child").accountId, "Other");
  assert.equal(readSessionRoutingProfile(grandchild, "grandchild").accountId, null);
  writeInheritedSessionRoutingProfile(grandchild, "grandchild", env(child, "child"), 10);
  assert.equal(readSessionRoutingProfile(grandchild, "grandchild").accountId, "Other");
  writeFileSync(root, "{}", { mode: 0o600 });
  assert.throws(() => readSessionRoutingProfile(grandchild, "grandchild"), /Invalid/);
});

test("restoring historical inheritance republishes above epochs already observed by descendants", t => {
  const dir = fixture(t), root = routingProfilePath(dir, "root"), child = routingProfilePath(dir, "child");
  const parent = { PI_SESSION_ROUTING_FILE: root, PI_SESSION_ROUTING_OWNER_SESSION: "root" };
  const inherited = { PI_SESSION_ROUTING_FILE: child, PI_SESSION_ROUTING_OWNER_SESSION: "child" };
  const descendant = context("existing-descendant");
  writeSessionRoutingProfile(root, profile("root", "openai", "Personal", 2));
  writeSessionRoutingProfile(child, profile("child", "openai-codex", "Work", 12));
  const admitted = readInheritedSessionRoutingProfile(descendant, inherited)!;
  assert.equal(admitted.revision, 12);
  writeInheritedSessionRoutingProfile(child, "child", parent, 0);
  const restored = readInheritedSessionRoutingProfile(descendant, inherited)!;
  assert.deepEqual(restored, profile("child", "openai", "Personal", 13));
  writeInheritedSessionRoutingProfile(child, "child", parent, 0);
  const resumed = readInheritedSessionRoutingProfile(descendant, inherited)!;
  assert.deepEqual(resumed, profile("child", "openai", "Personal", 14));
  assert.deepEqual(admitted, profile("child", "openai-codex", "Work", 12), "admitted snapshots are not rerouted");
  assert.deepEqual(readSessionRoutingProfile(root, "root"), profile("root", "openai", "Personal", 2), "ancestor selection and epoch are untouched");
  chmodSync(child, 0o644);
  assert.throws(() => writeInheritedSessionRoutingProfile(child, "child", parent, 0), /private/, "fresh epochs cannot repair or bypass an unsafe prior descriptor");
  chmodSync(child, 0o600);
  writeFileSync(child, JSON.stringify({ version: 1, kind: "inherit", ownerSessionId: "child", parentFile: join(dir, "missing-parent.json"), parentOwner: "missing", revision: 0 }));
  assert.throws(() => writeInheritedSessionRoutingProfile(child, "child", parent, 0), /ENOENT/, "broken existing parent chains are not treated as an absent local descriptor");
});

test("every inherited descriptor stays private; deletion and symlink substitution never fall back", t => {
  const dir = fixture(t), root = routingProfilePath(dir, "root"), child = routingProfilePath(dir, "child");
  writeSessionRoutingProfile(root, profile("root"));
  writeInheritedSessionRoutingProfile(child, "child", { PI_SESSION_ROUTING_FILE: root, PI_SESSION_ROUTING_OWNER_SESSION: "root" });
  chmodSync(root, 0o644);
  assert.throws(() => readSessionRoutingProfile(child, "child"), /private/);
  chmodSync(root, 0o600); unlinkSync(root);
  assert.throws(() => readSessionRoutingProfile(child, "child"), /ENOENT/);
  const other = routingProfilePath(dir, "other"); writeSessionRoutingProfile(other, profile("root"));
  symlinkSync(other, root);
  assert.throws(() => readSessionRoutingProfile(child, "child"));
  writeSessionRoutingProfile(child, profile("child", "openai", null, 2));
  assert.equal(readSessionRoutingProfile(child, "child").accountId, null, "nearest explicit override does not inspect unrelated ancestors");
});

test("parent descriptors reject cycles, owner substitution and unsafe revision overflow", t => {
  const dir = fixture(t), a = routingProfilePath(dir, "a"), b = routingProfilePath(dir, "b");
  writeSessionRoutingProfile(a, profile("a", "openai", null, Number.MAX_SAFE_INTEGER));
  assert.throws(() => writeInheritedSessionRoutingProfile(b, "b", { PI_SESSION_ROUTING_FILE: a, PI_SESSION_ROUTING_OWNER_SESSION: "a" }, 1), /Invalid/);
  writeSessionRoutingProfile(a, profile("a"));
  writeInheritedSessionRoutingProfile(b, "b", { PI_SESSION_ROUTING_FILE: a, PI_SESSION_ROUTING_OWNER_SESSION: "a" });
  writeFileSync(a, JSON.stringify({ version: 1, kind: "inherit", ownerSessionId: "a", parentFile: b, parentOwner: "b", revision: 0 }), { mode: 0o600 });
  assert.throws(() => readSessionRoutingProfile(a, "a"), /cyclic/);
  assert.throws(() => readSessionRoutingProfile(a, "wrong"), /Invalid/);
});
