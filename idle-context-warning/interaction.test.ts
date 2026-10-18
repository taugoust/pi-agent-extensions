import { describe, expect, it } from "bun:test";
import register from "./index.ts";

function setup(choice: string) {
  let handler: ((event: any, ctx: any) => Promise<any>) | undefined;
  const uiCalls: string[] = [];
  const pi: any = { on(name: string, fn: any) { if (name === "input") handler = fn; } };
  register(pi);
  const old = Date.now() - 60 * 60_000;
  const text = "  preserve this draft exactly  ";
  const ctx = {
    hasUI: true,
    mode: "tui",
    sessionManager: { getBranch: () => [{ type: "message", timestamp: new Date(old).toISOString(), message: { role: "assistant", model: "model", timestamp: old } }] },
    getContextUsage: () => ({ tokens: 30, contextWindow: 100, percent: 30 }),
    ui: {
      select: async (_title: string, options: string[]) => { uiCalls.push(options.join("|")); return choice; },
      setEditorText: (value: string) => uiCalls.push(`draft:${value}`),
    },
  };
  return { handler: handler!, ctx, text, uiCalls };
}

describe("idle warning input handling", () => {
  it("Cancel consumes the input and restores the exact terminal draft", async () => {
    const { handler, ctx, text, uiCalls } = setup("Cancel");
    expect(await handler({ source: "interactive", text }, ctx)).toEqual({ action: "handled" });
    expect(uiCalls).toEqual(["Cancel|Ignore", `draft:${text}`]);
  });
  it("Ignore continues this input without altering the draft", async () => {
    const { handler, ctx, text, uiCalls } = setup("Ignore");
    expect(await handler({ source: "interactive", text }, ctx)).toBeUndefined();
    expect(uiCalls).toEqual(["Cancel|Ignore"]);
  });
  it("does not gate automatic extension-originated prompts", async () => {
    const { handler, ctx, text, uiCalls } = setup("Cancel");
    expect(await handler({ source: "extension", text }, ctx)).toBeUndefined();
    expect(uiCalls).toEqual([]);
  });
  it("gates an explicitly dispatched Paseo prompt and reports Cancel to the bridge", async () => {
    const { handler, ctx, text, uiCalls } = setup("Cancel");
    const globals = globalThis as Record<string, any>;
    let approved: boolean | undefined;
    const marker = { resolve: (value: boolean) => { approved = value; } };
    globals.__piPaseoIdlePromptV1 = marker;
    try {
      expect(await handler({ source: "extension", text }, ctx)).toEqual({ action: "handled" });
      expect(approved).toBe(false);
      expect(uiCalls).toEqual(["Cancel|Ignore"]);
    } finally { delete globals.__piPaseoIdlePromptV1; }
  });
});
