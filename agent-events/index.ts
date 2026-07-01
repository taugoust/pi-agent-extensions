/**
 * Agent Events Extension — publish Pi session events to AgentSH.
 *
 * AgentSH owns event storage and external notification delivery. This extension
 * only publishes session-scoped events through the peer-authorized AgentSH UI
 * socket exposed to the wrapped Pi process. It deliberately does not accept or
 * use AgentSH approver/admin API keys.
 */

import * as http from "node:http";
import { createConnection } from "node:net";
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

type EventMode = "legacy-ui" | "rest" | "central-rest" | "";

type EventState = {
  active: boolean;
  mode: EventMode;
  sessionId: string;
  socketPath: string;
  centralURL: string;
  eventToken: string;
  lastError: string;
  lastPublishedAt: number;
  ctx?: ExtensionContext;
};

type AgentEventPublisher = (
  type: string,
  title: string,
  message: string,
  fields?: Record<string, unknown>,
) => Promise<boolean>;

type QuestionAnswerGetter = (questionnaireId: string) => Promise<unknown | undefined>;

declare global {
  var __PI_AGENTSH_PUBLISH_EVENT__: AgentEventPublisher | undefined;
  var __PI_AGENTSH_GET_QUESTION_ANSWER__: QuestionAnswerGetter | undefined;
}

const TURN_COMPLETED_DEBOUNCE_MS = Number(process.env.AGENTSH_EVENT_TURN_DEBOUNCE_MS || "3000");

function env(name: string) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : "";
}

function getSessionId() {
  return env("AGENTSH_SESSION_ID") || env("PI_AUTO_SESSION_ID") || "";
}

function normalizeSocketPath(value: string) {
  if (!value) return "";
  return value.startsWith("unix://") ? value.slice("unix://".length) : value;
}

function getSocketPath() {
  return normalizeSocketPath(env("AGENTSH_APPROVAL_UI_SOCKET") || env("AGENTSH_SESSION_UI_SOCKET") || env("AGENTSH_SESSION_SUPERVISOR"));
}

function getCentralURL() {
  return (env("AGENTSH_SESSION_EVENT_URL") || env("AGENTSH_DETACHED_EVENT_URL")).replace(/\/+$/, "");
}

function getEventToken() {
  return env("AGENTSH_SESSION_EVENT_TOKEN") || env("AGENTSH_DETACHED_EVENT_TOKEN");
}

function getEventMode(): EventMode {
  if (getCentralURL() && getEventToken()) return "central-rest";
  if (env("AGENTSH_APPROVAL_UI_SOCKET") || env("AGENTSH_SESSION_UI_SOCKET")) return "legacy-ui";
  if (env("AGENTSH_SESSION_SUPERVISOR")) return "rest";
  return "";
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

async function restRequest<T>(state: EventState, method: string, path: string, body?: unknown): Promise<T> {
  if (!state.socketPath) throw new Error("AgentSH supervisor socket not configured");
  return await new Promise<T>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      socketPath: state.socketPath,
      host: "unix",
      method,
      path,
      headers: payload === undefined ? { Accept: "application/json" } : {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
          reject(new Error(`${method} ${path}: HTTP ${res.statusCode}${text.trim() ? `: ${truncate(text.trim(), 1000)}` : ""}`));
          return;
        }
        if (!text.trim()) {
          resolve(undefined as T);
          return;
        }
        try {
          const parsed = JSON.parse(text) as { ok?: boolean; error?: string } & T;
          if (parsed.ok === false) reject(new Error(parsed.error || "AgentSH REST request failed"));
          else resolve(parsed as T);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    req.on("error", (error) => reject(error));
    req.setTimeout(10_000, () => req.destroy(new Error("AgentSH supervisor socket timeout")));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function centralRequest<T>(state: EventState, method: string, path: string, body?: unknown): Promise<T> {
  if (!state.centralURL || !state.eventToken) throw new Error("AgentSH central event endpoint not configured");
  return await new Promise<T>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const url = new URL(path, `${state.centralURL}/`);
    const req = http.request(url, {
      method,
      headers: payload === undefined ? {
        Accept: "application/json",
        "X-AgentSH-Session-Event-Token": state.eventToken,
      } : {
        Accept: "application/json",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "X-AgentSH-Session-Event-Token": state.eventToken,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode || 0) < 200 || (res.statusCode || 0) >= 300) {
          reject(new Error(`${method} ${url.pathname}: HTTP ${res.statusCode}${text.trim() ? `: ${truncate(text.trim(), 1000)}` : ""}`));
          return;
        }
        if (!text.trim()) {
          resolve(undefined as T);
          return;
        }
        try {
          const parsed = JSON.parse(text) as { ok?: boolean; error?: string } & T;
          if (parsed.ok === false) reject(new Error(parsed.error || "AgentSH central event request failed"));
          else resolve(parsed as T);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    req.on("error", (error) => reject(error));
    req.setTimeout(10_000, () => req.destroy(new Error("AgentSH central event request timeout")));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function isUnsupported(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /unknown op|unsupported|not implemented/i.test(message);
}

async function getQuestionAnswer(state: EventState, questionnaireId: string) {
  if (!state.active) return undefined;
  try {
    const response = state.mode === "central-rest"
      ? await centralRequest<{ answer?: unknown }>(
        state,
        "GET",
        `/api/v1/detached-sessions/${encodeURIComponent(state.sessionId)}/session-events/question-answers/${encodeURIComponent(questionnaireId)}`,
      )
      : state.mode === "rest"
        ? await restRequest<{ answer?: unknown }>(
          state,
          "GET",
          `/api/v1/sessions/${encodeURIComponent(state.sessionId)}/session-events/question-answers/${encodeURIComponent(questionnaireId)}`,
        )
        : await uiRequest<{ answer?: unknown }>(state, {
          op: "get_question_answer",
          questionnaire_id: questionnaireId,
        });
    state.lastError = "";
    return response.answer;
  } catch (error) {
    if (isUnsupported(error)) {
      state.lastError = "AgentSH questionnaire answers unsupported by server";
      return undefined;
    }
    state.lastError = error instanceof Error ? error.message : String(error);
    return undefined;
  }
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
    if (state.mode === "central-rest") {
      await centralRequest<unknown>(
        state,
        "POST",
        `/api/v1/detached-sessions/${encodeURIComponent(state.sessionId)}/session-events`,
        event,
      );
    } else if (state.mode === "rest") {
      await restRequest<unknown>(
        state,
        "POST",
        `/api/v1/sessions/${encodeURIComponent(state.sessionId)}/session-events`,
        event,
      );
    } else {
      await uiRequest<unknown>(state, { op: "publish_event", event });
    }
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
      "  AGENTSH_SESSION_SUPERVISOR=unix://<AgentSH supervisor socket>",
      "or central push:",
      "  AGENTSH_SESSION_EVENT_URL=http://127.0.0.1:18080",
      "  AGENTSH_SESSION_EVENT_TOKEN=<per-session token>",
      "or legacy:",
      "  AGENTSH_APPROVAL_UI_SOCKET=<AgentSH peer-authorized UI socket>",
    ].join("\n");
  }
  return [
    "AgentSH session events are active.",
    "",
    `Session: ${state.sessionId}`,
    `Mode:    ${state.mode}`,
    `Socket:  ${state.socketPath || "-"}`,
    `Central: ${state.centralURL || "-"}`,
    state.lastError ? `Last error: ${state.lastError}` : "Last error: -",
  ].join("\n");
}

export default function agentEvents(pi: ExtensionAPI) {
  const state: EventState = {
    active: false,
    mode: "",
    sessionId: "",
    socketPath: "",
    centralURL: "",
    eventToken: "",
    lastError: "",
    lastPublishedAt: 0,
  };

  pi.on("session_start", async (_event, ctx) => {
    state.ctx = ctx;
    state.sessionId = getSessionId();
    state.socketPath = getSocketPath();
    state.centralURL = getCentralURL();
    state.eventToken = getEventToken();
    state.mode = getEventMode();
    state.lastError = "";
    state.active = Boolean(state.sessionId && state.mode && (state.mode === "central-rest" ? state.centralURL && state.eventToken : state.socketPath));
    globalThis.__PI_AGENTSH_PUBLISH_EVENT__ = (type, title, message, fields = {}) =>
      publishEvent(state, type, title, message, fields);
    globalThis.__PI_AGENTSH_GET_QUESTION_ANSWER__ = (questionnaireId) =>
      getQuestionAnswer(state, questionnaireId);
    setStatus(state, ctx);
  });

  pi.on("session_shutdown", async () => {
    if (state.ctx?.hasUI) state.ctx.ui.setStatus("agent-events", undefined);
    if (globalThis.__PI_AGENTSH_PUBLISH_EVENT__) {
      globalThis.__PI_AGENTSH_PUBLISH_EVENT__ = undefined;
    }
    if (globalThis.__PI_AGENTSH_GET_QUESTION_ANSWER__) {
      globalThis.__PI_AGENTSH_GET_QUESTION_ANSWER__ = undefined;
    }
    state.active = false;
    state.mode = "";
    state.centralURL = "";
    state.eventToken = "";
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

}
