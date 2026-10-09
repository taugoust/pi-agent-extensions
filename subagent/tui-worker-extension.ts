import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { dirname, resolve } from "node:path";
import { closeSync, constants, fstatSync, openSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { TUI_WORKER_MANIFEST_ENV } from "../shared/tui-worker-protocol.ts";
import { WORKER_INTERACTIONS_KEY } from "../shared/foreground-tasks.ts";
import { currentSubagentPermissionAuthority } from "../shared/subagent-permission.ts";
import { TuiWorkerStore } from "./tui-worker-store.ts";
import { TuiWorkerServer } from "./tui-worker-server.ts";
import { callTuiWorker } from "./tui-worker-client.ts";
import { processIsAlive } from "./tui-worker-tmux.ts";
import { validateTaskOutcome } from "./outcome.ts";
import { ModelInactivityWatch } from "./model-inactivity.ts";
import type { LocalJobController } from "../shared/background-job.ts";

/** Explicit -e entry point, loaded inside the one interactive child Pi process. */
export default function tuiWorkerExtension(pi: ExtensionAPI): void {
  const manifestPath = process.env[TUI_WORKER_MANIFEST_ENV];
  if (!manifestPath) return;
  let worker: TuiWorkerServer | undefined;
  let context: ExtensionContext | undefined;
  let failed = false;
  let lastAssistant: unknown;
  let liveAssistantText = "";
  let ownerWatch: ReturnType<typeof setInterval> | undefined;
  let rpcLogTrimTimer: ReturnType<typeof setInterval> | undefined;
  let announcedReap = false;
  let notificationTimes: number[] = [];
  const clearModelInactivityStatus = () => {
    try { if (context?.hasUI) context.ui.setStatus("subagent-model-inactivity", undefined); } catch { /* A stale TUI must not affect worker execution. */ }
  };
  const modelInactivity = new ModelInactivityWatch(() => {
    if (!worker || worker.sealed) return;
    const message = "No assistant stream progress for 5 minutes while awaiting the model. Work has not been cancelled; inspect the child and steer or cancel explicitly if needed.";
    try { worker.notification({ message, requires_guidance: true }); } catch { /* Best-effort observability only. */ }
    try {
      if (context?.hasUI) {
        context.ui.setStatus("subagent-model-inactivity", context.ui.theme.fg("warning", "model stalled · awaiting progress"));
        context.ui.notify(message, "warning");
      }
    } catch { /* A stale TUI must not affect worker execution. */ }
  }, undefined, undefined, undefined, clearModelInactivityStatus);
  const boundedSuffix = (text: string, maxBytes = 16 * 1024) => {
    const bytes = Buffer.from(text); let start = Math.max(0, bytes.length - maxBytes);
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
    return bytes.subarray(start).toString("utf8");
  };
  const allowed = () => Boolean(worker && !failed && !worker.sealed && !worker.preparingReap && (worker.manifest.launchMode !== "guard-only"
    || currentSubagentPermissionAuthority()?.active === true));
  const sendRpcCommand = async (type: "clear_queue" | "abort"): Promise<void> => {
    if (worker?.manifest.execution !== "rpc-headless") return;
    const manifest = worker.manifest, requestId = `harness-${randomBytes(8).toString("hex")}`;
    const fd = openSync(manifest.fifoPath, constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try { writeSync(fd, Buffer.from(`${JSON.stringify({ type, id: requestId })}\n`)); }
    finally { closeSync(fd); }
    const store = worker.store, deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const output = store.readRpcLogTail("stdout", 512 * 1024);
      for (const line of output.split("\n").reverse()) {
        try {
          const response = JSON.parse(line);
          if (response?.id === requestId && response?.type === "response" && response.command === type) {
            if (response.success !== true) throw new Error(`RPC ${type} was rejected`);
            return;
          }
        } catch (error) { if (error instanceof Error && error.message.includes("was rejected")) throw error; }
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`RPC ${type} acknowledgement timed out`);
  };
  const requestShutdown = (ctx: ExtensionContext, sealedReap = false) => {
    if (ctx.mode === "rpc") void (async () => { try { await sendRpcCommand("clear_queue"); await sendRpcCommand("abort"); } catch {} })();
    void ctx.abort();
    ctx.shutdown();
    // RPC shutdown is deferred until its next idle command boundary. This
    // worker deliberately keeps stdin's FIFO open, so close its own endpoint
    // after requesting graceful shutdown to wake the RPC input loop (never a
    // parent-owned writer or EOF side effect).
    if (ctx.mode === "rpc") {
      const timer = setTimeout(() => {
        try { process.stdin.pause(); process.stdin.destroy(); } catch {}
        try { closeSync(0); } catch {}
      }, 500);
      timer.unref?.();
      if (sealedReap) {
        const exitTimer = setTimeout(() => { void worker?.close().finally(() => { try { process.kill(process.pid, "SIGTERM"); } catch {} }); }, 1500);
        exitTimer.unref?.();
      }
    }
  };
  const stop = (ctx: ExtensionContext) => {
    // A cleanup refusal must leave the controller available for repair/retry.
    if (worker?.preparingReap) { worker.running(); return; }
    requestShutdown(ctx);
  };
  const fail = (ctx: ExtensionContext, error: unknown) => {
    failed = true;
    const message = error instanceof Error ? error.message : String(error);
    if (ctx.mode === "rpc") {
      try {
        const store = new TuiWorkerStore(dirname(resolve(manifestPath)));
        let execution: string | undefined;
        try { execution = store.readManifest().execution; } catch { /* still record a bounded startup diagnostic in the launch-owned file */ }
        if (ctx.mode === "rpc" || execution === "rpc-headless") {
          const fd = openSync(store.path("rpc.stderr.log"), constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
          try {
            const stat = fstatSync(fd);
            if (stat.isFile() && (stat.mode & 0o077) === 0 && (!process.getuid || stat.uid === process.getuid())) {
              const safe = message.replace(/[a-f0-9]{64}/gi, "[redacted]").replace(/(token|capability)[=: ]+[^\s,;]+/gi, "$1=[redacted]");
              const bytes = Buffer.from(`${new Date().toISOString()} headless-worker-error ${boundedSuffix(safe, 2048)}\n`);
              writeSync(fd, bytes);
            }
          } finally { closeSync(fd); }
          store.trimRpcLogs();
        }
      } catch { /* Diagnostic logging must not weaken fail-closed shutdown. */ }
    } else if (ctx.hasUI) ctx.ui.notify(`TUI worker failed closed: ${message}`, "error");
    stop(ctx);
  };
  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    try {
      const store = new TuiWorkerStore(dirname(resolve(manifestPath)));
      if (store.path("manifest.json") !== resolve(manifestPath)) throw new Error("Invalid worker manifest filename");
      const manifest = store.readManifest();
      if (manifest.execution === "rpc-headless" ? ctx.mode !== "rpc" : ctx.mode !== "tui") throw new Error("Worker execution mode does not match launch manifest");
      // --tools limits builtins, not ordinary extension tools. Apply the parent
      // allowlist explicitly. Headless helpers must not advertise recursive
      // delegation or tmux-pane jobs even when no allowlist was supplied.
      if (manifest.execution === "rpc-headless") {
        const configured = manifest.tools ?? (typeof (pi as any).getActiveTools === "function" ? (pi as any).getActiveTools() : []);
        const headlessTools = configured.filter((name: string) => name !== "subagent" && name !== "background_job");
        if (typeof (pi as any).setActiveTools === "function") pi.setActiveTools([...new Set([...headlessTools, "notify_parent", "task_outcome"])]);
      } else if (manifest.tools !== undefined && typeof (pi as any).setActiveTools === "function") {
        pi.setActiveTools([...new Set([...manifest.tools, "notify_parent", "task_outcome"])]);
      }
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
        recursiveCleanup: true,
        prepareJobReap: async preserve => {
          const session = context;
          const controller = (globalThis as any).__paeLocalJobControllerV1 as LocalJobController | undefined;
          if (!session || controller?.protocol !== 1 || controller.sessionId !== session.sessionManager.getSessionId() || !controller.prepareReap) throw new Error("Child-local job cleanup controller unavailable for this session; reload/recover the child before reaping");
          // Flat RPC helpers enforce a subagent tool-call prohibition below and
          // never expose delegation. Their inventory is empty by construction,
          // not inferred from an absent controller or a dead parent.
          if (manifest.execution === "rpc-headless") return await controller.prepareReap(async report => {
            await preserve({ ...report as Record<string, unknown>, subagents: { groups: [], flatHeadless: true } });
          });
          const subagents = (globalThis as any).__paeLocalSubagentControllerV1;
          if (subagents?.protocol !== 1 || subagents.sessionId !== session.sessionManager.getSessionId() || typeof subagents.prepareReap !== "function") throw new Error(`Child-local subagent cleanup controller unavailable (${!subagents ? "missing" : subagents.sessionId !== session.sessionManager.getSessionId() ? "session changed" : "unsupported contract"}); reload/recover the child before reaping`);
          let subagentReport: unknown;
          const releaseSubagents = await subagents.prepareReap(async (report: unknown) => {
            subagentReport = report;
            await preserve({ subagents: report });
          });
          try {
            const releaseJobs = await controller.prepareReap(async report => { await preserve({ ...report as Record<string, unknown>, subagents: subagentReport }); });
            return () => { releaseJobs(); releaseSubagents(); };
          } catch (error) { releaseSubagents(); throw error; }
        },
        clearQueue: () => sendRpcCommand("clear_queue"),
        abort: async () => { if (manifest.execution === "rpc-headless") await sendRpcCommand("abort"); await context?.abort(); },
        shutdown: () => {
          if (worker?.state.sealed && !announcedReap) {
            announcedReap = true;
            pi.events?.emit?.("harness-runtime-reaping", { runtimeId: worker.manifest.runtimeId,
              childId: worker.manifest.childId, workerEpoch: worker.manifest.workerEpoch });
          }
          if (context) requestShutdown(context, worker?.state.sealed === true);
        },
        compact: () => new Promise<void | { compaction: "not-needed"; reason: "nothing-to-compact" | "already-compacted" }>((resolve, reject) => {
          if (!context || !allowed()) { reject(new Error("Compaction authority unavailable")); return; }
          const handleError = (error: unknown) => {
            // Pi throws this exact error when the session has no compactable
            // history. That is a successful no-op for the parent checkpoint
            // request; all other errors remain explicit failures.
            if (error instanceof Error && error.message === "Nothing to compact (session too small)") {
              resolve({ compaction: "not-needed", reason: "nothing-to-compact" });
            } else if (error instanceof Error && error.message === "Already compacted") {
              // Pi emits this before dispatch when the current leaf is already
              // a compaction entry. Reuse it; never drop or compact twice.
              resolve({ compaction: "not-needed", reason: "already-compacted" });
            } else reject(error);
          };
          try {
            context.compact({ onComplete: () => resolve(), onError: handleError });
          } catch (error) { handleError(error); }
        }),
        send: (message, mode, source = "parent") => {
          if (!allowed()) throw new Error("Worker or child-local command authority unavailable");
          // Neither source enters slash-command dispatch. Parent instructions and
          // trusted panel-user messages remain visibly distinct in session history.
          const user = source === "user";
          pi.sendMessage({ customType: user ? "harness-user-control" : "harness-control",
            content: user ? `Direct user instruction from Paseo (priority over parent guidance):\n${message}` : `Parent instructions:\n${message}`, display: true },
            { triggerTurn: true, deliverAs: mode === "follow_up" ? "followUp" : "steer" });
        },
        applyOperatorMode: async enabled => {
          const service = (globalThis as Record<string, any>).__PAE_PERMISSION_GATE_OPERATOR_V1__;
          if (worker?.manifest.launchMode !== "guard-only" || typeof service?.applyMode !== "function") throw new Error("Child operator authority unavailable");
          return await service.applyMode(ctx.sessionManager.getSessionId(), enabled);
        },
      });
      await worker.start();
      if (manifest.execution === "rpc-headless") {
        (globalThis as any)[WORKER_INTERACTIONS_KEY] = { protocol: 1, mode: "headless", workerEpoch: manifest.workerEpoch,
          request: (input: any, interactionSignal?: AbortSignal) => worker?.requestInteraction(input, interactionSignal) ?? Promise.reject(new Error("Worker interaction service closed")) };
        rpcLogTrimTimer = setInterval(() => { try { store.trimRpcLogs(); } catch (error) { fail(ctx, error); } }, 1000);
        rpcLogTrimTimer.unref?.();
      }
      let watching = false;
      ownerWatch = setInterval(() => {
        if (watching) return;
        watching = true;
        void (async () => {
          const current = store.readManifest();
          if (!(current.presentation === "foreground-staged" || current.presentation === "headless-foreground") || !current.foregroundOwner) return;
          const owner = current.foregroundOwner;
          const alive = await processIsAlive(owner.pid, owner.token);
          if (!alive) {
            await ctx.abort();
            if (!ctx.isIdle()) return;
            const reap = await callTuiWorker(current, { operation: "prepare_reap" }, { requestId: `owner-loss:${current.workerEpoch}`, timeoutMs: 30_000 });
            if (!reap.ok) return; // Keep the child controller alive; never orphan unknown local jobs.
          }
        })().catch(error => fail(ctx, error)).finally(() => { watching = false; });
      }, 500);
      ownerWatch.unref?.();
    } catch (error) { fail(ctx, error); }
  });
  pi.on("input", (_event, ctx) => {
    if (!allowed()) {
      if (worker?.preparingReap && ctx.hasUI) ctx.ui.notify("Child job cleanup in progress; retry input after cleanup finishes", "warning");
      else if (worker?.sealed || failed) stop(ctx);
      return { action: "handled" as const };
    }
    try { worker!.running(); } catch (error) { fail(ctx, error); return { action: "handled" as const }; }
    return { action: "continue" as const };
  });
  pi.on("before_agent_start", (event, ctx) => {
    lastAssistant = undefined;
    liveAssistantText = "";
    worker?.liveText("");
    if (!allowed()) { stop(ctx); return; }
    try { worker!.running(true); } catch (error) { fail(ctx, error); }
    return { systemPrompt: event.systemPrompt + "\n\nDirect user instructions take precedence over parent instructions. Notify the parent of scope changes. Parent messages do not authorize slash commands." };
  });
  pi.on("agent_start", (_event, ctx) => {
    liveAssistantText = "";
    worker?.liveText("");
    if (!allowed()) { stop(ctx); return; }
    try { worker!.running(); } catch (error) { fail(ctx, error); }
  });
  // Defence in depth if a built-in/other extension starts work while a graceful
  // shutdown is pending. Reap waits for actual endpoint/pane exit regardless.
  pi.on("tool_call", (event: any) => {
    if (worker?.manifest.execution === "rpc-headless" && event.toolName === "subagent") return { block: true, reason: "Foreground helpers cannot delegate to further subagents" };
    if (worker?.manifest.execution === "rpc-headless" && event.toolName === "background_job") return { block: true, reason: "This headless worker has no tmux pane; child-local background job operations are unavailable" };
    return allowed() ? undefined : { block: true, reason: "Worker sealed or local authority unavailable", terminate: true };
  });
  pi.on("user_bash", (_event, ctx) => {
    if (allowed()) return;
    stop(ctx);
    return { result: { output: "Worker sealed or local authority unavailable", exitCode: 1, cancelled: true, truncated: false } };
  });
  pi.on("session_before_switch", () => ({ cancel: true }));
  pi.on("session_before_fork", () => ({ cancel: true }));
  pi.on("turn_start", () => { modelInactivity.start(); });
  pi.on("turn_end", () => { modelInactivity.end(); });
  pi.on("tool_execution_start", () => { modelInactivity.end(); });
  pi.on("agent_end", () => { modelInactivity.end(); });
  pi.on("message_start", (event: any) => {
    if (event.message?.role === "assistant") { liveAssistantText = ""; worker?.liveText(""); }
  });
  pi.on("message_update", (event: any) => {
    if (event.message?.role === "assistant") modelInactivity.progress();
    if (!worker || worker.manifest.execution !== "rpc-headless") return;
    if (event.message?.role === "assistant") {
      const text = typeof event.message.content === "string" ? event.message.content : Array.isArray(event.message.content)
        ? event.message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text ?? "").join("") : "";
      liveAssistantText = boundedSuffix(text);
      worker.liveText(liveAssistantText);
    } else if (event.assistantMessageEvent?.type === "text_delta" && typeof event.assistantMessageEvent.delta === "string") {
      liveAssistantText = boundedSuffix(liveAssistantText + event.assistantMessageEvent.delta);
      worker.liveText(liveAssistantText);
    }
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") {
      modelInactivity.end();
      lastAssistant = event.message;
      const text = typeof event.message.content === "string" ? event.message.content : Array.isArray(event.message.content)
        ? event.message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text ?? "").join("") : "";
      liveAssistantText = boundedSuffix(text);
      worker?.liveText(liveAssistantText);
    }
  });
  pi.on("agent_settled", (_event, ctx) => {
    modelInactivity.end();
    if (!worker || failed || worker.sealed) return;
    try { worker.settled({ sessionFile: ctx.sessionManager.getSessionFile(), assistant: lastAssistant ?? null,
      ...(!allowed() ? { error: "Worker command authority unavailable at settlement" } : {}),
      contextTokens: ctx.getContextUsage()?.tokens, contextWindow: ctx.model?.contextWindow, timestamp: new Date().toISOString() }); }
    catch (error) { fail(ctx, error); }
  });
  // Ordinary local tools: no parent RPC connection is required to retain these.
  pi.registerTool({ name: "notify_parent", label: "Notify parent", description: "Report a finding or blocker to the parent. Continue working unless you need its answer.",
    parameters: { type: "object", properties: { message: { type: "string", minLength: 1, maxLength: 1000 }, requires_guidance: { type: "boolean" } }, required: ["message"], additionalProperties: false } as any,
    async execute(_id, params: any) {
      if (!worker || worker.sealed || typeof params.message !== "string" || Buffer.byteLength(params.message) > 1000) throw new Error("Worker notification unavailable or invalid");
      notificationTimes = notificationTimes.filter(time => time > Date.now() - 60_000);
      if (notificationTimes.length >= 5) throw new Error("At most five findings per minute; batch updates or retain them for the final report");
      notificationTimes.push(Date.now());
      worker.notification({ message: params.message, requires_guidance: params.requires_guidance === true });
      return { content: [{ type: "text", text: "Queued for the parent; no reply yet." }], details: {} };
    } });
  pi.registerTool({ name: "task_outcome", label: "Report task outcome", description: "Report what you delivered, with evidence. If incomplete, include remaining work and the next action.",
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
    modelInactivity.shutdown();
    if (ownerWatch) clearInterval(ownerWatch);
    if (rpcLogTrimTimer) clearInterval(rpcLogTrimTimer);
    context = undefined;
    const interactions = (globalThis as any)[WORKER_INTERACTIONS_KEY];
    if (interactions?.workerEpoch === worker?.manifest.workerEpoch) delete (globalThis as any)[WORKER_INTERACTIONS_KEY];
    await worker?.close();
    worker = undefined;
  });
}
