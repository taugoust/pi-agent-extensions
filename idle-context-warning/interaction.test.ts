import { describe, expect, it } from "bun:test";
import register, { REMOTE_PREFLIGHT_KEY } from "./index.ts";

function setup(choice: string) {
  const handlers: Record<string, (event: any, ctx: any) => Promise<any> | void> = {};
  const uiCalls: any[] = [];
  const pi: any = { on(name: string, fn: any) { handlers[name] = fn; } };
  register(pi);
  const old = Date.now() - 60 * 60_000;
  const text = "  preserve this draft exactly  ";
  const globals = globalThis as Record<string, any>;
  const initialCapability = globals[REMOTE_PREFLIGHT_KEY];
  const initiallyReady = initialCapability.ready;
  const ctx = {
    hasUI: true,
    mode: "tui",
    model: { provider: "example", id: "model-1" },
    sessionManager: { getBranch: () => [{ type: "message", timestamp: new Date(old).toISOString(), message: { role: "assistant", model: "model-1", timestamp: old } }] },
    getContextUsage: () => ({ tokens: 30, contextWindow: 100, percent: 30 }),
    ui: {
      select: async (title: string, options: string[], settings?: { signal?: AbortSignal }) => {
        uiCalls.push({ title, options, signal: settings?.signal });
        return choice;
      },
      setEditorText: (value: string) => uiCalls.push({ draft: value }),
    },
  };
  handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
  return { handlers, ctx, text, uiCalls, globals, initialCapability, initiallyReady, capability: globals[REMOTE_PREFLIGHT_KEY] };
}

describe("idle warning input handling", () => {
  it("Cancel consumes interactive input and restores its exact terminal text", async () => {
    const { handlers, ctx, text, uiCalls, globals } = setup("Cancel");
    expect(await handlers.input({ source: "interactive", text }, ctx)).toEqual({ action: "handled" });
    expect(uiCalls[0].options).toEqual(["Cancel", "Ignore"]);
    expect(uiCalls[0].signal).toBeInstanceOf(AbortSignal);
    expect(uiCalls[1].draft).toBe(text);
    handlers.session_shutdown?.({ type: "session_shutdown" }, ctx);
    expect(globals[REMOTE_PREFLIGHT_KEY]).toBeUndefined();
  });
  it("Ignore continues without changing the input", async () => {
    const { handlers, ctx, text, uiCalls, globals } = setup("Ignore");
    expect(await handlers.input({ source: "interactive", text }, ctx)).toBeUndefined();
    expect(uiCalls[0].options).toEqual(["Cancel", "Ignore"]);
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
    expect(uiCalls[0].signal).toBe(controller.signal);
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
      expect(received).toBe(controller.signal);
    } finally {
      if (previous === undefined) delete globals.__piPaseoRemoteUiV1;
      else globals.__piPaseoRemoteUiV1 = previous;
      delete globals[REMOTE_PREFLIGHT_KEY];
    }
  });
  it("does not gate automatic extension-originated prompts", async () => {
    const { handlers, ctx, text, uiCalls, globals } = setup("Cancel");
    expect(await handlers.input({ source: "extension", text }, ctx)).toBeUndefined();
    expect(uiCalls).toEqual([]);
    delete globals[REMOTE_PREFLIGHT_KEY];
  });
});
