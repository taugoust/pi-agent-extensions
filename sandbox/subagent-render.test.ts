import assert from "node:assert/strict";
import {
  formatSubagentUsage,
  renderSubagentCall,
  renderSubagentResult,
  renderSubagentStream,
  subagentDetailsFailed,
} from "./subagent-render.js";
import { createSubagentStreamState } from "./subagent-stream.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function renderLines(component: any, width = 120): string[] {
  return component.render(width);
}

{
  assert.deepEqual(renderLines(renderSubagentCall({ action: "approve", draft_id: "draft-1" }, theme)), [
    "subagent draft approve",
    "  draft-1",
  ]);
  assert.deepEqual(renderLines(renderSubagentCall({ chain: [{}, {}, {}] }, theme)), ["subagent chain (3 steps)"]);
  assert.deepEqual(renderLines(renderSubagentCall({ tasks: [{}, {}] }, theme)), ["subagent parallel (2 tasks)"]);
  assert.deepEqual(renderLines(renderSubagentCall({ task: "x".repeat(71) }, theme)), [
    "subagent single",
    `  ${"x".repeat(70)}...`,
  ]);
}

{
  assert.equal(formatSubagentUsage({
    turns: 2,
    input: 1_500,
    output: 10_000,
    cacheRead: 999,
    cacheWrite: 1_000_000,
    cost: 0.125,
    contextTokens: 2_500,
    contextWindow: 10_000,
  }, "registry/large"), "2 turns ↑1.5k ↓10k R999 W1.0M $0.1250 ctx:2.5k/10k (25%) registry/large");
  assert.equal(formatSubagentUsage({ contextTokens: 1_234 }), "ctx:1.2k");
  assert.equal(formatSubagentUsage({}), "");
}

{
  const state = createSubagentStreamState({
    label: "stream",
    prefix: "[stream started]\n",
    liveText: "working",
    rawText: "raw diagnostic\n",
    toolStatus: "[running read]",
    usage: { turns: 1, input: 3 },
    model: "registry/small",
  });
  assert.equal(renderSubagentStream(state), [
    "[stream started]",
    "working",
    "[running read]",
    "raw diagnostic",
    "[1 turn ↑3 registry/small]",
  ].join("\n"));
}

{
  assert.equal(subagentDetailsFailed({
    terminal: { state: "completed", exit_code: 0, termination: "natural", retryable: false },
    results: [{ exitCode: -1, stopReason: "running" }],
  }), false);
  assert.equal(subagentDetailsFailed({
    terminal: { state: "completed", exit_code: 0, termination: "natural", retryable: false },
    results: [{
      exitCode: 1,
      stopReason: "error",
      terminal: { state: "failed", failure_kind: "model", exit_code: 1, termination: "natural", retryable: false },
    }],
  }), true);
  assert.equal(subagentDetailsFailed({ error: "parent failure", results: [] }), true);
}

const singleResult = {
  content: [{ type: "text", text: "parent answer" }],
  details: {
    mode: "single",
    results: [{
      label: "child",
      task: "inspect rendering",
      exitCode: 0,
      stopReason: "completed",
      terminal: { state: "completed", exitCode: 0, termination: "natural", retryable: false },
      final: "answer",
      model: "registry/small",
      tools: ["read"],
      cwd: "/workspace",
      messages: [{
        role: "assistant",
        content: [
          { type: "text", text: "answer" },
          { type: "toolCall", name: "read", arguments: { path: "/tmp/example.ts", offset: 2, limit: 3 } },
        ],
      }],
      completedTools: [{ name: "read", args: { path: "/tmp/example.ts" }, isError: false, resultPreview: "preview" }],
      usage: { turns: 1, input: 10, output: 5 },
      fullResultPath: "/artifacts/child.md",
    }],
  },
};

{
  assert.deepEqual(renderLines(renderSubagentResult(singleResult, { expanded: false }, theme)), [
    "✓ subagent",
    "answer",
    "→ read /tmp/example.ts:2-4",
    "Full result: /artifacts/child.md",
    "1 turn ↑10 ↓5 registry/small",
  ]);

  const expanded = renderLines(renderSubagentResult(singleResult, { expanded: true }, theme));
  assert.deepEqual(expanded, [
    "✓ child",
    "Status: completed (exit 0)",
    "Task: inspect rendering",
    "Model: registry/small",
    "Tools: read",
    "Cwd: /workspace",
    "Last completed tool: read /tmp/example.ts",
    "preview",
    "→ read /tmp/example.ts:2-4",
    "",
    "─── Output ───",
    "answer",
    "Full result: /artifacts/child.md",
    "1 turn ↑10 ↓5 registry/small",
  ]);
}

{
  const parallel = {
    content: [{ type: "text", text: "parallel parent" }],
    details: {
      mode: "parallel",
      results: [
        {
          label: "one",
          exitCode: 0,
          stopReason: "completed",
          terminal: { state: "completed", exitCode: 0, termination: "natural", retryable: false },
          final: "first answer",
          messages: [],
          usage: { turns: 1, input: 3, output: 2 },
        },
        {
          label: "two",
          task: "failing task",
          exitCode: 1,
          stopReason: "error",
          terminal: { state: "failed", failureKind: "model", exitCode: 1, termination: "natural", retryable: false, message: "provider failed" },
          errorMessage: "provider failed",
          stderrTail: "last stderr",
          artifactError: "artifact unavailable",
          messages: [],
          usage: { turns: 2, input: 4, output: 1 },
        },
      ],
    },
  };
  const collapsed = renderLines(renderSubagentResult(parallel, { expanded: false }, theme)).join("\n");
  assert.match(collapsed, /^◐ parallel 1\/2 tasks/);
  assert.match(collapsed, /─── one ✓\nfirst answer/);
  assert.match(collapsed, /─── two ✗\nSubagent failed\./);
  assert.match(collapsed, /Task: failing task/);
  assert.match(collapsed, /stderr:\nlast stderr/);
  assert.match(collapsed, /Result artifact unavailable: artifact unavailable/);
  assert.match(collapsed, /Total: 3 turns ↑7 ↓3/);
  assert.ok(collapsed.endsWith("(Ctrl+O to expand)"));
}

{
  assert.deepEqual(renderLines(renderSubagentResult({ content: [{ type: "text", text: "plain fallback" }] }, {}, theme)), ["plain fallback"]);
  assert.deepEqual(renderLines(renderSubagentResult({ content: [] }, {}, theme)), ["(no output)"]);
}

console.log("sandbox subagent rendering glue checks passed");
