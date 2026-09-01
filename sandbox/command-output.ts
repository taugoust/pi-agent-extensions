import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
  type TruncationResult,
} from "@mariozechner/pi-coding-agent";
import type { ExecResult } from "./exec-result.js";

type JsonObject = Record<string, unknown>;

export type OutputSnapshot = {
  content: string;
  truncation: TruncationResult;
  fullOutputPath?: string;
};

function byteLength(text: string) {
  return Buffer.byteLength(text, "utf-8");
}

export class StringOutputAccumulator {
  private readonly decoder = new TextDecoder();
  private tailText = "";
  private tailBytes = 0;
  private tailStartsAtLineBoundary = true;
  private totalDecodedBytes = 0;
  private completedLines = 0;
  private totalLines = 0;
  private currentLineBytes = 0;
  private hasOpenLine = false;
  private finished = false;

  append(text: string): void {
    if (this.finished) throw new Error("Cannot append to a finished output accumulator");
    if (!text) return;

    const data = Buffer.from(text, "utf-8");
    this.appendDecodedText(this.decoder.decode(data, { stream: true }));
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.appendDecodedText(this.decoder.decode());
  }

  snapshot(_options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
    const tailTruncation = truncateTail(this.getSnapshotText(), {
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    });
    const truncated = this.totalLines > DEFAULT_MAX_LINES || this.totalDecodedBytes > DEFAULT_MAX_BYTES;
    const truncation: TruncationResult = {
      ...tailTruncation,
      truncated,
      truncatedBy: truncated ? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > DEFAULT_MAX_BYTES ? "bytes" : "lines")) : null,
      totalLines: this.totalLines,
      totalBytes: this.totalDecodedBytes,
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    };

    return {
      content: truncation.content,
      truncation,
    };
  }

  async closeTempFile(): Promise<void> {
    // Supervised overflow artifacts are owned by remote AgentSH. Retain this
    // no-op during the compatibility transition so existing finally blocks do
    // not create local-Pi filesystem capabilities.
  }

  getLastLineBytes(): number {
    return this.currentLineBytes;
  }

  private appendDecodedText(text: string): void {
    if (!text) return;

    const bytes = byteLength(text);
    this.totalDecodedBytes += bytes;
    this.tailText += text;
    this.tailBytes += bytes;
    if (this.tailBytes > DEFAULT_MAX_BYTES * 4) this.trimTail();

    let newlines = 0;
    let lastNewline = -1;
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
      newlines++;
      lastNewline = i;
    }
    if (newlines === 0) {
      this.currentLineBytes += bytes;
      this.hasOpenLine = true;
    } else {
      this.completedLines += newlines;
      const tail = text.slice(lastNewline + 1);
      this.currentLineBytes = byteLength(tail);
      this.hasOpenLine = tail.length > 0;
    }
    this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
  }

  private trimTail(): void {
    const buffer = Buffer.from(this.tailText, "utf-8");
    const maxRollingBytes = DEFAULT_MAX_BYTES * 2;
    if (buffer.length <= maxRollingBytes) {
      this.tailBytes = buffer.length;
      return;
    }

    let start = buffer.length - maxRollingBytes;
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;

    this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
    this.tailText = buffer.subarray(start).toString("utf-8");
    this.tailBytes = byteLength(this.tailText);
  }

  private getSnapshotText(): string {
    if (this.tailStartsAtLineBoundary) return this.tailText;
    const firstNewline = this.tailText.indexOf("\n");
    return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
  }

}

function execResultBoolean(result: ExecResult | undefined, key: string) {
  return result?.[key] === true;
}

function execResultNumber(result: ExecResult | undefined, key: string) {
  const value = result?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numericField(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export type RemoteOutputArtifact = {
  path?: string;
  bytes?: number;
  totalBytes?: number;
  complete?: boolean;
  error?: string;
};

export function remoteOutputArtifact(result: ExecResult | undefined): RemoteOutputArtifact | undefined {
  if (!result) return undefined;
  const nested = result.output_artifact && typeof result.output_artifact === "object" ? result.output_artifact as JsonObject : undefined;
  const path = typeof result.full_output_path === "string" ? result.full_output_path : typeof nested?.path === "string" ? nested.path : undefined;
  const bytes = execResultNumber(result, "artifact_bytes") ?? numericField(nested?.bytes);
  const totalBytes = execResultNumber(result, "artifact_total_bytes") ?? numericField(nested?.total_bytes);
  const completeValue = typeof result.artifact_complete === "boolean" ? result.artifact_complete : nested?.complete;
  const error = typeof result.artifact_error === "string" ? result.artifact_error : typeof nested?.error === "string" ? nested.error : undefined;
  if (!path && !error && bytes === undefined && totalBytes === undefined) return undefined;
  return { path, bytes, totalBytes, complete: typeof completeValue === "boolean" ? completeValue : undefined, error };
}

function agentSHOutputWarnings(result: ExecResult | undefined, artifact?: RemoteOutputArtifact) {
  const warnings: string[] = [];
  const sessionID = typeof result?.session_id === "string" ? result.session_id : "";
  const commandID = typeof result?.command_id === "string" ? result.command_id : "";
  for (const stream of ["stdout", "stderr"] as const) {
    if (!execResultBoolean(result, `${stream}_truncated`)) continue;
    const total = execResultNumber(result, `${stream}_total_bytes`);
    const totalText = total === undefined ? "" : ` at ${formatSize(total)}`;
    let hint = "";
    if (artifact?.path && artifact.complete) hint = " Complete output is available in the remote artifact.";
    else if (artifact?.path) hint = " The remote artifact is also bounded; its byte counts are shown above.";
    else if (sessionID && commandID) hint = ` The retained AgentSH prefix can be paged with: agentsh output ${sessionID} ${commandID} --stream ${stream}`;
    warnings.push(`AgentSH response truncated ${stream}${totalText}.${hint}`);
  }
  return warnings;
}

export function formatAccumulatedOutput(snapshot: OutputSnapshot, output: StringOutputAccumulator, result?: ExecResult, emptyText = "(no output)") {
  const truncation = snapshot.truncation;
  let text = snapshot.content || emptyText;
  const artifact = remoteOutputArtifact(result);
  const warnings = agentSHOutputWarnings(result, artifact);
  if (truncation.truncated) {
    const startLine = truncation.totalLines - truncation.outputLines + 1;
    const endLine = truncation.totalLines;
    let shown: string;
    if (truncation.lastLinePartial) {
      const lastLineSize = formatSize(output.getLastLineBytes());
      shown = `Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}).`;
    } else if (truncation.truncatedBy === "lines") {
      shown = `Showing lines ${startLine}-${endLine} of ${truncation.totalLines}.`;
    } else {
      shown = `Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit).`;
    }
    if (artifact?.path) {
      const retained = artifact.complete === false
        ? ` Retained remote output: ${artifact.path} (${formatSize(artifact.bytes ?? 0)} of ${formatSize(artifact.totalBytes ?? 0)}).`
        : ` Full output: ${artifact.path}`;
      shown += retained;
    } else if (artifact?.error) {
      shown += ` Remote output artifact unavailable: ${artifact.error}`;
    } else if (result) {
      shown += " Remote output artifact unavailable from this supervisor.";
    } else {
      shown += " Remote output artifact pending command completion.";
    }
    warnings.unshift(shown);
  }
  if (warnings.length > 0) text += `\n\n[${warnings.join(" ")}]`;
  return text;
}
