import assert from "node:assert/strict";
import { DEFAULT_MAX_LINES, formatSize } from "@mariozechner/pi-coding-agent";
import { Box } from "@mariozechner/pi-tui";
import * as presentationModule from "./tool-result-presentation.js";
import {
  contentFromReadResult,
  renderSandboxEditToolCall,
  renderSandboxEditToolResult,
  textFromResult,
} from "./tool-result-presentation.js";

assert.deepEqual(Object.keys(presentationModule).sort(), [
  "contentFromReadResult",
  "renderSandboxEditToolCall",
  "renderSandboxEditToolResult",
  "textFromResult",
]);

// Supervised responses retain their existing text-field precedence, including
// filtering empty/non-text content parts before joining them.
{
  assert.equal(textFromResult("direct", "fallback"), "direct");
  assert.equal(textFromResult({ text: "text field", content: "content field" }), "text field");
  assert.equal(textFromResult({ content: "content field" }), "content field");
  assert.equal(textFromResult({ content: [{ text: "first" }, { text: "" }, {}, { text: "second" }] }), "first\nsecond");
  assert.equal(textFromResult(undefined, "fallback"), "fallback");
}

// Existing content arrays and image envelopes pass through without being
// converted to text.
{
  const content = [{ type: "text", text: "already shaped" }];
  assert.equal(contentFromReadResult({ content }), content);
  assert.deepEqual(contentFromReadResult({ base64: "aGVsbG8=", mimeType: "image/png" }), [{
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
  }]);
}

// Remote paging metadata and the local line bound produce the same continuation
// notices consumed by the model.
{
  assert.deepEqual(contentFromReadResult({
    text: "alpha\nbeta",
    truncated: true,
    start_line: 4,
    end_line: 5,
    next_offset: 6,
  }), [{ type: "text", text: "alpha\nbeta\n\n[Showing lines 4-5. Use offset=6 to continue.]" }]);

  assert.deepEqual(contentFromReadResult({ text: "alpha\nbeta", truncated: true }), [{
    type: "text",
    text: "alpha\nbeta\n\n[Showing lines 1-2. Use offset=3 to continue.]",
  }]);

  const sourceLines = Array.from({ length: DEFAULT_MAX_LINES + 1 }, (_, index) => `line-${index}`);
  const [{ text }] = contentFromReadResult({ text: sourceLines.join("\n") });
  assert.ok(text.startsWith("line-0\nline-1\n"));
  assert.ok(!text.includes(`line-${DEFAULT_MAX_LINES}`));
  assert.ok(text.endsWith(`[Showing lines 1-${DEFAULT_MAX_LINES}. Use offset=${DEFAULT_MAX_LINES + 1} to continue.]`));
}

// A response that cannot provide a line offset retains the byte-range guidance.
{
  assert.deepEqual(contentFromReadResult({
    text: "partial line",
    truncated: true,
    byte_truncated: true,
    next_offset: 0,
    max_bytes: 123,
  }), [{
    type: "text",
    text: `partial line\n\n[Current line exceeds the ${formatSize(123)} read limit. Use supervised bash with a byte-range command to inspect the remainder.]`,
  }]);
}

const theme = {
  fg(color: string, text: string) { return `<fg:${color}>${text}</fg:${color}>`; },
  bg(color: string, text: string) { return `<bg:${color}>${text}</bg:${color}>`; },
  bold(text: string) { return `<bold>${text}</bold>`; },
};

// Self-shell edit rendering keeps one Box in row-local state, then mutates it
// from pending to success when the result slot arrives.
{
  const state: any = {};
  const args = { path: "src/file.ts", edits: [{ oldText: "old", newText: "new" }] };
  const call = renderSandboxEditToolCall(args, theme, { state });
  assert.equal(state.callComponent, call);
  assert.deepEqual(call.render(120), [
    "<bg:toolPendingBg><fg:toolTitle><bold>edit</bold></fg:toolTitle> <fg:accent>src/file.ts</fg:accent></bg:toolPendingBg>",
  ]);

  const diff = "--- a\n+++ b\n@@\n-old\n+new";
  const result = renderSandboxEditToolResult({
    content: [{ type: "text", text: "Edited src/file.ts" }],
    details: { diff },
  }, {}, theme, { args, state, isError: false });

  assert.deepEqual(result.render(120), []);
  assert.equal(state.output, diff);
  assert.equal(state.isError, false);
  const renderedCall = call.render(120);
  assert.equal(renderedCall[0], "<bg:toolSuccessBg><fg:toolTitle><bold>edit</bold></fg:toolTitle> <fg:accent>src/file.ts</fg:accent></bg:toolSuccessBg>");
  assert.equal(renderedCall[1], "<bg:toolSuccessBg></bg:toolSuccessBg>");
  assert.ok(renderedCall.includes("<bg:toolSuccessBg>@@</bg:toolSuccessBg>"));
}

// Result-first rendering is also retained: state is populated before the call
// component exists, and the later call includes the settled output.
{
  const state: any = {};
  renderSandboxEditToolResult({ content: [{ type: "text", text: "Edited later.ts" }] }, {}, theme, {
    args: { path: "later.ts" },
    state,
    isError: false,
  });
  const call = renderSandboxEditToolCall({ path: "later.ts" }, theme, { state });
  assert.equal(state.output, "<fg:toolOutput>Edited later.ts</fg:toolOutput>");
  assert.ok(call.render(120).every((line: string) => line.startsWith("<bg:toolSuccessBg>")));
}

// Without shared self-shell state, result text is shown above a diff. Error
// presentation takes precedence over diff presentation in either shell mode.
{
  const standalone = renderSandboxEditToolResult({
    content: [{ type: "text", text: "Edited standalone.ts" }],
    details: { diff: "@@\n-old\n+new" },
  }, {}, theme, { args: { path: "standalone.ts" } });
  assert.deepEqual(standalone.render(120), [
    "<fg:toolOutput>Edited standalone.ts</fg:toolOutput>",
    "",
    "@@",
    "-old",
    "+new",
  ]);

  const failed = renderSandboxEditToolResult({
    content: [{ type: "text", text: "edit failed" }],
    details: { diff: "ignored diff" },
  }, {}, theme, { args: { path: "standalone.ts" }, isError: true });
  assert.deepEqual(failed.render(120), ["<fg:error>edit failed</fg:error>"]);

  const state: any = {};
  const call = renderSandboxEditToolCall({ path: "failed.ts" }, theme, { state });
  renderSandboxEditToolResult({
    content: [{ type: "text", text: "shared edit failed" }],
    details: { diff: "ignored shared diff" },
  }, {}, theme, { args: { path: "failed.ts" }, state, isError: true });
  assert.equal(state.output, "<fg:error>shared edit failed</fg:error>");
  assert.equal(state.isError, true);
  assert.ok(call.render(120).every((line: string) => line.startsWith("<bg:toolErrorBg>")));
}

// Pi may hand the renderer its previous call component; preserve that identity.
{
  const previous = new Box(1, 1, (text: string) => text);
  const state: any = {};
  const rendered = renderSandboxEditToolCall({}, theme, { state, lastComponent: previous });
  assert.equal(rendered, previous);
  assert.equal(state.callComponent, previous);
  assert.ok(rendered.render(120)[0].includes("(unknown path)"));
}

console.log("sandbox tool result presentation checks passed");
