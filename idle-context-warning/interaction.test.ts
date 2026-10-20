import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register, { REMOTE_PREFLIGHT_KEY } from "./index.ts";

delete process.env.PI_SUBAGENT_ID;
delete process.env.AGENTSH_SUBAGENT_ID;

function setup(choice: string) {
  const handlers: Record<string, (event: any, ctx: any) => Promise<any> | void> = {};
  const uiCalls: any[] = [];
  const pi: any = { on(name: string, fn: any) { handlers[name] = fn; } };
  register(pi, { readSettings: () => ({ idleMinutes: 30, contextPercent: 20 }), tombstonePath: join(tmpdir(), `idle-guard-test-${randomUUID()}.json`) });
  const old = Date.now() - 60 * 60_000;
  const text = "  preserve this draft exactly  ";
  const globals = globalThis as Record<string, any>;
  const initialCapability = globals[REMOTE_PREFLIGHT_KEY];
  const initiallyReady = initialCapability.ready;
  let branch = [{ type: "message", timestamp: new Date(old).toISOString(), message: { role: "assistant", model: "model-1", timestamp: old } }];
  const ctx = {
    hasUI: true,
    mode: "tui",
    model: { provider: "example", id: "model-1" },
    sessionManager: { getBranch: () => branch, getSessionId: () => "interaction-session" },
    getContextUsage: () => ({ tokens: 30, contextWindow: 100, percent: 30 }),
    ui: {
      select: async (title: string, options: string[], settings?: { signal?: AbortSignal }) => {
        uiCalls.push({ title, options, signal: settings?.signal });
        return choice;
      },
      setEditorText: (value: string) => uiCalls.push({ draft: value }),
      compact: undefined,
    },
  };
  handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
  return { handlers, ctx, text, uiCalls, globals, initialCapability, initiallyReady, capability: globals[REMOTE_PREFLIGHT_KEY], setBranch: (value: any[]) => { branch = value; } };
}

describe("idle warning input handling", () => {
  it("leaves guarded aliases to the authoritative dispatch gate rather than Cancel/Ignore", async () => {
    const { handlers, ctx, text, uiCalls, capability, globals } = setup("Cancel");
    ctx.model = { provider: "idle-guard", id: "alias" };
    expect(await handlers.input({ source: "interactive", text }, ctx)).toBeUndefined();
    expect(await capability.check()).toBe("continue");
    expect(uiCalls).toHaveLength(0);
    delete globals[REMOTE_PREFLIGHT_KEY];
  });
  it("Cancel consumes interactive input without restoring the submitted text", async () => {
    const { handlers, ctx, text, uiCalls, globals } = setup("Cancel");
    expect(await handlers.input({ source: "interactive", text }, ctx)).toEqual({ action: "handled" });
    expect(uiCalls[0].options).toEqual(["Cancel", "Ignore", "Compact"]);
    expect(uiCalls[0].signal).toBeInstanceOf(AbortSignal);
    expect(uiCalls.some((call) => "draft" in call)).toBe(false);
    handlers.session_shutdown?.({ type: "session_shutdown" }, ctx);
    expect(globals[REMOTE_PREFLIGHT_KEY]).toBeUndefined();
  });
  it("Ignore continues without changing the input", async () => {
    const { handlers, ctx, text, uiCalls, globals } = setup("Ignore");
    expect(await handlers.input({ source: "interactive", text }, ctx)).toBeUndefined();
    expect(uiCalls[0].options).toEqual(["Cancel", "Ignore", "Compact"]);
    delete globals[REMOTE_PREFLIGHT_KEY];
  });
  it("registers an explicit preflight capability before session readiness", () => {
    const { initialCapability, initiallyReady, capability, globals } = setup("Cancel");
    expect(initialCapability).toBe(capability);
    expect(initiallyReady).toBe(false);
    delete globals[REMOTE_PREFLIGHT_KEY];
  });
  it("registered bridge capability includes model, token count, percent, and honors abort signals", async () => {
    const { capability, uiCalls, globals } = setup("Cancel");
    const controller = new AbortController();
    expect(capability.ready).toBe(true);
    expect(await capability.check(controller.signal)).toBe("cancel");
    expect(uiCalls[0].title).toContain("example/model-1");
    expect(uiCalls[0].title).toContain("30 / 100 tokens (30%). The model cache may have expired.");
    expect(uiCalls[0].signal).toBeInstanceOf(AbortSignal);
    delete globals[REMOTE_PREFLIGHT_KEY];
  });
  it("does not authorize an already-aborted preflight", async () => {
    const { capability, uiCalls, globals } = setup("Ignore");
    expect(await capability.check(AbortSignal.abort())).toBe("cancel");
    expect(uiCalls).toHaveLength(0);
    delete globals[REMOTE_PREFLIGHT_KEY];
  });
  it("passes cancellation signals through the mirrored Paseo selector", async () => {
    const { capability, globals } = setup("Cancel");
    let received: AbortSignal | undefined;
    const previous = globals.__piPaseoRemoteUiV1;
    globals.__piPaseoRemoteUiV1 = {
      isConnected: () => true,
      selectMirrored: async (_title: string, _options: string[], _local: any, settings: { signal?: AbortSignal }) => {
        received = settings.signal;
        return "Cancel";
      },
    };
    const controller = new AbortController();
    try {
      expect(await capability.check(controller.signal)).toBe("cancel");
      expect(received).toBeInstanceOf(AbortSignal);
    } finally {
      if (previous === undefined) delete globals.__piPaseoRemoteUiV1;
      else globals.__piPaseoRemoteUiV1 = previous;
      delete globals[REMOTE_PREFLIGHT_KEY];
    }
  });
  it("routes native and AgentSH workers through parent decision contract, failing closed if absent", async () => {
    const { capability, uiCalls, globals } = setup("Ignore");
    const oldPi = process.env.PI_SUBAGENT_ID;
    const oldAgent = process.env.AGENTSH_SUBAGENT_ID;
    const oldParent = globals.__piIdleContextParentV1;
    try {
      process.env.PI_SUBAGENT_ID = "child-native";
      process.env.AGENTSH_SUBAGENT_ID = "child-agentsh";
      let details: unknown;
      globals.__piIdleContextParentV1 = { request: async (value: unknown) => { details = value; return "ignore"; } };
      expect(await capability.check()).toBe("continue");
      expect(details).toMatchObject({ model: "example/model-1", idleMinutes: 60, contextPercent: 30 });
      delete globals.__piIdleContextParentV1;
      expect(await capability.check()).toBe("cancel");
      expect(uiCalls).toHaveLength(0);
    } finally {
      if (oldPi === undefined) delete process.env.PI_SUBAGENT_ID; else process.env.PI_SUBAGENT_ID = oldPi;
      if (oldAgent === undefined) delete process.env.AGENTSH_SUBAGENT_ID; else process.env.AGENTSH_SUBAGENT_ID = oldAgent;
      if (oldParent === undefined) delete globals.__piIdleContextParentV1; else globals.__piIdleContextParentV1 = oldParent;
      delete globals[REMOTE_PREFLIGHT_KEY];
    }
  });
  it("aborts the local mirrored selector when the remote choice wins", async () => {
    const { capability, globals, ctx } = setup("Ignore");
    const previous = globals.__piPaseoRemoteUiV1;
    let localSignal: AbortSignal | undefined;
    globals.__piPaseoRemoteUiV1 = {
      isConnected: () => true,
      selectMirrored: async (_title: string, _options: string[], local: any) => {
        const remoteLocal = new AbortController();
        const result = await local(remoteLocal.signal);
        localSignal = (globalThis as any).__lastIdleSelectSignal;
        remoteLocal.abort();
        return result;
      },
    };
    ctx.ui.select = async (_title: string, _options: string[], config: any) => {
      (globalThis as any).__lastIdleSelectSignal = config.signal;
      return "Ignore";
    };
    try {
      expect(await capability.check()).toBe("continue");
      expect(localSignal?.aborted).toBe(true);
    } finally {
      if (previous === undefined) delete globals.__piPaseoRemoteUiV1; else globals.__piPaseoRemoteUiV1 = previous;
      delete (globalThis as any).__lastIdleSelectSignal;
      delete globals[REMOTE_PREFLIGHT_KEY];
    }
  });
  for (const lifecycle of ["model_select", "thinking_level_select", "session_before_tree", "session_before_fork", "session_before_switch", "session_start", "session_shutdown"]) it(`does not start deferred compact after ${lifecycle}`, async () => {
    const fx = setup("Compact");
    const calls: any[] = [];
    fx.ctx.isIdle = () => true;
    fx.ctx.compact = (options: any) => calls.push(options);
    await fx.handlers.input({ source: "interactive", text: fx.text }, fx.ctx);
    fx.handlers[lifecycle]?.({ type: lifecycle }, fx.ctx);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(calls).toHaveLength(0);
    delete fx.globals[REMOTE_PREFLIGHT_KEY];
  });
  it("ignores old completion callbacks when a newer same-session compaction is pending", async () => {
    const fx = setup("Compact");
    const callbacks: { options: any; token: string }[] = [];
    fx.ctx.isIdle = () => true;
    fx.ctx.compact = (options: any) => callbacks.push({ options, token: (globalThis as any).__piIdleContextForceCheapV1.token });
    await fx.handlers.input({ source: "interactive", text: fx.text }, fx.ctx);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(callbacks).toHaveLength(1);
    fx.handlers.model_select?.({ type: "model_select" }, fx.ctx);
    const newer = fx.capability.check();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(callbacks).toHaveLength(2);
    const appendSummary = (callback: any, token: string, id: string) => {
      fx.setBranch([...fx.ctx.sessionManager.getBranch(), { type: "compaction", id, fromHook: true, details: { idleContextNativeCompaction: 1, idleContextExplicitAttempt: token } }]);
      callback.options.onComplete();
    };
    appendSummary(callbacks[0], callbacks[0].token, "old-entry");
    let settled = false;
    void newer.then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    appendSummary(callbacks[1], callbacks[1].token, "new-entry");
    expect(await newer).toBe("continue");
    delete fx.globals[REMOTE_PREFLIGHT_KEY];
  });
  it("does not gate automatic extension-originated prompts", async () => {
    const { handlers, ctx, text, uiCalls, globals } = setup("Cancel");
    expect(await handlers.input({ source: "extension", text }, ctx)).toBeUndefined();
    expect(uiCalls).toEqual([]);
    delete globals[REMOTE_PREFLIGHT_KEY];
  });
});
