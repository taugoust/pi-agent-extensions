import assert from "node:assert/strict";
import {
  boundedSubagentParentOutput,
  contextWindowForModel,
  latestSubagentAssistantText,
  piProtocolFailure,
  subagentParentDetails,
  trustedRetainedSubagentReports,
} from "./subagent-parent-result.js";
import { createSubagentStreamState } from "./subagent-stream.js";

function line(event: unknown): string {
  return `${JSON.stringify(event)}\n`;
}

const modelContext = {
  model: { provider: "current", id: "default", name: "Default", contextWindow: 8_192 },
  modelRegistry: {
    getAll: () => [
      { provider: "registry", id: "small", name: "Small", contextWindow: 4_096 },
      { provider: "registry", id: "large", name: "Large", contextWindow: 32_768 },
    ],
  },
} as any;

{
  assert.equal(contextWindowForModel(modelContext, "registry/large"), 32_768);
  assert.equal(contextWindowForModel(modelContext, "registry:small"), 4_096);
  assert.equal(contextWindowForModel(modelContext, "current/default"), 8_192);
  assert.equal(contextWindowForModel(modelContext, "missing/model"), 0);
  assert.equal(contextWindowForModel(modelContext), 8_192);
}

{
  const noEvidence = createSubagentStreamState({ label: "no-evidence" });
  assert.equal(piProtocolFailure(noEvidence), undefined);

  const interrupted = createSubagentStreamState({ label: "interrupted", sawPiJsonStdout: true });
  assert.deepEqual(piProtocolFailure(interrupted), {
    failureKind: "protocol",
    message: "child Pi stream ended before agent_settled",
    retryable: true,
  });

  const toolUse = createSubagentStreamState({
    label: "tool-use",
    sawPiJsonStdout: true,
    protocolSettled: true,
    modelStopReason: "toolUse",
    messages: [
      { role: "assistant", content: [{ type: "text", text: "stale answer" }], stopReason: "stop" },
      { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "/tmp/x" } }], stopReason: "toolUse" },
    ],
  });
  assert.equal(latestSubagentAssistantText(toolUse), "", "stale assistant text was treated as the latest response");
  assert.deepEqual(piProtocolFailure(toolUse), {
    failureKind: "protocol",
    message: "child Pi settled after a tool-use turn without a final assistant response",
    retryable: true,
  });

  const modelError = createSubagentStreamState({
    label: "model-error",
    sawPiJsonStdout: true,
    protocolSettled: true,
    modelStopReason: "error",
    messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "provider failed" }],
  });
  assert.deepEqual(piProtocolFailure(modelError), {
    failureKind: "model",
    message: "provider failed",
    retryable: false,
  });

  const completed = createSubagentStreamState({
    label: "completed",
    sawPiJsonStdout: true,
    protocolSettled: true,
    final: "done",
  });
  assert.equal(piProtocolFailure(completed), undefined);
}

{
  const streamed = createSubagentStreamState({
    label: "child",
    task: "inspect the failure",
    exitCode: 1,
    stopReason: "error",
    terminal: {
      state: "failed",
      failureKind: "protocol",
      exitCode: 1,
      termination: "natural",
      retryable: true,
      message: "streamed protocol failure",
    },
    final: "stale streamed final",
    errorMessage: "streamed protocol failure",
    usage: { input: 30, output: 7, turns: 3, contextWindow: 16_384 },
    messages: [{ role: "assistant", content: [{ type: "text", text: "retained diagnostic text" }], stopReason: "error" }],
    protocolSettled: true,
  });
  const details = subagentParentDetails({
    mode: "single",
    terminal: { state: "completed", exit_code: 0, termination: "natural", retryable: false },
    final: "server parent final must not mask child failure",
    summary: "server summary",
    results: [{
      label: "child",
      exit_code: 0,
      stop_reason: "completed",
      terminal: { state: "completed", exit_code: 0, termination: "natural", retryable: false },
      final: "server child final must not mask streamed failure",
      usage: { input: 1, output: 1, turns: 1 },
      context_window: 65_536,
      full_result_path: "/artifacts/child.md",
      final_truncated: true,
      final_total_bytes: 9_000,
      artifact_bytes: 8_000,
      artifact_complete: false,
    }],
  }, modelContext, new Map([["child", streamed]]));

  assert.equal(details.results.length, 1);
  assert.equal(details.results[0].terminal?.state, "failed");
  assert.equal(details.results[0].terminal?.failureKind, "protocol");
  assert.equal(details.results[0].final, undefined, "server success final survived a streamed terminal downgrade");
  assert.equal(details.results[0].usage.turns, 3, "less complete server usage replaced streamed usage");
  assert.equal(details.results[0].usage.contextWindow, 65_536, "explicit server context window lost precedence");
  assert.equal(details.terminal?.state, "failed", "completed parent terminal masked a failed child");
  assert.equal(details.error, "streamed protocol failure");
  assert.equal(details.final, undefined);
  assert.equal(details.fullResultPath, "/artifacts/child.md");
  assert.equal(details.finalTruncated, true);
  assert.equal(details.finalTotalBytes, 9_000);
  assert.equal(details.artifactBytes, 8_000);
  assert.equal(details.artifactComplete, false);
}

{
  const stdout = [
    line({
      type: "message_end",
      message: {
        role: "assistant",
        model: "registry/large",
        stopReason: "stop",
        usage: { input: 12, output: 5, totalTokens: 17 },
        content: [{ type: "text", text: "parsed final answer" }],
      },
    }),
    line({ type: "agent_settled" }),
  ].join("");
  const details = subagentParentDetails({
    terminal: { state: "completed", exit_code: 0, termination: "natural", retryable: false },
    results: [{
      label: "parsed",
      exit_code: 0,
      stop_reason: "completed",
      terminal: { state: "completed", exit_code: 0, termination: "natural", retryable: false },
      stdout,
      protocol_diagnostics: [{ kind: "unknown_event", event: "server_private", bytes: 42 }],
    }],
  }, modelContext);

  assert.equal(details.mode, "single");
  assert.equal(details.final, "parsed final answer", "parsed child stdout did not supply the single-child parent final");
  assert.equal(details.results[0].model, "registry/large");
  assert.equal(details.results[0].usage.input, 12);
  assert.equal(details.results[0].usage.turns, 1);
  assert.equal(details.results[0].usage.contextWindow, 32_768);
  assert.equal(details.results[0].protocolSettled, true);
  assert.deepEqual(details.results[0].protocolDiagnostics.at(-1), {
    kind: "unknown_event",
    detail: "server_private: 42 B",
  });
}

{
  const output = boundedSubagentParentOutput({
    content: [{ type: "text", text: "direct parent text" }],
    final: "lower-priority final",
    terminal: { state: "failed", retryable: false, sideEffectsMayHaveOccurred: true },
    results: [
      {
        label: "retained",
        fullResultPath: "/artifacts/full.md",
        artifactBytes: 1_024,
        finalTotalBytes: 2_048,
        artifactComplete: false,
      },
      { label: "missing", artifactError: "persistence denied" },
    ],
  });
  assert.ok(output.startsWith("direct parent text\n\n"), "direct content lost precedence in parent output");
  assert.match(output, /Full subagent result \[retained\]: \/artifacts\/full\.md .*retained\)/);
  assert.match(output, /Subagent result artifact unavailable \[missing\]: persistence denied/);
  assert.match(output, /must not be replayed automatically/);
  assert.equal(output.includes("lower-priority final"), false);
}

{
  const streamed = createSubagentStreamState({
    label: "recovered",
    messages: [{ role: "assistant", content: [{ type: "text", text: "complete streamed answer" }], stopReason: "stop" }],
  });
  const reports = trustedRetainedSubagentReports({
    results: [
      { label: "rejected", final: "stale raw success" },
      { label: "recovered", final: "" },
    ],
  }, {
    results: [
      { label: "rejected", terminal: { state: "failed", message: "protocol rejected" }, errorMessage: "protocol rejected" },
      { label: "recovered", terminal: { state: "completed" }, final: "short capsule" },
    ],
  }, new Map([["recovered", streamed]]));
  assert.equal(reports[0].text, "protocol rejected", "rejected stale raw final was retained");
  assert.equal(reports[1].text, "complete streamed answer", "stream-recovered final was not retained");
}

{
  const first = createSubagentStreamState({
    label: "duplicate",
    child: 1,
    final: "first authoritative result",
    terminal: { state: "completed" },
  });
  const second = createSubagentStreamState({
    label: "duplicate",
    child: 2,
    final: "second authoritative result",
    terminal: { state: "completed" },
  });
  const raw = {
    mode: "parallel",
    terminal: { state: "completed" },
    results: [
      { subagent_id: "backend-second", label: "duplicate", task: "same task", final: "second authoritative result", terminal: { state: "completed" } },
      { subagent_id: "backend-first", label: "duplicate", task: "same task", final: "first authoritative result", terminal: { state: "completed" } },
    ],
  };
  const states = new Map([
    ["id:backend-first", first],
    ["id:backend-second", second],
  ]);
  const details = subagentParentDetails(raw, modelContext, states);
  assert.deepEqual(details.results.map((result) => result.child), [2, 1], "completion order replaced authoritative launch ordinals");
  const reports = trustedRetainedSubagentReports(raw, details, states);
  assert.deepEqual(reports.map((report) => [report.child, report.text]), [
    [2, "second authoritative result"],
    [1, "first authoritative result"],
  ]);
}

console.log("sandbox subagent parent result glue checks passed");
