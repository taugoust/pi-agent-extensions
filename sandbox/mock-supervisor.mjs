#!/usr/bin/env node
/**
 * Mock AgentSH session supervisor for sandbox extension development.
 *
 * Protocol: newline-delimited JSON over a Unix socket, plus --stdio for local
 * protocol checks in sandboxes that disallow Unix-socket listen/connect.
 */

import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";
import { promises as fs } from "node:fs";

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

const stdioMode = hasFlag("--stdio");
// Keep socket path exactly as provided; Unix socket path limits are small.
const socketPath = argValue("--socket", process.env.PI_AGENTSH_MOCK_SUPERVISOR || `/tmp/pi-agentsh-mock-${process.pid}.sock`);
const emitFakeApproval = hasFlag("--fake-approval") || process.env.PI_AGENTSH_MOCK_FAKE_APPROVAL === "1";
const approvalDelayMs = Number(argValue("--approval-delay-ms", process.env.PI_AGENTSH_MOCK_APPROVAL_DELAY_MS || "1000"));
const sessionId = argValue("--session-id", process.env.AGENTSH_SESSION_ID || `mock-session-${process.pid}`);
const worktree = resolve(argValue("--worktree", process.cwd()));

const watchers = new Set();
const approvals = new Map();
let fakeApprovalCreated = false;
let server;

function send(peer, message) {
  const line = JSON.stringify(message) + "\n";
  if (peer.write) peer.write(line);
  else if (!peer.destroyed) peer.socket.write(line);
}

function broadcast(message) {
  for (const watcher of [...watchers]) send(watcher.peer, { id: watcher.id, ...message });
}

function pathInWorktree(p) {
  if (typeof p !== "string" || !p) throw new Error("path is required");
  return isAbsolute(p) ? p : resolve(worktree, p);
}

function createFakeApproval() {
  if (fakeApprovalCreated) return;
  fakeApprovalCreated = true;
  const approval = {
    id: `approval-${Date.now()}`,
    session_id: sessionId,
    kind: "file",
    target: `${worktree}/.env`,
    rule: "mock-sensitive-read",
    message: "Mock supervisor fake approval_pending event",
    actor: { kind: "subagent", subagent_id: "mock-subagent", label: "mock approval demo" },
    fields: {
      scope_kind: "file",
      scope_key: `file:read:${worktree}/.env`,
    },
  };
  approvals.set(approval.id, approval);
  broadcast({ event: "approval_pending", approval });
}

function metadata() {
  return {
    session_id: sessionId,
    created_at: new Date().toISOString(),
    state: "active",
    policy: "mock-pi-autonomous",
    real_workspace: worktree,
    workspace_mode: "direct",
    worktree,
    supervisor_sock: stdioMode ? "stdio" : socketPath,
    owner_pid: process.pid,
    protocol_version: 1,
    mock: true,
    supported_ops: ["hello", "exec_bash", "read_file", "write_file", "edit_file", "spawn_subagent", "watch_approvals", "resolve_approval", "stop"],
  };
}

function handleHello(peer, id) {
  send(peer, { id, ok: true, result: { metadata: metadata(), supported_ops: metadata().supported_ops } });
}

function handleExecBash(peer, id, params = {}) {
  const command = typeof params.command === "string" ? params.command : "";
  const cwd = typeof params.cwd === "string" && params.cwd ? pathInWorktree(params.cwd) : worktree;
  const timeoutMs = typeof params.timeout_ms === "number" && params.timeout_ms > 0 ? params.timeout_ms : undefined;
  if (!command) return send(peer, { id, ok: false, error: "exec_bash requires params.command" });

  let timedOut = false;
  const child = spawn(process.env.SHELL || "bash", ["-lc", command], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let timer;
  if (timeoutMs) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref?.();
    }, timeoutMs);
  }
  child.stdout.on("data", (chunk) => send(peer, { id, event: "stdout", data: chunk.toString("utf8") }));
  child.stderr.on("data", (chunk) => send(peer, { id, event: "stderr", data: chunk.toString("utf8") }));
  child.on("error", (error) => { if (timer) clearTimeout(timer); send(peer, { id, ok: false, error: error.message }); });
  child.on("close", (code, signal) => {
    if (timer) clearTimeout(timer);
    send(peer, { id, ok: true, result: { exitCode: timedOut ? 124 : code, signal, timedOut, command, cwd } });
  });
}

async function handleReadFile(peer, id, params = {}) {
  const file = pathInWorktree(params.path);
  const text = await fs.readFile(file, "utf8");
  const lines = text.split(/\r?\n/);
  const offset = typeof params.offset === "number" && params.offset > 0 ? Math.floor(params.offset) : 1;
  const limit = typeof params.limit === "number" && params.limit >= 0 ? Math.floor(params.limit) : undefined;
  const selected = limit === undefined ? lines.slice(offset - 1) : lines.slice(offset - 1, offset - 1 + limit);
  send(peer, { id, ok: true, result: { path: params.path, text: selected.join("\n"), details: { totalLines: lines.length, offset, limit } } });
}

async function handleWriteFile(peer, id, params = {}) {
  if (typeof params.content !== "string") throw new Error("write_file requires params.content");
  const file = pathInWorktree(params.path);
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, params.content, "utf8");
  send(peer, { id, ok: true, result: { path: params.path, text: `Wrote ${params.path}`, bytes: Buffer.byteLength(params.content, "utf8") } });
}

function normalizeEdits(params) {
  if (Array.isArray(params.edits)) return params.edits;
  if (typeof params.oldText === "string" && typeof params.newText === "string") return [{ oldText: params.oldText, newText: params.newText }];
  throw new Error("edit_file requires params.edits or oldText/newText");
}

async function handleEditFile(peer, id, params = {}) {
  const file = pathInWorktree(params.path);
  const edits = normalizeEdits(params);
  let original = await fs.readFile(file, "utf8");
  let next = original;
  for (const edit of edits) {
    if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") throw new Error("each edit requires oldText and newText");
    const first = next.indexOf(edit.oldText);
    if (first === -1) throw new Error(`oldText not found in ${params.path}`);
    if (next.indexOf(edit.oldText, first + edit.oldText.length) !== -1) throw new Error(`oldText is not unique in ${params.path}`);
    next = next.slice(0, first) + edit.newText + next.slice(first + edit.oldText.length);
  }
  await fs.writeFile(file, next, "utf8");
  const diff = [
    `--- ${params.path}`,
    `+++ ${params.path}`,
    `@@ mock edit (${edits.length} replacement${edits.length === 1 ? "" : "s"}) @@`,
  ].join("\n");
  send(peer, { id, ok: true, result: { path: params.path, text: `Edited ${params.path}`, diff, details: { diff } } });
}

async function handleSpawnSubagent(peer, id, params = {}) {
  const task = typeof params.task === "string" ? params.task : Array.isArray(params.tasks) ? `${params.tasks.length} parallel mock tasks` : Array.isArray(params.chain) ? `${params.chain.length} mock chain steps` : "mock subagent";
  send(peer, { id, event: "subagent_update", data: `mock subagent started: ${task}\n` });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const final = `Mock subagent completed: ${task}`;
  send(peer, { id, event: "message", data: final });
  send(peer, { id, ok: true, result: { final, text: final, exitCode: 0, mock: true, task, params } });
}

function handleWatchApprovals(peer, id, params = {}) {
  const watcher = { peer, id };
  watchers.add(watcher);
  if (peer.onClose) peer.onClose(() => watchers.delete(watcher));
  if (params.include_existing !== false) {
    for (const approval of approvals.values()) send(peer, { id, event: "approval_pending", approval });
  }
  if (emitFakeApproval && !fakeApprovalCreated) setTimeout(createFakeApproval, approvalDelayMs).unref?.();
}

function handleResolveApproval(peer, id, params = {}) {
  const approvalId = typeof params.approval_id === "string" ? params.approval_id : typeof params.id === "string" ? params.id : "";
  if (!approvalId || !approvals.has(approvalId)) return send(peer, { id, ok: false, error: `approval not found: ${approvalId || "<missing>"}` });
  const approval = approvals.get(approvalId);
  approvals.delete(approvalId);
  send(peer, { id, ok: true, result: { approval_id: approvalId, resolved: true, decision: params.decision, scope: params.scope || "once", approval } });
}

async function handleMessage(peer, message) {
  const id = typeof message.id === "string" ? message.id : `server-${Date.now()}`;
  const params = message.params || {};
  try {
    switch (message.op) {
      case "hello": return handleHello(peer, id);
      case "exec_bash": return handleExecBash(peer, id, params);
      case "read_file": return await handleReadFile(peer, id, params);
      case "write_file": return await handleWriteFile(peer, id, params);
      case "edit_file": return await handleEditFile(peer, id, params);
      case "spawn_subagent": return await handleSpawnSubagent(peer, id, params);
      case "watch_approvals": return handleWatchApprovals(peer, id, params);
      case "resolve_approval": return handleResolveApproval(peer, id, params);
      case "stop":
        send(peer, { id, ok: true, result: { stopping: true } });
        setTimeout(() => process.exit(0), 10).unref?.();
        return;
      default: return send(peer, { id, ok: false, error: `unsupported op: ${message.op}` });
    }
  } catch (error) {
    send(peer, { id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function attachLineReader(input, peer) {
  input.setEncoding("utf8");
  let buffer = "";
  input.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl === -1) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        void handleMessage(peer, JSON.parse(line));
      } catch (error) {
        send(peer, { id: "parse-error", ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
  });
}

if (stdioMode) {
  const closeHandlers = new Set();
  const peer = { write: (line) => process.stdout.write(line), onClose: (fn) => closeHandlers.add(fn) };
  process.stdin.on("close", () => closeHandlers.forEach((fn) => fn()));
  attachLineReader(process.stdin, peer);
  if (emitFakeApproval) setTimeout(createFakeApproval, approvalDelayMs).unref?.();
} else {
  mkdirSync(dirname(socketPath), { recursive: true });
  if (existsSync(socketPath)) unlinkSync(socketPath);
  server = createServer((socket) => {
    const closeHandlers = new Set();
    const peer = { socket, write: (line) => { if (!socket.destroyed) socket.write(line); }, onClose: (fn) => closeHandlers.add(fn) };
    socket.on("close", () => closeHandlers.forEach((fn) => fn()));
    socket.on("end", () => closeHandlers.forEach((fn) => fn()));
    attachLineReader(socket, peer);
  });
  server.on("error", (error) => {
    console.error(`[mock-supervisor] listen failed for ${socketPath}: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(socketPath, () => {
    console.log(JSON.stringify({ ok: true, socket: socketPath, session_id: sessionId, protocol_version: 1 }));
    console.error(`[mock-supervisor] listening on ${socketPath}`);
    console.error(`[mock-supervisor] worktree ${worktree}`);
    if (emitFakeApproval) console.error(`[mock-supervisor] fake approval will emit after watch_approvals (${approvalDelayMs}ms)`);
  });
}

function shutdown() {
  if (server) {
    server.close(() => {
      try { if (existsSync(socketPath)) unlinkSync(socketPath); } catch { /* best effort */ }
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
  setTimeout(() => process.exit(0), 500).unref?.();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
