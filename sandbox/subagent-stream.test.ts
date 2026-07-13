import assert from "node:assert/strict";
import {
  MAX_SUBAGENT_LINE_BYTES,
  appendSubagentStdoutChunk,
  appendUtf8LineChunk,
  createSubagentStreamState,
  flushSubagentStdout,
  flushUtf8LineChunk,
  parseSubagentPiJsonStdout,
  subagentLiveToolStatus,
  subagentStreamResult,
  type SubagentStreamState,
} from "./subagent-stream.js";

function line(event: unknown): string {
  return `${JSON.stringify(event)}\n`;
}

function assistant(text: string, extra: Record<string, unknown> = {}) {
  return { role: "assistant", content: [{ type: "text", text }], ...extra };
}

function newState(label = "child"): SubagentStreamState {
  return createSubagentStreamState({ label });
}

{
  const state = newState("success");
  const success = line({ type: "message_end", message: assistant("done", { model: "test/model", usage: { input: 3, output: 4, cacheRead: 1, cacheWrite: 2, cost: { total: 0.01 }, totalTokens: 7 } }) });
  appendSubagentStdoutChunk(state, success);
  assert.equal(state.liveText, "done");
  assert.equal(state.messages.length, 1);
  assert.equal(state.model, "test/model");
  assert.equal(state.usage.turns, 1);
  assert.equal(state.usage.input, 3);
  assert.equal(state.usage.output, 4);
  assert.equal(state.usage.contextTokens, 7);
  assert.equal(subagentStreamResult(state).stopReason, "running");
}

{
  const state = newState("split");
  const text = "hello 🌍 split";
  const encoded = Buffer.from(line({ type: "message_end", message: assistant(text) }), "utf8");
  const emojiOffset = encoded.indexOf(Buffer.from("🌍", "utf8"));
  assert.notEqual(emojiOffset, -1);
  appendSubagentStdoutChunk(state, encoded.subarray(0, 9));
  assert.equal(state.messages.length, 0, "partial JSON token should not parse before newline");
  appendSubagentStdoutChunk(state, encoded.subarray(9, emojiOffset + 1));
  assert.equal(state.messages.length, 0, "split UTF-8 sequence should remain buffered");
  appendSubagentStdoutChunk(state, encoded.subarray(emojiOffset + 1));
  assert.equal(state.messages.length, 1);
  assert.equal(state.liveText, text);
  assert.equal(state.stdoutBuffer, "");
}

{
  // The same byte-safe line helper is used by the production REST NDJSON client.
  const encoded = Buffer.from(`${JSON.stringify({ event: "stdout", data: "outer 🌍" })}\n${JSON.stringify({ event: "done", ok: true })}`, "utf8");
  const emojiOffset = encoded.indexOf(Buffer.from("🌍", "utf8"));
  let buffer = "";
  let decoder: TextDecoder | undefined;
  const lines: string[] = [];
  for (const chunk of [encoded.subarray(0, emojiOffset + 1), encoded.subarray(emojiOffset + 1, emojiOffset + 3), encoded.subarray(emojiOffset + 3)]) {
    const decoded = appendUtf8LineChunk(buffer, decoder, chunk);
    buffer = decoded.buffer;
    decoder = decoded.decoder;
    lines.push(...decoded.lines);
  }
  const flushed = flushUtf8LineChunk(buffer, decoder);
  lines.push(...flushed.lines);
  assert.equal((JSON.parse(lines[0]) as any).data, "outer 🌍");
  assert.equal((JSON.parse(lines[1]) as any).event, "done");
}

{
  const state = newState("multi");
  appendSubagentStdoutChunk(state, line({ type: "message_start", message: assistant("draft") }) + line({ type: "message_update", message: assistant("updated") }) + line({ type: "message_end", message: assistant("final") }));
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].content[0].text, "final");
  assert.equal(state.liveText, "final");
  assert.equal(state.activeMessageIndex, undefined);
}

{
  const state = newState("malformed");
  appendSubagentStdoutChunk(state, "not json\n");
  assert.equal(state.rawText, "not json\n");
  assert.equal(state.sawPiJsonStdout, false);
  appendSubagentStdoutChunk(state, line({ type: "message_end", message: assistant("valid") }));
  assert.equal(state.rawText, "not json\n");
  assert.equal(state.sawPiJsonStdout, true);
  assert.equal(state.liveText, "valid");

  const hiddenPayload = "unknown-event-payload-must-not-be-retained";
  appendSubagentStdoutChunk(state, line({ type: "provider_private_event", payload: hiddenPayload }));
  assert.equal(JSON.stringify(state).includes(hiddenPayload), false);
  assert.match(state.rawText, /unrecognized child event: provider_private_event/);
}

{
  const state = newState("terminal-controls");
  appendSubagentStdoutChunk(state, "\u001bP$q q\u001b\\\u001b[6 q\n");
  assert.equal(state.rawText, "");
  assert.equal(JSON.stringify(state).includes("\u001b"), false);
  assert.equal(state.protocolDiagnostics.at(-1)?.kind, "malformed_line");
  appendSubagentStdoutChunk(state, "\u001b[31mvisible raw text\u001b[0m\n");
  assert.equal(state.rawText, "visible raw text\n");
}

{
  const state = newState("tool-success");
  const secret = "live-command-secret-sentinel";
  const command = `echo visible-summary API_KEY=${secret}`;
  appendSubagentStdoutChunk(state, line({ type: "tool_execution_start", toolName: "bash", args: { command } }));
  assert.deepEqual(state.lastToolCall, { name: "bash", args: { command: "echo visible-summary API_KEY=[redacted]" } });
  assert.equal(state.toolStatus, "[running bash]");
  assert.match(subagentLiveToolStatus(state) ?? "", /^\[running bash\] \$ echo visible-summary API_KEY=\[redacted\]$/);
  assert.equal((subagentLiveToolStatus(state) ?? "").includes(secret), false);
  assert.equal(JSON.stringify(state).includes(secret), false);
  assert.equal(JSON.stringify(subagentStreamResult(state)).includes(secret), false);
  assert.equal(JSON.stringify(subagentStreamResult(state)).includes("echo visible-summary"), true);
  appendSubagentStdoutChunk(state, line({ type: "tool_execution_update", partialResult: { content: [{ type: "text", text: "o" }] } }));
  assert.equal(state.lastToolResult, "o");
  assert.match(subagentLiveToolStatus(state) ?? "", /echo visible-summary/);
  appendSubagentStdoutChunk(state, line({ type: "tool_execution_end", toolName: "bash", result: { content: [{ type: "text", text: "ok" }] } }));
  assert.equal(state.toolStatus, undefined);
  assert.equal(subagentLiveToolStatus(state), undefined);
  assert.equal(state.lastToolResult, "ok");
}

{
  const state = newState("tool-failure-recovery");
  appendSubagentStdoutChunk(state, line({ type: "tool_execution_start", toolName: "read", args: { path: "/missing", ignored: "not-parent-facing" } }));
  assert.deepEqual(state.lastToolCall, { name: "read", args: { path: "/missing" } });
  assert.equal(state.toolStatus, "[running read]");
  assert.equal(subagentLiveToolStatus(state), "[running read] read /missing");
  appendSubagentStdoutChunk(state, line({ type: "tool_execution_end", toolName: "read", isError: true, result: { content: [{ type: "text", text: "ENOENT" }] } }));
  assert.equal(state.toolStatus, undefined);
  assert.match(state.prefix, /\[tool failed: read\] ENOENT/);
  appendSubagentStdoutChunk(state, line({ type: "message_end", message: assistant("Recovered and final.", { stopReason: "completed" }) }));
  assert.equal(state.liveText, "Recovered and final.");
  assert.equal(state.stopReason, "completed");
  assert.equal(subagentStreamResult(state).messages.at(-1)?.content[0].text, "Recovered and final.");
}

{
  const state = newState("tool-failure-model-failure");
  appendSubagentStdoutChunk(state, line({ type: "tool_execution_end", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "exit 1" }] } }));
  appendSubagentStdoutChunk(state, line({ type: "message_end", message: assistant("", { stopReason: "error", errorMessage: "provider failed" }) }));
  assert.equal(state.stopReason, "error");
  assert.equal(state.errorMessage, "provider failed");
  assert.match(state.prefix, /tool failed/);
}

{
  const state = newState("flush");
  const incomplete = JSON.stringify({ type: "message_end", message: assistant("no trailing newline") });
  appendSubagentStdoutChunk(state, incomplete);
  assert.equal(state.messages.length, 0);
  assert.equal(state.stdoutBuffer, incomplete);
  flushSubagentStdout(state);
  assert.equal(state.stdoutBuffer, "");
  assert.equal(state.liveText, "no trailing newline");
  assert.equal(state.messages.length, 1);
}

{
  const state = newState("thinking");
  const hidden = "hidden-chain-sentinel";
  appendSubagentStdoutChunk(state, line({
    type: "message_end",
    message: {
      role: "assistant",
      responseId: "private-provider-id",
      content: [
        { type: "thinking", thinking: hidden, text: hidden },
        { type: "reasoning", text: hidden },
        { type: "text", text: "visible answer" },
      ],
    },
  }));
  assert.equal(state.liveText, "visible answer");
  assert.deepEqual(state.messages[0].content, [{ type: "text", text: "visible answer" }]);
  assert.equal(JSON.stringify(state).includes(hidden), false);
  assert.equal(JSON.stringify(subagentStreamResult(state)).includes(hidden), false);
  assert.equal(JSON.stringify(subagentStreamResult(state)).includes("private-provider-id"), false);
}

{
  const state = newState("compaction");
  appendSubagentStdoutChunk(state, line({ type: "compaction_start", reason: "threshold" }));
  assert.equal(state.compaction?.active, true);
  assert.equal(state.compaction?.reason, "threshold");
  assert.equal(state.compaction?.count, 1);
  assert.equal(state.lastEvent?.type, "compaction_start");
  appendSubagentStdoutChunk(state, line({
    type: "compaction_end",
    reason: "threshold",
    result: {
      summary: "private compaction summary",
      firstKeptEntryId: "private-entry-id",
      details: { arbitrary: "private-details" },
      tokensBefore: 100,
      estimatedTokensAfter: 25,
    },
    aborted: false,
    willRetry: true,
  }));
  assert.equal(state.compaction?.active, false);
  assert.deepEqual(state.compaction?.lastResult, { tokensBefore: 100, estimatedTokensAfter: 25 });
  assert.equal(state.compaction?.aborted, false);
  assert.equal(state.compaction?.willRetry, true);
  assert.equal(state.compaction?.events.length, 2);
  const serialized = JSON.stringify(subagentStreamResult(state));
  assert.equal(serialized.includes("private compaction summary"), false);
  assert.equal(serialized.includes("private-entry-id"), false);
  assert.equal(serialized.includes("private-details"), false);
}

{
  const state = newState("failed-compaction");
  for (let index = 0; index < 20; index++) {
    appendSubagentStdoutChunk(state, line({ type: "compaction_start", reason: "overflow" }));
  }
  appendSubagentStdoutChunk(state, line({ type: "compaction_end", reason: "overflow", aborted: true, willRetry: false, errorMessage: "authorization=secret-value failed" }));
  assert.equal(state.compaction?.count, 20);
  assert.equal(state.compaction?.events.length, 16);
  assert.equal(state.compaction?.aborted, true);
  assert.equal(state.compaction?.willRetry, false);
  assert.equal(state.compaction?.errorMessage?.includes("secret-value"), false);
}

{
  const state = newState("bounded-line");
  appendSubagentStdoutChunk(state, "x".repeat(MAX_SUBAGENT_LINE_BYTES + 1));
  assert.equal(state.stdoutBuffer, "");
  assert.equal(state.stdoutDiscardingOversizeLine, true);
  appendSubagentStdoutChunk(state, `discarded tail\n${line({ type: "message_end", message: assistant("after oversized line") })}`);
  assert.equal(state.stdoutDiscardingOversizeLine, false);
  assert.equal(state.liveText, "after oversized line");
  assert.ok(Buffer.byteLength(state.rawText) < MAX_SUBAGENT_LINE_BYTES);
}

{
  const state = newState("snapshot");
  appendSubagentStdoutChunk(state, line({ type: "message_end", message: assistant("stable") }));
  const result = subagentStreamResult(state);
  (result.messages[0].content[0] as any).text = "mutated snapshot";
  result.usage.input = 999;
  assert.equal(state.messages[0].content[0].text, "stable");
  assert.equal(state.usage.input, 0);
}

{
  const parsed = parseSubagentPiJsonStdout(line({ type: "compaction_start", reason: "overflow" }) + line({ type: "message_end", message: assistant("after compact") }));
  assert.equal(parsed.compaction?.active, true);
  assert.equal(parsed.messages.at(-1)?.content[0].text, "after compact");
}

console.log("sandbox subagent stream parser checks passed");
