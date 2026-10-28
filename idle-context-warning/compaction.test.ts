import { describe, expect, it } from "bun:test";
import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
// Test the real native preparation too; Pi exports compact(), but not its
// preparation helper. Production code uses only the public extension event.
const { prepareCompaction } = await import(new URL("./core/compaction/compaction.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
import { beforeCompact, parseModelSelector, registerCompaction, FORCE_CHEAP_COMPACTION_KEY } from "./compaction.ts";
import { getSessionModelRequestProfile, registerSessionRouting } from "../shared/session-routing.ts";
import { lastModelActivity, shouldWarn } from "./policy.ts";

const now = Date.now();
const old = now - 60 * 60_000;
const model = { provider: "cheap", id: "family/model", reasoning: true, maxTokens: 4096 };
const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } };
const settings = { idleMinutes: 30, contextPercent: 20, cheapCompactionModel: "cheap/family/model:low" };
const message = (timestamp = old): any => ({ type: "message", id: "assistant", parentId: null, timestamp: new Date(timestamp).toISOString(), message: { role: "assistant", model: "expensive", timestamp, content: [{ type: "text", text: "Earlier response" }] } });
function fixture(reason: SessionBeforeCompactEvent["reason"] = "manual") {
  const controller = new AbortController();
  const calls: any[] = [];
  const notices: string[] = [];
  const selectedModel = Object.freeze({ provider: "cheap", id: "conversation" });
  const ctx: any = {
    hasUI: true, model: selectedModel,
    getContextUsage() { throw new Error("Compaction must not consult the warning usage gate"); },
    ui: { notify: (text: string) => notices.push(text) },
    modelRegistry: {
      find: (provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined,
      streamSimple: (target: any, context: any, options: any) => {
        calls.push({ target, context, options });
        return { result: async () => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: `Summary ${calls.length}` }], usage }) };
      },
    },
  };
  const event: SessionBeforeCompactEvent = {
    type: "session_before_compact", reason, willRetry: reason === "overflow", signal: controller.signal,
    branchEntries: [message()], customInstructions: "Preserve the deployment constraints",
    preparation: {
      firstKeptEntryId: "kept", tokensBefore: 12345, previousSummary: "Earlier checkpoint",
      messagesToSummarize: [{ role: "user", content: "Keep this goal", timestamp: old }],
      turnPrefixMessages: [], isSplitTurn: false,
      fileOps: { read: new Set(["read.ts"]), edited: new Set(["edit.ts"]), written: new Set() },
      settings: { enabled: true, reserveTokens: 10000, keepRecentTokens: 20000 },
    },
  };
  ctx.sessionManager = { getSessionId: () => "unit-session", getBranch: () => event.branchEntries };
  return { event, ctx, calls, notices, controller, selectedModel };
}

describe("idle compaction routing", () => {
  it("preserves warm physical-model compaction and selected thinking without requiring a cheap selector", async () => {
    const f = fixture();
    f.ctx.thinkingLevel = "high";
    f.event.branchEntries = [message(Date.now())];
    expect(await beforeCompact(f.event, f.ctx, () => ({ ...settings, cheapCompactionModel: null }))).toBeUndefined();
    expect(f.calls).toHaveLength(0);
    expect(f.ctx.thinkingLevel).toBe("high");
  });
  it("explicit admission Compact uses cheap thinking even if physical activity is warm", async () => {
    const f = fixture();
    f.ctx.thinkingLevel = "high";
    f.event.branchEntries = [message(Date.now())];
    (globalThis as any)[FORCE_CHEAP_COMPACTION_KEY] = { sessionId: "unit-session", token: "explicit" };
    try {
      expect((await beforeCompact(f.event, f.ctx, () => settings))?.compaction).toBeDefined();
      expect(f.calls[0].target).toBe(model);
      expect(f.calls[0].options.reasoning).toBe("low");
      expect(f.ctx.thinkingLevel).toBe("high");
    } finally { delete (globalThis as any)[FORCE_CHEAP_COMPACTION_KEY]; }
  });
  it("rejects virtual or guarded summary models without recursive dispatch", async () => {
    for (const target of [{ ...model, api: "pi-virtual" }]) {
      const f = fixture();
      f.ctx.modelRegistry.find = () => target;
      expect(await beforeCompact(f.event, f.ctx, () => settings)).toEqual({ cancel: true });
      expect(f.calls).toHaveLength(0);
    }
  });
  for (const reason of ["manual", "threshold", "overflow"] as const) {
    it(`${reason}: uses cheap model after idle independently of context usage/UI`, async () => {
      const f = fixture(reason);
      f.ctx.hasUI = false;
      const result = await beforeCompact(f.event, f.ctx, () => settings);
      expect(result?.compaction?.summary).toContain("Summary 1");
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0].target).toBe(model);
      expect(f.ctx.model).toBe(f.selectedModel);
    });
    it(`${reason}: leaves normal compaction untouched before threshold`, async () => {
      const f = fixture(reason);
      f.event.branchEntries = [message(Date.now())];
      expect(await beforeCompact(f.event, f.ctx, () => settings)).toBeUndefined();
      expect(f.calls).toHaveLength(0);
      expect(f.ctx.model).toBe(f.selectedModel);
    });
  }
  it("uses exact threshold and configurable idle minutes without warning's 20% gate", async () => {
    const f = fixture();
    const original = Date.now;
    Date.now = () => now;
    try {
      f.event.branchEntries = [message(now - 5 * 60_000 + 1)];
      expect(await beforeCompact(f.event, f.ctx, () => ({ ...settings, idleMinutes: 5 }))).toBeUndefined();
      f.event.branchEntries = [message(now - 5 * 60_000)];
      expect(shouldWarn(lastModelActivity(f.event.branchEntries), now, 0, { ...settings, idleMinutes: 5 })).toBe(false);
      expect((await beforeCompact(f.event, f.ctx, () => ({ ...settings, idleMinutes: 5 })))?.compaction).toBeDefined();
    } finally { Date.now = original; }
  });
  it("missing/null configuration or no model history preserves normal compaction", async () => {
    for (const cheapCompactionModel of [null, undefined]) {
      const f = fixture();
      expect(await beforeCompact(f.event, f.ctx, () => ({ ...settings, cheapCompactionModel }))).toBeUndefined();
      expect(f.calls).toHaveLength(0);
    }
    const f = fixture();
    f.event.branchEntries = [];
    expect(await beforeCompact(f.event, f.ctx, () => settings)).toBeUndefined();
  });
  it("rebinds legacy cheap selectors and prepares the current provider account on every summary dispatch", async () => {
    const f = fixture();
    let profile: any = { version: 1, ownerSessionId: "unit-session", providerId: "cheap", accountId: "a", revision: 1 };
    let preparations = 0;
    registerSessionRouting(f.ctx, { file: "/tmp/unit-routing.json", getProfile: () => profile, prepareRequest: async () => { preparations++; return profile; } });
    const routed: any[] = [];
    f.ctx.modelRegistry.find = (provider: string, id: string) => {
      routed.push([provider, id]);
      return provider === profile.providerId && id === "family/model" ? { ...model, provider } : undefined;
    };
    const first = await beforeCompact(f.event, f.ctx, () => ({ ...settings, cheapCompactionModel: "openai/family/model:high" }));
    expect(first?.compaction).toBeDefined();
    expect(routed).toContainEqual(["cheap", "family/model"]);
    expect(getSessionModelRequestProfile(f.calls[0].target)).toMatchObject({ providerId: "cheap", accountId: "a", revision: 1 });
    expect(JSON.stringify(f.calls[0].target)).not.toContain("accountId");
    expect(preparations).toBeGreaterThanOrEqual(2);
    profile = { ...profile, providerId: "codex", accountId: "b", revision: 2 };
    f.ctx.model = { provider: "codex", id: "conversation" };
    routed.length = 0;
    const second = await beforeCompact(f.event, f.ctx, () => ({ ...settings, cheapCompactionModel: "openai/family/model:high" }));
    expect(second?.compaction).toBeDefined();
    expect(routed).toContainEqual(["codex", "family/model"]);
    expect(preparations).toBeGreaterThanOrEqual(4);
  });
  it("cancels remaining native chunks rather than retargeting after a profile switch", async () => {
    const f = fixture();
    f.event.preparation.isSplitTurn = true;
    f.event.preparation.turnPrefixMessages = [{ role: "user", content: "Second chunk", timestamp: old }];
    let profile: any = { version: 1, ownerSessionId: "unit-session", providerId: "cheap", accountId: "a", revision: 1 };
    registerSessionRouting(f.ctx, { file: "/tmp/unit-routing-pinned.json", getProfile: () => profile, prepareRequest: async () => profile });
    f.ctx.modelRegistry.find = (provider: string, id: string) => provider === profile.providerId && id === "family/model" ? { ...model, provider } : undefined;
    f.ctx.modelRegistry.streamSimple = (target: any, context: any, options: any) => {
      f.calls.push({ target, context, options });
      profile = { ...profile, providerId: "codex", accountId: "b", revision: 2 };
      return { result: async () => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "First chunk summary" }], usage }) };
    };
    expect(await beforeCompact(f.event, f.ctx, () => ({ ...settings, cheapCompactionModel: "openai/family/model" }))).toEqual({ cancel: true });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].target.provider).toBe("cheap");
  });
  it("fails closed when the currently routed provider lacks the selected model", async () => {
    const f = fixture();
    const profile: any = { version: 1, ownerSessionId: "unit-session", providerId: "codex", accountId: "b", revision: 1 };
    registerSessionRouting(f.ctx, { file: "/tmp/unit-routing-missing.json", getProfile: () => profile, prepareRequest: async () => profile });
    f.ctx.modelRegistry.find = () => undefined;
    expect(await beforeCompact(f.event, f.ctx, () => ({ ...settings, cheapCompactionModel: "openai/family/model" }))).toEqual({ cancel: true });
    expect(f.calls).toHaveLength(0);
  });
  it("registers the common native hook for all compaction entry points", async () => {
    const handlers: Record<string, any> = {};
    registerCompaction({ on: (name: string, handler: any) => { handlers[name] = handler; } } as any, () => settings);
    const f = fixture();
    expect((await handlers.session_before_compact(f.event, f.ctx))?.compaction).toBeDefined();
  });
  it("restored branches ignore newer user, tool, compaction, and cache-warming timestamps", async () => {
    const f = fixture();
    f.event.branchEntries.push(...[
      { type: "message", message: { role: "user", timestamp: now } },
      { type: "message", message: { role: "toolResult", timestamp: now } },
      { type: "usage", kind: "cache_warm", timestamp: new Date(now).toISOString() },
      { type: "compaction", timestamp: new Date(now).toISOString() },
    ] as any[]);
    const restored = JSON.parse(JSON.stringify(f.event.branchEntries));
    f.event.branchEntries = restored;
    expect((await beforeCompact(f.event, f.ctx, () => settings))?.compaction).toBeDefined();
  });
});

describe("exact model selectors", () => {
  it("accepts provider-relative model IDs plus thinking levels, nested IDs and colon-bearing model IDs", () => {
    expect(parseModelSelector("family:high")).toEqual({ provider: "", id: "family", thinking: "high" });
    for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(parseModelSelector(`provider/family/model:${thinking}`)).toEqual({ provider: "provider", id: "family/model", thinking });
    }
    expect(parseModelSelector("ollama/qwen:7b")).toEqual({ provider: "ollama", id: "qwen:7b", thinking: "low" });
    expect(parseModelSelector("ollama/qwen:7b:high").id).toBe("qwen:7b");
  });
  for (const selector of ["", "/model", "provider/", "provider/model high", false, 42]) {
    it(`rejects invalid selector ${JSON.stringify(selector)} without fallback`, async () => {
      const f = fixture();
      expect(await beforeCompact(f.event, f.ctx, () => ({ ...settings, cheapCompactionModel: selector }))).toEqual({ cancel: true });
      expect(f.calls).toHaveLength(0);
    });
  }
});

describe("native summary semantics", () => {
  it("preserves instructions, previous summary, boundary, usage, file tags, signal and output budget", async () => {
    const f = fixture();
    const result = (await beforeCompact(f.event, f.ctx, () => settings))!.compaction!;
    expect(result.firstKeptEntryId).toBe("kept");
    expect(result.tokensBefore).toBe(12345);
    expect(result.usage).toEqual(usage);
    expect(result.summary).toContain("<read-files>\nread.ts\n</read-files>");
    expect(result.summary).toContain("<modified-files>\nedit.ts\n</modified-files>");
    const prompt = JSON.stringify(f.calls[0].context);
    expect(prompt).toContain("Earlier checkpoint");
    expect(prompt).toContain("Preserve the deployment constraints");
    expect(prompt).toContain("Keep this goal");
    expect(f.calls[0].options).toMatchObject({ signal: f.controller.signal, reasoning: "low", cacheRetention: "none" });
    expect(result.details).toEqual({ readFiles: ["read.ts"], modifiedFiles: ["edit.ts"], idleContextNativeCompaction: 1 });
  });
  it("keeps split-turn summaries separate and combines their usage", async () => {
    const f = fixture();
    f.event.preparation.isSplitTurn = true;
    f.event.preparation.turnPrefixMessages = [{ role: "user", content: "Turn prefix", timestamp: old }];
    const result = (await beforeCompact(f.event, f.ctx, () => settings))!.compaction!;
    expect(f.calls).toHaveLength(2);
    expect(result.summary).toContain("Summary 1\n\n---\n\n**Turn Context (split turn):**\n\nSummary 2");
    expect(result.usage?.totalTokens).toBe(240);
    expect(result.usage?.cost.total).toBeCloseTo(0.06);
    expect(JSON.stringify(f.calls[1].context)).toContain("Turn prefix");
  });
  it("preserves prior history in a split turn with no older messages", async () => {
    const f = fixture();
    f.event.preparation.messagesToSummarize = [];
    f.event.preparation.isSplitTurn = true;
    f.event.preparation.turnPrefixMessages = [{ role: "user", content: "Turn prefix", timestamp: old }];
    const result = (await beforeCompact(f.event, f.ctx, () => settings))!.compaction!;
    expect(f.calls).toHaveLength(1);
    expect(result.summary).toContain("Earlier checkpoint");
    expect(result.usage).toEqual(usage);
  });
  it("restores cumulative files through real native preparation and cheap-to-normal transitions", async () => {
    const f = fixture();
    const first = (await beforeCompact(f.event, f.ctx, () => settings))!.compaction!;
    const branch: any[] = [
      { type: "compaction", id: "checkpoint", parentId: null, timestamp: new Date(old).toISOString(), ...first, firstKeptEntryId: "checkpoint", fromHook: true },
      { type: "message", id: "user", parentId: "checkpoint", timestamp: new Date(old).toISOString(), message: { role: "user", content: "Further work", timestamp: old } },
      { ...message(), parentId: "user" },
      { type: "message", id: "kept", parentId: "assistant", timestamp: new Date(now).toISOString(), message: { role: "user", content: "New request", timestamp: now } },
    ];
    for (const cheapCompactionModel of [settings.cheapCompactionModel, null]) {
      f.event.branchEntries = branch;
      f.event.preparation = prepareCompaction(branch, { enabled: true, reserveTokens: 10000, keepRecentTokens: 1 })!;
      expect(f.event.preparation.fileOps.read.size).toBe(0); // Native fromHook exclusion.
      const result = await beforeCompact(f.event, f.ctx, () => ({ ...settings, cheapCompactionModel }));
      expect([...f.event.preparation.fileOps.read]).toEqual(["read.ts"]);
      expect([...f.event.preparation.fileOps.edited]).toEqual(["edit.ts"]);
      if (cheapCompactionModel) expect(result?.compaction?.summary).toContain("read.ts");
      else expect(result).toBeUndefined();
    }
  });
  it("does not adopt unknown extension details or reach past the latest compaction", async () => {
    const f = fixture();
    f.event.branchEntries.push(...[
      { type: "compaction", fromHook: true, details: { idleContextNativeCompaction: 1, readFiles: ["stale"] } },
      { type: "compaction", fromHook: true, details: { readFiles: ["foreign"] } },
    ] as any[]);
    await beforeCompact(f.event, f.ctx, () => settings);
    expect([...f.event.preparation.fileOps.read]).toEqual(["read.ts"]);
  });
});

describe("cheap failures always cancel", () => {
  for (const stopReason of ["error", "length", "aborted", "toolUse", "pending", "deferred"]) {
    it(`rejects ${stopReason} even with partial text`, async () => {
      const f = fixture();
      f.ctx.modelRegistry.streamSimple = () => ({ result: async () => ({ stopReason, content: [{ type: "text", text: "Partial" }], usage }) });
      expect(await beforeCompact(f.event, f.ctx, () => settings)).toEqual({ cancel: true });
      expect(f.notices[0]).toContain("no default-model fallback");
      expect(f.ctx.model).toBe(f.selectedModel);
    });
  }
  for (const content of [[], [{ type: "thinking", thinking: "internal only" }], [{ type: "text", text: "  " }], [{ type: "toolCall", name: "read" }, { type: "text", text: "text" }]]) {
    it(`rejects empty or tool-call content ${JSON.stringify(content)}`, async () => {
      const f = fixture();
      f.ctx.modelRegistry.streamSimple = () => ({ result: async () => ({ stopReason: "stop", content, usage }) });
      expect(await beforeCompact(f.event, f.ctx, () => settings)).toEqual({ cancel: true });
    });
  }
  it("unknown model, unavailable credentials/provider and config errors cancel", async () => {
    const f = fixture();
    expect(await beforeCompact(f.event, f.ctx, () => ({ ...settings, cheapCompactionModel: "missing/model" }))).toEqual({ cancel: true });
    f.ctx.modelRegistry.streamSimple = () => { throw new Error("Credentials unavailable"); };
    expect(await beforeCompact(f.event, f.ctx, () => settings)).toEqual({ cancel: true });
    expect(await beforeCompact(f.event, f.ctx, () => { throw new Error("Invalid JSON"); })).toEqual({ cancel: true });
    expect(f.calls).toHaveLength(0);
  });
  it("cancels before starting and after a provider ignores abort", async () => {
    const f = fixture();
    f.controller.abort();
    expect(await beforeCompact(f.event, f.ctx, () => settings)).toEqual({ cancel: true });
    expect(f.calls).toHaveLength(0);
    const g = fixture();
    g.ctx.modelRegistry.streamSimple = () => ({ result: async () => { g.controller.abort(); return { stopReason: "stop", content: [{ type: "text", text: "Late summary" }], usage }; } });
    expect(await beforeCompact(g.event, g.ctx, () => settings)).toEqual({ cancel: true });
  });
  it("cancels the entire split summary if the second response is empty", async () => {
    const f = fixture();
    f.event.preparation.isSplitTurn = true;
    f.event.preparation.turnPrefixMessages = [{ role: "user", content: "Turn", timestamp: old }];
    let count = 0;
    f.ctx.modelRegistry.streamSimple = () => {
      const response = { stopReason: "stop", content: [{ type: "text", text: ++count === 1 ? "History" : "" }], usage };
      return { result: async () => response };
    };
    expect(await beforeCompact(f.event, f.ctx, () => settings)).toEqual({ cancel: true });
    expect(count).toBe(2);
  });
  it("cancels rejected asynchronous streams", async () => {
    const f = fixture();
    f.ctx.modelRegistry.streamSimple = () => ({ result: async () => { throw new Error("Connection lost"); } });
    expect(await beforeCompact(f.event, f.ctx, () => settings)).toEqual({ cancel: true });
  });
  it("cannot fall through even when error notifications throw", async () => {
    const f = fixture();
    f.ctx.ui.notify = () => { throw new Error("UI disconnected"); };
    f.ctx.modelRegistry.find = () => { throw new Error("Lookup failed"); };
    expect(await beforeCompact(f.event, f.ctx, () => settings)).toEqual({ cancel: true });
  });
});
