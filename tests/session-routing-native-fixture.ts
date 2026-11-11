// Offline fixture extension for native multi-process routing regression.
import accounts from "../openai-accounts/accounts.js";
import idleAdmission from "../idle-context-warning/index.js";
import { AccountStore } from "../openai-accounts/account-store.js";
import * as oauth from "../openai-accounts/oauth.js";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ACCOUNT_CONTROLS_KEY } from "../shared/account-controls.js";
import { appendFile } from "node:fs/promises";

const CODEX = "openai-codex";

export default async function fixture(pi: any) {
  const role = process.env.ROUTING_FIXTURE_ROLE!;
  const log = process.env.ROUTING_FIXTURE_LOG!;
  const write = (row: unknown) => appendFile(log, JSON.stringify(row) + "\n");
  globalThis.fetch = (async () => {
    await write({ role, network: "blocked" });
    throw new Error("HTTP_FORBIDDEN_NATIVE_FIXTURE");
  }) as any;
  // The runner owns <agentDir>/pi-accounts.json, including a legacy `openai` section.
  const store = new AccountStore();
  pi.registerProvider("openai", provider("openai", log));
  pi.registerProvider(CODEX, provider(CODEX, log));
  accounts(pi, { store, providers: oauth.createBuiltinProviderAdapters() });
  if (role === "parent") {
    idleAdmission(pi, {
      readSettings: () => ({
        idleMinutes: 30,
        contextPercent: 20,
        guardedModels: { astra: `${CODEX}/main-fixture` },
      }),
      tombstonePath: process.env.PI_CODING_AGENT_DIR + "/aliases.json",
    });
  }
  const service = () => (globalThis as any)[ACCOUNT_CONTROLS_KEY];
  pi.registerCommand("routing-switch", {
    handler: async (args: string, ctx: any) => {
      const [providerId, accountId] = args.split(/\s+/, 2);
      try {
        await write({ role: "control-start", providerId, accountId });
        const sessionId = ctx.sessionManager.getSessionId();
        const snapshot = await service().getSnapshot({ sessionId, providerId });
        const result = await service().switchAccount({
          protocol: 1,
          providerId,
          requestId: crypto.randomUUID(),
          expectedSessionId: snapshot.sessionId,
          expectedServiceEpoch: snapshot.serviceEpoch,
          expectedSelectionRevision: snapshot.selectionRevision,
          accountId: accountId === "default" || accountId === "inherit" ? null : accountId,
          ...(accountId === "inherit" ? { inherit: true } : {}),
        });
        await write({ role: "control", providerId, accountId, result });
        ctx.ui.notify(`switch:${result.ok}:${result.reason ?? "ok"}`);
      } catch (error) {
        await write({ role: "control-error", error: String(error) });
        throw error;
      }
    },
  });
  // Requests for the unmanaged `openai` provider, or without a provider, must be
  // rejected before they touch any selection, routing or store state.
  pi.registerCommand("routing-unsupported", {
    handler: async (_args: string, ctx: any) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const before = await service().getSnapshot({ sessionId, providerId: CODEX });
      const attempts: Record<string, () => Promise<unknown>> = {
        snapshotOpenAI: () => service().getSnapshot({ sessionId, providerId: "openai" }),
        snapshotMissing: () => service().getSnapshot({ sessionId }),
        switchOpenAI: () => service().switchAccount(switchRequest(before, "openai")),
        switchMissing: () => service().switchAccount(switchRequest(before)),
        manageOpenAI: () => service().manageAccount(
          { operation: "default", accountId: "Work", sessionId, providerId: "openai" },
        ),
        manageMissing: () => service().manageAccount(
          { operation: "default", accountId: "Work", sessionId },
        ),
      };
      const outcomes: Record<string, string> = {};
      for (const [name, attempt] of Object.entries(attempts)) {
        try { await attempt(); outcomes[name] = "accepted"; }
        catch (error) { outcomes[name] = error instanceof Error ? error.message : String(error); }
      }
      const after = await service().getSnapshot({ sessionId, providerId: CODEX });
      await write({ role: "unsupported", outcomes, before, after });
      ctx.ui.notify("unsupported:done");
    },
  });
  pi.registerCommand("routing-default", {
    handler: async (args: string, ctx: any) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const accountId = args.trim();
      const result = await service().manageAccount(
        { operation: "default", accountId, sessionId, providerId: CODEX },
      );
      await write({ role: "manage", result });
      ctx.ui.notify("manage:done");
    },
  });
  pi.registerCommand("routing-restore", {
    handler: async (args: string, ctx: any) => {
      const result = await ctx.navigateTree(args.trim(), { summarize: false });
      await write({ role: "history", source: role, cancelled: result.cancelled });
      ctx.ui.notify(`history:${result.cancelled ? "cancelled" : "restored"}`);
    },
  });
}

function switchRequest(snapshot: any, providerId?: string) {
  return {
    protocol: 1,
    ...(providerId ? { providerId } : {}),
    requestId: crypto.randomUUID(),
    expectedSessionId: snapshot.sessionId,
    expectedServiceEpoch: snapshot.serviceEpoch,
    expectedSelectionRevision: snapshot.selectionRevision,
    accountId: null,
  };
}

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const usage = (tokens: number) => ({
  input: tokens, output: tokens, cacheRead: 0, cacheWrite: 0, totalTokens: tokens * 2,
  cost: { ...zeroCost, total: 0 },
});

function provider(id: string, log: string) {
  const openai = id === "openai";
  return {
    api: openai ? "openai-responses" : "openai-codex-responses",
    baseUrl: openai ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api",
    models: ["main-fixture", "small-fixture"].map((model) => ({
      id: model, name: model, reasoning: true, input: ["text"],
      contextWindow: 128000, maxTokens: 4096, cost: zeroCost,
    })),
    streamSimple(model: any, _context: any, options: any = {}) {
      const stream = createAssistantMessageEventStream();
      const base = { role: "assistant", provider: id, api: model.api, model: model.id };
      queueMicrotask(async () => {
        try {
          await options.onPayload?.({ fixture: true }, model);
          await appendFile(log, JSON.stringify({
            role: process.env.ROUTING_FIXTURE_ROLE, provider: id, model: model.id,
            key: options.apiKey,
          }) + "\n");
          const message = {
            ...base, content: [{ type: "text", text: "offline" }], stopReason: "stop",
            timestamp: Date.now(), usage: usage(1),
          };
          stream.push({ type: "done", reason: "stop", message } as any);
          stream.end();
        } catch (error) {
          const message = {
            ...base, content: [], stopReason: "error", errorMessage: String(error),
            timestamp: Date.now(), usage: usage(0),
          };
          stream.push({ type: "error", reason: "error", error: message } as any);
          stream.end();
        }
      });
      return stream;
    },
  };
}
