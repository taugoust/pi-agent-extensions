/**
 * Agent Events Extension — publish Pi session events to AgentSH.
 *
 * AgentSH owns event storage and external notification delivery. This extension
 * only publishes session-scoped events through the peer-authorized AgentSH UI
 * socket exposed to the wrapped Pi process. It deliberately does not accept or
 * use AgentSH approver/admin API keys.
 */

import { createConnection } from "node:net";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type AgentEvent = {
  id: string;
  type: string;
  session_id: string;
  created_at: string;
  source: "pi";
  title: string;
  message: string;
  cwd?: string;
  fields?: Record<string, unknown>;
};

type EventState = {
  active: boolean;
  sessionId: string;
  socketPath: string;
  lastError: string;
  lastPublishedAt: number;
  ctx?: ExtensionContext;
};

const TURN_COMPLETED_DEBOUNCE_MS = Number(process.env.AGENTSH_EVENT_TURN_DEBOUNCE_MS || "3000");

function env(name: string) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : "";
}

function getSessionId() {
  return env("AGENTSH_SESSION_ID") || env("PI_AUTO_SESSION_ID") || "";
}

function getSocketPath() {
  return env("AGENTSH_APPROVAL_UI_SOCKET") || env("AGENTSH_SESSION_UI_SOCKET") || "";
}

function makeEventId(type: string) {
  const clean = type.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80) || "event";
  const random = Math.random().toString(36).slice(2, 10);
  return `${clean}-${Date.now()}-${random}`;
}

function truncate(text: string, max = 1600) {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

async function uiRequest<T>(state: EventState, request: Record<string, unknown>): Promise<T> {
  if (!state.socketPath) throw new Error("AgentSH session UI socket not configured");
  return await new Promise<T>((resolve, reject) => {
    const socket = createConnection({ path: state.socketPath });
    let buffer = "";
    let settled = false;
    const done = (err?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(value as T);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(10_000, () => done(new Error("AgentSH session UI socket timeout")));
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      const line = buffer.slice(0, nl).trim();
      if (!line) return;
      try {
        const response = JSON.parse(line) as { ok?: boolean; error?: string } & T;
        if (!response.ok) {
          done(new Error(response.error || "AgentSH session event publish failed"));
          return;
        }
        done(undefined, response as T);
      } catch (error) {
        done(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("error", (error) => done(error));
    socket.on("end", () => {
      if (!settled) done(new Error("AgentSH session UI socket closed before response"));
    });
  });
}

function isUnsupported(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /unknown op|unsupported|not implemented/i.test(message);
}

async function publishEvent(
  state: EventState,
  type: string,
  title: string,
  message: string,
  fields: Record<string, unknown> = {},
) {
  if (!state.active) return false;
  const event: AgentEvent = {
    id: makeEventId(type),
    type,
    session_id: state.sessionId,
    created_at: new Date().toISOString(),
    source: "pi",
    title: truncate(title, 240),
    message: truncate(message, 4000),
    cwd: state.ctx?.cwd,
    fields,
  };

  try {
    await uiRequest<unknown>(state, { op: "publish_event", event });
    state.lastError = "";
    return true;
  } catch (error) {
    if (isUnsupported(error)) {
      // Older AgentSH versions only support approval list/resolve on this
      // socket. Publishing is best-effort until the server side is deployed.
      state.lastError = "AgentSH session events unsupported by server";
      return false;
    }
    state.lastError = error instanceof Error ? error.message : String(error);
    return false;
  }
}

function setStatus(state: EventState, ctx = state.ctx) {
  if (!ctx?.hasUI) return;
  if (!state.active) {
    ctx.ui.setStatus("agent-events", ctx.ui.theme.fg("muted", "events inactive"));
  } else if (state.lastError) {
    ctx.ui.setStatus("agent-events", ctx.ui.theme.fg("warning", "events ?"));
  } else {
    ctx.ui.setStatus("agent-events", ctx.ui.theme.fg("success", "events ✓"));
  }
}

function helpText(state: EventState) {
  if (!state.active) {
    return [
      "AgentSH session events are inactive.",
      "",
      "Required environment:",
      "  AGENTSH_SESSION_ID=<session>",
      "  AGENTSH_APPROVAL_UI_SOCKET=<AgentSH peer-authorized UI socket>",
    ].join("\n");
  }
  return [
    "AgentSH session events are active.",
    "",
    `Session: ${state.sessionId}`,
    `Socket:  ${state.socketPath}`,
    state.lastError ? `Last error: ${state.lastError}` : "Last error: -",
  ].join("\n");
}

export default function agentEvents(pi: ExtensionAPI) {
  const state: EventState = {
    active: false,
    sessionId: "",
    socketPath: "",
    lastError: "",
    lastPublishedAt: 0,
  };

  pi.on("session_start", async (_event, ctx) => {
    state.ctx = ctx;
    state.sessionId = getSessionId();
    state.socketPath = getSocketPath();
    state.lastError = "";
    state.active = Boolean(state.sessionId && state.socketPath);
    setStatus(state, ctx);
  });

  pi.on("session_shutdown", async () => {
    if (state.ctx?.hasUI) state.ctx.ui.setStatus("agent-events", undefined);
    state.active = false;
    state.ctx = undefined;
  });

  pi.on("agent_end", async (_event, ctx) => {
    state.ctx = ctx;
    const now = Date.now();
    if (now - state.lastPublishedAt < TURN_COMPLETED_DEBOUNCE_MS) return;
    state.lastPublishedAt = now;
    await publishEvent(
      state,
      "agent.turn.completed",
      "Pi is ready",
      "Pi finished the last turn and is waiting for your next prompt.",
      { debounce_ms: TURN_COMPLETED_DEBOUNCE_MS },
    );
    setStatus(state, ctx);
  });

  pi.registerCommand("agent-events", {
    description: "Show AgentSH session event publisher status",
    handler: async (_args, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(helpText(state), state.lastError ? "warning" : "info");
    },
  });

  pi.registerTool({
    name: "agent_publish_event",
    label: "Publish AgentSH session event",
    description: "Publish a session-scoped event for external notification clients. AgentSH owns delivery and acknowledgement.",
    parameters: Type.Object({
      type: Type.String({ description: "Event type, e.g. agent.question.pending or agent.turn.completed" }),
      title: Type.String({ description: "Short notification title" }),
      message: Type.String({ description: "Notification body" }),
    }),
    async execute(_id, params) {
      const ok = await publishEvent(state, params.type, params.title, params.message);
      return {
        content: [{
          type: "text",
          text: ok
            ? `Published AgentSH session event: ${params.type}`
            : `AgentSH session event was not published: ${state.lastError || "publisher inactive"}`,
        }],
      };
    },
  });
}
