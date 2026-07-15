import assert from "node:assert/strict";
import { boundSubagentProgressCapsules, createSubagentProgressCapsule, MAX_SUBAGENT_CAPSULE_BYTES } from "./subagent-result.js";
import { appendSubagentStdoutChunk, createSubagentStreamState } from "./subagent-stream.js";

function line(event: unknown): string {
  return `${JSON.stringify(event)}\n`;
}

{
  const state = createSubagentStreamState({ label: "bounded", task: "x".repeat(10_000) });
  for (let index = 0; index < 24; index++) {
    const toolName = index % 3 === 0 ? "read" : index % 3 === 1 ? "write" : "bash";
    const args = toolName === "bash" ? { command: `echo authorization=secret-${index}` } : { path: `/workspace/${"p".repeat(100)}/${index}` };
    appendSubagentStdoutChunk(state, line({ type: "tool_execution_start", toolName, args }));
    appendSubagentStdoutChunk(state, line({ type: "tool_execution_end", toolName, args, isError: index === 23, result: { content: [{ type: "text", text: `result ${index} authorization=secret-value ${"z".repeat(1000)}` }] } }));
  }
  appendSubagentStdoutChunk(state, line({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hidden-reasoning-sentinel" },
        { type: "text", text: `visible ${"v".repeat(6000)}` },
      ],
    },
  }));
  state.stderr = "e".repeat(20_000);
  state.exitCode = 124;
  state.stopReason = "timeout";
  state.terminal = {
    state: "timed_out",
    failureKind: "process",
    cancellationCause: "request_timeout",
    exitCode: 124,
    termination: "forced",
    retryable: true,
    message: "authorization=terminal-secret timed out",
  };

  const capsule = createSubagentProgressCapsule(state);
  const serialized = JSON.stringify(capsule);
  assert.ok(Buffer.byteLength(serialized, "utf8") <= MAX_SUBAGENT_CAPSULE_BYTES, "capsule exceeded its global byte bound");
  assert.equal(capsule.completedTools.length <= 8, true);
  assert.equal(capsule.readFiles.length <= 16, true);
  assert.equal(capsule.modifiedFiles.length <= 16, true);
  assert.equal(capsule.terminal?.state, "timed_out");
  assert.equal(serialized.includes("hidden-reasoning-sentinel"), false);
  assert.equal(serialized.includes("terminal-secret"), false);
  assert.equal(serialized.includes("secret-value"), false);
  assert.equal(serialized.includes("authorization=secret-"), false);
  assert.equal(serialized.includes("echo authorization=[redacted]"), true);
}

{
  const capsules = Array.from({ length: 8 }, (_, index) => createSubagentProgressCapsule({
    label: `parallel ${index}`,
    task: "task".repeat(1000),
    exitCode: index === 7 ? 1 : 0,
    stopReason: index === 7 ? "error" : "completed",
    final: "answer".repeat(1000),
    errorMessage: index === 7 ? "failure".repeat(1000) : undefined,
    stderr: "stderr".repeat(1000),
    readFiles: Array.from({ length: 32 }, (_, pathIndex) => `/workspace/read/${index}/${pathIndex}`),
    modifiedFiles: Array.from({ length: 32 }, (_, pathIndex) => `/workspace/write/${index}/${pathIndex}`),
  }));
  const bounded = boundSubagentProgressCapsules(capsules);
  assert.equal(bounded.length, 8, "parallel siblings were dropped while bounding details");
  assert.ok(Buffer.byteLength(JSON.stringify({ results: bounded }), "utf8") <= MAX_SUBAGENT_CAPSULE_BYTES, "parallel capsule collection exceeded its global byte bound");
}

{
  const fullResultPath = "/remote/session/tmp/output-artifacts/subagent-result.md";
  const capsules = Array.from({ length: 8 }, (_, index) => createSubagentProgressCapsule({
    label: `artifact ${index}`,
    task: "large task ".repeat(1000),
    exitCode: 0,
    stopReason: "completed",
    final: "answer ".repeat(1000),
    fullResultPath: `${fullResultPath}-${index}`,
    finalTruncated: true,
    finalTotalBytes: 8192,
    finalInlineBytes: 4096,
    artifactBytes: 8192,
    artifactComplete: true,
  }));
  const bounded = boundSubagentProgressCapsules(capsules, 4 * 1024);
  assert.equal(bounded.length, 8);
  for (let index = 0; index < bounded.length; index++) {
    assert.equal(bounded[index].fullResultPath, `${fullResultPath}-${index}`, "artifact path was lost during capsule bounding");
    assert.equal(bounded[index].artifactComplete, true);
    assert.equal(bounded[index].finalTotalBytes, 8192);
  }
}

{
  const capsule = createSubagentProgressCapsule({
    label: "terminal-controls",
    exitCode: 1,
    stopReason: "error",
    final: "\u001b[31mvisible final\u001b[0m",
    errorMessage: "\u001bP$q q\u001b\\visible error\u001b[6 q",
    terminal: { state: "failed", failure_kind: "protocol", retryable: true, message: "\u001b[31mvisible terminal\u001b[0m" },
    completedTools: [{ name: "bash", args: { command: "\u001b[31mecho API_KEY=completed-secret\u001b[0m" }, isError: false }],
  });
  assert.equal(capsule.final, "visible final");
  assert.equal(capsule.errorMessage, "visible error");
  assert.equal(capsule.terminal?.message, "visible terminal");
  assert.deepEqual(capsule.completedTools[0].args, { command: "echo API_KEY=[redacted]" });
  assert.equal(JSON.stringify(capsule).includes("completed-secret"), false);
  assert.equal(JSON.stringify(capsule).includes("\u001b"), false);
}

{
  const secret = "capsule-tool-argument-secret";
  const capsule = createSubagentProgressCapsule({
    label: "known-tool-args",
    exitCode: -1,
    stopReason: "running",
    toolStatus: "[running grep]",
    lastToolCall: { name: "grep", args: { pattern: "needle", path: "/workspace", authorization: secret } },
    messages: [{
      role: "assistant",
      content: [
        { type: "toolCall", name: "find", arguments: { pattern: "**/*.ts", path: "/workspace", limit: 1000, password: secret } },
        { type: "toolCall", name: "custom", arguments: { path: "/workspace", password: secret } },
      ],
    }],
    completedTools: [
      { name: "ls", args: { path: "/workspace/\u001b[31msrc\u001b[0m", limit: 500, ignored: secret }, isError: false },
      { name: "find", args: { pattern: "**/*.ts", path: "/workspace", limit: 1000, ignored: secret }, isError: false },
      { name: "grep", args: { pattern: "password=credential", path: "/workspace", glob: "*.ts", ignoreCase: true, context: 2, limit: 100, ignored: secret }, isError: true },
      { name: "custom", args: { path: "/workspace", password: secret }, isError: false },
    ],
  });
  assert.deepEqual(capsule.activeTool, { name: "grep", args: { pattern: "needle", path: "/workspace" } });
  assert.deepEqual(capsule.completedTools.map((tool) => ({ name: tool.name, args: tool.args })), [
    { name: "ls", args: { path: "/workspace/src", limit: 500 } },
    { name: "find", args: { pattern: "**/*.ts", path: "/workspace", limit: 1000 } },
    { name: "grep", args: { pattern: "password=[redacted]", path: "/workspace", glob: "*.ts", ignoreCase: true, context: 2, limit: 100 } },
    { name: "custom", args: {} },
  ]);
  assert.deepEqual(capsule.messages[0].content, [
    { type: "toolCall", name: "find", arguments: { pattern: "**/*.ts", path: "/workspace", limit: 1000 } },
    { type: "toolCall", name: "custom", arguments: {} },
  ]);
  assert.equal(JSON.stringify(capsule).includes(secret), false);
  assert.equal(JSON.stringify(capsule).includes("credential"), false);
  assert.equal(JSON.stringify(capsule).includes("\u001b"), false);
}

{
  const capsule = createSubagentProgressCapsule({
    label: "latest-tool-use",
    exitCode: 1,
    stopReason: "error",
    modelStopReason: "toolUse",
    protocolSettled: true,
    messages: [
      { role: "assistant", content: [{ type: "text", text: "stale earlier text" }], stopReason: "stop" },
      { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "/tmp/x" } }], stopReason: "toolUse" },
    ],
  });
  assert.equal(capsule.lastAssistantText, undefined, "an earlier assistant message was misreported as the latest final text");
  assert.equal(capsule.modelStopReason, "toolUse");
}

{
  const state = createSubagentStreamState({ label: "snapshot" });
  appendSubagentStdoutChunk(state, line({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "stable" }] } }));
  const capsule = createSubagentProgressCapsule(state);
  (capsule.messages[0].content[0] as any).text = "mutated";
  assert.equal(state.messages[0].content[0].text, "stable");
}

console.log("sandbox subagent progress capsule checks passed");
