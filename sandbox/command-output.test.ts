import assert from "node:assert/strict";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@mariozechner/pi-coding-agent";
import * as commandOutputModule from "./command-output.js";
import {
  StringOutputAccumulator,
  formatAccumulatedOutput,
  remoteOutputArtifact,
} from "./command-output.js";

assert.deepEqual(Object.keys(commandOutputModule).sort(), [
  "StringOutputAccumulator",
  "formatAccumulatedOutput",
  "remoteOutputArtifact",
]);

// The configured byte bound is inclusive; the next byte selects an exact tail
// window while preserving the full-output counters.
{
  const output = new StringOutputAccumulator();
  const atLimit = "b".repeat(DEFAULT_MAX_BYTES);
  output.append(atLimit);

  const exact = output.snapshot();
  assert.equal(exact.content, atLimit);
  assert.equal(exact.truncation.truncated, false);
  assert.equal(exact.truncation.totalBytes, DEFAULT_MAX_BYTES);
  assert.equal(exact.truncation.totalLines, 1);

  output.append("x");
  const over = output.snapshot({ persistIfTruncated: true });
  assert.equal(over.truncation.truncated, true);
  assert.equal(over.truncation.truncatedBy, "bytes");
  assert.equal(over.truncation.totalBytes, DEFAULT_MAX_BYTES + 1);
  assert.equal(over.truncation.outputBytes, DEFAULT_MAX_BYTES);
  assert.equal(over.truncation.totalLines, 1);
  assert.equal(over.truncation.outputLines, 1);
  assert.equal(over.truncation.lastLinePartial, true);
  assert.equal(over.content, `${"b".repeat(DEFAULT_MAX_BYTES - 1)}x`);
}

// The line bound is also inclusive and retains the newest complete lines once
// one more line arrives.
{
  const lines = Array.from({ length: DEFAULT_MAX_LINES }, (_, index) => `line-${index}`);
  const output = new StringOutputAccumulator();
  output.append(lines.join("\n"));

  const exact = output.snapshot();
  assert.equal(exact.truncation.truncated, false);
  assert.equal(exact.truncation.totalLines, DEFAULT_MAX_LINES);
  assert.equal(exact.content, lines.join("\n"));

  output.append(`\nline-${DEFAULT_MAX_LINES}`);
  const over = output.snapshot();
  assert.equal(over.truncation.truncated, true);
  assert.equal(over.truncation.truncatedBy, "lines");
  assert.equal(over.truncation.totalLines, DEFAULT_MAX_LINES + 1);
  assert.equal(over.truncation.outputLines, DEFAULT_MAX_LINES);
  assert.equal(over.content, [...lines.slice(1), `line-${DEFAULT_MAX_LINES}`].join("\n"));
}

// Rolling-tail compaction and final byte truncation both start on UTF-8 code
// point boundaries, even when the nominal byte offset lands inside an emoji.
{
  const emoji = "🌍";
  assert.equal(Buffer.byteLength(emoji, "utf8"), 4);
  const output = new StringOutputAccumulator();
  output.append(emoji.repeat(DEFAULT_MAX_BYTES + 1) + "x");

  const snapshot = output.snapshot();
  const expected = emoji.repeat(Math.floor((DEFAULT_MAX_BYTES - 1) / 4)) + "x";
  assert.equal(snapshot.content, expected);
  assert.equal(snapshot.content.includes("�"), false);
  assert.equal(snapshot.truncation.totalBytes, (DEFAULT_MAX_BYTES + 1) * 4 + 1);
  assert.equal(snapshot.truncation.outputBytes, Buffer.byteLength(expected, "utf8"));
  assert.ok(snapshot.truncation.outputBytes <= DEFAULT_MAX_BYTES);
  assert.equal(snapshot.truncation.lastLinePartial, true);
}

// A final overlong line is reported as a partial tail of that line, including
// its full byte size and the pending-artifact wording used during updates.
{
  const output = new StringOutputAccumulator();
  output.append("first");
  output.append(`\n${"z".repeat(DEFAULT_MAX_BYTES * 2)}`);
  const snapshot = output.snapshot();

  assert.equal(snapshot.truncation.totalLines, 2);
  assert.equal(snapshot.truncation.outputLines, 1);
  assert.equal(snapshot.truncation.lastLinePartial, true);
  assert.equal(snapshot.content, "z".repeat(DEFAULT_MAX_BYTES));
  assert.equal(output.getLastLineBytes(), DEFAULT_MAX_BYTES * 2);
  assert.equal(
    formatAccumulatedOutput(snapshot, output),
    `${snapshot.content}\n\n[Showing last ${formatSize(DEFAULT_MAX_BYTES)} of line 2 (line is ${formatSize(DEFAULT_MAX_BYTES * 2)}). Remote output artifact pending command completion.]`,
  );
}

// Promoted artifact fields retain precedence over nested compatibility fields.
{
  assert.deepEqual(remoteOutputArtifact({
    full_output_path: "/remote/promoted.log",
    artifact_bytes: 10,
    artifact_total_bytes: 20,
    artifact_complete: false,
    artifact_error: "promoted error",
    output_artifact: {
      path: "/remote/nested.log",
      bytes: 1,
      total_bytes: 2,
      complete: true,
      error: "nested error",
    },
  }), {
    path: "/remote/promoted.log",
    bytes: 10,
    totalBytes: 20,
    complete: false,
    error: "promoted error",
  });
  assert.equal(remoteOutputArtifact({ output_artifact: { complete: true } }), undefined);
}

// Local truncation notices and AgentSH response warnings preserve the complete,
// bounded, failed, and pageable artifact diagnostics.
{
  const output = new StringOutputAccumulator();
  output.append("q".repeat(DEFAULT_MAX_BYTES + 1));
  const snapshot = output.snapshot();

  const complete = formatAccumulatedOutput(snapshot, output, {
    stdout_truncated: true,
    stdout_total_bytes: DEFAULT_MAX_BYTES * 3,
    full_output_path: "/remote/full.log",
    artifact_bytes: DEFAULT_MAX_BYTES * 3,
    artifact_total_bytes: DEFAULT_MAX_BYTES * 3,
    artifact_complete: true,
  });
  assert.match(complete, /Full output: \/remote\/full\.log/);
  assert.ok(complete.includes(`AgentSH response truncated stdout at ${formatSize(DEFAULT_MAX_BYTES * 3)}. Complete output is available in the remote artifact.`));

  const bounded = formatAccumulatedOutput(snapshot, output, {
    stderr_truncated: true,
    stderr_total_bytes: DEFAULT_MAX_BYTES * 4,
    output_artifact: {
      path: "/remote/bounded.log",
      bytes: DEFAULT_MAX_BYTES,
      total_bytes: DEFAULT_MAX_BYTES * 4,
      complete: false,
    },
  });
  assert.match(bounded, /Retained remote output: \/remote\/bounded\.log/);
  assert.match(bounded, /The remote artifact is also bounded; its byte counts are shown above\./);

  const unavailable = formatAccumulatedOutput(snapshot, output, {
    artifact_error: "remote persistence failed",
  });
  assert.match(unavailable, /Remote output artifact unavailable: remote persistence failed/);

  const shortOutput = new StringOutputAccumulator();
  shortOutput.append("visible");
  const pageable = formatAccumulatedOutput(shortOutput.snapshot(), shortOutput, {
    stdout_truncated: true,
    session_id: "session-1",
    command_id: "command-1",
  });
  assert.equal(
    pageable,
    "visible\n\n[AgentSH response truncated stdout. The retained AgentSH prefix can be paged with: agentsh output session-1 command-1 --stream stdout]",
  );
}

console.log("sandbox command output checks passed");
