import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSubagentRoutingSelection,
  registerSubagentRoutingControls,
  subagentRequestRoutingEnvironment,
  subagentRoutingEnvironment,
  SUBAGENT_ROUTING_ENTRY,
  SUBAGENT_ROUTING_KEY,
  type SubagentRoutingService,
} from "./subagent-routing.ts";
import {
  readSessionRoutingProfile,
  registerSessionRouting,
  routingProfilePath,
  writeSessionRoutingProfile,
} from "./session-routing.ts";
import { resolveSubagentModel } from "../subagent/config.ts";
import { DEFAULT_MODEL_TIERS } from "./model-tiers.ts";
import { resolveCoordinatorRole } from "../subagent/coordinator-role.ts";

const globals = globalThis as unknown as Record<string, any>;
const settings = { defaultModel: "cheap", defaultThinkingLevel: "low" };
const CODEX = "openai-codex";
const CLAUDE = "claude-bridge";

/** A Claude session whose branch is a plain array the tests can inspect. */
function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "subagent-routing-"));
  const branch: any[] = [];
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  let sessionId = "parent";

  const ctx = {
    model: { provider: CLAUDE, id: "claude-opus-5-5" },
    hasUI: false,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => branch,
      appendCustomEntry(customType: string, data: unknown) {
        branch.push({ type: "custom", customType, data });
      },
    },
    modelRegistry: {
      find: (provider: string, id: string) => ({ provider, id }),
      getAll: () => [
        { provider: CLAUDE, id: "claude-opus-5-5" },
        { provider: CODEX, id: "gpt-6.1-sol" },
      ],
    },
  };

  const pi = {
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand: (name: string, command: any) => commands.set(name, command),
  };

  async function start(): Promise<SubagentRoutingService> {
    registerSubagentRoutingControls(pi as any);
    await handlers.get("session_start")!({}, ctx);
    return globals[SUBAGENT_ROUTING_KEY];
  }

  function resolve(model?: string): string {
    return resolveSubagentModel(model, settings, ctx, undefined, DEFAULT_MODEL_TIERS);
  }

  function command(args: string) {
    return commands.get("subagent-provider").handler(args, ctx);
  }

  t.after(() => {
    delete globals[SUBAGENT_ROUTING_KEY];
    delete globals.__paeAccountControlsV1;
    rmSync(dir, { recursive: true, force: true });
  });

  return {
    ctx,
    dir,
    branch,
    handlers,
    start,
    resolve,
    command,
    switchSession: () => {
      sessionId = "another";
    },
  };
}

function fakeAccounts(ids: string[]) {
  globals.__paeAccountControlsV1 = {
    getSnapshot: async () => ({ accounts: ids.map((id) => ({ id })) }),
  };
}

/** Sets a selection against the service's current revision. */
async function set(service: SubagentRoutingService, selection: any) {
  const current = await service.getSnapshot({ sessionId: service.sessionId });
  return service.set({
    expectedSessionId: current.sessionId,
    expectedServiceEpoch: current.serviceEpoch,
    expectedRevision: current.revision,
    selection,
  });
}

function readEnvironment(env: Record<string, string>) {
  const file = env.PI_SESSION_ROUTING_FILE;
  const owner = env.PI_SESSION_ROUTING_OWNER_SESSION;
  return readSessionRoutingProfile(file, owner);
}

test("unset follows the session, set routes new tiers, explicit models win", async (t) => {
  const f = fixture(t);
  const service = await f.start();

  assert.equal((await service.getSnapshot({ sessionId: "parent" })).selection, null);
  const beforeSetting = f.resolve();
  assert.equal(beforeSetting, "claude-bridge/claude-haiku-5-5:low");

  await set(service, { providerId: CODEX, accountId: null });
  assert.equal(f.resolve(), "openai-codex/gpt-6-luna:low");
  assert.equal(f.resolve("gpt-6-astra:high"), "openai-codex/gpt-6-astra:high");
  const explicit = "claude-bridge/claude-opus-5-5:high";
  assert.equal(f.resolve(explicit), explicit);

  // Goal coordinators resolve their expensive tier the same way.
  const role = await resolveCoordinatorRole(undefined, async () => ({ model: "expensive" }));
  assert.equal(f.resolve(role.model), "openai-codex/gpt-6.1-sol:low");

  // A retained coordinator keeps the model it was launched with.
  const retained = await resolveCoordinatorRole({ model: beforeSetting }, async () => {
    throw new Error("Must retain role");
  });
  assert.equal(f.resolve(retained.model), beforeSetting);

  await set(service, null);
  assert.equal(f.resolve(), beforeSetting);
});

test("the selection survives a reload and follows the active branch", async (t) => {
  const f = fixture(t);
  const first = await f.start();
  await set(first, { providerId: CODEX, accountId: null });
  assert.equal(f.branch.at(-1).customType, SUBAGENT_ROUTING_ENTRY);

  await f.handlers.get("session_shutdown")!({});
  const second = await f.start();
  const reloaded = await second.getSnapshot({ sessionId: "parent" });
  assert.deepEqual(reloaded.selection, { providerId: CODEX, accountId: null });
  await assert.rejects(first.getSnapshot({ sessionId: "parent" }));

  // Moving to a branch without the entry clears it and bumps the revision.
  f.branch.length = 0;
  const after = await second.getSnapshot({ sessionId: "parent" });
  assert.equal(after.selection, null);
  assert(after.revision > reloaded.revision);
  await assert.rejects(
    second.set({
      expectedSessionId: reloaded.sessionId,
      expectedServiceEpoch: reloaded.serviceEpoch,
      expectedRevision: reloaded.revision,
      selection: null,
    }),
  );

  f.switchSession();
  await assert.rejects(second.getSnapshot({ sessionId: "parent" }));
});

test("changing the account never reroutes running launches or the parent", async (t) => {
  const f = fixture(t);
  const service = await f.start();
  fakeAccounts(["alpha", "beta"]);

  const parent = {
    version: 1 as const,
    ownerSessionId: "parent",
    providerId: CLAUDE,
    accountId: null,
    revision: 1,
  };
  const parentFile = routingProfilePath(f.dir, "parent");
  writeSessionRoutingProfile(parentFile, parent);
  registerSessionRouting(f.ctx, { file: parentFile, getProfile: () => parent });
  const route = (model: string) => subagentRoutingEnvironment(f.ctx, model, f.dir);

  // Unset, Codex children use their default login and Claude children the session's.
  assert.deepEqual(route("openai-codex/gpt-6-luna"), {});
  assert.equal(readEnvironment(route("claude-bridge/claude-opus-5-5")).providerId, CLAUDE);

  await set(service, { providerId: CODEX, accountId: "alpha" });
  const running = route(f.resolve());
  assert.equal(readEnvironment(running).accountId, "alpha");
  assert.equal(readEnvironment(route("openai-codex/gpt-6-astra")).accountId, "alpha");
  assert.deepEqual(route("other/model"), {});
  assert.equal(readEnvironment(route("claude-bridge/claude-opus-5-5")).providerId, CLAUDE);

  await set(service, { providerId: CODEX, accountId: "beta" });
  assert.equal(readEnvironment(route(f.resolve())).accountId, "beta");
  await set(service, { providerId: CODEX, accountId: null });
  assert.equal(readEnvironment(route(f.resolve())).accountId, null);
  await set(service, null);

  assert.equal(readEnvironment(running).accountId, "alpha");
  assert.deepEqual(readSessionRoutingProfile(parentFile, "parent"), parent);
});

test("AgentSH refuses mixed providers only when the setting is on", async (t) => {
  const f = fixture(t);
  const service = await f.start();
  const mixed = ["openai-codex/gpt-6-luna", "claude-bridge/claude-opus-5-5"];
  const route = (models: string[]) => subagentRequestRoutingEnvironment(f.ctx, models, f.dir);

  assert.deepEqual(route(mixed), {});

  await set(service, { providerId: CODEX, accountId: null });
  assert.throws(() => route(mixed));
  const profile = readEnvironment(route([mixed[0]]));
  assert.equal(profile.providerId, CODEX);
  assert.equal(profile.accountId, null);
  assert.deepEqual(route(["other/a", "another/b"]), {});

  await set(service, null);
  assert.deepEqual(route(mixed), {});
});

test("stale and invalid choices are rejected without changing anything", async (t) => {
  const f = fixture(t);
  const service = await f.start();
  const current = await service.getSnapshot({ sessionId: "parent" });
  const request = {
    expectedSessionId: current.sessionId,
    expectedServiceEpoch: current.serviceEpoch,
    expectedRevision: current.revision,
    selection: null,
  };
  await assert.rejects(service.set({ ...request, expectedServiceEpoch: "old" }));
  await assert.rejects(service.set({ ...request, expectedSessionId: "other" }));

  const invalid = [
    undefined,
    {},
    { providerId: "session-follow", accountId: null },
    { providerId: "unknown", accountId: null },
    { providerId: CLAUDE, accountId: "alpha" },
    { providerId: CODEX, accountId: "missing" },
  ];
  for (const selection of invalid) {
    await assert.rejects(set(service, selection));
    assert.equal(readSubagentRoutingSelection(f.ctx), null);
  }

  fakeAccounts([]);
  await assert.rejects(set(service, { providerId: CODEX, accountId: "missing" }));
  assert.equal(f.branch.length, 0);
});

test("the /subagent-provider command sets and clears the choice", async (t) => {
  const f = fixture(t);
  await f.start();

  await f.command(CODEX);
  assert.equal(f.resolve(), "openai-codex/gpt-6-luna:low");

  await f.command("clear");
  assert.equal(readSubagentRoutingSelection(f.ctx), null);
});

test("a slow account lookup cannot overwrite a newer choice", async (t) => {
  const f = fixture(t);
  const service = await f.start();
  let finishLookup!: Function;
  globals.__paeAccountControlsV1 = {
    getSnapshot: () =>
      new Promise((resolve) => {
        finishLookup = resolve;
      }),
  };

  const pending = set(service, { providerId: CODEX, accountId: "alpha" });
  await new Promise((resolve) => setImmediate(resolve));
  await set(service, null);
  finishLookup({ accounts: [{ id: "alpha" }] });

  await assert.rejects(pending);
  assert.equal(readSubagentRoutingSelection(f.ctx), null);
});
