/**
 * Sandbox Extension v1 — AgentSH approval relay UI.
 *
 * This test version intentionally does not enforce policy locally. AgentSH owns
 * enforcement and approval state. The extension only polls pending approvals,
 * asks the user, and relays the selected decision back to AgentSH.
 */

import { closeSync, readFileSync } from "node:fs";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

type ApprovalRequest = {
  id: string;
  created_at?: string;
  expires_at?: string;
  session_id?: string;
  command_id?: string;
  kind?: string;
  target?: string;
  rule?: string;
  message?: string;
  fields?: Record<string, unknown>;
};

type RelayStatus = "inactive" | "connected" | "pending" | "error";

type RelayState = {
  active: boolean;
  sessionId: string;
  server: string;
  apiKey: string;
  status: RelayStatus;
  lastError: string;
  pendingCount: number;
  seen: Set<string>;
  resolving: Set<string>;
  promptChain: Promise<void>;
  pollTimer?: ReturnType<typeof setInterval>;
  ctx?: ExtensionContext;
};

const POLL_INTERVAL_MS = Number(process.env.AGENTSH_APPROVAL_POLL_MS || "1500");

function env(name: string) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : "";
}

function normalizeServer(raw: string) {
  const value = raw || "http://127.0.0.1:18080";
  return value.replace(/\/+$/, "");
}

function getSessionId() {
  return env("AGENTSH_SESSION_ID") || env("PI_AUTO_SESSION_ID") || "";
}

function getServer() {
  return normalizeServer(env("AGENTSH_SERVER") || env("AGENTSH_API_URL") || env("AGENTSH_BASE_URL"));
}

function readSecretFromFd(rawFd: string) {
  if (!rawFd) return "";
  if (!/^\d+$/.test(rawFd)) return "";

  const fd = Number(rawFd);
  if (!Number.isSafeInteger(fd) || fd < 3) return "";

  try {
    return readFileSync(fd, "utf8").trim();
  } catch {
    return "";
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Ignore close errors; the fd may already be closed or invalid.
    }
  }
}

function getApproverKey() {
  // Deliberately do not fall back to AGENTSH_API_KEY. pi-auto normally uses an
  // agent key there, and the extension must not let the agent self-approve.
  // Preferred v1 transport: pi-auto passes only an inherited fd number in env;
  // the actual key is read once from that fd and the fd is immediately closed.
  const keyFd =
    env("AGENTSH_APPROVER_API_KEY_FD") ||
    env("AGENTSH_APPROVAL_API_KEY_FD") ||
    env("AGENTSH_APPROVAL_UI_TOKEN_FD");
  const key = env("AGENTSH_APPROVER_API_KEY") || env("AGENTSH_APPROVAL_API_KEY");
  const keyFile = env("AGENTSH_APPROVER_API_KEY_FILE") || env("AGENTSH_APPROVAL_API_KEY_FILE");

  // Best-effort: do not let future child processes inherit approval credentials
  // or credential-locator env vars. The fd path is preferable because env only
  // contains a non-secret fd number, not the key itself.
  delete process.env.AGENTSH_APPROVER_API_KEY_FD;
  delete process.env.AGENTSH_APPROVAL_API_KEY_FD;
  delete process.env.AGENTSH_APPROVAL_UI_TOKEN_FD;
  delete process.env.AGENTSH_APPROVER_API_KEY;
  delete process.env.AGENTSH_APPROVAL_API_KEY;
  delete process.env.AGENTSH_APPROVER_API_KEY_FILE;
  delete process.env.AGENTSH_APPROVAL_API_KEY_FILE;

  const fdKey = readSecretFromFd(keyFd);
  if (fdKey) return fdKey;
  if (key) return key;
  if (keyFile) {
    try {
      return readFileSync(keyFile, "utf8").trim();
    } catch {
      return "";
    }
  }
  return "";
}

function truncate(text: string, max = 1200) {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function approvalTitle(a: ApprovalRequest) {
  const kind = a.kind || "approval";
  const target = a.target || a.command_id || a.id;
  return `${kind}: ${target}`;
}

function formatApproval(a: ApprovalRequest) {
  const lines = [
    "AgentSH approval requested",
    "",
    `ID:      ${a.id}`,
    `Kind:    ${a.kind || "unknown"}`,
    `Target:  ${a.target || "-"}`,
    `Rule:    ${a.rule || "-"}`,
    `Message: ${a.message || "-"}`,
  ];
  if (a.command_id) lines.push(`Command: ${a.command_id}`);
  if (a.expires_at) lines.push(`Expires: ${a.expires_at}`);
  if (a.fields && Object.keys(a.fields).length > 0) {
    lines.push("", "Fields:", truncate(JSON.stringify(a.fields, null, 2), 2000));
  }
  return lines.join("\n");
}

function setStatus(state: RelayState, ctx = state.ctx) {
  if (!ctx?.hasUI) return;
  const theme = ctx.ui.theme;
  if (!state.active) {
    ctx.ui.setStatus("sandbox", theme.fg("muted", "agentsh inactive"));
    return;
  }
  if (state.status === "error") {
    ctx.ui.setStatus("sandbox", theme.fg("error", "agentsh ✗"));
    return;
  }
  if (state.pendingCount > 0) {
    ctx.ui.setStatus("sandbox", theme.fg("warning", `agentsh ? ${state.pendingCount}`));
    return;
  }
  ctx.ui.setStatus("sandbox", theme.fg("success", "agentsh ✓"));
}

function notify(ctx: ExtensionContext | undefined, message: string, level: "info" | "warning" | "error" = "info") {
  if (!ctx?.hasUI) return;
  ctx.ui.notify(message, level);
}

async function api<T>(state: RelayState, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${state.server}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-api-key": state.apiKey,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    let body = "";
    try { body = await res.text(); } catch {}
    throw new Error(`AgentSH API ${res.status} ${res.statusText}${body ? `: ${body}` : ""}`);
  }
  if (res.status === 204) return undefined as T;
  return await res.json() as T;
}

async function listApprovals(state: RelayState) {
  const all = await api<ApprovalRequest[]>(state, "/api/v1/approvals");
  return all.filter((a) => a.session_id === state.sessionId);
}

async function resolveApproval(state: RelayState, id: string, approve: boolean, reason: string) {
  await api<unknown>(state, `/api/v1/approvals/${encodeURIComponent(id)}`, {
    method: "POST",
    body: JSON.stringify({ decision: approve ? "approve" : "deny", reason }),
  });
}

async function promptApproval(state: RelayState, approval: ApprovalRequest) {
  const ctx = state.ctx;
  if (!ctx?.hasUI) return;
  if (state.resolving.has(approval.id)) return;
  state.resolving.add(approval.id);
  try {
    const detail = formatApproval(approval);
    const choice = await ctx.ui.select(detail, [
      `Approve ${approvalTitle(approval)}`,
      `Deny ${approvalTitle(approval)}`,
    ]);
    const approve = choice.startsWith("Approve");
    await resolveApproval(state, approval.id, approve, approve ? "approved in Pi" : "denied in Pi");
    state.seen.add(approval.id);
    notify(ctx, `${approve ? "Approved" : "Denied"}: ${approvalTitle(approval)}`, approve ? "info" : "warning");
  } catch (error) {
    state.status = "error";
    state.lastError = error instanceof Error ? error.message : String(error);
    notify(ctx, `AgentSH approval relay failed: ${state.lastError}`, "error");
  } finally {
    state.resolving.delete(approval.id);
    setStatus(state);
  }
}

function enqueuePrompt(state: RelayState, approval: ApprovalRequest) {
  state.promptChain = state.promptChain
    .catch(() => undefined)
    .then(() => promptApproval(state, approval));
}

async function poll(state: RelayState) {
  if (!state.active) return;
  try {
    const approvals = await listApprovals(state);
    state.pendingCount = approvals.length;
    state.status = approvals.length > 0 ? "pending" : "connected";
    state.lastError = "";
    setStatus(state);

    for (const approval of approvals) {
      if (state.seen.has(approval.id) || state.resolving.has(approval.id)) continue;
      enqueuePrompt(state, approval);
    }
  } catch (error) {
    state.pendingCount = 0;
    state.status = "error";
    state.lastError = error instanceof Error ? error.message : String(error);
    setStatus(state);
  }
}

function helpText(state: RelayState) {
  if (!state.active) {
    return [
      "AgentSH approval relay is inactive.",
      "",
      "Required environment:",
      "  AGENTSH_SESSION_ID=<session>",
      "  AGENTSH_APPROVER_API_KEY_FD=<fd containing approver/admin key>",
      "Optional/test fallback:",
      "  AGENTSH_APPROVER_API_KEY=<approver/admin key>",
      "  AGENTSH_SERVER=http://127.0.0.1:18080",
    ].join("\n");
  }
  return [
    "AgentSH approval relay is active.",
    "",
    `Session: ${state.sessionId}`,
    `Server:  ${state.server}`,
    `Status:  ${state.status}`,
    `Pending: ${state.pendingCount}`,
    state.lastError ? `Error:   ${state.lastError}` : "",
  ].filter(Boolean).join("\n");
}

function grantGuidance(kind: string, target: string, reason: string, state: RelayState) {
  const active = state.active ? `active for session ${state.sessionId}` : "inactive (missing AgentSH session/key env)";
  return [
    `AgentSH owns ${kind} grants; this extension does not mutate local sandbox policy.`,
    `Relay status: ${active}`,
    target ? `Target: ${target}` : "",
    reason ? `Reason: ${reason}` : "",
    "",
    "Retry the blocked operation. If AgentSH policy requires approval, this extension will prompt the user and relay approve/deny back to AgentSH.",
  ].filter(Boolean).join("\n");
}

export default function sandbox(pi: ExtensionAPI) {
  const state: RelayState = {
    active: false,
    sessionId: "",
    server: getServer(),
    apiKey: "",
    status: "inactive",
    lastError: "",
    pendingCount: 0,
    seen: new Set(),
    resolving: new Set(),
    promptChain: Promise.resolve(),
  };

  pi.on("session_start", async (_event, ctx) => {
    state.ctx = ctx;
    state.sessionId = getSessionId();
    state.server = getServer();
    state.apiKey = getApproverKey();
    state.seen.clear();
    state.resolving.clear();
    state.pendingCount = 0;
    state.lastError = "";

    if (state.pollTimer) clearInterval(state.pollTimer);

    if (!state.sessionId || !state.apiKey) {
      state.active = false;
      state.status = "inactive";
      setStatus(state, ctx);
      notify(ctx, "AgentSH approval relay inactive: AGENTSH_SESSION_ID or approval key fd/key missing", "warning");
      return;
    }

    state.active = true;
    state.status = "connected";
    setStatus(state, ctx);
    notify(ctx, `AgentSH approval relay active for ${state.sessionId}`, "info");
    await poll(state);
    state.pollTimer = setInterval(() => { void poll(state); }, POLL_INTERVAL_MS);
  });

  pi.on("session_shutdown", async () => {
    state.active = false;
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = undefined;
    if (state.ctx?.hasUI) state.ctx.ui.setStatus("sandbox", undefined);
    state.ctx = undefined;
  });

  pi.registerCommand("sandbox", {
    description: "Show AgentSH approval relay status",
    handler: async (_args, ctx) => {
      notify(ctx, helpText(state), state.status === "error" ? "error" : "info");
    },
  });

  pi.registerCommand("sandbox-control", {
    description: "Show AgentSH relay help; enforcement is controlled by AgentSH",
    handler: async (_args, ctx) => {
      notify(ctx, "Sandbox enforcement is controlled by AgentSH. This Pi extension can only relay approval decisions.\n\n" + helpText(state), "info");
    },
  });

  pi.registerCommand("sandbox-allow", {
    description: "Explain AgentSH grant flow for a target path/domain",
    handler: async (args, ctx) => {
      notify(ctx, grantGuidance("access", args?.trim?.() || "", "manual request", state), "info");
    },
  });

  pi.registerTool({
    name: "sandbox_allow_path",
    label: "Request AgentSH write approval",
    description: "Request write access guidance. AgentSH owns enforcement; retry the blocked operation to trigger an approval prompt.",
    parameters: Type.Object({
      path: Type.String({ description: "The filesystem path to allow write access to" }),
      reason: Type.String({ description: "Why write access is needed" }),
    }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: grantGuidance("write", params.path, params.reason, state) }] };
    },
  });

  pi.registerTool({
    name: "sandbox_allow_read_path",
    label: "Request AgentSH read approval",
    description: "Request read access guidance. AgentSH owns enforcement; retry the blocked operation to trigger an approval prompt.",
    parameters: Type.Object({
      path: Type.String({ description: "The filesystem path to allow read access to" }),
      reason: Type.String({ description: "Why read access is needed" }),
    }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: grantGuidance("read", params.path, params.reason, state) }] };
    },
  });

  pi.registerTool({
    name: "sandbox_allow_domain",
    label: "Request AgentSH network approval",
    description: "Request network access guidance. AgentSH owns enforcement; retry the blocked operation to trigger an approval prompt.",
    parameters: Type.Object({
      domain: Type.String({ description: "The domain to allow" }),
      reason: Type.String({ description: "Why network access is needed" }),
    }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: grantGuidance("network", params.domain, params.reason, state) }] };
    },
  });

  pi.registerTool({
    name: "sandbox_allow_unix_socket",
    label: "Request AgentSH Unix socket approval",
    description: "Request Unix socket access guidance. AgentSH owns enforcement; retry the blocked operation to trigger an approval prompt.",
    parameters: Type.Object({
      path: Type.String({ description: "The unix socket path to allow" }),
      reason: Type.String({ description: "Why socket access is needed" }),
    }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: grantGuidance("unix socket", params.path, params.reason, state) }] };
    },
  });
}
