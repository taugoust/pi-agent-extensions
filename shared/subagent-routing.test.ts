import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSubagentRoutingSelection, registerSubagentRoutingControls, subagentRoutingEnvironment, subagentRequestRoutingEnvironment,
  SUBAGENT_ROUTING_ENTRY, SUBAGENT_ROUTING_KEY, type SubagentRoutingService,
} from "./subagent-routing.ts";
import { readSessionRoutingProfile, registerSessionRouting, routingProfilePath, writeSessionRoutingProfile } from "./session-routing.ts";
import { resolveSubagentModel } from "../subagent/config.ts";
import { DEFAULT_MODEL_TIERS } from "./model-tiers.ts";
import { resolveCoordinatorRole } from "../subagent/coordinator-role.ts";

const globals = globalThis as unknown as Record<string, any>;
const settings = { defaultModel: "cheap", defaultThinkingLevel: "low" };
function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "subagent-routing-"));
  const branch: any[] = [];
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  let sessionId = "parent";
  const ctx = {
    model: { provider: "claude-bridge", id: "claude-opus-5-5" }, hasUI: false,
    sessionManager: {
      getSessionId: () => sessionId, getBranch: () => branch,
      appendCustomEntry(customType: string, data: unknown) { branch.push({ type: "custom", customType, data }); },
    },
    modelRegistry: { find: (provider: string, id: string) => ({ provider, id }), getAll: () => [
      { provider: "claude-bridge", id: "claude-opus-5-5" },
      { provider: "openai-codex", id: "gpt-6.1-sol" },
    ] },
  };
  const pi = { on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command) };
  const start = async () => { registerSubagentRoutingControls(pi as any); await handlers.get("session_start")!({}, ctx); return globals[SUBAGENT_ROUTING_KEY] as SubagentRoutingService; };
  t.after(() => { delete globals[SUBAGENT_ROUTING_KEY]; delete globals.__paeAccountControlsV1; rmSync(dir, { recursive: true, force: true }); });
  const resolve = (model?: string) => resolveSubagentModel(model, settings, ctx, undefined, DEFAULT_MODEL_TIERS);
  return { ctx, dir, branch, handlers, commands, start, resolve, switchSession: () => { sessionId = "another"; } };
}
async function set(service: SubagentRoutingService, selection: any) {
  const s = await service.getSnapshot({ sessionId: service.sessionId });
  return service.set({ expectedSessionId: s.sessionId, expectedServiceEpoch: s.serviceEpoch, expectedRevision: s.revision, selection });
}

test("unset follows the session, set routes new worker and coordinator tiers, explicit models win", async t => {
  const f = fixture(t), service = await f.start();
  assert.equal(f.resolve(), "claude-bridge/claude-haiku-5-5:low");
  assert.equal((await service.getSnapshot({ sessionId: "parent" })).selection, null);
  const running = f.resolve();
  await set(service, { providerId: "openai-codex", accountId: null });
  assert.equal(f.resolve(), "openai-codex/gpt-6-luna:low");
  const role = await resolveCoordinatorRole(undefined, async () => ({ model: "expensive" }));
  assert.equal(f.resolve(role.model), "openai-codex/gpt-6.1-sol:low");
  assert.equal(f.resolve("gpt-6-astra:high"), "openai-codex/gpt-6-astra:high");
  assert.equal(f.resolve("claude-bridge/claude-opus-5-5:high"), "claude-bridge/claude-opus-5-5:high");
  assert.equal(running, "claude-bridge/claude-haiku-5-5:low");
  const retainedRole = await resolveCoordinatorRole({ model: running }, async () => { throw new Error("Must retain role"); });
  assert.equal(f.resolve(retainedRole.model), running);
  await set(service, null);
  assert.equal(f.resolve(), running);
});

test("selection persists across service reload and follows the active branch", async t => {
  const f = fixture(t), first = await f.start();
  await set(first, { providerId: "openai-codex", accountId: null });
  assert.equal(f.branch.at(-1).customType, SUBAGENT_ROUTING_ENTRY);
  await f.handlers.get("session_shutdown")!({});
  const second = await f.start();
  assert.deepEqual((await second.getSnapshot({ sessionId: "parent" })).selection, { providerId: "openai-codex", accountId: null });
  await assert.rejects(first.getSnapshot({ sessionId: "parent" }));
  const before = await second.getSnapshot({ sessionId: "parent" });
  f.branch.length = 0;
  const after = await second.getSnapshot({ sessionId: "parent" });
  assert.equal(after.selection, null);
  assert(after.revision > before.revision);
  await assert.rejects(second.set({ expectedSessionId: before.sessionId, expectedServiceEpoch: before.serviceEpoch, expectedRevision: before.revision, selection: null }));
  f.switchSession();
  await assert.rejects(second.getSnapshot({ sessionId: "parent" }));
});

test("account snapshots do not reroute running launches or the parent session", async t => {
  const f = fixture(t), service = await f.start();
  globals.__paeAccountControlsV1 = { getSnapshot: async () => ({ accounts: [{ id: "alpha" }, { id: "beta" }] }) };
  const parent = { version: 1 as const, ownerSessionId: "parent", providerId: "claude-bridge", accountId: null, revision: 1 };
  const parentFile = routingProfilePath(f.dir, "parent");
  writeSessionRoutingProfile(parentFile, parent);
  registerSessionRouting(f.ctx, { file: parentFile, getProfile: () => parent });
  const route = (model: string) => subagentRoutingEnvironment(f.ctx, model, f.dir);
  const read = (env: Record<string, string>) => readSessionRoutingProfile(env.PI_SESSION_ROUTING_FILE, env.PI_SESSION_ROUTING_OWNER_SESSION);
  assert.deepEqual(route("openai-codex/gpt-6-luna"), {});
  assert.equal(read(route("claude-bridge/claude-opus-5-5")).providerId, "claude-bridge");
  await set(service, { providerId: "openai-codex", accountId: "alpha" });
  const running = route(f.resolve());
  assert.equal(read(running).accountId, "alpha");
  assert.equal(read(route("openai-codex/gpt-6-astra")).accountId, "alpha");
  assert.deepEqual(route("other/model"), {});
  assert.equal(read(route("claude-bridge/claude-opus-5-5")).providerId, "claude-bridge");
  await set(service, { providerId: "openai-codex", accountId: "beta" });
  assert.equal(read(route(f.resolve())).accountId, "beta");
  await set(service, { providerId: "openai-codex", accountId: null });
  assert.equal(read(route(f.resolve())).accountId, null);
  await set(service, null);
  assert.equal(read(running).accountId, "alpha");
  assert.deepEqual(readSessionRoutingProfile(parentFile, "parent"), parent);
});

test("AgentSH preserves unset mixed groups and refuses mixed configured-account groups before launch", async t => {
  const f = fixture(t), service = await f.start();
  const models = ["openai-codex/gpt-6-luna", "claude-bridge/claude-opus-5-5"];
  assert.deepEqual(subagentRequestRoutingEnvironment(f.ctx, models, f.dir), {});
  await set(service, { providerId: "openai-codex", accountId: null });
  assert.throws(() => subagentRequestRoutingEnvironment(f.ctx, models, f.dir));
  const env = subagentRequestRoutingEnvironment(f.ctx, [models[0]], f.dir);
  const profile = readSessionRoutingProfile(env.PI_SESSION_ROUTING_FILE, env.PI_SESSION_ROUTING_OWNER_SESSION);
  assert.equal(profile.providerId, "openai-codex");
  assert.equal(profile.accountId, null);
  assert.deepEqual(subagentRequestRoutingEnvironment(f.ctx, ["other/a", "another/b"], f.dir), {});
  await set(service, null);
  assert.deepEqual(subagentRequestRoutingEnvironment(f.ctx, models, f.dir), {});
});

test("controls reject stale and invalid choices without altering state", async t => {
  const f = fixture(t), service = await f.start();
  const s = await service.getSnapshot({ sessionId: "parent" });
  const request = { expectedSessionId: s.sessionId, expectedServiceEpoch: s.serviceEpoch, expectedRevision: s.revision, selection: null };
  await assert.rejects(service.set({ ...request, expectedServiceEpoch: "old" }));
  await assert.rejects(service.set({ ...request, expectedSessionId: "other" }));
  for (const selection of [undefined, {}, { providerId: "session-follow", accountId: null },
    { providerId: "unknown", accountId: null }, { providerId: "claude-bridge", accountId: "alpha" },
    { providerId: "openai-codex", accountId: "missing" }]) {
    await assert.rejects(set(service, selection));
    assert.equal(readSubagentRoutingSelection(f.ctx), null);
  }
  globals.__paeAccountControlsV1 = { getSnapshot: async () => ({ accounts: [] }) };
  await assert.rejects(set(service, { providerId: "openai-codex", accountId: "missing" }));
  assert.equal(f.branch.length, 0);
  await f.commands.get("subagent-provider").handler("openai-codex", f.ctx);
  assert.equal(f.resolve(), "openai-codex/gpt-6-luna:low");
  await f.commands.get("subagent-provider").handler("clear", f.ctx);
  assert.equal(readSubagentRoutingSelection(f.ctx), null);
});

test("an account lookup cannot overwrite a concurrently changed selection", async t => {
  const f = fixture(t), service = await f.start();
  let finish!: Function;
  globals.__paeAccountControlsV1 = { getSnapshot: () => new Promise(resolve => { finish = resolve; }) };
  const pending = set(service, { providerId: "openai-codex", accountId: "alpha" });
  await new Promise(resolve => setImmediate(resolve));
  await set(service, null);
  finish({ accounts: [{ id: "alpha" }] });
  await assert.rejects(pending);
  assert.equal(readSubagentRoutingSelection(f.ctx), null);
});
