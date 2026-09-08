import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { dirname, resolve } from "node:path";
import { TUI_WORKER_MANIFEST_ENV } from "../shared/tui-worker-protocol.ts";
import { currentSubagentPermissionAuthority } from "../shared/subagent-permission.ts";
import { TuiWorkerStore } from "./tui-worker-store.ts";
import { TuiWorkerServer } from "./tui-worker-server.ts";
import { processIdentity } from "./tui-worker-tmux.ts";
import { validateTaskOutcome } from "./outcome.ts";

/** Explicit -e entry point, loaded inside the one interactive child Pi process. */
export default function tuiWorkerExtension(pi: ExtensionAPI): void {
  const manifestPath = process.env[TUI_WORKER_MANIFEST_ENV];
  if (!manifestPath) return;
  let worker: TuiWorkerServer | undefined;
  let context: ExtensionContext | undefined;
  let failed = false;
  let lastAssistant: unknown;
  let ownerWatch: ReturnType<typeof setInterval> | undefined;
  let announcedReap = false;
  let notificationTimes: number[] = [];
  const allowed = () => Boolean(worker && !failed && !worker.sealed && (worker.manifest.launchMode !== "guard-only"
    || currentSubagentPermissionAuthority()?.active === true));
  const stop = (ctx: ExtensionContext) => { void ctx.abort(); ctx.shutdown(); };
  const fail = (ctx: ExtensionContext, error: unknown) => {
    failed = true;
    if (ctx.hasUI) ctx.ui.notify(`TUI worker failed closed: ${error instanceof Error ? error.message : String(error)}`, "error");
    stop(ctx);
  };
  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    try {
      if (ctx.mode !== "tui") throw new Error("Native worker requires a real Pi TUI");
      const store = new TuiWorkerStore(dirname(resolve(manifestPath)));
      if (store.path("manifest.json") !== resolve(manifestPath)) throw new Error("Invalid worker manifest filename");
      const manifest = store.readManifest();
      // --tools limits builtins, not ordinary extension tools. Apply the parent
      // initial allowlist explicitly; humans may deliberately change it later.
      if (manifest.tools !== undefined) pi.setActiveTools([...new Set([...manifest.tools, "notify_parent", "task_outcome"])]);
      const actualSession = ctx.sessionManager.getSessionFile();
      if (!actualSession || resolve(actualSession) !== resolve(manifest.sessionFile)) throw new Error("Worker Pi session does not match launch manifest");
      worker = new TuiWorkerServer(store, {
        isIdle: () => context?.isIdle() === true && context?.hasPendingMessages() !== true,
        canRun: () => allowed(),
        permissionMode: () => {
          try { return (globalThis as any).__PAE_PERMISSION_GATE_OPERATOR_V1__?.status(ctx.sessionManager.getSessionId()).enabled; }
          catch { return undefined; }
        },
        jobs: async (params, requestId) => {
          const controller = (globalThis as any).__paeLocalJobControllerV1;
          if (!context || controller?.protocol !== 1 || controller.sessionId !== context.sessionManager.getSessionId()
            || typeof controller.execute !== "function") throw new Error("Child-local job controller unavailable for this session");
          return await controller.execute(`tui:${worker!.manifest.workerEpoch}:${requestId}`, params);
        },
        abort: () => context?.abort(),
        shutdown: () => {
          if (worker?.state.sealed && !announcedReap) {
            announcedReap = true;
            pi.events?.emit?.("harness-runtime-reaping", { runtimeId: worker.manifest.runtimeId,
              childId: worker.manifest.childId, workerEpoch: worker.manifest.workerEpoch });
          }
          context?.shutdown();
        },
        compact: () => new Promise<void>((resolve, reject) => {
          if (!context || !allowed()) { reject(new Error("Compaction authority unavailable")); return; }
          context.compact({ onComplete: () => resolve(), onError: error => reject(error) });
        }),
        send: (message, mode) => {
          if (!allowed()) throw new Error("Worker or child-local command authority unavailable");
          // This does NOT enter the user/slash-command input dispatch pipeline.
          pi.sendMessage({ customType: "harness-control", content: `Supervising-agent instructions (not direct user input):\n${message}`, display: true },
            { triggerTurn: true, deliverAs: mode === "follow_up" ? "followUp" : "steer" });
        },
        applyOperatorMode: async enabled => {
          const service = (globalThis as Record<string, any>).__PAE_PERMISSION_GATE_OPERATOR_V1__;
          if (worker?.manifest.launchMode !== "guard-only" || typeof service?.applyMode !== "function") throw new Error("Child operator authority unavailable");
          return await service.applyMode(ctx.sessionManager.getSessionId(), enabled);
        },
      });
      await worker.start();
      let watching = false;
      ownerWatch = setInterval(() => {
        if (watching) return;
        watching = true;
        void (async () => {
          const current = store.readManifest();
          if (current.presentation !== "foreground-staged" || !current.foregroundOwner) return;
          const owner = current.foregroundOwner;
          const alive = await processIdentity(owner.pid).then(token => token === owner.token, () => false);
          if (!alive) { await ctx.abort(); ctx.shutdown(); }
        })().catch(error => fail(ctx, error)).finally(() => { watching = false; });
      }, 500);
      ownerWatch.unref?.();
    } catch (error) { fail(ctx, error); }
  });
  pi.on("input", (_event, ctx) => {
    if (!allowed()) { if (worker?.sealed || failed) stop(ctx); return { action: "handled" as const }; }
    try { worker!.running(); } catch (error) { fail(ctx, error); return { action: "handled" as const }; }
    return { action: "continue" as const };
  });
  pi.on("before_agent_start", (event, ctx) => {
    lastAssistant = undefined;
    if (!allowed()) { stop(ctx); return; }
    try { worker!.running(true); } catch (error) { fail(ctx, error); }
    return { systemPrompt: event.systemPrompt + "\n\nSupervising-agent custom messages are task instructions, not direct user input. Direct human instructions in this TUI or Paseo take precedence over supervising-agent instructions. Report material scope changes to the parent with notify_parent; do not execute slash-looking supervising-agent text as commands." };
  });
  pi.on("agent_start", (_event, ctx) => {
    if (!allowed()) { stop(ctx); return; }
    try { worker!.running(); } catch (error) { fail(ctx, error); }
  });
  // Defence in depth if a built-in/other extension starts work while a graceful
  // shutdown is pending. Reap waits for actual endpoint/pane exit regardless.
  pi.on("tool_call", () => allowed() ? undefined : { block: true, reason: "Worker sealed or local authority unavailable", terminate: true });
  pi.on("user_bash", (_event, ctx) => {
    if (allowed()) return;
    stop(ctx);
    return { result: { output: "Worker sealed or local authority unavailable", exitCode: 1, cancelled: true, truncated: false } };
  });
  pi.on("session_before_switch", () => ({ cancel: true }));
  pi.on("session_before_fork", () => ({ cancel: true }));
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") lastAssistant = event.message;
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (!worker || failed || worker.sealed) return;
    try { worker.settled({ sessionFile: ctx.sessionManager.getSessionFile(), assistant: lastAssistant ?? null,
      contextTokens: ctx.getContextUsage()?.tokens, contextWindow: ctx.model?.contextWindow, timestamp: new Date().toISOString() }); }
    catch (error) { fail(ctx, error); }
  });
  // Ordinary local tools: no parent RPC connection is required to retain these.
  pi.registerTool({ name: "notify_parent", label: "Notify parent", description: "Retain a concise discovery or blocker for the parent. Queued is not answered; do not wait for guidance unless required.",
    parameters: { type: "object", properties: { message: { type: "string", minLength: 1, maxLength: 1000 }, requires_guidance: { type: "boolean" } }, required: ["message"], additionalProperties: false } as any,
    async execute(_id, params: any) {
      if (!worker || worker.sealed || typeof params.message !== "string" || Buffer.byteLength(params.message) > 1000) throw new Error("Worker notification unavailable or invalid");
      notificationTimes = notificationTimes.filter(time => time > Date.now() - 60_000);
      if (notificationTimes.length >= 5) throw new Error("At most five findings per minute; batch updates or retain them for the final report");
      notificationTimes.push(Date.now());
      worker.notification({ message: params.message, requires_guidance: params.requires_guidance === true });
      return { content: [{ type: "text", text: "Retained for parent delivery. Queued is not answered." }], details: {} };
    } });
  pi.registerTool({ name: "task_outcome", label: "Report task outcome", description: "Report task delivery independently of execution completion. Provide evidence, remaining work and next_action when incomplete. This does not close or reap the Pi pane.",
    parameters: { type: "object", properties: { version: { type: "integer", const: 1 }, state: { type: "string", enum: ["delivered", "partial", "blocked", "checkpointed"] }, summary: { type: "string", maxLength: 2000 },
      acceptance: { type: "array", maxItems: 16, items: { type: "object", properties: { criterion: { type: "string" }, status: { type: "string", enum: ["passed", "failed", "not_run"] }, evidence: { type: "string" } }, required: ["criterion", "status"] } },
      artifacts: { type: "array", maxItems: 16, items: { type: "object", properties: { path: { type: "string" }, sha256: { type: "string" } }, required: ["path"] } }, remaining: { type: "array", maxItems: 16, items: { type: "string" } }, next_action: { type: "string" } },
      required: ["version", "state", "summary", "acceptance", "artifacts", "remaining"], additionalProperties: false } as any,
    async execute(_id, params: any) {
      if (!worker || worker.sealed) throw new Error("Worker outcome unavailable");
      const outcome = validateTaskOutcome(params, worker.manifest.acceptance ?? []);
      worker.outcome(outcome);
      return { content: [{ type: "text", text: `Recorded ${outcome.state}; execution completion and explicit reap remain separate.` }], details: { task_outcome: outcome } };
    } });
  pi.on("session_shutdown", async () => {
    if (ownerWatch) clearInterval(ownerWatch);
    context = undefined;
    await worker?.close();
    worker = undefined;
  });
}
