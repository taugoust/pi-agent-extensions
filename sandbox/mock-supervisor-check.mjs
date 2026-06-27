#!/usr/bin/env node
/** Mock-driven protocol check for sandbox/mock-supervisor.mjs. */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const worktree = await mkdtemp("sandbox-mock-check-");
await writeFile(join(worktree, "file.txt"), "hello\nworld\n", "utf8");

const child = spawn(process.execPath, ["sandbox/mock-supervisor.mjs", "--stdio", "--worktree", worktree, "--fake-approval", "--approval-delay-ms", "1"], {
  stdio: ["pipe", "pipe", "inherit"],
});
child.stdout.setEncoding("utf8");
let buffer = "";
const waiters = new Map();
const eventWaiters = [];

function onMessage(message) {
  const waiter = message.id && waiters.get(message.id);
  if (waiter) {
    if (message.event) {
      waiter.events.push(message);
      return;
    }
    waiters.delete(message.id);
    if (message.ok === false) waiter.reject(new Error(message.error || "request failed"));
    else waiter.resolve({ result: message.result, events: waiter.events });
    return;
  }
  for (let i = 0; i < eventWaiters.length; i++) {
    const waiter = eventWaiters[i];
    if (waiter.predicate(message)) {
      eventWaiters.splice(i, 1);
      waiter.resolve(message);
      return;
    }
  }
}

child.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const nl = buffer.indexOf("\n");
    if (nl === -1) break;
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    onMessage(JSON.parse(line));
  }
});

let nextId = 1;
function request(op, params = {}) {
  const id = `check-${nextId++}`;
  return new Promise((resolve, reject) => {
    waiters.set(id, { resolve, reject, events: [] });
    child.stdin.write(JSON.stringify({ id, op, params }) + "\n");
  });
}

function waitEvent(predicate) {
  return new Promise((resolve) => eventWaiters.push({ predicate, resolve }));
}

try {
  const hello = await request("hello");
  if (!hello.result.metadata.session_id) throw new Error("hello missing metadata.session_id");

  const bash = await request("exec_bash", { command: "printf mock-bash" });
  if (!bash.events.some((event) => event.event === "stdout" && event.data.includes("mock-bash"))) throw new Error("exec_bash did not stream stdout");
  if (bash.result.exitCode !== 0) throw new Error("exec_bash non-zero exit");

  await request("write_file", { path: "file.txt", content: "alpha\nbeta\n" });
  const read = await request("read_file", { path: "file.txt", offset: 2, limit: 1 });
  if (read.result.text !== "beta") throw new Error(`read_file returned ${JSON.stringify(read.result.text)}`);

  const edit = await request("edit_file", { path: "file.txt", edits: [{ oldText: "beta", newText: "gamma" }] });
  if (!edit.result.text.includes("Edited")) throw new Error("edit_file missing Edited text");
  const readEdited = await request("read_file", { path: "file.txt" });
  if (!readEdited.result.text.includes("gamma")) throw new Error("edit_file did not change file");

  const subagent = await request("spawn_subagent", { task: "summarize mock state" });
  if (!subagent.result.final.includes("summarize mock state")) throw new Error("spawn_subagent final missing task");

  child.stdin.write(JSON.stringify({ id: "watch", op: "watch_approvals", params: { include_existing: true } }) + "\n");
  const approval = await waitEvent((message) => message.id === "watch" && message.event === "approval_pending");
  if (!approval.approval?.id) throw new Error("approval_pending missing approval.id");
  await request("resolve_approval", { approval_id: approval.approval.id, decision: "approve", scope: "once", reason: "mock check" });

  console.log("sandbox mock supervisor checks passed");
} finally {
  child.kill("SIGTERM");
  await rm(worktree, { recursive: true, force: true });
}
