import { afterEach, describe, expect, it } from "bun:test";
import register, { REMOTE_PREFLIGHT_KEY } from "./index.ts";
import { admitHarnessWake } from "../shared/idle-admission.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
function fixture(choice = "Ignore") {
  const oldWorker = process.env.PI_SUBAGENT_ID,
    oldAgent = process.env.AGENTSH_SUBAGENT_ID;
  delete process.env.PI_SUBAGENT_ID;
  delete process.env.AGENTSH_SUBAGENT_ID;
  const handlers: Record<string, Function[]> = {},
    commands: Record<string, any> = {},
    sent: any[] = [],
    notices: any[] = [],
    dialogs: any[] = [];
  let sendFailure = false;
  let persistFailure = false;
  let editorText = "";
  const pi: any = {
    on: (name: string, fn: Function) => (handlers[name] ??= []).push(fn),
    registerCommand: (name: string, command: any) => (commands[name] = command),
    appendEntry: (customType: string, data: any) => {
      if (persistFailure) throw new Error("entry persistence unavailable");
      branch.push({
        type: "custom",
        id: `custom-${branch.length}`,
        parentId: branch.at(-1)?.id,
        customType,
        data,
      });
    },
    events: { on: () => () => {}, emit() {} },
    sendUserMessage: (...args: any[]) => {
      if (sendFailure) return Promise.reject(new Error("offline"));
      sent.push(args);
      return Promise.resolve();
    },
    registerVirtualModel() {},
  };
  register(pi, {
    readSettings: () => ({ idleMinutes: 30, contextPercent: 20, cheapCompactionModel: "p/small" }),
  });
  const old = Date.now() - 3_600_000;
  let sessionId = "test";
  let branch: any[] = [
    {
      type: "message",
      id: "old",
      parentId: null,
      message: { role: "assistant", model: "model", timestamp: old },
    },
  ];
  const compacts: any[] = [];
  const ctx: any = {
    hasUI: true,
    mode: "tui",
    model: { provider: "p", id: "model" },
    thinkingLevel: "low",
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => sessionId,
      getLeafId: () => branch.at(-1)?.id,
    },
    getContextUsage: () => ({ tokens: 30, contextWindow: 100, percent: 30 }),
    ui: {
      select: async (...args: any[]) => {
        dialogs.push(args);
        return choice;
      },
      setStatus() {},
      notify: (...args: any[]) => notices.push(args),
      getEditorText: () => editorText,
      setEditorText: (text: string) => (editorText = text),
    },
    compact: (options: any) =>
      compacts.push({
        options,
        token: (globalThis as any).__piIdleContextForceCheapV1.token,
        parentId: branch.at(-1)?.id,
      }),
  };
  const emit = async (name: string, event: any = {}) => {
    for (const fn of handlers[name] ?? []) await fn(event, ctx);
  };
  for (const fn of handlers.session_start ?? []) void fn({}, ctx);
  const capability = (globalThis as any)[REMOTE_PREFLIGHT_KEY];
  cleanups.push(() => {
    void emit("session_shutdown");
    if (oldWorker === undefined) delete process.env.PI_SUBAGENT_ID;
    else process.env.PI_SUBAGENT_ID = oldWorker;
    if (oldAgent === undefined) delete process.env.AGENTSH_SUBAGENT_ID;
    else process.env.AGENTSH_SUBAGENT_ID = oldAgent;
    delete (globalThis as any).__piIdleContextParentV1;
  });
  const complete = (
    attempt = compacts.at(-1),
    options: {
      tag?: boolean;
      token?: string;
      afterSummary?: (entry: any) => void;
      afterCallback?: (entry: any) => void;
      duplicateReceipt?: boolean;
      callbackSummary?: string;
      summary?: string;
      fromHook?: boolean;
      omitEntry?: boolean;
    } = {},
  ) => {
    const receipt =
      options.tag === false
        ? {}
        : {
            idleContextNativeCompaction: 1,
            idleContextExplicitAttempt: options.token ?? attempt.token,
          };
    const entry = {
      type: "compaction",
      id: `summary-${branch.length}`,
      parentId: branch.at(-1)?.id,
      firstKeptEntryId: "old",
      summary: options.summary ?? (options.tag === false ? "Bridge-owned summary" : "Idle summary"),
      tokensBefore: 100,
      fromHook: options.fromHook ?? true,
      details: receipt,
    };
    if (!options.omitEntry) branch.push(entry);
    options.afterSummary?.(entry);
    if (options.duplicateReceipt)
      branch.push({
        type: "compaction",
        id: `duplicate-${branch.length}`,
        parentId: branch.at(-1)?.id,
        firstKeptEntryId: "old",
        fromHook: true,
        details: receipt,
      });
    options.afterCallback?.(entry);
    attempt.options.onComplete({
      summary: options.callbackSummary ?? entry.summary,
      firstKeptEntryId: entry.firstKeptEntryId,
      tokensBefore: entry.tokensBefore,
    });
  };
  return {
    emit,
    commands,
    ctx,
    sent,
    dialogs,
    notices,
    capability,
    compacts,
    complete,
    pi,
    branch: () => branch,
    replaceBranch: (next: any[]) => (branch = next),
    setSession: (next: string) => (sessionId = next),
    failSend: () => (sendFailure = true),
    failPersistence: () => (persistFailure = true),
    savedSubmissions: () =>
      branch
        .filter(
          (entry) => entry.type === "custom" && entry.customType === "idle-context-submission",
        )
        .map((entry) => entry.data),
    editorText: () => editorText,
    setEditorText: (text: string) => (editorText = text),
  };
}
describe("provider-independent admission", () => {
  it("consumes first, asks user, and replays exact text/images once on Ignore", async () => {
    const f = fixture();
    const images = [{ type: "image", data: "image", mimeType: "image/png" }];
    expect(
      await f.emit("input", { source: "interactive", text: "  draft  ", images }),
    ).toBeUndefined();
    expect(f.sent).toHaveLength(0);
    await tick();
    expect(f.sent).toEqual([
      [
        [{ type: "text", text: "  draft  " }, ...images],
        { expandPromptTemplates: false, deliverAs: undefined },
      ],
    ]);
    expect(f.dialogs[0][0]).toContain("30 / 100 tokens (30%)");
  });
  it("Cancel never replays or restores the draft", async () => {
    const f = fixture("Cancel");
    await f.emit("input", { source: "interactive", text: "discard" });
    await tick();
    expect(f.sent).toHaveLength(0);
  });
  it("accepted compaction replays images and delivery options exactly once", async () => {
    const f = fixture("Compact"),
      images = [{ type: "image", data: "attached", mimeType: "image/png" }];
    await f.emit("input", {
      source: "interactive",
      text: "continue after compact",
      images,
      streamingBehavior: "followUp",
    });
    await tick();
    expect(f.sent).toHaveLength(0);
    expect(f.compacts).toHaveLength(1);
    f.complete();
    await tick();
    await tick();
    expect(f.sent).toEqual([
      [
        [{ type: "text", text: "continue after compact" }, ...images],
        { deliverAs: "followUp", expandPromptTemplates: false },
      ],
    ]);
  });
  it("accepts safe compaction across benign appends with the original payload", async () => {
    const f = fixture("Compact"),
      images = [{ type: "image", data: "attached", mimeType: "image/png" }];
    await f.emit("input", {
      source: "interactive",
      text: "exact prompt",
      images,
      streamingBehavior: "followUp",
    });
    await tick();
    f.branch().push({
      type: "custom_message",
      id: "notice",
      parentId: f.ctx.sessionManager.getLeafId(),
      customType: "harness-state",
      content: "background work completed",
      display: true,
    });
    f.branch().push({
      type: "usage",
      id: "usage",
      parentId: "notice",
      kind: "cache_warm",
      usage: {},
    });
    f.complete(undefined, {
      afterSummary: (entry) =>
        f.branch().push({
          type: "custom_message",
          id: "later-notice",
          parentId: entry.id,
          customType: "harness-state",
          content: "another update",
          display: true,
        }),
      afterCallback: () =>
        f.branch().push({
          type: "custom_message",
          id: "post-callback-notice",
          parentId: f.ctx.sessionManager.getLeafId(),
          customType: "harness-state",
          content: "late but benign",
          display: true,
        }),
    });
    await tick();
    await tick();
    expect(f.sent).toEqual([
      [
        [{ type: "text", text: "exact prompt" }, ...images],
        { deliverAs: "followUp", expandPromptTemplates: false },
      ],
    ]);
  });
  it("still rejects branch navigation and model-visible entries during compaction", async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) =>
        f.replaceBranch([{ type: "message", id: "other", parentId: null }]),
      (f: ReturnType<typeof fixture>) =>
        f.branch().push({
          type: "message",
          id: "other-message",
          parentId: "old",
          message: { role: "user", content: "different turn" },
        }),
    ]) {
      const f = fixture("Compact");
      const check = f.capability.check();
      await tick();
      mutate(f);
      f.complete();
      expect(await check).toBe("cancel");
      expect(f.sent).toHaveLength(0);
    }
  });
  it("rechecks the branch after callback and rejects a late model-visible append", async () => {
    const f = fixture("Compact");
    const check = f.capability.check();
    await tick();
    f.complete(undefined, {
      afterCallback: (entry) =>
        f.branch().push({
          type: "message",
          id: "late-user",
          parentId: entry.id,
          message: { role: "user", content: "new request" },
        }),
    });
    expect(await check).toBe("cancel");
    expect(f.sent).toHaveLength(0);
  });
  it("accepts a single safe compaction returned by its request without the marker", async () => {
    for (const bridgeRunsLast of [false, true]) {
      const f = fixture("Compact");
      const check = f.capability.check();
      await tick();
      // In either load order, the single returned compaction may carry the bridge summary.
      f.complete(undefined, {
        tag: !bridgeRunsLast,
        token: "bridge-owned-summary",
      });
      expect(await check).toBe("continue");
      expect(f.sent).toHaveLength(0);
    }
  });
  it("accepts a matching native compaction entry without fromHook ownership", async () => {
    const f = fixture("Compact");
    const check = f.capability.check();
    await tick();
    f.complete(undefined, {
      tag: false,
      summary: "Pi-owned native summary",
      fromHook: false,
    });
    expect(await check).toBe("continue");
  });
  it("rejects a callback summary that does not match the appended compaction", async () => {
    const f = fixture("Compact");
    const check = f.capability.check();
    await tick();
    f.complete(undefined, { callbackSummary: "unrelated summary" });
    await expect(check).rejects.toThrow("Compaction callback does not match the new branch entry");
    expect(f.sent).toHaveLength(0);
  });
  it("reports a missing callback compaction on an otherwise safe branch as an error", async () => {
    const f = fixture("Compact");
    const check = f.capability.check();
    await tick();
    f.complete(undefined, { omitEntry: true });
    await expect(check).rejects.toThrow("Expected one new compaction entry, found 0");
  });
  it("rejects duplicate summaries bearing the same approval token", async () => {
    const f = fixture("Compact");
    const check = f.capability.check();
    await tick();
    f.complete(undefined, { duplicateReceipt: true });
    await expect(check).rejects.toThrow("Expected one new compaction entry, found 2");
    expect(f.sent).toHaveLength(0);
  });
  it("session identity change during compaction cancels delivery", async () => {
    const f = fixture("Compact");
    const check = f.capability.check();
    await tick();
    f.setSession("replacement-session");
    f.complete();
    expect(await check).toBe("cancel");
    expect(f.sent).toHaveLength(0);
  });
  it("uses Pi's awaited submitUserMessage admission receipt when available", async () => {
    const f = fixture();
    let fallbackCalls = 0;
    f.pi.sendUserMessage = (...args: any[]) => {
      fallbackCalls++;
      f.sent.push(args);
    };
    f.pi.submitUserMessage = async (content: any, options: any) => {
      await f.emit("input", { source: "extension", text: "receipt-backed" });
      f.sent.push([content, options]);
      return { disposition: "started" };
    };
    await f.emit("input", { source: "interactive", text: "receipt-backed" });
    await tick();
    await tick();
    expect(f.sent).toHaveLength(1);
    expect(fallbackCalls).toBe(0);
  });
  it("terminal compaction failure reports an error and preserves the prompt", async () => {
    const f = fixture("Compact");
    await f.emit("input", { source: "interactive", text: "keep for retry" });
    await tick();
    f.compacts[0].options.onError(new Error("provider offline"));
    await tick();
    expect(f.sent).toHaveLength(0);
    expect(f.savedSubmissions().at(-1)).toMatchObject({ state: "failed", text: "keep for retry" });
    expect(f.notices.some(([message]: any[]) => String(message).includes("provider offline"))).toBe(
      true,
    );
    expect(f.editorText()).toBe("keep for retry");
    const failed = f.savedSubmissions().at(-1);
    f.setEditorText("");
    await f.commands["idle-context"].handler(`recover ${failed.id}`, f.ctx);
    expect(f.editorText()).toBe("keep for retry");
    expect(f.sent).toHaveLength(0);
  });
  it("intentional Cancel during Compact remains cancellation without failed recovery", async () => {
    const f = fixture("Compact");
    await f.emit("input", { source: "interactive", text: "discard by choice" });
    await tick();
    expect(f.compacts).toHaveLength(1);
    expect(f.capability.decide(f.capability.pending.id, "cancel")).toBe(true);
    await tick();
    await tick();
    expect(f.savedSubmissions().at(-1)).toMatchObject({
      state: "cancelled",
      text: "discard by choice",
    });
    expect(f.savedSubmissions().some((item: any) => item.state === "failed")).toBe(false);
    expect(
      f.notices.some(([message]: any[]) => String(message).includes("was not submitted")),
    ).toBe(false);
    expect(f.editorText()).toBe("");
  });
  it("external abort during Compact remains cancellation without an error", async () => {
    const f = fixture("Compact"),
      controller = new AbortController();
    const check = f.capability.check(controller.signal);
    await tick();
    await tick();
    expect(f.compacts).toHaveLength(1);
    controller.abort();
    expect(await check).toBe("cancel");
    expect(f.savedSubmissions().some((item: any) => item.state === "failed")).toBe(false);
    const failureNotice = f.notices.some(([message]: any[]) =>
      String(message).includes("was not submitted"),
    );
    expect(failureNotice).toBe(false);
  });
  it("does not replace a draft when the editor value is unknown", async () => {
    const f = fixture("Compact");
    await f.emit("input", { source: "interactive", text: "preserve original" });
    await tick();
    f.setEditorText("newer draft");
    f.ctx.ui.getEditorText = undefined;
    f.compacts[0].options.onError();
    await tick();
    expect(f.editorText()).toBe("newer draft");
    expect(f.savedSubmissions().at(-1)).toMatchObject({
      state: "failed",
      text: "preserve original",
    });
  });
  it("reservation persistence failure reports and restores the prompt", async () => {
    const f = fixture();
    await f.emit("input", { source: "interactive", text: "persist this draft" });
    f.failPersistence();
    await tick();
    await tick();
    expect(f.sent).toHaveLength(0);
    expect(f.editorText()).toBe("persist this draft");
    expect(f.notices.some(([message]: any[]) => String(message).includes("reserve"))).toBe(true);
  });
  it("remote preflight errors are real and retained payloads never auto-replay", async () => {
    const f = fixture("Compact");
    f.failSend();
    const payload = {
      text: "remote draft",
      images: [{ type: "image", data: "kept", mimeType: "image/png" }],
      streamingBehavior: "followUp" as const,
    };
    const check = f.capability.check();
    await tick();
    f.compacts[0].options.onError(new Error("summary provider offline"));
    await expect(check).rejects.toThrow("summary provider offline");
    expect(f.capability.retainPrompt(payload, "remote preflight compaction failed")).toBe(true);
    await tick();
    expect(f.sent).toHaveLength(0);
    expect(f.savedSubmissions().at(-1)).toMatchObject({
      state: "failed",
      text: payload.text,
      images: payload.images,
      streamingBehavior: "followUp",
      error: "remote preflight compaction failed",
    });
  });
  it("missing root channel stays pending until explicit user control", async () => {
    const f = fixture();
    f.ctx.hasUI = false;
    const check = f.capability.check();
    await tick();
    expect(f.capability.pending.state).toBe("pending");
    let done = false;
    void check.then(() => (done = true));
    await tick();
    expect(done).toBe(false);
    expect(f.capability.decide(f.capability.pending.id, "ignore")).toBe(true);
    expect(await check).toBe("continue");
  });
  it("missing parent stays pending and child UI cannot approve", async () => {
    const f = fixture();
    process.env.PI_SUBAGENT_ID = "child";
    const check = f.capability.check();
    await tick();
    expect(f.capability.pending.state).toBe("pending");
    await f.commands["idle-context"].handler("ignore", f.ctx);
    expect(f.capability.pending).toBeDefined();
    expect(f.dialogs).toHaveLength(0);
    f.capability.decide(f.capability.pending.id, "cancel");
    expect(await check).toBe("cancel");
  });
  it("parent owns worker decisions; transport disconnect remains pending", async () => {
    const f = fixture();
    process.env.PI_SUBAGENT_ID = "child";
    let request: any;
    (globalThis as any).__piIdleContextParentV1 = {
      request: async (details: any) => {
        request = details;
        return "ignore";
      },
    };
    expect(await f.capability.check()).toBe("continue");
    expect(request.model).toBe("p/model");
    expect(f.dialogs).toHaveLength(0);
    (globalThis as any).__piIdleContextParentV1.request = async () => {
      throw new Error("disconnected");
    };
    const check = f.capability.check();
    await tick();
    expect(f.capability.pending.state).toBe("pending");
    await f.emit("session_shutdown");
    expect(await check).toBe("cancel");
  });
  it("one lane rejects late and mismatched choices without overwriting pending input", async () => {
    const f = fixture();
    f.ctx.hasUI = false;
    const first = f.capability.check();
    await tick();
    const id = f.capability.pending.id;
    expect(await f.capability.check()).toBe("cancel");
    expect(f.capability.pending.id).toBe(id);
    expect(f.capability.decide("wrong", "ignore")).toBe(false);
    f.capability.decide(id, "cancel");
    expect(await first).toBe("cancel");
    expect(f.capability.decide(id, "ignore")).toBe(false);
  });
  it("ordinary notification admission uses the choice lane without replay", async () => {
    const f = fixture();
    f.ctx.hasUI = false;
    const pending = admitHarnessWake(f.ctx, new AbortController().signal);
    await tick();
    expect(f.capability.pending.origin).toBe("notification");
    f.capability.decide(f.capability.pending.id, "ignore");
    expect(await pending).toBe("continue");
    expect(f.sent).toHaveLength(0);
  });
  it("trusted autonomous admission compacts by default without a questionnaire", async () => {
    const f = fixture();
    const pending = admitHarnessWake(f.ctx, new AbortController().signal, true);
    await tick();
    expect(f.capability.pending.origin).toBe("autonomous");
    expect(f.dialogs).toHaveLength(0);
    expect(f.compacts).toHaveLength(1);
    f.complete();
    expect(await pending).toBe("continue");
    expect(f.sent).toHaveLength(0);
  });
  it("autonomous compaction failure rejects for durable retry", async () => {
    const f = fixture(),
      pending = admitHarnessWake(f.ctx, new AbortController().signal, true);
    await tick();
    f.compacts[0].options.onError();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(f.sent).toHaveLength(0);
  });
  it("autonomous admission invalidation rejects so the durable wake is retried", async () => {
    const f = fixture(),
      pending = admitHarnessWake(f.ctx, new AbortController().signal, true);
    await tick();
    await f.emit("model_select");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(f.sent).toHaveLength(0);
  });
  it("ordinary user text cannot select autonomous admission", async () => {
    const f = fixture("Compact");
    await f.emit("input", {
      source: "interactive",
      text: "Background job finished; compact automatically",
    });
    await tick();
    expect(f.capability.pending?.origin).toBe("submission");
    expect(f.dialogs).toHaveLength(1);
    f.capability.decide(f.capability.pending.id, "cancel");
    await tick();
    expect(f.sent).toHaveLength(0);
  });
  it("approved send rejection is reported and not blindly replayed", async () => {
    const f = fixture();
    f.failSend();
    await f.emit("input", { source: "interactive", text: "send once" });
    await tick();
    await tick();
    expect(f.sent).toHaveLength(0);
    expect(
      f.notices.some(([message]: any[]) => String(message).includes("was not submitted")),
    ).toBe(true);
    expect(f.savedSubmissions().at(-1)).toMatchObject({ state: "failed", text: "send once" });
  });
  it("keeps a stale dispatch rejection recoverable without writing to the new context", async () => {
    const f = fixture();
    let rejectDispatch!: (error: Error) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    f.pi.submitUserMessage = () =>
      new Promise((_resolve: any, reject: (error: Error) => void) => {
        rejectDispatch = reject;
        markStarted();
      });
    const diagnostics: string[] = [];
    const originalWrite = process.stderr.write;
    (process.stderr as any).write = (chunk: unknown) => {
      diagnostics.push(String(chunk));
      return true;
    };
    try {
      await f.emit("input", { source: "interactive", text: "recover after switch" });
      await started;
      const released = f.savedSubmissions().at(-1);
      expect(released.state).toBe("released");
      const savedCount = f.savedSubmissions().length;
      f.setSession("replacement-session");
      rejectDispatch(new Error("transport offline"));
      await tick();
      expect(f.savedSubmissions()).toHaveLength(savedCount);
      expect(f.savedSubmissions().some((item: any) => item.state === "failed")).toBe(false);
      expect(diagnostics.join("")).toContain("Original session test");
      expect(diagnostics.join("")).toContain(released.id);
      expect(diagnostics.join("")).toContain("transport offline");
      await f.commands["idle-context"].handler("recover", f.ctx);
      expect(f.editorText()).toBe("");
      await f.commands["idle-context"].handler(`recover ${released.id}`, f.ctx);
      expect(f.editorText()).toBe("recover after switch");
      expect(f.notices.at(-1)[0]).toContain("may already have been delivered");
      expect(f.sent).toHaveLength(0);
    } finally {
      (process.stderr as any).write = originalWrite;
    }
  });
  it("explicit Compact waits for a matching persisted receipt, no selection change", async () => {
    const f = fixture("Compact");
    const model = f.ctx.model;
    const check = f.capability.check();
    await tick();
    expect(f.compacts).toHaveLength(1);
    f.complete();
    expect(await check).toBe("continue");
    expect(f.ctx.model).toBe(model);
    expect(f.ctx.thinkingLevel).toBe("low");
  });
  it("Cancel during compaction revokes replay after a late callback", async () => {
    const f = fixture("Compact");
    const check = f.capability.check();
    await tick();
    const id = f.capability.pending.id;
    expect(f.capability.decide(id, "cancel")).toBe(true);
    expect(await check).toBe("cancel");
    f.complete();
    expect(f.sent).toHaveLength(0);
    expect(f.capability.decide(id, "ignore")).toBe(false);
  });
  it("callback mismatch is a real failure, not a silent cancellation", async () => {
    const f = fixture("Compact");
    const check = f.capability.check();
    await tick();
    f.complete(undefined, { tag: false, callbackSummary: "wrong summary" });
    await expect(check).rejects.toMatchObject({ name: "Error" });
  });
  for (const event of [
    "model_select",
    "thinking_level_select",
    "session_before_tree",
    "session_before_fork",
    "session_before_switch",
    "session_start",
    "session_shutdown",
  ])
    it(`${event} revokes pending approval and late compaction`, async () => {
      const f = fixture("Compact");
      const pending = f.capability.check();
      await tick();
      const old = f.compacts[0];
      await f.emit(event);
      old.options.onComplete();
      expect(await pending).toBe("cancel");
      expect(f.sent).toHaveLength(0);
    });
  it("already-aborted preflight never opens a dialog", async () => {
    const f = fixture();
    expect(await f.capability.check(AbortSignal.abort())).toBe("cancel");
    expect(f.dialogs).toHaveLength(0);
  });
});
