import { afterEach, describe, expect, it } from "bun:test";
import register, { REMOTE_PREFLIGHT_KEY } from "./index.ts";
import { admitHarnessWake } from "../shared/idle-admission.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
function fixture(choice = "Ignore") {
  const oldWorker = process.env.PI_SUBAGENT_ID, oldAgent = process.env.AGENTSH_SUBAGENT_ID;
  delete process.env.PI_SUBAGENT_ID; delete process.env.AGENTSH_SUBAGENT_ID;
  const handlers: Record<string, Function[]> = {}, commands: Record<string, any> = {}, sent: any[] = [], notices: any[] = [], dialogs: any[] = [];
  const pi: any = { on: (name: string, fn: Function) => (handlers[name] ??= []).push(fn), registerCommand: (name: string, command: any) => commands[name] = command,
    appendEntry: (customType: string, data: any) => branch.push({ type: "custom", id: `custom-${branch.length}`, customType, data }),
    events: { on: () => () => {}, emit() {} }, sendUserMessage: (...args: any[]) => sent.push(args), registerVirtualModel() {} };
  register(pi, { readSettings: () => ({ idleMinutes: 30, contextPercent: 20, cheapCompactionModel: "p/small" }), tombstonePath: "/nonexistent/idle-test" });
  const old = Date.now() - 3_600_000;
  let branch: any[] = [{ type: "message", id: "old", parentId: null, message: { role: "assistant", model: "model", timestamp: old } }];
  const compacts: any[] = [];
  const ctx: any = { hasUI: true, mode: "tui", model: { provider: "p", id: "model" }, thinkingLevel: "low", isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getBranch: () => branch, getSessionId: () => "test", getLeafId: () => branch.at(-1)?.id },
    getContextUsage: () => ({ tokens: 30, contextWindow: 100, percent: 30 }),
    ui: { select: async (...args: any[]) => { dialogs.push(args); return choice; }, setStatus() {}, notify: (...args: any[]) => notices.push(args) },
    compact: (options: any) => compacts.push({ options, token: (globalThis as any).__piIdleContextForceCheapV1.token, parentId: branch.at(-1)?.id }),
  };
  const emit = async (name: string, event: any = {}) => { for (const fn of handlers[name] ?? []) await fn(event, ctx); };
  for (const fn of handlers.session_start ?? []) void fn({}, ctx);
  const capability = (globalThis as any)[REMOTE_PREFLIGHT_KEY];
  cleanups.push(() => { void emit("session_shutdown"); if (oldWorker === undefined) delete process.env.PI_SUBAGENT_ID; else process.env.PI_SUBAGENT_ID = oldWorker; if (oldAgent === undefined) delete process.env.AGENTSH_SUBAGENT_ID; else process.env.AGENTSH_SUBAGENT_ID = oldAgent; delete (globalThis as any).__piIdleContextParentV1; });
  const complete = (attempt = compacts.at(-1), tag = true) => { branch.push({ type: "compaction", id: `summary-${branch.length}`, parentId: attempt.parentId, fromHook: true, details: tag ? { idleContextNativeCompaction: 1, idleContextExplicitAttempt: attempt.token } : {} }); attempt.options.onComplete(); };
  return { emit, commands, ctx, sent, dialogs, notices, capability, compacts, complete };
}
describe("provider-independent admission", () => {
  it("consumes first, asks user, and replays exact text/images once on Ignore", async () => {
    const f = fixture(); const images = [{ type: "image", data: "image", mimeType: "image/png" }];
    expect(await f.emit("input", { source: "interactive", text: "  draft  ", images })).toBeUndefined();
    expect(f.sent).toHaveLength(0); await tick();
    expect(f.sent).toEqual([[[{ type: "text", text: "  draft  " }, ...images], { expandPromptTemplates: false, deliverAs: undefined }]]);
    expect(f.dialogs[0][0]).toContain("30 / 100 tokens (30%)");
  });
  it("Cancel never replays or restores the draft", async () => { const f = fixture("Cancel"); await f.emit("input", { source: "interactive", text: "discard" }); await tick(); expect(f.sent).toHaveLength(0); });
  it("missing root channel stays pending until explicit user control, never autoapproves", async () => {
    const f = fixture(); f.ctx.hasUI = false;
    const check = f.capability.check(); await tick(); expect(f.capability.pending.state).toBe("pending");
    let done = false; void check.then(() => done = true); await tick(); expect(done).toBe(false);
    expect(f.capability.decide(f.capability.pending.id, "ignore")).toBe(true); expect(await check).toBe("continue");
  });
  it("missing parent stays pending and child UI cannot approve", async () => {
    const f = fixture(); process.env.PI_SUBAGENT_ID = "child";
    const check = f.capability.check(); await tick();
    expect(f.capability.pending.state).toBe("pending"); await f.commands["idle-context"].handler("ignore", f.ctx);
    expect(f.capability.pending).toBeDefined(); expect(f.dialogs).toHaveLength(0);
    f.capability.decide(f.capability.pending.id, "cancel"); expect(await check).toBe("cancel");
  });
  it("parent owns worker decisions; transport disconnect remains pending", async () => {
    const f = fixture(); process.env.PI_SUBAGENT_ID = "child";
    let request: any;
    (globalThis as any).__piIdleContextParentV1 = { request: async (details: any) => { request = details; return "ignore"; } };
    expect(await f.capability.check()).toBe("continue"); expect(request.model).toBe("p/model"); expect(f.dialogs).toHaveLength(0);
    (globalThis as any).__piIdleContextParentV1.request = async () => { throw new Error("disconnected"); };
    const check = f.capability.check(); await tick(); expect(f.capability.pending.state).toBe("pending");
    await f.emit("session_shutdown"); expect(await check).toBe("cancel");
  });
  it("one lane never overwrites pending submission; late and mismatched choices cannot approve", async () => {
    const f = fixture(); f.ctx.hasUI = false;
    const first = f.capability.check(); await tick(); const id = f.capability.pending.id;
    expect(await f.capability.check()).toBe("cancel"); expect(f.capability.pending.id).toBe(id);
    expect(f.capability.decide("wrong", "ignore")).toBe(false);
    f.capability.decide(id, "cancel"); expect(await first).toBe("cancel"); expect(f.capability.decide(id, "ignore")).toBe(false);
  });
  it("notification admission uses the same user lane without replaying a submission", async () => {
    const f = fixture(); f.ctx.hasUI = false;
    const pending = admitHarnessWake(f.ctx, new AbortController().signal); await tick();
    expect(f.capability.pending.origin).toBe("notification"); f.capability.decide(f.capability.pending.id, "ignore");
    expect(await pending).toBe("continue"); expect(f.sent).toHaveLength(0);
  });
  it("explicit Compact waits for a matching persisted receipt, no selection change", async () => {
    const f = fixture("Compact"); const model = f.ctx.model;
    const check = f.capability.check(); await tick(); expect(f.compacts).toHaveLength(1);
    f.complete(); expect(await check).toBe("continue"); expect(f.ctx.model).toBe(model); expect(f.ctx.thinkingLevel).toBe("low");
  });
  it("Cancel during compaction revokes replay even if the native callback arrives late", async () => {
    const f = fixture("Compact"); const check = f.capability.check(); await tick();
    const id = f.capability.pending.id; expect(f.capability.decide(id, "cancel")).toBe(true);
    expect(await check).toBe("cancel"); f.complete(); expect(f.sent).toHaveLength(0); expect(f.capability.decide(id, "ignore")).toBe(false);
  });
  it("callback alone or wrong receipt cannot release admission", async () => {
    const f = fixture("Compact"); const check = f.capability.check(); await tick(); f.complete(undefined, false); expect(await check).toBe("cancel");
  });
  for (const event of ["model_select", "thinking_level_select", "session_before_tree", "session_before_fork", "session_before_switch", "session_start", "session_shutdown"]) it(`${event} revokes pending approval and late compaction`, async () => {
    const f = fixture("Compact"); const pending = f.capability.check(); await tick(); const old = f.compacts[0];
    await f.emit(event); old.options.onComplete(); expect(await pending).toBe("cancel"); expect(f.sent).toHaveLength(0);
  });
  it("already-aborted preflight never opens a dialog", async () => { const f = fixture(); expect(await f.capability.check(AbortSignal.abort())).toBe("cancel"); expect(f.dialogs).toHaveLength(0); });
});
