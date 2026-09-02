import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isAbsolute, join } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { agentSHRuntimeDisposition, classifyAgentSHStartup, type AgentSHRuntimeState } from "../shared/agentsh-mode.js";
import { BackgroundJobManager, resolveExecutable, sanitizeOutput } from "./manager.js";
import { JobStore } from "./store.js";
import { TmuxBackend } from "./tmux.js";
import type { JobRecord } from "./types.js";

const ACTION_PATTERN = "^(start|list|status|output|wait|signal|cancel)$";
const JOB_PATTERN = "^job-[0-9a-f]{24}$";
const POLL_MS = 2000;
const COMMAND_AUTHORITY_KEY = "__paeCommandAuthorityV1";

type CommandAuthority = {
  protocol: 1;
  active: boolean;
  consume(toolCallId: string, command: string, cwd: string): boolean;
};

type Params = {
  action: "start" | "list" | "status" | "output" | "wait" | "signal" | "cancel";
  command?: string;
  name?: string;
  job_id?: string;
  timeout_ms?: number;
  lines?: number;
  limit?: number;
  signal?: "SIGINT" | "SIGTERM";
};

function runtimeState(): AgentSHRuntimeState | undefined {
  const api = (globalThis as Record<string, any>).__AGENTSH_PI__;
  if (!api) return undefined;
  try { return api.getSupervisorState?.() ?? { configured: true, active: false }; }
  catch { return { configured: true, active: false }; }
}

function requireNativeExecution(startup: ReturnType<typeof classifyAgentSHStartup>): void {
  const disposition = agentSHRuntimeDisposition(startup, runtimeState());
  if (disposition.kind === "full") {
    throw new Error("background_job is not yet supported by the full AgentSH backend; refusing native execution");
  }
  if (disposition.kind === "unavailable") {
    throw new Error("Full AgentSH mode is selected but unavailable; refusing native background execution");
  }
}

function requireStartAuthorization(
  startup: ReturnType<typeof classifyAgentSHStartup>,
  toolCallId: string,
  command: string,
  cwd: string,
): void {
  const authority = (globalThis as Record<string, unknown>)[COMMAND_AUTHORITY_KEY] as CommandAuthority | undefined;
  if (authority?.protocol === 1) {
    if (!authority.active) throw new Error("Permission Gate command authority is inactive; refusing background start");
    if (!authority.consume(toolCallId, command, cwd)) {
      throw new Error("background_job start lacks an exact Permission Gate authorization receipt");
    }
    return;
  }
  if (startup.kind === "guard-only" || startup.kind === "conflict") {
    throw new Error("AgentSH Permission Gate is selected but no active command authority is available");
  }
}

function sessionId(ctx: ExtensionContext): string {
  const value = (ctx.sessionManager as any).getSessionId?.();
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 512) {
    throw new Error("background_job requires a stable Pi session ID");
  }
  return value;
}

function runtimeRoot(stateRoot: string): string {
  const configured = process.env.XDG_RUNTIME_DIR;
  const preferred = configured && isAbsolute(configured) ? configured : "/tmp";
  const uid = process.getuid?.() ?? process.pid;
  const key = createHash("sha256").update(stateRoot).digest("hex").slice(0, 16);
  const suffix = `pi-bg-${uid}-${key}`;
  const value = join(preferred, suffix);
  return Buffer.byteLength(join(value, "tmux.sock"), "utf8") <= 100 ? value : join("/tmp", suffix);
}

function requireJobId(params: Params): string {
  if (!params.job_id || !new RegExp(JOB_PATTERN).test(params.job_id)) {
    throw new Error(`${params.action} requires a valid job_id`);
  }
  return params.job_id;
}

function validate(params: Params): void {
  if (params.action === "start") {
    if (typeof params.command !== "string" || params.command.length === 0) throw new Error("start requires command");
    if (params.job_id !== undefined || params.timeout_ms !== undefined || params.lines !== undefined || params.limit !== undefined || params.signal !== undefined) {
      throw new Error("start accepts only command and optional name");
    }
    return;
  }
  if (params.command !== undefined || params.name !== undefined) throw new Error(`${params.action} does not accept command or name`);
  if (params.action === "list") {
    if (params.job_id !== undefined || params.timeout_ms !== undefined || params.lines !== undefined || params.signal !== undefined) throw new Error("list accepts only optional limit");
    return;
  }
  requireJobId(params);
  if (params.action === "wait") {
    if (params.limit !== undefined || params.signal !== undefined) throw new Error("wait accepts only job_id, timeout_ms, and lines");
    return;
  }
  if (params.action === "output") {
    if (params.timeout_ms !== undefined || params.limit !== undefined || params.signal !== undefined) throw new Error("output accepts only job_id and lines");
    return;
  }
  if (params.action === "signal") {
    if (params.timeout_ms !== undefined || params.limit !== undefined || params.lines !== undefined) throw new Error("signal accepts only job_id and signal");
    if (params.signal !== "SIGINT" && params.signal !== "SIGTERM") throw new Error("signal requires SIGINT or SIGTERM");
    return;
  }
  if (params.timeout_ms !== undefined || params.limit !== undefined || params.lines !== undefined || params.signal !== undefined) {
    throw new Error(`${params.action} accepts only job_id`);
  }
}

function age(record: JobRecord): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(record.metadata.createdAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function preview(command: string, maximum = 100): string {
  const oneLine = sanitizeOutput(command).replace(/\s+/g, " ").trim();
  return oneLine.length <= maximum ? oneLine : `${oneLine.slice(0, maximum - 1)}…`;
}

function recordLine(record: JobRecord): string {
  const code = record.result?.exitCode === null || record.result?.exitCode === undefined ? "" : ` exit=${record.result.exitCode}`;
  return `${record.metadata.id}  ${record.status}${code}  ${age(record)}  ${record.metadata.name ? preview(record.metadata.name, 80) : preview(record.metadata.command)}`;
}

function recordText(record: JobRecord): string {
  return [
    recordLine(record),
    `cwd: ${sanitizeOutput(record.metadata.cwd)}`,
    `command: ${preview(record.metadata.command, 200)}`,
    ...(record.result?.reason ? [`reason: ${record.result.reason}`] : []),
  ].join("\n");
}

function publicDetails(record: JobRecord): Record<string, unknown> {
  return {
    job_id: record.metadata.id,
    status: record.status,
    exit_code: record.result?.exitCode,
    signal: record.result?.signal,
  };
}

function assertOwned(record: JobRecord, ownerSessionId: string): void {
  if (record.metadata.sessionId !== ownerSessionId) {
    throw new Error(`Background job ${record.metadata.id} belongs to a different Pi session`);
  }
}

function takeLines(text: string, lines: number | undefined): string {
  if (lines === undefined) return text;
  return text.split("\n").slice(-lines).join("\n");
}

function outputText(snapshot: Awaited<ReturnType<BackgroundJobManager["output"]>>, lines?: number): string {
  const text = takeLines(snapshot.text, lines) || "(no output)";
  return `${text}${snapshot.truncated ? "\n[output truncated to the last 50 KiB / 2000 lines]" : ""}`;
}

function toolResult(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

export default function backgroundJob(pi: ExtensionAPI) {
  const startup = classifyAgentSHStartup(process.env);
  let managerPromise: Promise<BackgroundJobManager> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let sessionContext: ExtensionContext | undefined;
  let pollRunning = false;
  let sessionGeneration = 0;

  const manager = () => {
    if (!managerPromise) managerPromise = (async () => {
      const stateRoot = join(getAgentDir(), "state", "background-jobs-v1");
      const store = new JobStore(stateRoot, runtimeRoot(stateRoot));
      await store.initialize();
      const [tmux, node] = await Promise.all([resolveExecutable("tmux"), resolveExecutable("node")]);
      const runner = fileURLToPath(new URL("./runner.mjs", import.meta.url));
      return new BackgroundJobManager(store, new TmuxBackend(store, tmux, node, runner));
    })();
    return managerPromise;
  };

  const updateStatus = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    try {
      const ownerSessionId = sessionId(ctx);
      const running = (await (await manager()).list()).filter((record) => record.metadata.sessionId === ownerSessionId && (record.status === "running" || record.status === "starting")).length;
      ctx.ui.setStatus("background-jobs", running > 0 ? ctx.ui.theme.fg("accent", `jobs ${running}`) : undefined);
    } catch {
      ctx.ui.setStatus("background-jobs", ctx.ui.theme.fg("error", "jobs ✗"));
    }
  };

  const poll = async () => {
    if (pollRunning) return;
    const ctx = sessionContext;
    if (!ctx) return;
    const generation = sessionGeneration;
    pollRunning = true;
    try {
      const ownerSessionId = sessionId(ctx);
      const service = await manager();
      const records = (await service.list()).filter((record) => record.metadata.sessionId === ownerSessionId);
      for (const record of records) {
        if (!record.result || generation !== sessionGeneration || sessionContext !== ctx) return;
        if (!(await service.store.markNotified(record.metadata.id))) continue;
        const message = `Background job ${record.metadata.id}: ${record.status}${record.result.exitCode === null ? "" : ` (exit ${record.result.exitCode})`}`;
        if (ctx.hasUI) ctx.ui.notify(message, record.status === "completed" ? "info" : "warning");
        if (generation !== sessionGeneration || sessionContext !== ctx) return;
        pi.sendMessage({ customType: "background-job-complete", content: message, display: false, details: { job_id: record.metadata.id, status: record.status } }, { deliverAs: "nextTurn" });
      }
      if (generation === sessionGeneration && sessionContext === ctx) await updateStatus(ctx);
    } catch {
      if (generation === sessionGeneration && sessionContext === ctx && ctx.hasUI) ctx.ui.setStatus("background-jobs", ctx.ui.theme.fg("error", "jobs ✗"));
    } finally {
      pollRunning = false;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    sessionGeneration += 1;
    sessionContext = ctx;
    await updateStatus(ctx);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => void poll(), POLL_MS);
    pollTimer.unref();
    void poll();
  });

  pi.on("session_shutdown", () => {
    sessionGeneration += 1;
    sessionContext = undefined;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
  });

  pi.registerTool({
    name: "background_job",
    label: "Background Job",
    description: "Manage durable native background shell jobs. Actions: start, list, status, output, bounded wait, signal, and cancel. Jobs survive Pi exit. Cancelling wait never cancels the job. Output is limited to the last 50 KiB/2000 lines.",
    promptSnippet: "Start, inspect, wait for, signal, or cancel durable background shell jobs",
    promptGuidelines: [
      "Use background_job for commands that should continue across turns or Pi exits; use bash for short foreground commands.",
      "Cancelling a background_job wait only stops waiting; use background_job cancel to stop the job.",
    ],
    parameters: Type.Object({
      action: Type.String({ pattern: ACTION_PATTERN, description: "Lifecycle action." }),
      command: Type.Optional(Type.String({ description: "Shell command; required only for start." })),
      name: Type.Optional(Type.String({ maxLength: 80, description: "Optional start label." })),
      job_id: Type.Optional(Type.String({ pattern: JOB_PATTERN, description: "Opaque job ID for non-list actions." })),
      timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 30_000, description: "Bounded wait duration; default 1000ms." })),
      lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000, description: "Output tail line count." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Maximum jobs returned by list." })),
      signal: Type.Optional(Type.String({ pattern: "^(SIGINT|SIGTERM)$", description: "Signal for the signal action." })),
    }),
    async execute(toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = rawParams as Params;
      validate(params);
      requireNativeExecution(startup);
      const ownerSessionId = sessionId(ctx);
      if (params.action === "start") requireStartAuthorization(startup, toolCallId, params.command!, ctx.cwd);
      const service = await manager();
      let response;
      switch (params.action) {
        case "start": {
          const record = await service.start({ command: params.command!, cwd: ctx.cwd, name: params.name, sessionId: ownerSessionId }, signal);
          response = toolResult(`${recordText(record)}\nStarted in an extension-owned tmux server.`, { action: params.action, ...publicDetails(record) });
          break;
        }
        case "list": {
          const records = (await service.list(50)).filter((record) => record.metadata.sessionId === ownerSessionId).slice(0, params.limit ?? 20);
          for (const record of records) if (record.result) await service.store.markNotified(record.metadata.id);
          response = toolResult(records.length ? records.map(recordLine).join("\n") : "No background jobs for this Pi session.", { action: params.action, jobs: records.map(publicDetails) });
          break;
        }
        case "status": {
          const record = await service.get(requireJobId(params));
          assertOwned(record, ownerSessionId);
          if (record.result) await service.store.markNotified(record.metadata.id);
          response = toolResult(recordText(record), { action: params.action, ...publicDetails(record) });
          break;
        }
        case "output": {
          const id = requireJobId(params);
          assertOwned(await service.get(id), ownerSessionId);
          const snapshot = await service.output(id);
          response = toolResult(outputText(snapshot, params.lines), { action: params.action, job_id: id, source: snapshot.source, truncated: snapshot.truncated });
          break;
        }
        case "wait": {
          const id = requireJobId(params);
          assertOwned(await service.get(id), ownerSessionId);
          const waited = await service.wait(id, params.timeout_ms ?? 1000, signal);
          const snapshot = await service.output(id);
          response = toolResult(`${recordText(waited.record)}\n${waited.timedOut ? "Wait timed out; job is still running.\n" : ""}${outputText(snapshot, params.lines)}`, { action: params.action, ...publicDetails(waited.record), timed_out: waited.timedOut, output_source: snapshot.source });
          break;
        }
        case "signal": {
          const id = requireJobId(params);
          assertOwned(await service.get(id), ownerSessionId);
          const record = await service.signal(id, params.signal!);
          response = toolResult(`Sent ${params.signal} to ${record.metadata.id}.`, { action: params.action, ...publicDetails(record), signal: params.signal });
          break;
        }
        case "cancel": {
          const id = requireJobId(params);
          assertOwned(await service.get(id), ownerSessionId);
          const record = await service.cancel(id);
          response = toolResult(recordText(record), { action: params.action, ...publicDetails(record) });
          break;
        }
      }
      await updateStatus(ctx);
      return response!;
    },
    renderCall(args, theme) {
      const params = args as Params;
      const subject = params.action === "start" ? params.name ?? preview(params.command ?? "") : params.job_id ?? "";
      return new Text(`${theme.fg("toolTitle", theme.bold("background_job"))} ${theme.fg("muted", params.action)}${subject ? ` ${theme.fg("dim", subject)}` : ""}`, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Working…"), 0, 0);
      const text = result.content.find((part: any) => part.type === "text")?.text ?? "";
      return new Text(text, 0, 0);
    },
  });

  pi.registerCommand("background-jobs", {
    description: "Inspect and manage extension-owned background jobs",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const service = await manager();
      const records = await service.list(50);
      if (records.length === 0) { ctx.ui.notify("No background jobs", "info"); return; }
      const labels = records.map(recordLine);
      const selected = await ctx.ui.select("Background jobs", labels);
      if (!selected) return;
      const record = records[labels.indexOf(selected)];
      if (!record) return;
      const actions = record.status === "running" ? ["Show output", "Show status", "Show attach command", "Cancel job"] : ["Show output", "Show status", "Remove record"];
      const action = await ctx.ui.select(record.metadata.id, actions);
      if (action === "Show output") {
        const snapshot = await service.output(record.metadata.id);
        await ctx.ui.editor(`${record.metadata.id} output`, outputText(snapshot));
      } else if (action === "Show status") {
        await ctx.ui.editor(`${record.metadata.id} status`, `${recordText(await service.get(record.metadata.id))}\nattach: ${service.backend.attachCommand()}`);
      } else if (action === "Show attach command") {
        ctx.ui.notify(service.backend.attachCommand(), "info");
      } else if (action === "Cancel job" && await ctx.ui.confirm("Cancel background job?", recordLine(record))) {
        await service.cancel(record.metadata.id);
        ctx.ui.notify(`Cancelled ${record.metadata.id}`, "info");
      } else if (action === "Remove record" && await ctx.ui.confirm("Remove background job record?", recordLine(record))) {
        await service.remove(record.metadata.id);
        ctx.ui.notify(`Removed ${record.metadata.id}`, "info");
      }
      await updateStatus(ctx);
    },
  });
}
