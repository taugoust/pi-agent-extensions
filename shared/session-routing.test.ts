import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionRoutingProfile, isInheritedSessionRouting, notifySessionRoutingChanged, onSessionRoutingChanged, prepareSessionRoutingRequest, publishAgentSHRoutingBinding, releaseAgentSHRoutingBinding, readInheritedSessionRoutingProfile, registerSessionModelReference, registerSessionRouting, resolveSessionPhysicalModelReference, resolveSessionModelSelector, routingProfilePath, sessionRoutingEnvironment, validateRoutingProfile, writeSessionRoutingProfile, type RoutingProfile } from "./session-routing.ts";
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
